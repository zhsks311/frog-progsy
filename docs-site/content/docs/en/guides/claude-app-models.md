---
title: Claude Code App model picker
description: How FrogProgsy models appear in Claude Code App, Claude Code CLI, and Claude Code TUI through gateway model discovery aliases.
---

This guide focuses on making routed models visible in Claude Code App/CLI/TUI and refreshing stale picker state.

FrogProgsy does not patch Claude Code App. It writes owned env keys to Claude Code settings and serves Anthropic-style `/v1/models` discovery from the local gateway. Because Claude Code CLI/TUI/App use the same gateway discovery, routed models appear as stable aliases.

## Operational path

`frogp init`, `frogp start`, and `frogp claude` profile actions keep these local files aligned:

```text
<profile-home>/settings.json
~/.frogprogsy/claude-profiles/<cp_id>/claude-settings-backup.json
~/.frogprogsy/model-aliases.json
```

The settings injection writes only owned env keys:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:10100",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  }
}
```

Model discovery returns aliases such as `claude-frogp-provider-model`. When two models sanitize to the same alias, a short hash suffix disambiguates only those entries. Each `display_name` preserves the exact `provider/model` route key. Prefer that route key over picker aliases in operator-facing docs and runbooks.

Responses WebSocket support is retired for Claude Messages. FrogProgsy does not advertise `supports_websockets`; Claude Code gateway traffic uses HTTP/SSE.

## Why routed models show up

Claude Code's model picker expects Claude Code-shaped catalog entries. FrogProgsy builds those entries by cloning a native Claude Code model template, then replacing the routed model identity:

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

The clone keeps strict-parser fields such as reasoning levels, shell type, API support flags, and base instructions. That makes each routed entry look like a valid picker-visible Claude Code model.

## Subagent selection

Claude Code `spawn_agent` advertises the first five high-priority catalog models. Pick up to five `provider/model` or native ids through `subagentModels` or the web dashboard; FrogProgsy sorts those entries to the front of the catalog.

## Refresh stale model state

If the Claude Code picker still shows stale entries, reload the catalog for the target profile and start a new Claude Code session or resume the existing one so Claude Code refetches `/v1/models`:

```bash
frogp claude reload-models <profile-id>
```

Already-open `/model` screens do not hot reload after the catalog changes. Close that picker and open it from a newly started or resumed Claude Code session. Dashboard/API list reload is separate from Claude Code picker recovery; use it for the web/API view, not as a substitute for `frogp claude reload-models <profile-id>`. If the local proxy is down, recover it with `frogp refresh` before reloading the Claude Code picker.
