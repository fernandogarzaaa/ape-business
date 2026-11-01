# Mods

Mods are the code-level extension seam: they run `preCall`/`postCall` hooks around every
tool call and are the only place user-supplied JavaScript runs. They sit inside APE's
trust boundary and are throw-safe — a broken mod is skipped, never crashes core.

## Anatomy

`mods/<name>/mod.json`:

```json
{ "name": "policy-gates", "version": "1.0.0", "enabled": true, "description": "..." }
```

`mods/<name>/hooks.js`:

```js
export const preCall = async (name, args, ctx) => { ... return args; };
export const postCall = async (name, args, result, ctx) => { ... return result; };
```

`preCall` may mutate args (return the new args or `undefined` to keep them).
`postCall` may mutate the result. Throwing inside a hook logs and is skipped.

## Enabling

- Bundled mod: listed in `mods/` and always considered unless disabled in its `mod.json`.
- Additional mods: add the directory to `mods:` in `ape.config.yaml`:

```yaml
mods: ["./mods/policy-gates", "./mods/my-gate"]
```

Toggle at runtime by flipping `"enabled": false` in `mod.json` — no restart.

## Bundled: `policy-gates`

Confirms destructive operations (MRTR-style `input_required`):

- `ape_evolve` accept/apply without explicit confirm.
- `ape_orchestrate` release with `force: true`.

## Trust boundary

Mods run inside the server process with full file/network access. Treat a mod as you
would any code you `npm install`. For declarative-only external reach, use connectors —
they run sandboxed by egress allowlists and auth-by-env.