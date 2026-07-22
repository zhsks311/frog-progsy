# Catalog And Subagents SOT

## Shared catalog

`src/claude-catalog.ts` builds a shared Claude Code-shaped catalog for CLI, TUI, App, and SDK. It:

- preserves native OpenAI entries from the live catalog or static fallback;
- clones a native template for routed `provider/model` entries;
- forces strict Claude Code catalog fields required by the current parser;
- hides `disabledModels`;
- strips native-only service tier and WebSocket metadata unless explicitly enabled;
- backs up the pristine catalog once to `~/.frogprogsy/catalog-backup.json`;
- invalidates `~/.claude/models_cache.json` when model visibility changes.

Claude Code App model picker visibility comes from this shared catalog, not from patching the App.

## Entry shape

Routed entries keep Claude Code-required metadata such as reasoning levels, shell type, API support flags,
base instructions, modalities, auto-compact fields, and strict parser booleans. The public slug and
display name use `provider/model`.

## Native OpenAI models

Native OpenAI entries remain available through the ChatGPT/Codex Responses upstream. Routed non-OpenAI models must not
inherit native-only service tier or WebSocket metadata unless the user explicitly enables that
capability.

## Subagents

Claude Code `spawn_agent` advertises only the highest-priority first five catalog models. `subagentModels`
is an unbounded ordered list of routed `provider/model` slugs or native model slugs; each featured model
gets catalog priority equal to its rank, and when the list outgrows the legacy non-featured defaults
(routed 5, native 9) those defaults shift up by the overflow so every featured entry still sorts first.
Featuring only reassigns priority — each model appears exactly once in the catalog (no duplicate entries).
Startup seeds native GPT defaults only when the field is unset; an explicit empty list persists.
