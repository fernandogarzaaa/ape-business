// Harness manifest (adapted from google-research/harness2, Apache 2.0):
// the eight editable components around the model, inventoried for one
// profile and hashed, so every run receipt records exactly which
// harness produced it (provenance). Components:
//   system prompt, guardrails, memory, tool guidance, subagents,
//   skills, scripts, plugins.
// Locked surfaces are NOT components and never appear as editable
// here: the Sigil policy, budget ceilings, and the eval scorer.
import { createHash } from 'node:crypto';

function sha(v) {
  return createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 16);
}

export function harnessManifest(profile) {
  const components = {
    system_prompt: { hash: sha(profile.system ?? '') },
    guardrails: {
      hash: sha(profile.policy ?? {}),
      stop_conditions: profile.stop_conditions ?? [],
    },
    memory: {
      builtins: (profile.tools ?? []).filter((t) => String(t.builtin ?? '').startsWith('memory.')).map((t) => t.builtin),
    },
    tool_guidance: { hash: sha((profile.tools ?? []).map((t) => t.engine ?? t.builtin ?? '')) },
    subagents: {
      max_delegate_depth: profile.limits?.max_delegate_depth ?? 2,
      delegation: (profile.tools ?? []).some((t) => t.engine === 'delegate' || t.builtin === 'delegate'),
    },
    skills: { profile: profile.name },
    scripts: { engines: (profile.tools ?? []).map((t) => t.engine).filter(Boolean) },
    plugins: { hash: sha(profile.mods ?? profile.plugins ?? []) },
  };
  const hash = createHash('sha256').update(JSON.stringify(components)).digest('hex').slice(0, 16);
  return { version: 'ape-harness/v1', profile: profile.name, components, hash };
}
