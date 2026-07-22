# Config And Claude Code Home SOT

## Claude Code home

`src/claude-paths.ts` resolves Claude Code state from an explicit Claude Code home, then `CLAUDE_CONFIG_DIR`,
then `CLAUDE_HOME`, otherwise `~/.claude`. The managed files are per target home:

```text
<profile-home>/settings.json
<profile-home>/cache/gateway-models.json
<profile-home>/frogprogsy-catalog.json
<profile-home>/models_cache.json
<profile-home>/config.toml              # read/cleanup compatibility only
<profile-home>/frogprogsy.config.toml   # legacy cleanup only
```

Never assume macOS-only paths. Windows, service installs, and app-launched Claude Code can all depend on
the resolved target home.

`claudeProfiles` in `~/.frogprogsy/config.json` stores stable `cp_...` ids, mutable user-facing names,
target `claudeHome` directories, gateway-applied timestamps, last-seen timestamps, and auth-state fields.
Profile ids, not names, key `X-Frogp-Claude-Profile` headers, backups, caches, and status.
Registered profiles are managed homes: `frogp refresh` and `frogp start` apply/refresh the gateway for every
configured home. `frogp claude refresh <name-or-id>` remains the per-home override.

Project-local enrollment is the ordinary/safe path for making plain `claude` inside a repository see
frogprogsy Codex/GPT routes. It writes only the project-local file:

```text
<project>/.claude/settings.local.json
```

That file is protected before write: if git reports it as tracked, enrollment must block and show a
tracked-file warning; ignored, locally excluded, untracked, non-git, and unwritable states are reported
explicitly. Project enrollment uses the currently effective Claude Code home for auth and profile headers.
It must not claim to select `~/.claude`, `~/.claude-personal`, `~/.claude-work`, `CLAUDE_CONFIG_DIR`,
or a Claude account/login. Multiple Claude homes remain explicit home/profile choices, not something a
project enrollment silently switches.

`atomicWriteFile` uses a temp file named `{path}.frogp.{pid}.{seq}.tmp` (process ID + incrementing
sequence number) to avoid collisions when concurrent writers (e.g. `frogp stop` and the proxy's own
shutdown handler) both restore Claude Code config simultaneously. The temp is renamed atomically into place.

## Settings injection

`src/claude-settings.ts` is the current supported Claude Code integration path. It writes only
frogprogsy-owned env keys under `<profile-home>/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3764",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "ANTHROPIC_CUSTOM_HEADERS": "{\"X-Frogp-Claude-Profile\":\"cp_...\"}"
  }
}
```

Settings intentionally do not store frogprogsy's local discovery auth token by default. Managed settings,
project enrollment, and launcher environments are token-free: they set the gateway base URL and discovery
flag while leaving Claude Code's native claude.ai OAuth bearer/connectors in control. Immediately before a
managed launch, frogprogsy refreshes that profile home's exact gateway cache so routed aliases remain visible
without a synthetic credential. `gatewayAuthCarrier:"sentinel"`, `frogp claude refresh
--global-discovery-auth`, and management `globalDiscoveryAuth:true` are explicit rollback overrides that
inject `ANTHROPIC_AUTH_TOKEN:"local-frogprogsy"` and may disable claude.ai connectors. The sentinel token must
never be forwarded upstream.
`ANTHROPIC_CUSTOM_HEADERS` is added only for a selected Claude Code home so
the gateway can resolve the profile id. Settings merges preserve unrelated user env/header values and record
a per-profile backup before the first write.

`src/claude-inject.ts` exists for removing older `config.toml`/provider-table integrations and for compatibility
with old local files; new runtime activation must not depend on `model_provider`, `model_catalog_json`, or a
`[model_providers.frogprogsy]` table.

Gateway model discovery is the primary picker path. `refreshClaudeCodeModelCatalog` still rebuilds the
frogprogsy catalog/cache files when present and materializes `<profile-home>/cache/gateway-models.json`
from enabled routed aliases so Claude Code's `/model` picker has a current gateway list even when it
does not immediately refetch `/v1/models`.

## Gateway model cache and auth carrier

The picker/discovery cache is `<profile-home>/cache/gateway-models.json` with the exact schema
`{baseUrl, fetchedAt, models: [{id, display_name?}]}`, written atomically (temp + `renameSync`) and verified to
be mode `0600` on the FINAL file. The cache exports ROUTED ALIASES ONLY: `<provider>/<model>` stays the internal
routing identity while the entry `id` is the generated gateway cache id (e.g. `claude-frogp-codex-gpt-5-4` with
`display_name: codex/gpt-5.4`). Native Claude/OpenAI built-in slugs are never cache entries — they are preserved
by construction, and any candidate whose generated id/display collides with a native slug or lacks a namespaced
routing identity is rejected with a redacted (id-only) warning.

Cache retention is last-known-good: a transient sync/live-fetch failure KEEPS the previous cache and surfaces a
warning instead of invalidating it. Deletion happens only on restore, stop, or a baseUrl/port change; a legacy
cache with a missing or unparseable `baseUrl` counts as a mismatch and is deleted-then-rewritten (never
retained). Doctor reports the cache `fetchedAt` age.

Auth carrier — token-free is the approved default; sentinel is the rollback override. Following the corrected
manual P0 PASS (`artifacts/claude-dual-auth/probe-picker-manual-2026-07-20.json`; see
`structure/09_claude-dual-auth.md`), the approved default interactive `frogp` launch is token-free: managed
settings/launchers set only `ANTHROPIC_BASE_URL` + `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` and inject NO
`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`, so the native subscription bearer passes through unchanged and
claude.ai connectors stay eligible (the corrected run showed `claude mcp list` connectors with no
connectors-disabled warning). The new `gatewayAuthCarrier?: "token-free" | "sentinel"` config field carries the
choice: absent ⇒ token-free (post-PASS default, immediate, no soak); `"sentinel"` ⇒ the prior behavior that
injects the `ANTHROPIC_AUTH_TOKEN:"local-frogprogsy"` sentinel (which can disable claude.ai connectors for that
home). `frogp claude refresh --global-discovery-auth` / management `globalDiscoveryAuth:true` remain
per-invocation sentinel overrides, and the sentinel token, when used, must never be forwarded upstream. This is
the implemented default carrier: `gatewayAuthCarrier` is wired through home settings, project enrollment, and managed
profile launches, while the sentinel behavior described above remains the explicit rollback path. The carrier choice
does not change readiness filtering: the picker/export cache still exports only authReady routed aliases and native
built-ins stay untouched (`structure/05_gui-and-management-api.md`).

## Claude launchers

`frogp start` and `frogp refresh` also regenerate managed launcher shims under
`~/.frogprogsy/bin/`. The default configured Claude Code home gets `claude`; each named home gets
stable profile/home aliases such as `claude-work`, `claude-personal`, and `claude-<profile-name>`
when those names can be expressed as safe ASCII command names. The shims call the same frogprogsy CLI command
that generated them (for a source checkout this is the pinned `bun <repo>/src/cli.ts` command), with
`FROGP_REAL_CLAUDE` pinned to the real Claude Code executable. Real-Claude resolution skips frogprogsy's own
shim directory and transient cmux shim directories to avoid recursion. When the proxy is active, managed launchers
prewrite that profile's gateway cache and run token-free by default; `gatewayAuthCarrier:"sentinel"` restores the
local discovery token only as an explicit rollback. When the proxy is not active, the same launchers keep only
`CLAUDE_CONFIG_DIR`/`CLAUDE_HOME` and pass through to native Claude Code for that profile.

The package also exposes a `claude` bin that behaves as the default-profile launcher when that bin wins
PATH resolution; otherwise users can put `~/.frogprogsy/bin` before the native Claude Code binary.
`frogp stop` and `frogp restore` remove gateway settings but leave launchers installed as native-profile
pass-through commands; `frogp uninstall` removes the config directory that contains them.

Project enrollment intent and on-disk routing state have different lifetimes. A project row with
`enrolled:true` records durable intent, but its `.claude/settings.local.json` gateway keys are active only
while the proxy is intended to serve traffic. Global `frogp stop`, `frogp restore`, intentional shutdown,
and uninstall restore both managed homes and every enrolled project to Claude-direct settings. They keep
`enrolled:true` for temporary stop/restore; the next successful `frogp start` or healthy `frogp refresh`
reapplies each enrolled project with the active port, routing-profile header, and current auth carrier.
This symmetry also migrates stale sentinel project settings to the token-free default. Explicit
`frogp claude project restore [path]` (or the equivalent management-API restore) is a durable project
opt-out and changes `enrolled` to false. A successful global stop/restore therefore guarantees that a
newly launched Claude Code process cannot inherit a frogprogsy base URL pointing at the stopped proxy.

## Profile ownership

`frogp claude` operations are target-aware: backup paths live under
`~/.frogprogsy/claude-profiles/<id>/`, settings merges preserve unrelated `ANTHROPIC_CUSTOM_HEADERS`, and
restore removes only the selected profile's frogprogsy-owned env/header/cache entries. Claude Code home rows
represent Claude Code account/config directories, not provider secrets stored by frogprogsy.

## Isolated Claude grants (dual-auth)

Native Claude Code homes and their account/session semantics stay owned by Claude Code. frogprogsy owns
only dedicated, config-dir-scoped grants under `~/.frogprogsy/claude-grants/<cg_id>` (`src/claude-grants.ts`).
A grant is an isolated Claude subscription login the user issues once into that frogprogsy-owned
`CLAUDE_CONFIG_DIR`; it is never a copy, mirror, or co-write of any `~/.claude*` home. In the current
hybrid, isolated Branch-B grants remain the explicit headless/server path; interactive managed launches
use the separately probed token-free native passthrough path — see `structure/09_claude-dual-auth.md`.

Grant setup resolves the real Claude Code executable (`assertRealClaudeExecutable` /
`findRealClaudeExecutable`) and builds a guided, human-driven login command (`buildClaudeGrantLoginCommand`,
default args `auth login --claudeai`). frogprogsy never automates the login and never invokes the managed
`claude` shim or a launcher-bin/source-dir executable for it: Probe-B recorded that the managed shim ignores
a caller-supplied `CLAUDE_CONFIG_DIR` and writes the shim's configured profile instead, which changed a
native scoped default-home service and required a human native re-login to restore
(`artifacts/claude-dual-auth/probe-b-2026-07-14.json`). Real-executable resolution and a post-login check that
the expected scoped credential appeared (`verifyClaudeGrantProvisioned`) are therefore mandatory product
invariants.

Hard invariants (`src/claude-grants.ts`, `src/claude-grant-auth.ts`):

- Grant directories live strictly under the `claude-grants` root; reads/removes outside it throw
  (`assertInsideGrantsRoot`). Grant ids are `cg_<hex>` with no path separators.
- The only credential origin is the grant's scoped store: on macOS the scoped Keychain service
  `Claude Code-credentials-<sha256(configDir)[:8]>`, otherwise `<grant-dir>/.credentials.json`.
- The unscoped/global native service `Claude Code-credentials`, every `~/.claude*` home, and any other Claude
  Code home are never read or written by grant code (`assertScopedKeychainService` hard-errors on the native
  service).
- Multiple native Claude homes stay explicit home/profile choices; a grant is an additional, separate
  credential context, not a replacement or a global takeover.
- Removing a grant first proves the exact in-root marker/path, then deletes only that grant's scoped Keychain
  service (or scoped credential file), directory, and config record in that order. A cleanup failure leaves the
  record and directory intact. It does not touch native homes, the global Keychain service, or revoke any
  Anthropic-side login.

## Restore

`frogp stop`, `frogp restore`, and `frogp uninstall` must strip frogprogsy settings/env, profile headers,
gateway cache entries, and routed catalog/cache entries for every configured Claude Code home without
damaging native Claude Code state.
