---
title: Configuration
description: "Complete FrogProgsy config.json contract: relay defaults, provider lanes, model catalog controls, reasoning/capability gates, capability fallbacks, and safe operations."
---

This docs site is FrogProgsy's official full documentation surface. The README stays limited to first-success quickstart; the field contract for `~/.frogprogsy/config.json` lives here.

FrogProgsy reads `~/.frogprogsy/config.json` on startup. The setup wizard and dashboard write this file, but it remains plain JSON and can be edited directly. If the file is missing or invalid, FrogProgsy falls back to a single Anthropic forward provider.

Public schema names used by the dashboard and docs are `ProviderConfig` and `WebSearchFallbackConfig`.

## Files and write rules

| Path | Role |
| --- | --- |
| `~/.frogprogsy/config.json` | Relay, provider, catalog, and capability fallback settings. |
| `~/.frogprogsy/auth.json` | OAuth provider access/refresh token store. |
| `~/.frogprogsy/claude-profiles/<cp_id>/claude-settings-backup.json` | Per-profile restore backup for FrogProgsy-owned Claude Code settings. |
| `~/.frogprogsy/model-aliases.json` | Claude Code-visible routed model alias map. |

FrogProgsy writes config and backup files with temp-file + rename. Prefer `${ENV_VAR}` or `$ENV_VAR` references over literal API keys.

## Runtime type anchors

The JSON fields map to the runtime `ProviderConfig` objects under `providers.*` and the `WebSearchFallbackConfig` object under `webSearchFallback`. Keep those public type names stable when updating configuration examples.

## Top-level fields

| Field | Type | Default | Role |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | Local relay listen port. |
| `hostname` | `string` | `"127.0.0.1"` | Bind hostname. Use `0.0.0.0` only when deliberately exposing the relay on all interfaces. |
| `providers` | object | fallback provider | Named provider lanes. Each key becomes a route prefix. |
| `defaultProvider` | `string` | `"anthropic"` | Routing fallback lane when the requested model id has no provider prefix. |
| `subagentModels` | `string[]` | default GPT native list | Up to five routed/native model ids shown first in Claude Code's subagent picker. Setting `[]` is respected. |
| `disabledModels` | `string[]` | — | Routed models hidden from injected catalog and `/v1/models`. |
| `modelCacheTtlMs` | `number` | `300000` | Provider `/models` cache freshness window. |
| `stallTimeoutSec` | `number` | `90` | Seconds of upstream data silence before an incomplete/error close; minimum `1`. |
| `connectTimeoutMs` | `number` | `30000` | Upstream DNS/TCP/TLS/response-header timeout in milliseconds. |
| `webSearchFallback` | object | auto when a compatible forward/key provider exists | Hosted web-search helper settings. |
| `imageFallback` | object | auto when a compatible forward/key provider exists | Image-description helper settings for text-only lanes. |
| `classifierFallback` | object | — | Cross-provider override for Claude Code auto-mode classifier side queries; `{ provider, model }` takes precedence over per-provider `classifierModel`. |
| `modelMixing` | object | — | Model mixing behind the `frogp/mix` alias (route/fusion/pipeline). Disabled unless `enabled: true`. See [Model mixing fields](#model-mixing-fields). |
| `websockets` | `boolean` | `false` | Legacy ignored compatibility field; the Claude Messages data plane uses HTTP/SSE. |
| `syncResumeHistory` | `boolean` | `false` | Legacy ignored/no-op; FrogProgsy does not touch Claude Code history. |

## Provider lane fields

Each `providers` key is a route namespace. For example, model `qwen/qwen3-coder` in provider `openrouter` is exposed to Claude Code as `openrouter/qwen/qwen3-coder`.

| Field | Type | Role |
| --- | --- | --- |
| `adapter` | string | One of `openai-chat`, `openai-responses`, `anthropic`, `google`, or `azure-openai`. `azure` is accepted as a legacy alias. |
| `baseUrl` | string | Upstream API base URL. |
| `authMode` | `"key" \| "oauth" \| "forward"` | Authentication mode. Defaults to `key`. |
| `apiKey` | string | Literal key or `${ENV_VAR}` / `$ENV_VAR` reference. |
| `headers` | object | Extra static upstream headers. Do not use this to bypass credential handling. |
| `defaultModel` | string | Provider-owned short model id used for provider/default fallback routing. |
| `classifierModel` | string | Lightweight model used for Claude Code auto-mode classifier side queries when this provider is the default or selected by `classifierFallback`. |
| `models` | string[] | Seed/fallback model list; exact allowlist when `liveModels` is `false`. |
| `liveModels` | boolean | Whether start/sync fetches live `/models`; default `true`. |
| `contextWindow` | number | Provider-wide Claude-visible context cap. |
| `modelContextWindows` | object | Model-specific context cap. It caps downward and does not raise live metadata. |
| `modelCapabilities` | object | Provider/model capability map, for example `{ "model-a": { "input": ["text", "image"] } }`; `imageFallback` can be `reject` or `describe`. |
| `reasoningEfforts` | string[] | Provider-wide Claude Code-visible reasoning tiers: `low`, `medium`, `high`, `xhigh`. |
| `modelReasoningEfforts` | object | Model-specific visible reasoning tiers. Empty arrays hide effort choices. |
| `reasoningEffortMap` | object | Claude Code effort label to upstream wire value mapping. |
| `modelReasoningEffortMap` | object | Model-specific effort mapping. |
| `noReasoningModels` | string[] | Models that must not receive reasoning/thinking parameters. |
| `noTemperatureModels` | string[] | Models that reject caller temperature. |
| `noTopPModels` | string[] | Models that reject caller `top_p`. |
| `noPenaltyModels` | string[] | Models that reject presence/frequency penalties. |
| `autoToolChoiceOnlyModels` | string[] | Models whose forced/named tool choice must be lowered to `auto` or `none`. |
| `preserveReasoningContentModels` | string[] | Chat models that need assistant `reasoning_content` preserved in history. |
| `escapeBuiltinToolNames` | boolean | Anthropic-compatible gateways that need built-in tool names prefixed on the wire and stripped on return. |

## Auth modes

| Mode | Contract |
| --- | --- |
| `key` | Sends `apiKey` or its env reference upstream as Bearer/API-key material. Most API-key catalog providers use this mode. |
| `oauth` | Resolves and refreshes a stored OAuth token from `~/.frogprogsy/auth.json`, then sends it as Bearer auth. |
| `forward` | Copies only allowlisted upstream-compatible auth headers from the incoming Claude Code request. Used by Anthropic and OpenAI Responses lanes. |

## Classifier routing fields

Claude Code auto-mode permission checks are separate small-model side queries. When `defaultProvider` is not Anthropic, set a lightweight classifier route so those checks do not silently use the heavyweight `defaultModel`.

How a permission check flows:

```text
main model attempts an action (e.g. a Bash command)
  → Claude Code sends a side query with a Haiku-class id (claude-haiku-*)
  → FrogProgsy routes it: classifierFallback → provider classifierModel → defaultModel (+ warning)
  → the routed model judges the action against Claude Code's auto-mode policy → allow / block
```

| Field | Scope | Role |
| --- | --- | --- |
| `classifierModel` | provider | Provider-local model used for Haiku-class classifier requests. |
| `classifierFallback.provider` | top level | Provider that should receive all classifier side queries. |
| `classifierFallback.model` | top level | Model id used with the fallback provider. |

If neither field is configured, FrogProgsy still routes the request but emits a warning when a Haiku-class classifier id falls back to `defaultModel`.

The model choice changes how strictly Claude Code's built-in auto-mode policy (`allow` / `soft_deny` / `hard_deny` categories) is interpreted — a frontier model over-blocks, a light model matches the original Haiku calibration. The policy itself is not configured here: inspect and tune it in Claude Code via `claude auto-mode defaults` / `claude auto-mode config` (an `autoMode.allow` entry unblocks trusted `soft_deny` commands; `hard_deny` categories stay blocked no matter which model judges).

## Model capability fields

FrogProgsy uses per-provider `modelCapabilities` to keep Claude Code catalog hints and image fallback behavior aligned.

```json
{
  "providers": {
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "apiKey": "${OLLAMA_API_KEY}",
      "modelCapabilities": {
        "glm-5.2": { "input": ["text"], "imageFallback": "describe" },
        "qwen3-vl": { "input": ["text", "image"] }
      }
    }
  }
}
```

- `modelCapabilities.<model>.input` controls input modality hints shown in the Claude Code model picker/catalog.
- If an image request targets a text-only model and `imageFallback.enabled` is true, the helper can convert images to text descriptions.
- Unknown models are tried natively first; classify only models whose input behavior is known.

## Static catalog lane

Use `liveModels: false` when a provider catalog is too large or slow and Claude Code should see only pinned models.

```json
{
  "providers": {
    "openrouter": {
      "adapter": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "liveModels": false,
      "models": ["deepseek/deepseek-v4-flash", "qwen/qwen3-coder-plus"]
    }
  }
}
```

If `liveModels` is `false` and `models` is empty, the provider exposes no routed models.

## Capability fallback fields

`webSearchFallback` and `imageFallback` are helper paths inside the relay process, not separate daemons. Both can activate automatically when a compatible OpenAI Responses forward/key provider exists.

| Field | Applies to | Role |
| --- | --- | --- |
| `enabled` | both | Master switch. When omitted, compatibility with an available forward/key provider decides. |
| `model` | both | Helper model id. |
| `timeoutMs` | both | Helper fetch timeout in milliseconds. |
| `reasoning` | web search | Reasoning effort sent to the hosted-search helper; prefer light values such as `low` or `minimal`. |
| `maxSearchesPerTurn` | web search | Loop guard for hosted searches in one main-model turn. |

## Model mixing fields

`modelMixing` puts several providers/models behind the `frogp/mix` alias. It is disabled unless `enabled: true`, and it is never the auto-mode safety classifier. See the [Model Mixing](/frog-progsy/guides/model-mixing/) guide for worked examples.

| Field | Type | Role |
| --- | --- | --- |
| `enabled` | boolean | Master switch. Default false; when off, routing is unchanged and `frogp/mix` is not advertised. |
| `aliasId` | string | Model id that triggers mixing. Default `frogp/mix`. |
| `mode` | string | `coordinator` (an LLM picks using `guidance`) or `rules` (deterministic table, no extra call). Default `coordinator`. |
| `combine` | string | `route` (pick one), `fusion` (panel + judge + synthesizer), or `pipeline` (thinker → worker → verifier). Default `route`. |
| `coordinator` | object | `{ provider, model }` used to choose in route/coordinator mode and as the default fusion judge/synthesizer. |
| `agents` | array | Roster of `{ provider, model, tasks?, difficulty?, role?, notes? }` the coordinator may choose from; also the default fusion panel. |
| `guidance` | string | Natural-language routing guidance the coordinator reads. |
| `fusion` | object | `{ panel?: [{provider,model}] (1–8), judge?: {provider,model}, synthesizer?: {provider,model}, contextMode?: "task"|"full", judgeContextMode?: "task"|"full", panelWebSearch?: {...}, multiround?: {...} }`. Judge/synthesizer default to `coordinator`; panel defaults to `agents`. `contextMode`, `judgeContextMode`, `panelWebSearch`, and `multiround` are experimental pending frozen-suite acceptance. |
| `fusion.contextMode` | `"task"` \| `"full"` | Experimental. Panel prompt context: `task` preserves the latest-user-message-only prompt bytes; `full` embeds the system prompt and full message history. Default `task`. |
| `fusion.judgeContextMode` | `"task"` \| `"full"` | Experimental. Judge prompt context: `task` or `full`, independent from `fusion.contextMode`. Default `task`, even when panel context is `full`. |
| `fusion.panelWebSearch` | object | Experimental. Default disabled; active only when `enabled: true`. Panel-only synthetic/internal web search: `{ enabled?, maxSearchesPerPanel?, maxTotalSearches?, timeoutMs?, tiers? }`. `tiers` may contain only `fallback_model`, `search_api`, and `no_key`. It applies only to fusion panel members, never to judge/synthesizer and never as a client-visible tool. |
| `fusion.multiround` | object | Experimental. Default disabled; active only when `enabled: true`. Bounded branch/refine/score loop: `{ enabled?, maxRounds?, branchFactor?, budgetCalls? }`. When enabled, defaults start at `maxRounds: 2`, `branchFactor: 2`, and `budgetCalls: 12`. `budgetCalls` is a hard cap for answer/scoring calls; exceeding it triggers a loud fallback instead of silent extra work. |
| `pipeline` | array | Ordered `[{ role: "thinker"|"worker"|"verifier", provider, model }]` chain (deduped, capped at 3). |
| `rules` | array | Deterministic table `[{ match?: { taskKeywords?, difficulty?, hint? }, provider, model }]` matched (case-insensitive substring) against the task text; first match wins. |
| `surfaceStages` | boolean | Stream intermediate stages as live `thinking` blocks. Default true (opt out with false). |
| `timeoutMs` / `stageTimeoutMs` / `panelTimeoutMs` | number | Per-call / buffered pre-final stage / buffered panel-member timeouts. Default 15000. `stageTimeoutMs` and `panelTimeoutMs` apply only to buffered panel/judge/pipeline pre-final calls; they do not bound the final streamed synthesizer, which is governed only by client abort and SSE idle handling. |

Every degraded path is loud (a warning is logged), never silent, and the Claude Code-facing model id stays `frogp/mix`.

## Full example

```json
{
  "port": 10100,
  "hostname": "127.0.0.1",
  "defaultProvider": "anthropic",
  "providers": {
    "anthropic": {
      "adapter": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "authMode": "forward",
      "defaultModel": "claude-sonnet-4-6"
    },
    "openai-forward": {
      "adapter": "openai-responses",
      "baseUrl": "https://api.openai.com/v1",
      "authMode": "forward",
      "defaultModel": "gpt-5.5"
    },
    "codex": {
      "adapter": "openai-responses",
      "baseUrl": "https://chatgpt.com/backend-api/codex",
      "authMode": "oauth",
      "defaultModel": "gpt-5.5",
      "classifierModel": "gpt-5.4-mini"
    },
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "apiKey": "${OLLAMA_API_KEY}",
      "defaultModel": "glm-5.2",
      "models": ["glm-5.2", "gpt-oss", "qwen3-coder"],
      "modelCapabilities": {
        "glm-5.2": { "input": ["text"], "imageFallback": "describe" },
        "gpt-oss": { "input": ["text"], "imageFallback": "reject" },
        "qwen3-coder": { "input": ["text", "image"] }
      },
      "noReasoningModels": ["gpt-oss"]
    }
  },
  "subagentModels": ["anthropic/claude-sonnet-4-6", "ollama-cloud/glm-5.2"],
  "disabledModels": ["ollama-cloud/experimental-model"],
  "classifierFallback": {
    "provider": "codex",
    "model": "gpt-5.4-mini"
  },
  "webSearchFallback": {
    "enabled": true,
    "model": "gpt-5.5",
    "reasoning": "low",
    "maxSearchesPerTurn": 3,
    "timeoutMs": 30000
  },
  "imageFallback": {
    "enabled": true,
    "model": "gpt-5.5",
    "timeoutMs": 30000
  }
}
```

## Safe restore expectations

`frogp restore`, `frogp stop`, and `frogp uninstall` remove only Claude Code settings/catalog entries that FrogProgsy wrote. They do not delete unrelated Claude Code settings, history, or credentials. If state is tangled, follow the clean restore path in [Troubleshooting](/frog-progsy/guides/troubleshooting/).
