---
title: Architecture
description: "FrogProgsy local data plane contract: Claude Messages ingress, routing, adapters, stream bridge, catalog sync, capability fallbacks, safe logs, and restore guardrails."
---

This docs site is FrogProgsy's official full documentation surface. The README stays limited to first-success quickstart; runtime architecture contracts live here.

FrogProgsy does not provide hosted/cloud deployment; it runs as a local Claude Code relay. The main process accepts Claude Code's Anthropic Messages traffic, chooses a provider lane, and returns Anthropic-compatible JSON or SSE back to Claude Code. The provider side can be Anthropic, OpenAI-compatible chat, OpenAI Responses, Gemini, Azure OpenAI, or an in-process capability fallback helper path.

## Boundary map

```txt
Claude Code
  └─ Anthropic Messages ingress
      ├─ /v1/messages
      ├─ /v1/messages/count_tokens
      └─ management /api/* for dashboard + config

FrogProgsy core
  ├─ server.ts                    HTTP ingress, lifecycle, safe request/usage logs
  ├─ messages/parser.ts           Claude Messages → FrogParsedRequest
  ├─ router.ts                    model id → provider lane + adapter
  ├─ adapters/*                   provider wire builder + stream/JSON parser
  ├─ messages/bridge.ts           AdapterEvent → Claude Messages JSON/SSE
  ├─ claude-catalog.ts            routed model alias materialization for Claude Code
  ├─ claude-inject.ts             owned env/settings injection + restore
  ├─ model-cache.ts               provider /models cache and stale fallback
  ├─ web-search-fallback/*                 hosted-search replacement capability fallback
  └─ image-fallback/*                     image-description capability fallback for text-only lanes
```

## Data plane contract

Claude Code-facing ingress is Anthropic Messages.

| Route | Role |
| --- | --- |
| `/v1/messages` | Main Claude Code request path. Supports streaming and JSON responses. |
| `/v1/messages/count_tokens` | Claude Code token-counting compatibility path. |
| `/v1/models` | Active routed catalog view. `disabledModels` are excluded. |
| `/api/*` | Dashboard/config/diagnostic management path. Local operations surface. |

FrogProgsy does not make `/v1/responses` a Claude Code-facing public ingress contract. Responses is a provider-facing adapter protocol.

## Request lifecycle

1. `server.ts` accepts Claude Code traffic on the local port and attaches request-log phase events.
2. `messages/parser.ts` validates the Anthropic Messages payload and creates a `FrogParsedRequest`.
3. `router.ts` resolves the requested model id to a configured provider, adapter, and upstream model id.
4. If web-search or image capability fallback work is needed, an in-process helper path runs before or during the main turn.
5. The selected adapter builds the upstream HTTP request. Forward-auth adapters copy only explicit allowlisted headers.
6. Provider output is parsed into `AdapterEvent`s: text, thinking, raw reasoning, tool-call, usage, error, and done.
7. `messages/bridge.ts` emits Anthropic Messages JSON or SSE back to Claude Code.
8. When Claude Code cancels a request, upstream and helper requests are aborted too.

## Parser contract

`messages/parser.ts` preserves Claude Code semantics before provider translation.

- `system` blocks become internal developer context.
- User/developer text and image parts become normalized content parts.
- Assistant `text`, `thinking`, `redacted_thinking`, and `tool_use` blocks round-trip as assistant content.
- User `tool_result` blocks are linked to matching `tool_use` ids.
- `tools[]` and `tool_choice` are preserved as internal tool definitions and choice policy.
- Anthropic `thinking.budget_tokens` maps to FrogProgsy reasoning effort levels.
- Provider-internal Responses-shaped raw bodies are retained for Responses-compatible lanes, but do not become public ingress.

## Routing contract

Model ids resolve by route prefix.

| Input model id | Resolution |
| --- | --- |
| `provider/model` | Routes to `config.providers.provider` and sends provider-owned `model` upstream. |
| `model` | Routes to `defaultProvider` and resolves as that provider's default/model id. |
| Disabled route | Hidden from catalog and `/v1/models`, preventing picker exposure. |
| Unknown provider prefix | Returns a routing error as a safe error payload. |

`reasoning-effort.ts` translates Claude Code effort labels to provider wire values, clamps unsupported levels, and removes effort entirely for models that cannot receive it.

## Stream bridge

The bridge owns the return path to Claude Code. It converts adapter events into the Anthropic Messages stream shape Claude Code expects.

| Adapter event | Claude Messages output |
| --- | --- |
| `text_delta` | text `content_block_start` → text `content_block_delta` → `content_block_stop` |
| `thinking_delta` / `reasoning_raw_delta` | thinking block deltas when summaries are not hidden |
| `tool_call_start` | `content_block_start` with `tool_use` |
| `tool_call_delta` | incremental `input_json_delta` |
| `tool_call_end` | closes the `tool_use` block and sets `stop_reason: "tool_use"` |
| `done` | final usage in `message_delta`, then `message_stop` |
| `error` | Anthropic-style error payload without proxy stack traces |

During upstream silence, the bridge sends a harmless SSE comment heartbeat (`: frogprogsy keepalive`) so Claude Code keeps the stream open. Non-streaming replies are assembled from the same event sequence, so streaming and JSON modes share one behavior path.

## Catalog and cache state

- `model-cache.ts` keeps short-lived `/models` results per provider and falls back to stale cache entries when a model endpoint temporarily fails.
- `claude-catalog.ts` materializes routed models into Claude Code's catalog.
- `subagentModels` are placed first in Claude Code's subagent picker.
- `disabledModels` are excluded from the injected catalog and `/v1/models` response.
- FrogProgsy can restore the pristine catalog from the backup made before it touched it.

## Capability Fallbacks

Capability Fallbacks are in-process paths that keep Claude Code-facing behavior stable when the target provider lacks a native capability.

| Capability fallback | Module | Trigger | Contract |
| --- | --- | --- | --- |
| Web search capability fallback | `web-search-fallback/*` | Claude Code requests the hosted `web_search` tool, but the routed provider cannot execute it directly. | Uses a compatible OpenAI Responses forward/key provider to run a bounded search loop and provide compact result/tool_result content to the main model. |
| Image fallback | `image-fallback/*` | Image input targets a model whose `modelCapabilities.<model>.input` is text-only. | Uses a vision-capable helper model to describe the image, then supplies a safe text marker to the main text-only lane. |

Capability fallback requests follow the same auth-forwarding, timeout, abort, and safe logging rules as main adapter requests.

## Management plane and dashboard

The dashboard is a local operations surface. It shows config provider lanes, route/default state, model catalog, safe request logs, and usage summaries. When inspecting failed requests, dashboard logs provide safe metadata rather than prompt bodies or credentials:

- request id;
- phase/status;
- provider/model route;
- duration;
- safe error summary;
- aggregate provider-reported token usage when available.

Operational procedures live in [Troubleshooting](/frog-progsy/guides/troubleshooting/).

## Operational guardrails

FrogProgsy owns only the settings and catalog entries it writes. `frogp restore`, `frogp stop`, and `frogp uninstall` remove owned changes without deleting other Claude Code state.

Log privacy invariant:

- Request logs do not store API keys, OAuth tokens, request bodies, prompts, or account identities.
- Usage accounting stores only request id, timestamp, provider, model, status, duration, and provider-reported token counts.
- Error responses describe upstream/provider failure without proxy stack traces or credential material.

## Core type surface

The internal model lives in `types.ts`: `FrogParsedRequest`, `FrogContext`, `FrogMessage`, `FrogContentPart`, `FrogToolCall`, `FrogTool`, `AdapterEvent`, `FrogConfig`, and `FrogProviderConfig`.

Helpers such as `namespacedToolName()` and `modelInList()` keep tool names and provider model lists consistent across adapters, capability fallbacks, catalog sync, and tests.
