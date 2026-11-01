// Persistent store for APE for Business (production data layer).
//
// One real database, zero npm dependencies: SQLite via the Node
// built-in node:sqlite (Node >= 22.5). Local/test/CI use a single
// file (APE_DB_PATH, default provisioning/data/ape.db, gitignored).
// Production on AWS runs the same schema on RDS for PostgreSQL:
// every statement below is portable SQL, and this module is the
// only file that knows the dialect. Swap the driver here, not in
// callers. DynamoDB was rejected for this workload: tenant records,
// deployments, and jobs are relational and queried by tenant+time.
//
// What lives here, and why it must survive a restart:
// - tenants + deployments: losing them loses the business.
// - processed intents: losing them re-provisions on Stripe retry.
// - opt-outs: losing them re-messages people who said STOP (TCPA).
// - message dedup: losing it double-creates jobs on provider retry.
// - Sealbox token maps: losing them makes <EMAIL_1> resolve to a
//   DIFFERENT person's value after restart. Never reassign tokens.
//
// Bearer tokens are stored only as SHA-256 hashes. The plaintext is
// returned once, at provision time, and never written anywhere.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TENANT_ID_RE = /^tn_[a-f0-9]{12,32}$/;

function isValidTenantId(id) {
  return typeof id === 'string' && TENANT_ID_RE.test(id);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function createStore(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const file = dbPath || process.env.APE_DB_PATH ||
    path.join(__dirname, '..', 'data', 'ape.db');
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(file);
  // Several processes (server, pipeline, webhook) share this file:
  // wait for locks instead of dying with SQLITE_BUSY at startup.
  db.exec('PRAGMA busy_timeout = 10000');
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      break;
    } catch (e) {
      if (attempt >= 20) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  db.exec('PRAGMA foreign_keys = ON');
  const initSql = `
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, token_hash TEXT,
      data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deployments (
      tenant_id TEXT PRIMARY KEY, status TEXT NOT NULL,
      data TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS processed_intents (
      intent_id TEXT PRIMARY KEY, result TEXT, claimed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, channel TEXT NOT NULL,
      data TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_tenant_idx ON jobs (tenant_id, created_at);
    CREATE TABLE IF NOT EXISTS dedup (
      tenant_id TEXT NOT NULL, kind TEXT NOT NULL, dedup_key TEXT NOT NULL,
      result TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, kind, dedup_key)
    );
    CREATE TABLE IF NOT EXISTS optouts (
      tenant_id TEXT NOT NULL, sender TEXT NOT NULL,
      PRIMARY KEY (tenant_id, sender)
    );
    CREATE TABLE IF NOT EXISTS seen_senders (
      tenant_id TEXT NOT NULL, sender TEXT NOT NULL,
      PRIMARY KEY (tenant_id, sender)
    );
    CREATE TABLE IF NOT EXISTS sealbox_tokens (
      tenant_id TEXT NOT NULL, kind TEXT NOT NULL, raw TEXT NOT NULL,
      token TEXT NOT NULL, PRIMARY KEY (tenant_id, token),
      UNIQUE (tenant_id, raw)
    );
    CREATE TABLE IF NOT EXISTS sealbox_counters (
      tenant_id TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, kind)
    );
    CREATE TABLE IF NOT EXISTS sealbox_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
      ts TEXT NOT NULL, token_count INTEGER NOT NULL, payload_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credentials (
      tenant_id TEXT NOT NULL, system TEXT NOT NULL,
      ciphertext TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, system)
    );
  `;
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec(initSql);
      break;
    } catch (e) {
      if (attempt >= 20) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }

  const now = () => new Date().toISOString();
  const parse = (s) => (s == null ? null : JSON.parse(s));

  return {
    file,
    // ---- tenants ----
    putTenant(t) {
      db.prepare(`INSERT INTO tenants (id, status, token_hash, data, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,
          token_hash=excluded.token_hash, data=excluded.data,
          updated_at=excluded.updated_at`)
        .run(t.id, t.status, t.tokenHash || null,
          JSON.stringify(t), t.createdAt || now(), now());
    },
    getTenant(id) {
      if (!isValidTenantId(id)) return null;
      const row = db.prepare('SELECT data FROM tenants WHERE id = ?').get(id);
      return row ? parse(row.data) : null;
    },
    tenantTokenMatches(id, plaintext) {
      if (!plaintext) return false;
      const row = db.prepare('SELECT token_hash FROM tenants WHERE id = ?').get(id);
      if (!row || !row.token_hash) return false;
      const a = Buffer.from(row.token_hash);
      const b = Buffer.from(hashToken(plaintext));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
    // ---- deployments ----
    putDeployment(d) {
      db.prepare(`INSERT INTO deployments (tenant_id, status, data, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(tenant_id) DO UPDATE SET status=excluded.status,
          data=excluded.data, updated_at=excluded.updated_at`)
        .run(d.tenantId, d.status, JSON.stringify(d), now());
    },
    getDeployment(id) {
      if (!isValidTenantId(id)) return null;
      const row = db.prepare('SELECT data FROM deployments WHERE tenant_id = ?').get(id);
      return row ? parse(row.data) : null;
    },
    // ---- Stripe idempotency: claim is a single atomic INSERT ----
    claimIntent(intentId) {
      const r = db.prepare(
        'INSERT OR IGNORE INTO processed_intents (intent_id, result, claimed_at) VALUES (?, NULL, ?)')
        .run(intentId, now());
      if (r.changes === 1) return true;
      // Crash recovery: a claim whose process died before recording
      // must not block provisioning forever. Claims older than the
      // TTL with no result may be stolen by the next delivery.
      const CLAIM_TTL_MS = 15 * 60 * 1000;
      const row = db.prepare(
        'SELECT result, claimed_at FROM processed_intents WHERE intent_id = ?')
        .get(intentId);
      if (row && row.result == null &&
          Date.now() - Date.parse(row.claimed_at) > CLAIM_TTL_MS) {
        const steal = db.prepare(
          'UPDATE processed_intents SET claimed_at = ? WHERE intent_id = ? AND result IS NULL AND claimed_at = ?')
          .run(now(), intentId, row.claimed_at);
        return steal.changes === 1;
      }
      return false; // recorded, or a live claim within its TTL
    },
    recordIntent(intentId, result) {
      db.prepare(`INSERT INTO processed_intents (intent_id, result, claimed_at)
        VALUES (?, ?, ?)
        ON CONFLICT(intent_id) DO UPDATE SET result=excluded.result`)
        .run(intentId, JSON.stringify(result), now());
    },
    releaseIntent(intentId) {
      // Provision failed: free the claim so Stripe's retry can proceed.
      db.prepare('DELETE FROM processed_intents WHERE intent_id = ? AND result IS NULL')
        .run(intentId);
    },
    getIntent(intentId) {
      const row = db.prepare('SELECT result FROM processed_intents WHERE intent_id = ?')
        .get(intentId);
      return row ? parse(row.result) : null;
    },
    hasIntent(intentId) {
      return Boolean(db.prepare('SELECT 1 AS x FROM processed_intents WHERE intent_id = ?')
        .get(intentId));
    },
    // ---- jobs / dedup / opt-outs (all tenant-scoped) ----
    addJob(job) {
      db.prepare('INSERT INTO jobs (id, tenant_id, channel, data, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(job.jobId, job.tenantId, job.channel, JSON.stringify(job), job.createdAt || now());
    },
    listJobs(tenantId) {
      const rows = tenantId
        ? db.prepare('SELECT data FROM jobs WHERE tenant_id = ? ORDER BY created_at').all(tenantId)
        : db.prepare('SELECT data FROM jobs ORDER BY created_at').all();
      return rows.map((r) => parse(r.data));
    },
    getDedup(tenantId, kind, key) {
      const row = db.prepare(
        'SELECT result FROM dedup WHERE tenant_id = ? AND kind = ? AND dedup_key = ?')
        .get(tenantId, kind, key);
      return row ? parse(row.result) : null;
    },
    putDedup(tenantId, kind, key, result) {
      db.prepare(`INSERT OR REPLACE INTO dedup (tenant_id, kind, dedup_key, result, created_at)
        VALUES (?, ?, ?, ?, ?)`)
        .run(tenantId, kind, key, JSON.stringify(result), now());
    },
    optOut(tenantId, sender) {
      db.prepare('INSERT OR IGNORE INTO optouts (tenant_id, sender) VALUES (?, ?)')
        .run(tenantId, sender);
    },
    optIn(tenantId, sender) {
      db.prepare('DELETE FROM optouts WHERE tenant_id = ? AND sender = ?')
        .run(tenantId, sender);
    },
    isOptedOut(tenantId, sender) {
      return Boolean(db.prepare('SELECT 1 AS x FROM optouts WHERE tenant_id = ? AND sender = ?')
        .get(tenantId, sender));
    },
    markSenderSeen(tenantId, sender) {
      const r = db.prepare(
        'INSERT OR IGNORE INTO seen_senders (tenant_id, sender) VALUES (?, ?)')
        .run(tenantId, sender);
      return r.changes === 1; // true = first message from this sender
    },
    // ---- Sealbox token maps (persisted: restart must not remap) ----
    sealboxTokenFor(tenantId, kind, raw) {
      const hit = db.prepare(
        'SELECT token FROM sealbox_tokens WHERE tenant_id = ? AND raw = ?')
        .get(tenantId, raw);
      if (hit) return hit.token;
      const row = db.prepare(
        'SELECT n FROM sealbox_counters WHERE tenant_id = ? AND kind = ?')
        .get(tenantId, kind);
      const n = (row ? row.n : 0) + 1;
      db.prepare(`INSERT INTO sealbox_counters (tenant_id, kind, n) VALUES (?, ?, ?)
        ON CONFLICT(tenant_id, kind) DO UPDATE SET n=excluded.n`).run(tenantId, kind, n);
      const token = `<${kind}_${n}>`;
      db.prepare('INSERT INTO sealbox_tokens (tenant_id, kind, raw, token) VALUES (?, ?, ?, ?)')
        .run(tenantId, kind, raw, token);
      return token;
    },
    sealboxEntries(tenantId) {
      return db.prepare('SELECT token, raw FROM sealbox_tokens WHERE tenant_id = ?')
        .all(tenantId);
    },
    sealboxTokenCount(tenantId) {
      const row = db.prepare('SELECT COUNT(*) AS c FROM sealbox_tokens WHERE tenant_id = ?')
        .get(tenantId);
      return row.c;
    },
    sealboxAudit(tenantId, tokenCount, payloadHash) {
      const ts = now();
      db.prepare('INSERT INTO sealbox_audit (tenant_id, ts, token_count, payload_hash) VALUES (?, ?, ?, ?)')
        .run(tenantId, ts, tokenCount, payloadHash);
      return { event: 'sealbox_tokenize', tenantId, timestamp: ts, tokenCount, payloadHash };
    },
    sealboxAuditLog(tenantId) {
      const rows = tenantId
        ? db.prepare('SELECT tenant_id, ts, token_count, payload_hash FROM sealbox_audit WHERE tenant_id = ? ORDER BY id').all(tenantId)
        : db.prepare('SELECT tenant_id, ts, token_count, payload_hash FROM sealbox_audit ORDER BY id').all();
      return rows.map((r) => ({
        event: 'sealbox_tokenize', tenantId: r.tenant_id, timestamp: r.ts,
        tokenCount: r.token_count, payloadHash: r.payload_hash,
      }));
    },
    // ---- connector credentials (ciphertext only; see lib/vault.js) ----
    putCredential(tenantId, system, ciphertext) {
      db.prepare(`INSERT INTO credentials (tenant_id, system, ciphertext, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(tenant_id, system) DO UPDATE SET ciphertext=excluded.ciphertext,
          updated_at=excluded.updated_at`).run(tenantId, system, ciphertext, now());
    },
    getCredential(tenantId, system) {
      const row = db.prepare(
        'SELECT ciphertext FROM credentials WHERE tenant_id = ? AND system = ?')
        .get(tenantId, system);
      return row ? row.ciphertext : null;
    },
    // Quota decision + job insert in ONE transaction: two intakes
    // in separate processes must not both win the last slot.
    addJobWithQuota(tenantId, job, limit, sinceIso) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare(
          'SELECT COUNT(*) AS c FROM jobs WHERE tenant_id = ? AND created_at >= ?')
          .get(tenantId, sinceIso);
        if (row.c >= limit) {
          db.exec('COMMIT');
          return false;
        }
        db.prepare('INSERT INTO jobs (id, tenant_id, channel, data, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(job.jobId, job.tenantId, job.channel,
            JSON.stringify(job), job.createdAt || now());
        db.exec('COMMIT');
        return true;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* already closed */ }
        throw e;
      }
    },
    // ---- usage + observability ----
    countJobsSince(tenantId, sinceIso) {
      const row = db.prepare(
        'SELECT COUNT(*) AS c FROM jobs WHERE tenant_id = ? AND created_at >= ?')
        .get(tenantId, sinceIso);
      return row.c;
    },
    stats() {
      const by = (sql) => Object.fromEntries(
        db.prepare(sql).all().map((r) => [r.k, r.c]));
      return {
        tenantsByStatus: by('SELECT status AS k, COUNT(*) AS c FROM tenants GROUP BY status'),
        jobsByChannel: by('SELECT channel AS k, COUNT(*) AS c FROM jobs GROUP BY channel'),
        deploymentsByStatus: by('SELECT status AS k, COUNT(*) AS c FROM deployments GROUP BY status'),
      };
    },
    close() { db.close(); },
  };
}

module.exports = { createStore, isValidTenantId, TENANT_ID_RE, hashToken };
