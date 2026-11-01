import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.APE_ALLOW_MOCK_INPUT ??= '1';
process.env.APE_MAX_DAILY_USD ??= '1000000';

const { harnessManifest } = await import('../src/agent/harness-manifest.js');
const { reflectLesson, appendLesson, loadLessons, frameLessons } = await import('../src/agent/lessons.js');
const { proposeVariants, assertVariantLocked, proposeProbeCompose } = await import('../src/agent/probe.js');

const profile = {
  name: 'probe-profile',
  model: { provider: 'mock', id: 'mock-model' },
  system: 'Be careful.',
  tools: [{ builtin: 'memory.recall' }, { builtin: 'finish' }],
  limits: { max_steps: 20, max_tokens: 100000, max_wall_seconds: 60, max_usd: 1.0 },
  stop_conditions: ['explicit_final_answer'],
  policy: { sigil: 'proposed' },
};

test('manifest: eight components, stable hash, changes with system prompt', () => {
  const a = harnessManifest(profile);
  assert.deepEqual(Object.keys(a.components).sort(),
    ['guardrails', 'memory', 'plugins', 'scripts', 'skills', 'subagents', 'system_prompt', 'tool_guidance']);
  assert.equal(a.hash, harnessManifest(profile).hash);
  assert.notEqual(a.hash, harnessManifest({ ...profile, system: 'Different.' }).hash);
});

test('lessons: failure distilled, appended, loaded per profile, framed untrusted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ape-lessons-'));
  const file = join(dir, 'lessons.jsonl');
  try {
    const lesson = reflectLesson({ profile: 'probe-profile', stop_reason: 'max_steps', unverified: 1, step_count: 3, total_cost: 0, harness_hash: 'abc', receipt: { delegations: [], repairs: [] } });
    assert.ok(lesson);
    assert.equal(reflectLesson({ profile: 'probe-profile', stop_reason: 'explicit_final_answer', unverified: 0 }), null);
    appendLesson(lesson, file);
    const loaded = loadLessons('probe-profile', 5, file);
    assert.equal(loaded.length, 1);
    assert.match(frameLessons(loaded), /untrusted/);
    assert.equal(loadLessons('other-profile', 5, file).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('probe: locked surfaces rejected, variants stay within caps', () => {
  const [base, guided] = proposeVariants(profile);
  assertVariantLocked(profile, guided.profile);
  assert.throws(() => assertVariantLocked(profile, { ...profile, policy: {} }), /locked surface/);
  assert.throws(() => assertVariantLocked(profile, { ...profile, limits: { ...profile.limits, max_usd: 99 } }), /budget ceiling/);
  assert.equal(base.id, 'base');
});

test('propose-probe-compose: hermetic run composes a winner with provenance', async () => {
  const out = await proposeProbeCompose({
    profile,
    objective: 'Recall then finish.',
    mockScript: [
      { tool: 'memory.recall', args: { query: 'x' } },
      { tool: 'finish', args: { summary: 'done' } },
    ],
  });
  assert.ok(out.winner);
  assert.equal(out.probes.length, 3);
  assert.ok(out.probes.every((p) => p.harness_hash));
  assert.match(out.note, /human PR decision/);
});

test('probe locks: removed ceilings and live/engine profiles are rejected', async () => {
  const { assertVariantLocked: avl, assertHermetic } = await import('../src/agent/probe.js');
  assert.throws(() => avl(profile, { ...profile, limits: {} }), /removes budget ceiling/);
  assert.throws(() => avl(profile, { ...profile, limits: { ...profile.limits, max_wall_seconds: 999 } }), /budget ceiling/);
  assert.throws(() => assertHermetic({ ...profile, model: { provider: 'meta', id: 'x' } }), /mock provider/);
  assert.throws(() => assertHermetic({ ...profile, tools: [{ engine: 'skein.orchestrate' }] }), /builtin tools/);
});

test('lessons: unreadable storage means no lessons, never a failed run', async () => {
  const { loadLessons: ll } = await import('../src/agent/lessons.js');
  assert.deepEqual(ll('probe-profile', 5, '/nonexistent-dir-xyz/lessons.jsonl'), []);
});
