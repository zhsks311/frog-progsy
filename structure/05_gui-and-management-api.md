# GUI And Management API SOT

## Dashboard serving

The bundled React dashboard is built into `gui/dist` and served by the same Bun proxy. `frogp gui`
starts the proxy when needed and opens `http://localhost:<port>`.

## API ownership

Management endpoints live in `src/server.ts` under `/api/*`:

| Endpoint area | Responsibility |
| --- | --- |
| Config | Read/write `~/.frogprogsy/config.json`; mask secrets on read. |
| Providers | Create/update/delete provider configs and enrich registry metadata. The AI Accounts page is the owner for provider rows: API-key providers store proxy credentials, OAuth providers store/refresh proxy-owned OAuth credentials, and Anthropic Claude rows default to `authMode:"forward"` so frogprogsy stores no Claude subscription token. An Anthropic row may instead opt into `authMode:"claude-grant"` with a known isolated `claudeGrantId`; this is accepted only for the official Anthropic API endpoint. Deleting an OAuth provider also removes its stored OAuth credential so it cannot reappear as a dangling login. |
| Models | Fetch home-aware routed model lists, disabled/allowed visibility, and catalog-facing ids. `fetchProviderModels` resolves key/OAuth/grant auth through `resolveProviderAuth`; a missing grant credential fails closed and leaves configured model metadata visible without attempting unauthenticated discovery. |
| OAuth | Login/status/logout for OAuth-backed providers (`codex`, `xai`, `kimi`); login completion and logout both refresh the readiness-filtered routed catalog/cache. A dashboard login click explicitly replaces an unfinished attempt, aborts its poller, and returns a fresh auth URL/device code; an abandoned in-memory flow also expires after the dashboard's five-minute polling window. Codex device-code creation retries transient network failures three times but does not retry rejected 4xx requests. Native Anthropic subscription login is intentionally absent from this OAuth store. A dedicated Claude grant is a separate opt-in credential family owned by the grant broker, not an OAuth-provider row. |
| Key providers | Expose API-key provider presets for setup and dashboard flows, including Anthropic-compatible API-key services that are not Claude subscription accounts. |
| Fallback settings | Expose/update web-search and image fallback helpers; provider lists are feature-specific and include eligible OpenAI Responses forward, OAuth, and key-backed providers. |
| Model Mixing | Expose/update `config.modelMixing`, server-owned presets/evidence, catalog alias status, and read-only call-plan previews. The provider roster is the configured provider table; Anthropic appears only after an Anthropic provider row exists. |
| Subagents | Read/write the ordered featured `subagentModels` list (unbounded; catalog priority follows the order). |
| Claude Code homes/projects | `GET/POST/PATCH/DELETE /api/claude-profiles` plus per-home `inject`, `refresh`, and `restore`; stores stable ids, target homes, and auth-state/last-seen fields. `GET` reports each home's active carrier (`token-free` or `sentinel`) and gateway readiness. Token-free is the default: managed home and project settings write the base URL + discovery flag without a synthetic auth token. `POST .../inject|refresh` accepts `{globalDiscoveryAuth:true}` only as a per-invocation sentinel rollback; `gatewayAuthCarrier:"sentinel"` is the durable config rollback and may disable claude.ai connectors. Project enrollment endpoints are `GET /api/claude-projects?root=<path>`, `POST /api/claude-projects` with `{root,routingProfileId?}`, `POST /api/claude-projects/:id/restore`, and `DELETE /api/claude-projects/:id`. They manage `<project>/.claude/settings.local.json`, including git protection/status (`tracked`, `ignored`, `excluded`, `untracked`, `not_git`, `unwritable`), settings path, carrier, gateway/model-discovery readiness/effective source, and optional routing profile id. The dashboard label says "Claude Code homes" for config/account directories and "project-local enrollment" for project settings; neither is an AI provider account selector. User-facing status must describe modes such as "frogprogsy gateway", "Claude direct", or "tracked by git — blocked" instead of raw implementation flags such as `injected:false`. |
| Claude grants (dual-auth) | `GET/POST/DELETE /api/claude-grants` plus `POST /api/claude-grants/:id/probe` (selected Branch B; see `structure/09_claude-dual-auth.md`). Owns isolated `claude-grant` records and scoped credentials. Provider create/update accepts `{authMode:"claude-grant", claudeGrantId}` only for a known grant and the official Anthropic API endpoint. List/probe payloads expose readiness and redacted diagnostics only; no token, credential JSON, native-home path, or user identity. |
| Logs | Surface request/runtime logs for local diagnosis. |
| Stop | `POST /api/stop` — restore native Claude Code, stop any installed service, and exit the proxy. |

Provider writes must not round-trip masked API keys as real secrets. Dashboard actions that change
model visibility or subagent selection should trigger catalog/cache sync behavior through the server
path that owns it.

All management mutations are local-origin guarded by method (`GET`/`HEAD`/`OPTIONS` are read-only; `POST`,
`PUT`, `PATCH`, and `DELETE` require a local origin). The Claude Code Homes page is the dashboard owner for
home CRUD, per-home model preview, and status/auth-state. Model visibility and featured subagent order live
on the Models page as global settings.

### Model Picker page contract

The Models page reads `/api/models` rows (`provider`, `id`, `namespaced`, `disabled`, optional `authReady`) plus
featured subagent order. It may derive compact provider summaries such as enabled vs hidden counts, but it must not
infer launcher/process state from model publication alone. `disabled` rows are intentionally hidden by user policy.
Rows with `authReady:false` stay visible in the management registry with redacted `frogp login <provider>` guidance,
but are excluded from picker/export surfaces until their credential is resolvable.

Launcher, process, cmux, raw `PATH`, real Claude target, and stale already-open `/model` screen diagnosis
belongs to the deterministic `frogp doctor claude` command. GUI/server diagnostics must source-label claims
so a healthy provider publication with a launcher/PATH/session mismatch is reported as a launcher/process/session
issue, not as a gateway publishing failure.

### Auth-ready model visibility (readiness-filtered picker vs full management registry)

Model visibility is split by auth readiness so the Claude Code `/model` picker never disagrees with the gateway
export while the dashboard keeps the full configured registry (implemented token-free carrier; gate evidence in
`structure/09_claude-dual-auth.md`):

- Picker/export surfaces are readiness-filtered. The gateway cache (`cache/gateway-models.json`), the
  `/v1/models?client_version` proxy branch, and injected on-disk catalog entries export a routed alias ONLY
  while its provider is authReady (OAuth credential present / key/grant resolvable). Native Claude built-ins are
  always shown, untouched. A logged-out Codex provider is therefore ABSENT from the cache, the `?client_version`
  list, and the `/model` picker; it reappears on the next refresh after login. No placeholder or
  "(login required)" rows appear in the picker.
- The management registry keeps everything. `/api/models`, Model Mixing, doctor, and the GUI show the full
  configured registry: an OAuth/key/grant provider with no resolvable credential still returns its CONFIGURED models
  tagged `authReady:false` with redacted login/repair guidance, rather than an empty list. Auth state never erases
  provider config, so logged-out Codex stays manageable/re-loginable in the dashboard even while hidden from the
  picker.
- No token crossover. Readiness filtering changes visibility only; it never reuses one provider's credential for
  another. A grant/OAuth token attaches solely to its bound provider (codex/xai/kimi and the openai-responses
  fallback never receive Anthropic tokens and vice versa), and token evidence stays redacted to sha256[:8]+length
  everywhere.
- Native connector preservation. The default carrier is token-free (no injected
  `ANTHROPIC_AUTH_TOKEN`), so a managed launch keeps the native subscription bearer and
  claude.ai connectors remain eligible; the sentinel carrier that can disable connectors is the explicit
  rollback override. This implemented carrier is backed by runtime probe evidence
  (`structure/09_claude-dual-auth.md`); readiness filtering is independent of the carrier choice
  (see `structure/02_config-and-claude-home.md`).
- Fail-closed request path. A stale cache alias or a manually typed alias for a logged-out OAuth provider still
  fails closed at request time with a typed `401 oauth_missing` (message redacted); visibility filtering does not
  substitute a credential.

Refresh timing: the picker/cache readiness state is recomputed on catalog sync, profile refresh, immediately
before every managed launch, and on OAuth login/logout transitions — login-complete refresh is unconditional
(including re-login of an already-configured provider) and logout refresh is explicit.

### AI Accounts vs Claude Code homes

AI Accounts answer "which upstream can frogprogsy route to?" Claude Code homes answer "which Claude Code config
directory supplies Anthropic subscription auth and receives settings/cache injection?" An Anthropic Claude provider
row is still required for Anthropic models to appear in Model Picker or Model Mixing, but in forward mode the row
does not hold a Claude token. The token comes from the selected Claude Code home at request time.

Project-local enrollment answers "should ordinary `claude` launched from this repository use frogprogsy settings?"
It does not answer "which Claude account/home is active?" The API may accept an optional routing profile id to bind
gateway routing metadata, but UI copy must say the enrollment uses the currently effective Claude Code home and does
not choose `~/.claude`, `~/.claude-personal`, `~/.claude-work`, `CLAUDE_CONFIG_DIR`, or a login. If the saved routing
profile becomes dangling, diagnostics must surface a re-enroll/use-effective-home hint instead of silently falling
back with an account-selection claim.

### Claude grants (dual-auth)

Dual-auth (Claude subscription + Codex OAuth in one session) ships as an explicit hybrid: token-free native
passthrough for interactive managed Claude Code sessions, and the selected Branch-B isolated grant path for
headless/server work without an incoming native bearer. The management surface is readiness-first and
documented in `structure/09_claude-dual-auth.md`. The isolated grant core (`src/claude-grants.ts`,
`src/claude-grant-auth.ts`, `authMode:"claude-grant"`) and its API/CLI/doctor/GUI wiring remain implemented
under the unchanged Branch-B custody contract.

- API: `GET /api/claude-grants` lists redacted live scoped-store state; `POST /api/claude-grants`
  resolves and rejects an unsafe/missing real Claude executable before creating a record, then returns a
  human-run login command; `DELETE /api/claude-grants/:id` preflights the exact marker/path, deletes the scoped
  credential, then removes the directory and record. A cleanup failure leaves the grant intact. `POST
  /api/claude-grants/:id/probe` is tiered: tier 1 is local/read-only; tier 2 requires explicit confirmation and
  targets only the bound official Anthropic provider. Provider writes accept `{authMode:"claude-grant",
  claudeGrantId}` only for a known id and reject every non-official target.
- GUI: a Claude Grants card shows per-grant readiness (`ok`, `expiring`, `reauth required`, `unreadable`,
  `none`) with Set up (guided real-executable `CLAUDE_CONFIG_DIR=… claude auth login --claudeai`), Re-auth
  guide, and Remove. Remove warns when a provider still binds the grant and deletion intentionally leaves that
  binding dangling; it is never auto-rebound. The Providers page adds an Anthropic auth-mode selector
  `Forward (default) / API key / Claude grant` and rejects a new unknown grant binding before save. Forward
  copy stays explicit that frogprogsy stores no Claude token.
- Advanced diagnostics (credential source, last refresh actor, store sha256[:8]+length) live behind a
  disclosure and `frogp doctor claude`; readiness and binding lead the UI.
- Grant record creation itself performs no authenticated network call and launches nothing. The user runs the
  printed real-executable login command. Any tier-2 probe that sends subscription auth requires explicit
  confirmation carrying the ToS/quota/account-risk disclosure; tier 1 never reads token bytes or uses network.
- Anthropic API-key providers remain the explicit alternative for headless/API callers and for anyone who
  does not want subscription custody.

### Model Mixing endpoints

Model Mixing has its own endpoint area and must stay separate from classifier settings:

- `GET /api/model-mixing-settings` returns `{modelMixing,providers,catalogAlias,presets,evidence}`. The
  provider roster is feature-specific and comes from all configured providers; each provider option includes
  `{name,defaultModel,models,authMode,adapter}`. `catalogAlias` reports the current alias id, namespace split,
  exposure, exact-id hidden state, and `hiddenPolicy:"alias-id-specific"`.
- `PUT /api/model-mixing-settings` accepts `{modelMixing:{...partial}}` and uses PATCH-style preservation:
  omitted fields survive, nested plain objects merge, arrays replace only when present, warnings are
  returned for semantic/config issues, and only malformed JSON returns `400`.
- `GET /api/model-mixing/call-plan` returns the current `computeCallPlan(config)` result. A
  `draft=<urlencoded JSON>` query parameter previews a non-persistent raw `modelMixing` patch; malformed
  draft JSON returns `400`, while semantic draft problems return warnings.
- The settings response carries the three server presets `low`, `balanced`, and `research`; `research`
  matches the `f3-codex` profile except it does not set `enabled` or `aliasId`.

## Sidebar stop button

The dashboard sidebar includes a stop button that calls `POST /api/stop`. The button shows a
confirmation prompt, then fires the request and accepts the connection drop (the proxy exits). The
endpoint restores native Claude Code config, stops any installed service to prevent respawn, and exits.

## UX boundary

The dashboard is a local control surface, not a separate service. It should reflect the same config
and catalog invariants documented in this folder rather than inventing parallel state.

## Model Mixing page contract

The dashboard contract for Model Mixing is a dedicated page, not a Dashboard card and not part of the
auto-mode classifier page. Classifier controls and copy remain under the classifier feature; Model Mixing
copy and controls describe a quality/cost fan-out feature.

The page should read and write through `/api/model-mixing-settings` and preview cost through
`/api/model-mixing/call-plan`. It must not keep a parallel dashboard-owned model-mixing state that can
drift from `config.modelMixing`, the provider catalog, or the routed model visibility rules.

Alias visibility is displayed as status only: enabled/namespaced/exposed/hidden for the current
`catalogAlias`. The Model Picker remains the authority for hide/show via `disabledModels`; the Model
Mixing page must not duplicate those controls. Hidden state is alias-id-specific and is not migrated when
`aliasId` changes, so the page should explain that a newly configured alias may appear until hidden in
Model Picker.

Model selection controls use the provider/model catalog from the settings response. Configured unknown
values remain displayable because the API persists unknown model strings with warnings. A future compact
Dashboard status card may link to the dedicated page, but the Dashboard must not maintain separate
enabled/alias/preset/call-plan state.
