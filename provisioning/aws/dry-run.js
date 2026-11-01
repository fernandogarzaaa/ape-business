#!/usr/bin/env node
// Dry-run harness for aws/deploy.js + health-check.js + rollback.js.
// Creates no AWS resource, spends nothing, uses no real key.
// Starts a local stub APE serving the real /discover and /tools shapes
// (server.name ape-mcp, capabilities, tools list), runs deploy in
// dry-run mode, runs the health check against the stub, runs rollback
// in dry-run mode, and asserts scope, order, and redaction.
// Also checks build-image.sh: fails loud without docker (exit 2), or
// validates its Dockerfile with --check when docker is present, so the
// dry run never attempts a real image build and never passes by
// accident on a machine that happens to have docker installed.
// Usage: node dry-run.js <tenant-id>   (default tn_dryrun1)
'use strict';
const { spawnSync, spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const dir = __dirname;
const tenant = process.argv[2] || 'tn_dryrun1';
const env = { ...process.env, AWS_REGION: 'us-east-1', AWS_ACCOUNT_ID: '000000000000', APE_CLUSTER: 'ape-test-cluster', APE_SUBNETS: 'subnet-0001', APE_SECURITY_GROUP: 'sg-0001', APE_IMAGE: '000000000000.dkr.ecr.us-east-1.amazonaws.com/ape-tenant:test', APE_CADDY_IMAGE: 'caddy:2-alpine', APE_EXECUTION_ROLE_ARN: 'arn:aws:iam::000000000000:role/ape-execution' };
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail: detail || '' });

async function main() {
  // Stub APE: /discover mirrors src/server.js discover() shape; /tools is read-only.
  const stub = createServer((req, res) => {
    if (req.url === '/discover') return res.end(JSON.stringify({ protocol: '2025-06-18', server: { name: 'ape-mcp', version: '1.0.0' }, capabilities: { tools: {}, resources: {}, prompts: {} } }));
    if (req.url === '/tools') return res.end(JSON.stringify({ tools: [{ name: 'ape_agent_run' }] }));
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  const base = `http://127.0.0.1:${port}`;

  const deploy = spawnSync('node', [join(dir, 'deploy.js'), tenant, `--out=${join(dir, 'calls.json')}`], { encoding: 'utf8', env });
  check('deploy dry-run exit 0', deploy.status === 0, deploy.stderr.slice(0, 200));
  const result = JSON.parse(readFileSync(join(dir, 'calls.json'), 'utf8'));
  const seq = result.calls.map((c) => `${c.service}:${c.action}`);
  check('deploy call order', JSON.stringify(seq) === JSON.stringify(['iam:CreateRole', 'iam:PutRolePolicy', 'secretsmanager:CreateSecret', 'logs:CreateLogGroup', 'logs:PutRetentionPolicy', 'ecs:RegisterTaskDefinition', 'ecs:RunTask', 'elbv2:RoutingNotConfigured']), seq.join(','));
  check('role name scoped', result.roleName === `ape-tenant-${tenant}`, result.roleName);
  const policy = result.calls[1].policy;
  const resources = policy.Statement.flatMap((s) => s.Resource);
  check('policy has no wildcard resource', !resources.includes('*') && resources.every((r) => r.includes(tenant) || r === 'arn:aws:s3:::ape-tenants'), resources.join(','));
  check('policy has no ec2/iam actions', !JSON.stringify(policy).includes('ec2:') && !JSON.stringify(policy).includes('iam:'), '');
  check('secret value redacted in output', JSON.stringify(result).includes('<redacted>') && !JSON.stringify(result).includes('bearer_token'), '');
  check('no live flag in dry-run', result.live === false, '');

  const health = await new Promise((resolve) => {
    // Async spawn, NOT spawnSync: spawnSync blocks this process's event
    // loop, so the in-process stub server could never answer the fetch
    // and the health check timed out at 10s. That was the first failure.
    const child = spawn('node', [join(dir, 'health-check.js'), base, '--retries', '1'], { encoding: 'utf8' });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  check('health check passes against stub', health.status === 0, (health.stdout + health.stderr).slice(0, 300));

  const rb = spawnSync('node', [join(dir, 'rollback.js'), tenant, '--task-arn', 'arn:aws:ecs:us-east-1:000000000000:task/ape-test/abc', `--out=${join(dir, 'rollback-calls.json')}`], { encoding: 'utf8', env });
  const rbSeq = JSON.parse(readFileSync(join(dir, 'rollback-calls.json'), 'utf8')).calls.map((c) => `${c.service}:${c.action}`);
  check('rollback reverse order', JSON.stringify(rbSeq) === JSON.stringify(['ecs:StopTask', 'ecs:DeregisterTaskDefinition', 'secretsmanager:DeleteSecretWithRecovery', 'logs:RetainLogGroup', 'iam:DeleteRolePolicy', 'iam:DeleteRole']), rbSeq.join(','));

  // Fixture ape-mcp root: --check must prove every COPY source
  // exists (the old existence-only check hid an unbuildable image).
  const os = require('node:os');
  const fixture = require('node:fs').mkdtempSync(join(os.tmpdir(), 'ape-mcp-fixture-'));
  require('node:fs').mkdirSync(join(fixture, 'src'), { recursive: true });
  require('node:fs').mkdirSync(join(fixture, 'bin'), { recursive: true });
  require('node:fs').writeFileSync(join(fixture, 'package.json'), '{"name":"ape-mcp-fixture","version":"0.0.0"}');
  const dockerPresent = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).status === 0;
  const build = spawnSync('sh', [join(dir, 'build-image.sh'), '--check'], { encoding: 'utf8', env: { ...process.env, APE_MCP_ROOT: fixture } });
  check('build-image --check validates every COPY source against fixture root', build.status === 0, ((build.stdout || '') + (build.stderr || '')).slice(0, 200));
  const buildMissing = spawnSync('sh', [join(dir, 'build-image.sh'), '--check'], { encoding: 'utf8', env: { ...process.env, APE_MCP_ROOT: join(fixture, 'nope') } });
  check('build-image --check fails when a COPY source is missing', buildMissing.status !== 0, '');
  require('node:fs').rmSync(fixture, { recursive: true, force: true });

  stub.close();
  const report = { tenant, stubBase: base, deployCalls: seq, rollbackCalls: rbSeq, healthStdout: health.stdout.trim(), checks, allPass: checks.every((c) => c.ok) };
  writeFileSync(join(dir, 'dry-run-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.allPass ? 0 : 1);
}
main();
