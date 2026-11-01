// Propose–Probe–Compose (task-level recursion, adapted from
// google-research/harness2, Apache 2.0): propose small harness
// variants, probe each on the SAME task hermetically, compose the
// best. No ground truth is used: scoring is behavioral contrast
// (completed? fewer steps? lower cost? no budget halt?).
//
// Locked surfaces a variant may NEVER touch (rejected, not scored):
// Sigil policy/gate settings, budget ceilings above the base
// profile's caps, stop conditions, and the eval scorer. Variants may
// only: append tool-guidance text to the system prompt, narrow
// max_steps within the base cap, and reorder profile tools.
import { runAgent } from './loop.js';
import { harnessManifest } from './harness-manifest.js';

const LOCKED_KEYS = ['policy', 'stop_conditions', 'sigilIndexDir', 'sigil_index_dir'];

export function proposeVariants(profile) {
  const base = structuredClone(profile);
  const variants = [{ id: 'base', profile: base, edits: [] }];
  const guided = structuredClone(profile);
  guided.system = (guided.system ?? '') +
    '\nTool guidance: prefer the fewest tool calls that verify the outcome. Finish explicitly when done.';
  variants.push({ id: 'guided', profile: guided, edits: ['tool_guidance+finish-early'] });
  const capped = structuredClone(profile);
  const cap = Math.max(3, Math.floor((profile.limits?.max_steps ?? 20) / 2));
  capped.limits = { ...capped.limits, max_steps: Math.min(cap, profile.limits?.max_steps ?? cap) };
  variants.push({ id: 'lean-steps', profile: capped, edits: [`max_steps<=${capped.limits.max_steps}`] });
  return variants;
}

export function assertVariantLocked(base, variant) {
  for (const k of LOCKED_KEYS) {
    if (JSON.stringify(variant[k] ?? null) !== JSON.stringify(base[k] ?? null)) {
      throw new Error(`variant touches locked surface: ${k}`);
    }
  }
  if ((variant.limits?.max_usd ?? 0) > (base.limits?.max_usd ?? 0) ||
      (variant.limits?.max_tokens ?? 0) > (base.limits?.max_tokens ?? 0) ||
      (variant.limits?.max_steps ?? 0) > (base.limits?.max_steps ?? 0)) {
    throw new Error('variant raises a budget ceiling (locked)');
  }
  return true;
}

function probeScore(result) {
  // Behavioral contrast only: completion first, then efficiency.
  const completed = result.stop_reason === 'explicit_final_answer' ? 1 : 0;
  return {
    completed,
    steps: result.step_count ?? 0,
    cost: result.total_cost ?? 0,
    unverified: result.unverified ?? 0,
  };
}

export async function proposeProbeCompose({ profile, objective, mockScript }) {
  const variants = proposeVariants(profile);
  const probes = [];
  for (const v of variants) {
    assertVariantLocked(profile, v.profile);
    const result = await runAgent({ profile: v.profile, objective, mockScript });
    probes.push({
      id: v.id, edits: v.edits,
      harness_hash: harnessManifest(v.profile).hash,
      score: probeScore(result),
      stop_reason: result.stop_reason,
    });
  }
  const ranked = [...probes].sort((a, b) =>
    b.score.completed - a.score.completed ||
    a.score.unverified - b.score.unverified ||
    a.score.steps - b.score.steps ||
    a.score.cost - b.score.cost);
  const winner = ranked[0];
  return {
    winner: winner.id,
    edits: winner.edits,
    harness_hash: winner.harness_hash,
    probes,
    note: 'Composed from behavioral contrast on this task only. Promoting the winner into a profile is a human PR decision; nothing here self-modifies the shipped harness.',
  };
}
