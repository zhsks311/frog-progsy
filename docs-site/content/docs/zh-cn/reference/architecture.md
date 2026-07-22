---
title: 架构
description: "FrogProgsy 本地数据平面完整契约：Claude Messages ingress、routing、adapters、stream bridge、catalog sync、capability fallbacks、safe logs、restore guardrails。"
---

本文档站点的 `/zh-cn/` 路径是 FrogProgsy 的官方完整文档表面。README 只覆盖第一次成功的 quickstart；runtime architecture 契约以本参考页为准。

FrogProgsy 是本地 Claude Code relay，不是通用云代理。主进程接收 Claude Code 的 Anthropic Messages traffic，选择 provider lane，再把 Claude Code 能理解的 Anthropic-compatible JSON 或 SSE 返回给 Claude Code。Provider 侧可以是 Anthropic、OpenAI-compatible chat、OpenAI Responses、Gemini、Azure OpenAI，或 in-process capability fallback helper path。

## Boundary map

```txt
Claude Code
  └─ Anthropic Messages ingress
      ├─ /v1/messages
      ├─ /v1/messages/count_tokens
      └─ dashboard + config 的 management /api/*

FrogProgsy core
  ├─ server.ts                    HTTP ingress, lifecycle, safe request/usage logs
  ├─ messages/parser.ts           Claude Messages → FrogParsedRequest
  ├─ router.ts                    model id → provider lane + adapter
  ├─ adapters/*                   provider wire builder + stream/JSON parser
  ├─ messages/bridge.ts           AdapterEvent → Claude Messages JSON/SSE
  ├─ claude-catalog.ts            Claude Code routed model alias materialization
  ├─ claude-inject.ts             owned env/settings injection + restore
  ├─ model-cache.ts               provider /models cache and stale fallback
  ├─ web-search-fallback/*                 hosted-search replacement capability fallback
  └─ image-fallback/*                     text-only lane 的 image-description capability fallback
```

## Data plane contract

Claude Code-facing ingress 是 Anthropic Messages。

| Route | Role |
| --- | --- |
| `/v1/messages` | Main Claude Code request path。支持 streaming 与 JSON response。 |
| `/v1/messages/count_tokens` | Claude Code token counting compatibility path。 |
| `/v1/models` | Active routed catalog view。`disabledModels` 会被排除。 |
| `/api/*` | Dashboard/config/diagnostic management path。本地运营表面。 |

FrogProgsy 不把 `/v1/responses` 做成 Claude Code-facing public ingress contract。Responses 是 provider-facing adapter protocol。

## Request lifecycle

1. `server.ts` 在 local port 接收 Claude Code traffic，并附加 request-log phase event。
2. `messages/parser.ts` 验证 Anthropic Messages payload，创建 `FrogParsedRequest`。
3. `router.ts` 将 request model id 解析为 configured provider、adapter、upstream model id。
4. 如果需要 web-search request 或 image capability fallback，in-process helper path 会在 main turn 前/中执行。
5. 选中的 adapter 构建 upstream HTTP request。Forward-auth adapter 只复制明确 allowlist header。
6. Provider output 被解析为 `AdapterEvent`：text、thinking、raw reasoning、tool-call、usage、error、done。
7. `messages/bridge.ts` 向 Claude Code 输出 Anthropic Messages JSON 或 SSE。
8. Claude Code cancellation 会同时中止 upstream request 与 helper request。

## Parser contract

`messages/parser.ts` 在 provider translation 前保留 Claude Code semantics。

- `system` block 变成 internal developer context。
- User/developer text 与 image part 变成 normalized content part。
- Assistant `text`、`thinking`、`redacted_thinking`、`tool_use` block 会作为 assistant content round-trip。
- User `tool_result` block 会关联到匹配的 `tool_use` id。
- `tools[]` 与 `tool_choice` 保留为 internal tool definition 和 choice policy。
- Anthropic `thinking.budget_tokens` 映射到 FrogProgsy reasoning effort level。
- Provider-internal Responses-shaped raw body 会被保留以复用 Responses-compatible lane，但不会成为 public ingress。

## Routing contract

Model id 解析基于 route prefix。

| Input model id | Resolution |
| --- | --- |
| `provider/model` | 路由到 `config.providers.provider` lane，并把 provider-owned `model` 发送到 upstream。 |
| `model` | 路由到 `defaultProvider` lane，并按 provider default/model id 解析。 |
| Disabled route | 从 catalog 与 `/v1/models` 隐藏，并阻止 picker 暴露。 |
| Unknown provider prefix | 返回 routing error 的 safe error payload。 |

`reasoning-effort.ts` 将 Claude Code 允许的 effort label 翻译为 provider wire value，clamp unsupported level，并在不能接收 effort 的 model 上完全移除该字段。

## Stream bridge

Bridge 拥有返回 Claude Code 的路径。它把 adapter event 转换为 Claude Code 期望的 Anthropic Messages stream shape。

| Adapter event | Claude Messages output |
| --- | --- |
| `text_delta` | text `content_block_start` → text `content_block_delta` → `content_block_stop` |
| `thinking_delta` / `reasoning_raw_delta` | summary 未隐藏时输出 thinking block delta |
| `tool_call_start` | 带 `tool_use` 的 `content_block_start` |
| `tool_call_delta` | Incremental `input_json_delta` |
| `tool_call_end` | 关闭 `tool_use` block，并设置 `stop_reason: "tool_use"` |
| `done` | `message_delta` 中的 final usage，然后 `message_stop` |
| `error` | Anthropic-style error payload，不包含 proxy stack trace |

上游静默时，bridge 会发送无害 SSE comment heartbeat（`: frogprogsy keepalive`），让 Claude Code 保持 stream open。Non-streaming response 也从同一 event sequence 组装，因此 streaming 与 JSON mode 共享一条 behavior path。

## Catalog and cache state

- `model-cache.ts` 为每个 provider 短期缓存 `/models` 结果；model endpoint 临时失败时使用 stale cache entry fallback。
- `claude-catalog.ts` 将 routed model materialize 到 Claude Code catalog。
- `subagentModels` 会优先放到 Claude Code subagent picker 前面。
- `disabledModels` 会从 injected catalog 与 `/v1/models` response 中排除。
- FrogProgsy 可从修改前创建的 backup 恢复 pristine catalog。

## Capability Fallbacks

Capability fallback 是 in-process path，即使目标 provider 不直接提供 capability，也能保持 Claude Code-facing behavior。

| Capability fallback | Module | Trigger | Contract |
| --- | --- | --- | --- |
| Web search capability fallback | `web-search-fallback/*` | Claude Code 请求 hosted `web_search` tool，但 routed provider 不能直接执行 | 使用 compatible OpenAI Responses forward/key provider 运行 bounded search loop，并向 main model 提供 compact result/tool_result。 |
| Image fallback | `image-fallback/*` | `modelCapabilities.<model>.input` 为 text-only 的 target model 收到 image input | 使用 vision-capable helper model 生成 image description，再向 main text-only lane 提供 safe text marker。 |

Capability fallback request 也遵循与 main adapter 相同的 auth-forwarding、timeout、abort、safe logging 规则。

## Management plane and dashboard

Dashboard 是本地运营表面。它显示 config provider lanes、route/default state、model catalog、safe request log、usage summary。查看失败请求时，dashboard log 只提供下列 safe metadata，而不是 prompt body 或 credential：

- request id
- phase/status
- provider/model route
- duration
- safe error summary
- provider-reported token usage 的 aggregate count（如果存在）

运营流程维护在 [`/zh-cn/guides/troubleshooting/`](/frog-progsy/zh-cn/guides/troubleshooting/)。

## Operational guardrails

FrogProgsy 只拥有自己写入的 settings 与 catalog entry。`frogp restore`、`frogp stop`、`frogp uninstall` 不会删除用户其他 Claude Code state，只移除 owned change。

Log privacy invariant:

- Request log 不保存 API key、OAuth token、request body、prompt、account identity。
- Usage accounting 只保存 request id、timestamp、provider、model、status、duration、provider-reported token count。
- Error response 会说明 upstream/provider failure，但不会暴露 proxy stack trace 或 credential material。

## Core type surface

Internal model 位于 `types.ts`：`FrogParsedRequest`、`FrogContext`、`FrogMessage`、`FrogContentPart`、`FrogToolCall`、`FrogTool`、`AdapterEvent`、`FrogConfig`、`FrogProviderConfig`。

`namespacedToolName()` 与 `modelInList()` 等 helper 让 adapter、capability fallback、catalog sync、test 中的 tool name 与 provider model list 保持一致。
