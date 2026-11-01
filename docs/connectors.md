# Connectors

How you give the agent reach into third-party services without APE shipping a wrapper
per service. Connectors are **declarative only** — no user-supplied JavaScript (that is
what mods are for). Loaded at call time; add one with no restart, no rebuild.

## Anatomy

`.ape/connectors/<name>.yaml`:

```yaml
name: github_issues
base_url: https://api.github.com
auth:
  type: bearer
  token_env: GITHUB_TOKEN        # name only, never the value
egress_allow: [api.github.com]   # enforced at request time
operations:
  - name: list_issues
    method: GET
    path: /repos/{owner}/{repo}/issues
    query:                        # optional: const / from / default
      per_page: { from: per_page, default: 30 }
    input_schema:
      type: object
      required: [owner, repo]
      properties:
        owner: { type: string }
        repo:  { type: string }
    annotations: { readOnly: true, idempotent: true }
  - name: comment
    method: POST
    path: /repos/{owner}/{repo}/issues/{number}/comments
    body:
      body: { from: message }
    input_schema: { type: object }
    annotations: { readOnly: false, destructive: true }
```

## Rules

- **Declarative only.** Path params come from `{name}` placeholders; query params and
  bodies from `query:`/`body:` maps (`const`, `from: <inputKey>`, `default`).
- **`egress_allow` is mandatory and enforced.** Requests to a host outside it are
  refused with `egress_denied` and traced. `ape-mcp doctor` prints every allowed host.
- **Auth by env reference.** `auth.token_env` names an environment variable; the value
  is never read from the YAML. Missing token → `connector_auth_missing` (honest error).
- **Destructive ops inherit the MRTR confirm gate.** Calling a destructive operation
  from a host requires explicit `confirm: true`; an agent calling one gets an
  `input_required` result telling it to ask the user.

## Bundled flagship: `web`

The `web` connector (ships in `connectors/web.yaml`) reads the public Wikipedia API —
**no API key required** — and is what the `research-verify` profile uses:

```yaml
tools:
  - connector: web
```

The agent can `search`, `page`, and `summary` against `en.wikipedia.org` (the only
allowed host).

## Listing and calling

- `ape_connector_list` — loaded connectors, operations, egress hosts.
- `ape_connector_call {connector, operation, input, confirm?}` — call one operation.

User-authored connectors live in `.ape/connectors/`; bundled ones in `connectors/`.