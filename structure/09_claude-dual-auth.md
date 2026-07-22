# Claude Dual-Auth SOT (Token-Free Interactive + Branch-B Grants)

Maintainer source of truth for using the user's Claude subscription and Codex OAuth in one enrolled Claude
Code session, including `frogp/mix` fused sub-calls. It records the initial Branch-B selection, the later
probe-approved token-free interactive carrier, and the invariants a maintainer must verify against code and tests.
Related surfaces: `structure/02_config-and-claude-home.md` (grant ownership/homes),
`structure/05_gui-and-management-api.md` (API/GUI), `structure/08_model-mixing.md` (roster semantics).

Status: the isolated grant core is implemented — `src/claude-grants.ts` (metadata + path safety),
`src/claude-grant-auth.ts` (scoped-credential broker), `authMode:"claude-grant"`/`claudeGrantId` and
`ClaudeGrantRecord` in `src/types.ts`, and `claude-grant` wire equivalence in `src/adapters/anthropic.ts`.
The central `resolveProviderAuth` seam wiring, `/api/claude-grants`, CLI, `frogp doctor claude`, and the GUI
cards are the selected product contract, built on the `feature/claude-dual-auth` worktree. This document
does not claim more than the code proves; where a surface is a contract it says so.

## Initial decision: A failed, B passed, ship B

The auth strategy was a probe-gated three-branch tree (A no-custody header, B isolated grant, C stop). The
contract is deterministic:

| Probe-A | Probe-B | Action |
|---|---|---|
| PASS | not run | Ship A only. |
| FAIL | PASS | **Ship B only** — no Option-A enrollment/header code ships; enrollment behavior is unchanged. |
| FAIL | FAIL | C-STOP — nothing merged to main; redacted probe artifacts + failure report only. |

Recorded initial outcome: Probe-A FAIL, Probe-B PASS (with required human remediation), so Branch B was selected
(`artifacts/claude-dual-auth/probe-b-2026-07-14.json`). At that point frogprogsy shipped no Option-A no-custody
discovery-header enrollment. The 2026-07-20 amendment below later added a separately probed token-free +
prewritten-cache interactive path without weakening Branch B: isolated grants remain the explicit path for
headless/server callers, and Anthropic API-key providers remain an alternative.

## Probe evidence and exact limits

Probe-A (`artifacts/claude-dual-auth/probe-a-2026-07-14.json`), Claude Code 2.1.207, real claude.ai session,
loopback mock gateway:

- Every tested no-custody carrier failed the joint requirement. The custom-header and custom-header +
  sentinel `x-api-key` variants preserved the native OAuth `Authorization` Bearer but did not trigger gateway
  `/v1/models` discovery (gateway model not visible). The `ANTHROPIC_API_KEY`-env variant did trigger
  discovery but dropped the native OAuth Bearer (`failed-native-oauth-preservation`).
- Verdict: no tested carrier simultaneously enabled gateway `/v1/models` discovery and preserved the native
  Claude OAuth `Authorization` header, so Probe-A FAIL.
- Native store integrity: before/after equal across the known native homes (sha256[:8]+length recorded in the
  artifact); no token bytes persisted.
- Limit: this is a single-session, single-version observation against a loopback mock gateway. It is evidence
  that the no-custody carrier does not work for this Claude Code version, not a proof about future versions.

Probe-B (`artifacts/claude-dual-auth/probe-b-2026-07-14.json`), real native Claude executable, dedicated
`CLAUDE_CONFIG_DIR` grant:

- Incident (source of a mandatory invariant): the first attempt invoked the managed `claude` shim with a
  caller-supplied `CLAUDE_CONFIG_DIR`. The shim ignored it and wrote its configured profile, which changed a
  native scoped default-home Keychain service instead of creating the grant service. Restoring that account
  needs a human native re-login (recorded as outstanding human remediation). This is why grant setup must
  resolve and invoke the REAL Claude executable, reject managed launchers, and verify the expected scoped
  service appeared before accepting the grant.
- Corrected run (real executable, isolated config dir): created the dedicated scoped service, left the native
  stores unchanged from the corrected baseline, and a gateway-originated call succeeded — `/v1/models` `200`
  with a model list and `/v1/messages` `200` returning a `message` (`stopReason:"max_tokens"`, no error).
- Verdict: PASS with required remediation, so Branch B is selected.
- Limit: verified with one dedicated grant against a real subscription. It does not prove Anthropic tolerates
  an unbounded number of concurrent grants over time; doctor monitors `claude --version` against the
  scoped-naming assumption, and multi-grant policy drift is a watch item.

Both artifacts store credential/token evidence only as sha256[:8]+length; no access token, refresh token, or
OAuth authorization code bytes are persisted, and the consent for each subscription-authenticated call is
recorded in the artifact.

### 2026-07-20 token-free cache follow-up — FAIL, Branch B unchanged

A consented follow-up tested a carrier not covered by Probe-A: real Claude Code 2.1.215 with only
`ANTHROPIC_BASE_URL` plus `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, an exact prewritten
`gateway-models.json` cache, and no API-key/auth-token environment variable
(`artifacts/claude-dual-auth/probe-passthrough-2026-07-20.json`).

- The request-scoped portion passed: a real non-interactive message reached the loopback gateway with the native
  subscription bearer unchanged (fingerprint match), the OAuth beta and `anthropic-version` headers were present,
  no `x-api-key` or `local-frogprogsy` sentinel appeared, the explicit probe alias was accepted, and the cache
  file had the target `{baseUrl,fetchedAt,models:[{id,display_name?}]}` shape with mode 0600.
- Connector eligibility also remained: native `claude mcp list` reported claude.ai connectors without the
  connectors-disabled warning. This proves eligibility only; no third-party connector call was made.
- The required picker proof did not pass. A temporary HOME safely isolated TUI writes but lost the native
  subscription (`loggedIn:false`); retaining native auth required shared Claude state that the restoration
  contract prohibited the probe from clobbering. Therefore `/model` visibility was not safely observed.
  Non-interactive `--model` acceptance is not substituted for picker evidence.
- Verdict: **FAIL** under the partial-pass-is-failure rule. The gateway cache was restored byte-for-byte and by
  mode, Claude settings and the native credential store were unchanged, and the artifact contains only redacted
  hash prefixes and lengths. No token-free default, cache migration, catalog/readiness change, or other product
  change ships from this probe. Branch B remains the selected doctrine.

### 2026-07-20 corrected manual P0 — PASS (picker proof); supersedes only the picker-proof limitation

The FAIL follow-up above is preserved as history and is NOT rewritten. A corrected, consented manual run on
the same real Claude Code 2.1.215 obtained the ONE gate the automated harness could not construct — the
interactive `/model` picker proof — and is recorded separately in
`artifacts/claude-dual-auth/probe-picker-manual-2026-07-20.json` (schemaVersion 1, redacted). This is
additive evidence; it does not restate or re-run the gates the automated run already passed.

- What changed vs the automated FAIL: the corrected run isolated only the current working directory
  (`/tmp/frogprogsy-claude-picker-sandbox`) instead of replacing HOME, and restricted setting sources to User
  only (`--setting-sources user`). Isolating cwd plus User-only sources excluded project-local settings, so no
  project-local `ANTHROPIC_AUTH_TOKEN` was injected — but it did NOT isolate HOME: normal Claude Code runtime
  may have written its usual shared session/preferences state under the real HOME. The run did not deliberately
  clobber or restore-overwrite shared Claude state (which is why the native Claude Team subscription login was
  retained), but it did not — and could not — prevent ordinary runtime writes to shared session/preferences.
  Base URL `http://127.0.0.1:10100` is the REAL frogprogsy proxy (not a mock/ephemeral gateway; the automated
  FAIL used a loopback mock), token-free (`ANTHROPIC_BASE_URL` + `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`,
  no auth-token/api-key env).
- Observed PASS: `claude mcp list` showed connectors in connected/needs-auth state with NO connectors-disabled
  warning (eligibility only; no third-party connector call); a native built-in Sonnet response succeeded;
  `/model` showed native built-ins plus namespaced Codex aliases; a Codex OAuth alias response succeeded in the
  SAME session; the temporary probe cache was restored to sha256[:8] `c8cdda20`, length 19, mode 0600. The user
  explicitly confirmed the corrected run all worked. Transient screenshots were reviewed to confirm the
  picker/responses and then intentionally NOT retained because they carried PII; no screenshot path is recorded.
- Combined verdict (precise): the automated run proved 17 of 18 gates — message bearer preservation, OAuth and
  `anthropic-version` header presence, sentinel/`x-api-key` absence, request isolation, and native store
  integrity — and failed only the picker gate; this corrected manual run supplied the missing picker proof plus
  the native built-in + Codex OAuth response and connector-eligibility evidence. The ONLY integrity property
  independently re-checked manually was gateway-cache byte/mode restoration. The manual run did NOT independently
  hash or compare Claude settings or the Keychain; native store integrity is INHERITED from the automated
  store-integrity gate (`probe-passthrough-2026-07-20.json`), not re-proven here.
- Invalidated diagnostic (NOT PASS evidence): an earlier project-local run showed `ANTHROPIC_AUTH_TOKEN`
  sourced from Project local settings and caused a native Claude `401` when that injected token displaced the
  subscription bearer. It is retained as a diagnostic that shows WHY setting sources must be User-only for the
  token-free carrier; it does NOT count toward the P0 verdict.
- Verified model correction (not exhaustive): ChatGPT Codex rejected `gpt-5.3-codex` with `400`; `gpt-5.4` and
  `gpt-5.4-mini` returned `200` and remain. Only these ids were exercised — no claim is made that every
  configured model was tested.

Scope of this PASS: it supersedes ONLY the prior picker-proof limitation. Token-free base-URL enrollment with a
prewritten, readiness-filtered gateway cache is the implemented default interactive `frogp` launch carrier
(immediate, no soak), with `gatewayAuthCarrier:"sentinel"` retained as an explicit rollback override. The
implementation wires the carrier through home settings, project enrollment, and managed profile launches, and
prewrites the exact gateway cache before managed launch. Branch-B isolated grants are
UNCHANGED and remain the selected path for headless/server-initiated work with no incoming Claude Bearer — the
request-scoped passthrough (interactive sessions) vs isolated-grant (headless) split, where neither substitutes
for the other. All prior Branch-B evidence, the grants contract, and native Claude built-ins are preserved; this
amendment adds evidence and does not rewrite the FAIL record or the grants doctrine.

## Custody boundary and superseded doctrine

The earlier doctrine "frogprogsy never possesses Anthropic OAuth" (Anthropic absent from OAuth login,
`structure/05`) still holds for native Claude homes: in `authMode:"forward"` and for every `~/.claude*`
login, frogprogsy stores no Claude token and reads/writes no native store. That doctrine is superseded ONLY
for a dedicated grant the user separately issues via an isolated real-executable login into a
frogprogsy-owned `CLAUDE_CONFIG_DIR`. Precisely:

- Native homes: unchanged, zero-custody, outside frogprogsy.
- User-issued dedicated grant: opt-in, consented custody of an independent OAuth grant, brokered only from
  the grant's scoped store.

Custody minimization stays the ranking function: forward (zero custody) is the default; a grant is used only
when the user chooses it. No branch reads-and-rotates, overwrites, mirrors, or co-refreshes global/shared
native Claude auth.

## Grant model and scoped store

- Location: `~/.frogprogsy/claude-grants/<cg_id>`; ids `cg_<hex>`; marker `.frogprogsy-grant.json` binds the
  id; path safety asserts every grant path is strictly inside the `claude-grants` root
  (`src/claude-grants.ts`).
- Credential origin (single): macOS scoped Keychain service `Claude Code-credentials-<sha256(configDir)[:8]>`,
  else `<grant-dir>/.credentials.json`. The unscoped/global native service `Claude Code-credentials` and any
  `~/.claude*` home are hard-error write targets (`assertScopedKeychainService`, `src/claude-grant-auth.ts`).
- Single writer per rotating chain: for native homes the writer is the Claude CLI; for a grant the writer is
  the frogprogsy broker. Co-writing is excluded by construction, not by locking a non-cooperating CLI. The
  broker serializes refresh with in-process coalescing plus a per-grant lockfile under `~/.frogprogsy/locks`.
- 5-minute expiry skew: a token within 5 minutes of expiry is treated as expiring and refreshed before use
  (`EXPIRY_SKEW_MS`).
- Rotate-preserve: refresh replaces the rotating token pair but preserves unknown fields in the credential
  envelope; writes go only to the scoped store.

## Eight auth-resolution seams

All provider request-auth resolution funnels through `resolveProviderAuth`, which dispatches `key`, `forward`,
`oauth`, and `claude-grant`. The original eight acquisition sites are the six server functions
`runCoordinatorCompletion`, `runMixTurn`, `handleResponses`, the `handleMessages` retry-attempt loop,
`handleCountTokens`, and `testProviderConnection`; provider model discovery now resolves inside
`fetchProviderModels` (`src/claude-catalog.ts`); and the eighth is
`resolveOpenAIResponsesFallbackProvider` (`src/fallback-openai-responses.ts`). The separate management
connection-test module also uses an injectable resolver defaulting to the same seam.

`resolveModelsAuthToken` was removed rather than retained as a parallel dispatcher. A structural guard permits
low-level OAuth access only in the OAuth definition/central resolver and permits direct grant-broker access only
in `src/claude-grant-auth.ts`, `src/provider-auth.ts`, and the consented live-probe exception
`src/claude-grant-probe.ts`. The OpenAI Responses fallback explicitly rejects `claude-grant`; each fallback
surface still forwards only its own allowlisted incoming headers.

## Fail-closed matrix (FC1-FC9)

Each item is covered by a named test in the selected branch.

- FC1 — the gateway-discovery sentinel (`local-frogprogsy`) never reaches upstream on any carrier
  (`authorization`, `x-api-key`, `X-Frogp-Gateway-Auth`), asserted by planted-value tests. Token-free enrollment
  is the interactive default and writes no sentinel; `gatewayAuthCarrier:"sentinel"` and per-invocation global
  discovery auth are explicit rollback overrides. The never-upstream guarantee applies when that override is used.
- FC2 — a forward-mode session with no native OAuth (logged-out home) returns the upstream `401` untouched
  with a typed hint; the gateway substitutes no credential.
- FC3 — a `claude-grant` provider with no binding or a missing grant store fails typed (`not_bound` /
  `no_credential`) naming provider + grant; it never falls back to forwarded headers, another grant, or an
  API key.
- FC4 — refresh `invalid_grant` gives `reauth_required` + `401` with guided re-login
  (`CLAUDE_CONFIG_DIR=<grant-dir>` real-executable login); a transient refresh failure with an unexpired
  access token gives a single use + loud warning; an expired token gives `503 refresh_unavailable`; expired
  tokens are never sent.
- FC5 — credential isolation: grant tokens attach only to their bound provider; codex/xai/kimi and the
  openai-responses fallback never receive Anthropic tokens and vice versa; incoming headers are never merged
  into `claude-grant` requests.
- FC6 — the broker writes ONLY the grant's scoped store; any path that would write the unscoped/global
  Keychain item or a `~/.claude*` path is a hard error with a test.
- FC7 — probe failure means the feature is absent/unmerged; CLI and report name the API-key alternative; no
  synthetic fallback.
- FC8 — deleting a bound grant/provider yields a dangling typed error at request time plus a GUI/doctor
  warning; it never auto-rebinds. `claude-grant` is not in `OAUTH_PROVIDERS`, so `/api/oauth/*`,
  `removeCredential`, and reconcile flows cannot touch grants (guard test).
- FC9 — redaction: no token bytes in logs, API, GUI payloads, artifacts, or errors — sha256[:8]+length only;
  a planted-token harness scans every sink.

## Refresh and reauth (fail-closed)

Typed error codes (`src/claude-grant-auth.ts`): `not_bound`, `no_credential`, `reauth_required`,
`refresh_unavailable`, `unreadable`. Refresh uses the isolated-grant OAuth token endpoint and client id
defined in `src/claude-grant-auth.ts` (`CLAUDE_GRANT_REFRESH_URL`, `CLAUDE_GRANT_CLIENT_ID`) with a bounded
timeout. Error messages are constructed to never contain token text. Reauth guidance points the user at a
`CLAUDE_CONFIG_DIR=<grant-dir>` real-executable login; frogprogsy never automates it.

## Redaction

Credential and token evidence is limited to `sha256[:8]` + byte length everywhere — logs, API responses,
GUI-served payloads, error bodies, and artifacts. Raw access tokens, refresh tokens, and OAuth authorization
codes are never stored or logged. This SOT follows the same rule: it records no token, no OAuth code, no user
email, and no absolute home path.

## Deletion and dangling semantics

Grant deletion preflights the exact `<claude-grants>/<cg_id>` path and matching marker before any mutation. It
then deletes the exact scoped Keychain service (or in-root credential file); only after that succeeds does it
remove the directory and config record. Credential cleanup failure keeps metadata and the directory intact.
A provider still bound to a removed grant is a dangling binding: it fails typed at request time and is surfaced
by GUI/doctor; it is never silently re-bound to another grant, a forwarded header, or an API key.

## Residual ToS / account risk

A grant means the gateway holds a consented subscription-grant token. Network calls carrying subscription
auth may breach Anthropic terms with account-level consequences no fail-closed rule can undo. Every
subscription-authenticated probe/setup call is gated by explicit `--yes`/typed GUI consent that states quota
and ToS/account risk, and the consent is recorded (redacted) in the probe artifact. The GUI consent dialog
carries this disclosure verbatim.

## Rollback, removal, and process rules

- Removing a grant (`DELETE /api/claude-grants/:id` / `frogp claude grants remove`) preflights the exact
  marker/path, deletes the scoped credential, then deletes the scoped dir + record. A cleanup failure leaves the
  grant intact. `frogp stop`/`restore`/`uninstall` leave native Claude homes and the global Keychain
  byte-identical; grant dirs are frogprogsy-owned local state removed with the config dir on uninstall.
- Removing a grant does not log out the native account or revoke the separate grant login on Anthropic's side
  (that is a human `claude` login/logout concern).
- No login automation: the user runs the real-executable login (`auth login --claudeai`); frogprogsy only
  builds the guided command and verifies the scoped credential appeared.
- No global takeover: never write the global/unscoped Keychain item or a `~/.claude*` path; multiple native
  Claude homes are preserved as explicit choices.
- API-key alternative: Anthropic API-key providers stay documented and available for callers who do not want
  subscription custody or need headless/API auth without a grant.
- Process: dual-auth work lands on the `feature/claude-dual-auth` worktree and merges to local `main` for an
  A/B outcome only; nothing is pushed to a remote.
