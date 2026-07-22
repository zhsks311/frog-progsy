# Runtime SOT

## Entrypoints

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | `frogp` / `frogprogsy` CLI: init, start, stop, restore, refresh, status, models, `claude`, login/logout, gui, update, version, help, uninstall. Unknown commands and help topics get a closest-match suggestion. Owns human and JSON status/models rendering: `status --json` exposes a stable snapshot schema (fixed normalized `watchdog` fields only) and `models [--json]` is an online-only view over the existing `GET /api/models` (no offline synthesis, no new server API). JSON modes print exactly one JSON document to stdout with diagnostics on stderr. |
| `src/server.ts` | Bun server for Claude-facing `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /v1/models`, static GUI, and `/api/*` management endpoints. The old OpenAI Responses inbound path returns `410`. |
| `src/cli-suggest.ts` | Side-effect-free typo suggestion helper (edit distance ≤ 2, order-stable ties) shared by command and `login` provider suggestions. |
| `src/cli-color.ts` | Dependency-free minimal ANSI palette for human output only: `NO_COLOR` always wins, non-TTY disables by default, `FORCE_COLOR=1` forces on; JSON output never uses it. |
| `src/init.ts` | Interactive setup wizard. Provider menu derives from `src/providers/registry.ts` via `src/providers/derive.ts`, but the default provider is the explicit `DEFAULT_INIT_PROVIDER_ID` constant (not registry order). Invalid input reprompts; the wizard is all-or-nothing — `saveConfig` runs only after every answer is validated, and EOF/aborts write nothing. |
| `src/config.ts` | `~/.frogprogsy/config.json`, defaults, PID path, env-value resolution, `websocketsEnabled()`. |
| `src/router.ts` | Provider/model selection before adapter dispatch. |
| `src/types.ts` | Shared config, parsed request, adapter, and event types. |
| `src/reasoning-effort.ts` | Claude Code reasoning-level definitions (`low`/`medium`/`high`/`xhigh`), per-model effort mapping, and catalog effort sanitization. |

## Lifecycle

`frogp start` refuses a duplicate PID, starts the proxy, writes `~/.frogprogsy/frogp.pid`,
arms the default-on watchdog unless supervision is externally owned, injects settings and refreshes
models/cache for every configured Claude Code home, then serves until shutdown. Normal foreground shutdown
restores native Claude Code for configured homes.
`FROGP_EXTERNAL_SUPERVISOR=1` means Docker/systemd/Kubernetes already owns restart behavior, so
frogp skips its watchdog and avoids repeated restore/reinject churn across supervised restarts.

The bridge enforces a heartbeat stall deadline: after 5 minutes (150 ticks at the default 2 s
interval) of upstream silence with no real events, the stream is closed and the upstream request
cancelled. If the adapter generator ends without an explicit done/error event, the response is marked
`incomplete` rather than `completed` so Claude Code can distinguish a clean finish from a truncated stream.

The server exposes `POST /api/stop` which writes shutdown intent, restores every configured Claude Code home,
and exits the process. The GUI sidebar stop button calls this endpoint.

## Providers and adapters

| Path | Responsibility |
| --- | --- |
| `src/providers/registry.ts` | Canonical provider presets for CLI, dashboard, OAuth, key providers, and metadata. |
| `src/providers/derive.ts` | Enrichment from provider presets into user config. |
| `src/oauth/` | Non-Anthropic OAuth providers, token storage, refresh, and auth-token resolution. Claude subscription auth remains pass-through through Claude Code homes. |
| `src/adapters/openai-responses.ts` | OpenAI/ChatGPT Responses upstream adapter. |
| `src/adapters/openai-chat.ts` | OpenAI-compatible Chat Completions bridge. |
| `src/adapters/anthropic.ts` | Anthropic Messages bridge. |
| `src/adapters/google.ts` | Gemini bridge. |
| `src/adapters/azure.ts` | Azure OpenAI bridge. |

Adapter output must stay in internal `AdapterEvent` form until `messages/bridge.ts` converts it back to
Anthropic Messages SSE for Claude Code.
