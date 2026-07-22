---
title: Claude Code Wiring
description: "The local hooks FrogProgsy owns: settings env keys, gateway discovery, catalog aliases, subagent ranking, and clean restore."
---

This guide focuses on what FrogProgsy writes into Claude Code, what it does not write, and how to restore the native state when needed.

FrogProgsy connects through the gateway path Claude Code already reads. It does not patch Claude Code binaries and it does not install a `model_provider` table in `config.toml` for the active integration path. It does generate optional launcher shims so `claude` and aliases such as `claude-work` can start with the right gateway environment instead of requiring `frogp claude run` in daily use.

## Owned settings only

`frogp init`, `frogp start`, and the startup path write only FrogProgsy-owned env keys under `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:10100",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  }
}
```

Unrelated settings stay untouched. Before the first write, previous values for the owned keys are saved in `~/.frogprogsy/claude-profiles/<cp_id>/claude-settings-backup.json`; restore paths put those values back exactly for that profile. If the backup is missing, restore removes only clearly recognizable FrogProgsy residue: a local `ANTHROPIC_BASE_URL` paired with gateway discovery, the optional local FrogProgsy auth marker, the `X-Frogp-Claude-Profile` header, and routed default model aliases created by current or older releases. Unrelated settings remain in place so Claude Code account connectors keep working.

## Gateway discovery shows models

With gateway discovery enabled, Claude Code calls the local relay's `/v1/models`. FrogProgsy returns Anthropic-style aliases Claude Code accepts:
Claude Code refetches `/v1/models` when a session starts or resumes; reopening an already-open `/model` screen does not hot reload the picker.

```txt
claude-frogp-codex-gpt-5-5
```

The human-readable `display_name` preserves the original route key, such as `codex/gpt-5.5`. Alias state is stored in `~/.frogprogsy/model-aliases.json`, and the router can reconstruct configured aliases if the file is missing. Claude Messages traffic uses HTTP/SSE; the retired Responses WebSocket path is not advertised for this Claude Code integration.
For Claude Code picker recovery after model changes, run `frogp claude reload-models <profile-id>`; use `frogp refresh` when the proxy-side model list needs recovery after the proxy was down.

Anthropic Claude aliases require an Anthropic provider row in frogprogsy. In forward-auth mode the row does not
store a Claude token; model-list discovery can use the real `Authorization` or `x-api-key` from the active Claude
Code home and caches the result per `X-Frogp-Claude-Profile`. Without a configured Anthropic row, Claude Code's
native Claude account still exists, but frogprogsy has no routed Anthropic model to show in Model Picker or Model
Mixing.

## Isolated Claude subscription grants (dual-auth)

Anthropic auth has two modes, and they never mix credentials.

**Forward (default, no custody).** frogprogsy stores no Claude token. Model discovery and Anthropic sub-calls reuse the real `Authorization` or `x-api-key` from your active Claude Code home, cached per `X-Frogp-Claude-Profile`. Your native `~/.claude*` homes and any multiple Claude accounts stay owned by Claude Code — grant code reads and writes none of them.

**Claude grant (opt-in, isolated custody).** A grant is a separate Claude subscription login you issue once into a frogprogsy-owned `CLAUDE_CONFIG_DIR` under `~/.frogprogsy/claude-grants/<cg_id>`. It lets a Claude subscription answer in the same session and `frogp/mix` roster as your Codex OAuth without relying on a logged-in Claude Code home for every call. Codex OAuth remains a separate credential that a grant never touches.

```bash
frogp claude grants add "Work Claude"
```

`grants add` verifies your real `claude` executable, creates the grant record and scoped directory, and prints a login command like `CLAUDE_CONFIG_DIR=<grant-dir> /absolute/path/to/real/claude auth login --claudeai` that pins the verified executable by absolute path. Run frogprogsy's printed command verbatim: never swap in the managed frogprogsy `claude` launcher or a bare PATH-resolved `claude` for grant login, because the launcher can ignore or collide with the intended isolated `CLAUDE_CONFIG_DIR`. You run that login yourself: frogprogsy never runs it, never opens a browser, never copies tokens, and never writes a native `~/.claude*` home or the global/unscoped Keychain login. After you log in, `frogp claude grants status` (or the GUI) verifies the scoped credential appeared and reports readiness:

```bash
frogp claude grants status
```

Readiness is redacted — it reports `ok` (with time to expiry), `reauth required`, `unreadable`, `none`, or `dangling` per grant and never prints token bytes. Bind a provider to a ready grant (the dashboard Providers page offers the same `Forward (default) / API key / Claude grant` selector):

```bash
frogp providers set anthropic --auth claude-grant --grant <cg_id>
```

Grant custody is per-provider isolated and fail-closed. A bound grant serves only its own scoped store; Codex, xAI, and Kimi providers never receive Anthropic tokens and vice versa. If refresh fails, the provider returns a typed re-auth or `refresh_unavailable` error with a re-login hint instead of falling back to a forwarded header, another grant, or an API key, and expired tokens are never sent.

Removing a grant (`frogp claude grants remove <id>` or the dashboard) deletes the frogprogsy-owned local scoped credential, its scoped directory, and its record; it does not revoke the grant on Anthropic's side or log out your native account. `frogp doctor claude` reports the resolved real `claude` path, scoped-store confinement, and any provider still bound to a missing grant — all without touching native homes or the global Keychain.

You consent to a grant when you set it up, and again for any live subscription-authenticated diagnostic probe (an explicit `--yes`/typed GUI confirmation) — not on every routed request. That consented custody hands frogprogsy a Claude subscription token, so subscription-authenticated calls carry Anthropic ToS, account, and quota risk that no fail-closed rule can undo. Anthropic API-key providers remain the documented alternative for anyone who does not want subscription custody or needs headless/API auth without a grant.

## Launching Claude Code

`frogp start` and `frogp refresh` regenerate `~/.frogprogsy/bin/claude` for the default Claude Code home and aliases derived from configured homes, such as `claude-work` or `claude-personal`. Put `~/.frogprogsy/bin` before the native Claude Code binary in `PATH`, or rely on the package-provided `claude` bin when it wins PATH resolution. Each launcher calls the low-level `frogp claude run <cp_id>` path with `FROGP_REAL_CLAUDE` pinned to the real Claude Code executable, skipping frogprogsy and transient cmux shims to avoid recursion. When the proxy is stopped, the launcher keeps only the selected Claude home env and passes through to native Claude Code.

## Catalog sync responsibilities

FrogProgsy uses the Claude Code catalog as a routed model presentation layer.

1. Save a one-time pristine backup at `~/.frogprogsy/catalog-backup.json`.
2. Fetch each provider's `/models` list, using cache and configured `models[]` fallback.
3. Create namespaced routed entries from a native Claude Code catalog template.
4. Remove anything listed in `disabledModels`.
5. Rank featured subagent models first.
6. Write the merged catalog back.

## Subagent ranking

Claude Code `spawn_agent` sees the first high-priority routed models. Pick up to five `provider/model` or native ids through `subagentModels`:

```json
{
  "subagentModels": [
    "anthropic/claude-opus-4-8",
    "codex/gpt-5.5",
    "xai/grok-4.3"
  ]
}
```

FrogProgsy ranks featured entries before other routed entries, then leaves native entries behind them. The dashboard exposes the same list for point-and-click edits.

## Clean restore

`frogp stop` stops the proxy, then removes FrogProgsy-owned settings, routed catalog/cache entries, and legacy `config.toml`/profile wiring. Managed launchers remain installed and pass through to native Claude Code while no proxy is active. `frogp restore` performs the same Claude Code cleanup without stopping the current process.

```bash
frogp stop
frogp restore
```
