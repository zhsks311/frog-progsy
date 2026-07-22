---
title: Model Routing
description: "How FrogProgsy picks a provider lane for each Claude Code model request and keeps aliases, short ids, and fallbacks predictable."
---

This guide helps operators answer: “why did this request go to this provider?”

FrogProgsy treats every model id as a routing lookup. Claude Code may send a gateway alias, a `provider/model` route, a short upstream id, or a native-looking family name. Before any adapter runs, the router reduces that input to one provider and one upstream model.

## Operator lookup order

| Step | Match | Result |
| --- | --- | --- |
| 1 | Gateway alias from `model-aliases.json` | Reverse-map `claude-frogp-…` back to the saved `provider/model` route. |
| 2 | Explicit `provider/model` | Use the named provider and strip the prefix before sending upstream. |
| 3 | Provider `defaultModel` | Use the provider whose default exactly matches the requested id. |
| 4 | Provider `models[]` | Use the provider that explicitly lists the id. |
| 5 | Built-in family prefix | Route common families to configured providers such as `anthropic`, `openai`, or `groq`. |
| 6 | `defaultProvider` | Last fallback; the model id is sent unchanged. |

If nothing resolves and no default provider exists, FrogProgsy fails early instead of guessing.

## Operational default: prefer explicit routes

```txt
anthropic/claude-sonnet-4-6  → provider: anthropic    upstream model: claude-sonnet-4-6
codex/gpt-5.5                → provider: codex        upstream model: gpt-5.5
local-test/local-model       → provider: local-test   upstream model: local-model
```

Claude Code's picker may show stable aliases, while `display_name` preserves the original `provider/model` route for debugging. After adding providers in the dashboard, record explicit routes in runbooks, issues, and internal docs because they survive future provider catalog overlap.

## Short ids need ownership

Short ids such as `gpt-5.5` are convenient but safe only when one provider clearly owns them. Assign ownership with `defaultModel` or `models[]`.

```json
{
  "providers": {
    "codex": {
      "defaultModel": "gpt-5.5",
      "models": ["gpt-5.5", "gpt-5.4-mini"]
    }
  }
}
```

`defaultModel` wins before `models[]`. Prefix routing is a convenience layer for common families; it does not create providers that are not configured.

## Secret checks happen after routing

```json
{
  "apiKey": "${OPENAI_API_KEY}"
}
```

`resolveEnvValue()` expands `${NAME}` and `$NAME` when the request is built. That keeps config files shareable without embedding the real secret.

## Route debugging order

1. In the dashboard request log, check chosen model, provider, status, endpoint, phase, and safe error code.
2. Decide whether the requested model was a `provider/model`, gateway alias, or short id.
3. Check static settings: `defaultProvider`, each provider's `defaultModel`, each provider's `models[]`, and `disabledModels`.
4. If an alias is involved, inspect `~/.frogprogsy/model-aliases.json`.
5. If the route still does not resolve, follow the relevant fields in [Configuration](/frog-progsy/reference/configuration/).
