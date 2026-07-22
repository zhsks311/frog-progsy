---
title: Adapters
description: "Complete FrogProgsy adapter contract: provider protocol selection, request shaping, auth handling, stream parsing, and Claude Messages bridge invariants."
---

This docs site is FrogProgsy's official full documentation surface. The README stays limited to first-success quickstart; adapter and runtime contracts live here.

FrogProgsy adapters sit between Claude Code's Anthropic Messages ingress and the provider lane selected in `config.json`. They have three jobs:

1. build the upstream request for one protocol family;
2. read the upstream stream or JSON response without leaking credentials;
3. emit FrogProgsy `AdapterEvent`s that the bridge can turn back into Claude Code-compatible Messages JSON or SSE.

The source entry point is `src/adapters/base.ts`. The runtime contract is intentionally small. `buildRequest(...)` creates `{ url, method, headers, body }`, while `parseStream(...)` and optional `parseResponse(...)` convert upstream output into text, thinking, raw reasoning, tool-call, usage, error, and done events.

## Adapter event contract

| Event | Meaning | Bridge obligation |
| --- | --- | --- |
| `text_delta` | Assistant visible text delta | Emit an Anthropic text content block. |
| `thinking_delta` | Reasoning/thinking text that can be summarized | Emit a thinking block or apply the hide-summary policy. |
| `reasoning_raw_delta` | Provider raw reasoning trace | Preserve through the thinking path when possible while respecting user-visible leak policy. |
| `tool_call_start` | Tool call id/name start | Start a Claude `tool_use` content block. |
| `tool_call_delta` | Tool arguments JSON fragment | Accumulate as incremental `input_json_delta`. |
| `tool_call_end` | Tool call end | Close the tool block and set `stop_reason: "tool_use"`. |
| `done` | Normal completion with optional usage | Emit final usage and `message_stop`. |
| `error` | Upstream/protocol failure | Emit an Anthropic-style error payload without proxy stack traces. |

Every adapter must keep streaming and non-streaming output semantically equivalent.

## Lane map

| Adapter id | Provider protocol | Auth modes | Contract |
| --- | --- | --- | --- |
| `openai-chat` | `/chat/completions` compatible APIs | `key` or local keyless | Generic OpenAI-compatible routing, tool-call repair, model identity cleanup, and provider option clamps. |
| `openai-responses` | `/responses` or `/v1/responses` | `forward`, `key`, `oauth` | OpenAI Responses, ChatGPT/Codex backend, allowlisted forward headers, and Responses item parsing. |
| `anthropic` | `/v1/messages` | `key`, `forward` | Claude-native Messages, pass-through auth boundaries, extended-thinking token budget, and tool-name compatibility. |
| `google` | Gemini `generateContent` / `streamGenerateContent` | `key` | Gemini contents/parts, inline image conversion, and synthetic tool-call ids. |
| `azure-openai` | Azure OpenAI Responses-compatible endpoint | `key` | Azure API-key header and `api-version` query handling. `azure` is a legacy alias. |

## Common invariants

- Adapters do not log API keys, OAuth tokens, or full prompt bodies.
- Provider-specific failures become bridge-handled `error` events or safe error payloads.
- Tool namespace paths are flattened with `namespacedToolName(namespace, name)` and restored on the return path.
- Provider-rejected options are removed or lowered by provider/model gates. Unsupported values are not sent unchanged.
- Claude Code ingress is Anthropic Messages. FrogProgsy does not advertise `/v1/responses` as a Claude Code-facing public ingress.

## `openai-chat`: compatible chat lane

Use this lane for OpenAI-compatible Chat Completions endpoints such as xAI, Kimi, DeepSeek, GLM, Groq, OpenRouter, Ollama, vLLM, and LM Studio.

Request shaping:

- Claude Code developer/system context is relocated into provider-understood system/developer role messages.
- Tools become OpenAI function tools with namespace-safe names.
- Standalone tool-result turns that providers may reject are repaired with a synthetic assistant `tool_call`.
- Claude Code's GPT-5 identity line is neutralized so routed non-OpenAI models do not claim the wrong vendor.
- Temperature, top-p, penalties, tool-choice mode, and `reasoning_effort` are gated by provider/model support lists.

Response parsing:

- Streaming deltas fold into `text_delta`, optional `thinking_delta`, `tool_call_*`, and usage events.
- Tool-call argument fragments are accumulated as JSON fragments that the bridge can close into Claude Messages shape.
- Models listed in `preserveReasoningContentModels` keep assistant reasoning history in the field expected by that provider.

## `openai-responses`: Responses upstream lane

Use this lane for OpenAI Responses shape or ChatGPT/Codex OAuth backend traffic.

Request target:

- `forward` mode targets `{baseUrl}/responses` and copies only explicit allowlisted headers from the incoming request.
- `key` mode usually targets `{baseUrl}/v1/responses`.
- Codex backend URLs intentionally use the backend `/responses` route.

Request safety:

- Reasoning input content is sanitized so raw reasoning echoes do not cause backend 400s on later turns.
- Codex backend requests keep only fields FrogProgsy can safely replay: model, input, instructions, stream, tools, tool choice, `store: false`, and bounded reasoning options.
- Forwarded headers are allowlisted. The local FrogProgsy marker token is not forwarded as an upstream credential.

Response parsing:

- Message output becomes text events.
- Reasoning summaries become thinking events.
- Function, custom, and search call output becomes tool-call events.
- Usage blocks attach to the final `done` event.

## `anthropic`: Claude-native lane

Use this lane for Anthropic API keys, Anthropic-compatible gateways, or Claude Code pass-through profiles. Translation is minimal because Claude Code already speaks Anthropic Messages, but relay-stability repairs still matter.

- Forward-auth requests ignore the local `Bearer local-frogprogsy` marker token and forward only real Anthropic auth headers.
- Tool names can be prefixed or stripped for built-in tool compatibility when an explicit custom oauth-mode route exists.
- Tool-result images stay as Anthropic native content blocks; orphan tool results are preserved as text instead of invalid standalone `tool_result` blocks.
- Extended thinking adjusts `max_tokens` so it always exceeds `thinking.budget_tokens`, and removes temperature/top-p values Anthropic would reject.

The stream parser follows Anthropic event names (`content_block_start`, `content_block_delta`, `message_delta`, `message_stop`) and emits FrogProgsy events.

## `google`: Gemini lane

Use this lane for Gemini APIs. Requests are rebuilt as Gemini `contents[]`:

- system prompt becomes `systemInstruction`;
- assistant turns become Gemini `model` turns;
- tools become `functionDeclarations`;
- data-URL images become `inline_data`;
- remote images fall back to a small marker because Gemini needs MIME data that a plain URL does not provide.

Gemini does not return stable tool-call ids in Claude Code's shape, so FrogProgsy creates relay-local call ids before handing calls to the bridge.

## `azure-openai`: Azure wrapper lane

Azure reuses the Responses adapter's request/response handling, then adjusts the wire shape:

- `Authorization` is replaced with `api-key`;
- `api-version` is appended when the URL is not already a `/v1/` route;
- the default API version is `2025-04-01-preview` unless provider headers override it.

## Image helper utilities

`src/adapters/image.ts` contains shared media helpers:

- `parseDataUrl(url)` splits Claude Code inline images into `{ mediaType, base64 }` for Anthropic and Gemini.
- `contentPartsToText(content)` flattens text-only tool-result lanes and replaces an undescribed image with `[image]` instead of dumping base64 into the prompt.

## New adapter checklist

When adding an adapter, satisfy the runtime contract before writing user recipes.

1. Implement `ProviderAdapter` and make `name` match the config `adapter` id.
2. Limit auth headers, URL, and body fields in `buildRequest` to the provider protocol.
3. Keep streaming and non-streaming parsers semantically equivalent at the `AdapterEvent` level.
4. Preserve tool-call start/delta/end, reasoning, usage, error, abort, and timeout paths in bridgeable form.
5. Update the `server.ts` adapter resolver and provider registry/catalog metadata together.
6. Update root `/reference/adapters/` and `/reference/configuration/` when the adapter id contract changes.
