# frogprogsy Structure

This folder is the maintainer source of truth for the current system shape. Public user workflows
belong in `docs-site/`; historical investigations belong in `docs/`.

## Reading order

| File | Purpose |
| --- | --- |
| [`00_overview.md`](00_overview.md) | Product boundary, local state, and non-negotiable invariants. |
| [`01_runtime.md`](01_runtime.md) | Process lifecycle, CLI, server endpoints, config, providers, adapters. |
| [`02_config-and-claude-home.md`](02_config-and-claude-home.md) | Claude Code home resolution, config injection, profile files, restore rules. |
| [`03_catalog-and-subagents.md`](03_catalog-and-subagents.md) | Shared Claude Code catalog, Claude Code App picker, subagent ordering. |
| [`04_transports-and-sidecars.md`](04_transports-and-sidecars.md) | Responses HTTP/SSE, WebSocket opt-in, sidecars, compatibility guards. |
| [`05_gui-and-management-api.md`](05_gui-and-management-api.md) | Dashboard serving and `/api/*` management surface. |
| [`06_docs-and-release.md`](06_docs-and-release.md) | Public docs site, GitHub Pages, README ownership, release flow. |
| [`07_classifier-routing.md`](07_classifier-routing.md) | Auto-mode classifier model selection, routing precedence, config, API, GUI. |
| [`08_model-mixing.md`](08_model-mixing.md) | Model mixing (fusion/pipeline/rules) alias, config, modules, streaming contract. |
| [`09_claude-dual-auth.md`](09_claude-dual-auth.md) | Isolated Claude grants, central auth resolution, dual-auth failure boundaries, and probe decision record. |

## Product boundary

frogprogsy is a local Claude Messages gateway for Claude Code. It does not patch Claude Code binaries. It
changes local Claude Code state by injecting `settings.json` gateway-discovery env, then serves:

```text
Claude Code CLI / TUI / App / SDK
  -> http://localhost:<port>/v1/messages
  -> http://localhost:<port>/v1/messages/count_tokens
  -> frogprogsy routing + adapter bridge
  -> upstream provider
```

The default install uses the Anthropic Claude forward-auth provider, so Claude Code or gateway
credentials can be forwarded without storing a proxy API key. Additional providers are routed by
explicit `provider/model`, provider model lists, or the configured `defaultProvider`.

## Local state

| Path | Owner | Notes |
| --- | --- | --- |
| `~/.frogprogsy/config.json` | frogprogsy | Main config written by `frogp init` and the dashboard. |
| `~/.frogprogsy/auth.json` | frogprogsy | OAuth tokens; not committed. |
| `~/.frogprogsy/claude-profiles/<cp_id>/claude-settings-backup.json` | frogprogsy | Per-home `settings.json` backup for restore. |
| `~/.frogprogsy/claude-grants/<cg_id>/.frogprogsy-grant.json` | frogprogsy | Non-secret isolated-grant metadata marker; credentials are never embedded here. |
| scoped Keychain service or `<grant-dir>/.credentials.json` | frogprogsy grant broker | One credential origin per grant; never the global Claude service or a native `~/.claude*` home. |
| `<profile-home>/settings.json` | Claude Code, edited by frogprogsy | Injected `ANTHROPIC_BASE_URL`, gateway discovery, and optional `X-Frogp-Claude-Profile` header. |
| `<profile-home>/models_cache.json` | Claude Code, invalidated by frogprogsy | Cache invalidated after model/discovery changes for that Claude Code home. |
| `dist/`, `gui/dist/`, `node_modules/` | generated | Build output/dependencies. |

## Non-negotiable invariants

- `websockets` defaults to `false`; Claude Code gateway discovery uses HTTP Messages endpoints.
- Explicit Claude Code home wins first; otherwise `CLAUDE_CONFIG_DIR`, then `CLAUDE_HOME`, then `~/.claude`.
- `settings.json` injection must preserve unrelated user env/header settings and keep a restorable backup.
- Routed model slugs use `provider/model`.
- Claude Code `spawn_agent` visibility depends on the first five featured catalog entries.
- `frogp stop`, `frogp restore`, and service stop/uninstall must leave native Claude Code usable.
- The auto-mode classifier (Haiku-class ids) routes to a configured lightweight model; an unconfigured request falls back to `defaultModel` with a loud warning, never a silent heavy judge.
- Provider request authentication funnels through `resolveProviderAuth`; `forward` clears stored keys, and `claude-grant` is accepted only for the official Anthropic API endpoint.
- Isolated grants are opt-in and separate from native Claude homes. Deletion must remove the exact scoped credential before deleting its in-root directory and config record.

## Writing rule

Keep this directory flat. Add or extend lexicographically ordered `NN_topic.md` files; do not add
subdirectories. If one file grows too broad, split the next stable topic into the next unused number
instead of creating nested folders.
