# Transports And Sidecars SOT

## Messages HTTP/SSE

`POST /v1/messages` is the main Claude Code-facing endpoint. `POST /v1/messages/count_tokens` handles token
estimates, and `GET /v1/models` serves gateway-discovery model lists. The server parses Anthropic Messages input,
routes to a provider/model, lets the selected adapter speak the upstream protocol, then bridges internal
`AdapterEvent` values back to Anthropic Messages SSE.

Native OpenAI/ChatGPT model routes still use the `openai-responses` upstream adapter internally, but that is an
upstream implementation detail. The public Claude Code inbound OpenAI Responses route is retired: `POST
/v1/responses` returns `410` and tells callers to use `/v1/messages`.

OpenAI/ChatGPT forward routes use `authMode:"forward"` and forward only the allowed Claude Code/OpenAI auth/session
headers. Anthropic forward routes use the `anthropic` adapter and forward only real `Authorization` or `x-api-key`
values; the local `local-frogprogsy` marker is stripped before upstream traffic.

## WebSocket

The old Responses WebSocket upgrade path at `/v1/responses` is retired and returns `410`. `websocketsEnabled()`
is currently hard-disabled, so Claude Code stays on HTTP/SSE. Routed catalog entries must not advertise WebSocket
support.

## Heartbeat and stall deadline

The Messages SSE bridge emits `: frogprogsy keepalive` comments during upstream silence to re-arm Claude Code's
idle timer. A bounded stall deadline (150 ticks = 5 minutes at the default 2 s interval) closes the stream and
cancels the upstream request if no real events arrive, preventing indefinitely hung connections.

## Reasoning and tool-result compatibility

Native OpenAI Responses upstream sanitizes routed reasoning history so `reasoning` input items do not send
non-empty `content` arrays to upstream models that reject them. Chat Completions bridging repairs
orphan `toolResult` messages by inserting a synthetic assistant `tool_call` before tool messages.

These compatibility guards are covered by focused tests and should stay close to the adapters that
need them.

## Sidecars

Web search and vision sidecars only run when the main request needs that capability and a configured
OpenAI Responses helper provider is available. Eligible helpers are `authMode: "forward"` providers
with usable incoming authorization, `authMode: "oauth"` providers with a stored refreshable login, or
API-key-backed OpenAI Responses providers.

| Sidecar | Default model | Activation |
| --- | --- | --- |
| `web-search/` | `gpt-5.4-mini` | Hosted `web_search` requested by a routed model that cannot run it natively. |
| `vision/` | `gpt-5.4-mini` | Image input targets a model whose `modelCapabilities.input` is text-only. |

Sidecar failures must degrade to text markers or skipped capability, not abort the main request.
