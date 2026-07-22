---
title: First Relay Run
description: "Go from frogp start to dashboard Add Provider, default provider/model selection, and the first Claude Code request."
---

## 1. Start the relay

```bash
frogp start
```

The relay starts on `http://localhost:10100` by default. If the port is already in use, FrogProgsy chooses an open local port and synchronizes Claude Code gateway settings plus the model catalog.

## 2. Open the dashboard

```bash
frogp gui
```

When the dashboard opens, add the first provider.

1. Select **Add Provider**.
2. Choose a built-in provider or enter a custom OpenAI-compatible endpoint.
3. Paste an API key or complete Codex/ChatGPT, xAI, or Kimi OAuth login. Claude subscription access stays in Claude Code; manage multiple Claude homes with `frogp claude`.
4. Review the available models and make this provider/model the default.

Model lists are discovered automatically when the provider has a model-listing endpoint, then merged with configured/catalog hints. After you save the default provider/model, the new provider is available without restarting the relay.

## 3. Send the first Claude Code request

```bash
claude "Write a hello world in Rust"
```

When the model is omitted, FrogProgsy routes to the default provider/model selected in the dashboard.

Use `provider/model` only when you need an explicit route.

```bash
claude -m "anthropic/claude-opus-4-8" "Explain this stack trace"
claude -m "codex/gpt-5.5" "Draft a migration plan"
```

## Operational paths not on the first run

- `frogp init` is the alternate setup path for environments that need a CLI wizard.
- `frogp restore` and `frogp uninstall` are recovery commands for returning Claude Code or local FrogProgsy state to a clean baseline.
- Direct edits to `~/.frogprogsy/config.json` are covered by the configuration reference; provider catalog choices are covered by the provider guide.

Next: [Request Lifecycle](/frog-progsy/getting-started/how-it-works/) or [Provider Setup](/frog-progsy/guides/providers/).
