---
title: 适配器
description: "FrogProgsy adapter 完整契约：provider protocol selection、request shaping、auth handling、stream parsing、Claude Messages bridge invariants。"
---

本文档站点的 `/zh-cn/` 路径是 FrogProgsy 的官方完整文档表面。README 只覆盖第一次成功的 quickstart；adapter/runtime 契约以本参考页为准。

FrogProgsy adapter 位于 Claude Code 的 Anthropic Messages ingress 与 `config.json` 中选择的 provider lane 之间。它们负责三件事：

1. 为一个协议族构建 upstream request。
2. 在不泄露 credential 的前提下读取 upstream stream 或 JSON response。
3. 输出 FrogProgsy `AdapterEvent`，让 bridge 可以再转换为 Claude Code 兼容的 Messages JSON/SSE。

源码入口是 `src/adapters/base.ts`。运行时契约刻意保持很小：`buildRequest(...)` 生成 `{ url, method, headers, body }`；`parseStream(...)` 与可选的 `parseResponse(...)` 将 upstream output 转换为 text、thinking、raw reasoning、tool-call、usage、error、done event。

## Adapter event contract

| Event | Meaning | Bridge obligation |
| --- | --- | --- |
| `text_delta` | Assistant visible text delta | 作为 Anthropic text content block 输出 |
| `thinking_delta` | 可 summary 的 reasoning/thinking text | 作为 thinking block 输出或应用隐藏策略 |
| `reasoning_raw_delta` | Provider raw reasoning trace | 尽可能保留到 thinking path，同时遵守 user-visible leak policy |
| `tool_call_start` | Tool call id/name start | 开始 Claude `tool_use` content block |
| `tool_call_delta` | Tool arguments JSON fragment | 作为 incremental `input_json_delta` 累积 |
| `tool_call_end` | Tool call end | 关闭 tool block 并设置 `stop_reason: "tool_use"` |
| `done` | 正常结束与 optional usage | 输出 final usage 与 `message_stop` |
| `error` | Upstream/protocol failure | 输出 Anthropic-style error payload，不包含 proxy stack trace |

所有 adapters 必须让 streaming 与 non-streaming 产生相同语义的 event sequence。

## Lane map

| Adapter id | Provider protocol | Auth modes | Contract |
| --- | --- | --- | --- |
| `openai-chat` | `/chat/completions` 兼容 API | `key` 或 local keyless | 通用 OpenAI-compatible routing、tool-call 修复、模型身份清理、provider option clamp |
| `openai-responses` | `/responses` 或 `/v1/responses` | `forward`, `key`, `oauth` | OpenAI Responses、ChatGPT/Codex backend、allowlisted forward headers、Responses item parsing |
| `anthropic` | `/v1/messages` | `key`, `forward` | Claude-native Messages、pass-through auth boundary、extended-thinking token budget、tool name compatibility |
| `google` | Gemini `generateContent` / `streamGenerateContent` | `key` | Gemini contents/parts、inline image conversion、synthetic tool-call id |
| `azure-openai` | Azure OpenAI Responses-compatible endpoint | `key` | Azure API-key header 与 `api-version` query handling。`azure` 是 legacy alias。 |

## Common invariants

- Adapter 不会把 API key、OAuth token、full prompt body 写入 log。
- Adapter 会把 provider-specific failure 转换为 bridge 可处理的 `error` event 或 safe error payload。
- Tool namespaced path 使用 `namespacedToolName(namespace, name)` 规则 flatten，并在 return path 恢复。
- Provider 拒绝的 option 会按 model/provider gate 移除或降级。不会把 unsupported 值原样发送。
- Claude Code ingress 是 Anthropic Messages。FrogProgsy 不会向 Claude Code public ingress 广告 `/v1/responses`。

## `openai-chat`: compatible chat lane

用于 xAI、Kimi、DeepSeek、GLM、Groq、OpenRouter、Ollama、vLLM、LM Studio 等 OpenAI-compatible Chat Completions endpoint。

Request shaping:

- Claude Code 的 developer/system context 会重排为 provider 能理解的 system/developer role message。
- Tool 会转换为带 namespace-safe 名称的 OpenAI function tool。
- Provider 可能拒绝的 standalone tool-result turn 会补成 synthetic assistant `tool_call`。
- Claude Code 的 GPT-5 identity line 会被中和，避免 routed non-OpenAI model 声称错误 vendor identity。
- Temperature、top-p、penalty、tool-choice mode、`reasoning_effort` 会按 provider/model 支持列表 gate。

Response parsing:

- Streaming delta 会折叠为 `text_delta`、optional `thinking_delta`、`tool_call_*`、usage event。
- Tool-call argument fragment 会按 JSON fragment 原样累积，但 bridge 必须能关闭为 Claude Messages shape。
- `preserveReasoningContentModels` 中的 model 会以 provider 期望的字段保留 assistant reasoning history。

## `openai-responses`: Responses upstream lane

用于 OpenAI Responses shape 或 ChatGPT/Codex OAuth backend。

Request target:

- `forward` mode 指向 `{baseUrl}/responses`，并且只从 incoming request 复制明确 allowlist header。
- `key` mode 通常指向 `{baseUrl}/v1/responses`。
- Codex backend URL 刻意使用 backend `/responses` route。

Request safety:

- 清理 reasoning input content，避免 raw reasoning echo 在后续 turn 中造成 backend 400。
- Codex backend request 只保留 FrogProgsy 可安全 replay 的字段：model、input、instructions、stream、tools、tool choice、`store: false`、bounded reasoning options。
- Forwarded header 受 allowlist 限制。Local FrogProgsy marker token 不会作为 upstream credential 转发。

Response parsing:

- Message output 变成 text event。
- Reasoning summary 变成 thinking event。
- Function/custom/search call output 变成 tool-call event。
- Usage block 附加到 final `done` event。

## `anthropic`: Claude-native lane

用于 Anthropic API key、Anthropic-compatible gateway 或 Claude Code pass-through profile。Claude Code 本身已使用 Anthropic Messages，因此 translation 最少，但仍需要为 local relay stability 做边界修正。

- Forward-auth request 会忽略 local `Bearer local-frogprogsy` marker token，只转发真实 Anthropic auth header。
- 只有显式配置 custom oauth-mode route 时，才会为了 built-in tool compatibility 添加或移除 tool name prefix。
- Tool-result image 保持 Anthropic native content block；orphan tool result 作为 text 保留，而不是发送 invalid standalone `tool_result`。
- Extended thinking 会调整 token，使 `max_tokens` 始终大于 `thinking.budget_tokens`；Anthropic 拒绝的 temperature/top-p 会被移除。

Stream parser 跟随 Anthropic event names（`content_block_start`, `content_block_delta`, `message_delta`, `message_stop`）并输出 FrogProgsy event。

## `google`: Gemini lane

用于 Gemini API。请求会重建为 Gemini `contents[]`：

- System prompt 变成 `systemInstruction`。
- Assistant turn 变成 Gemini `model` turn。
- Tool 变成 `functionDeclarations`。
- Data-URL image 变成 `inline_data`。
- Remote image 因缺少 MIME data，会降级为小 marker。

Gemini 不返回与 Claude Code 同形状的 stable tool-call id，因此 FrogProgsy 会创建 relay-local call id 再交给 bridge。

## `azure-openai`: Azure wrapper lane

Azure 复用 Responses adapter 的 request/response handling，然后只调整 wire shape：

- `Authorization` 替换为 `api-key`。
- URL 不是 `/v1/` route 时追加 `api-version` query。
- provider header 没有覆盖时，默认 API version 是 `2025-04-01-preview`。

## Image helper utilities

`src/adapters/image.ts` 包含共享 media helper：

- `parseDataUrl(url)` 将 Claude Code inline image 拆分为 Anthropic/Gemini 使用的 `{ mediaType, base64 }`。
- `contentPartsToText(content)` 为 text-only tool-result lane flatten content；未描述的 image 会变成 `[image]` marker，而不是把 base64 倒进 prompt。

## 新 adapter checklist

添加新 adapter 时，先对齐 runtime contract，而不是写 public recipe。

1. 实现 `ProviderAdapter`，并让 `name` 与 config `adapter` id 一致。
2. 在 `buildRequest` 中按 provider protocol 限制 auth header、URL 与 body field。
3. 让 streaming parser 与 non-streaming parser 产生相同的 `AdapterEvent` 语义。
4. 保留 tool-call start/delta/end、reasoning、usage、error path，且都能 bridge。
5. 同步更新 `server.ts` adapter resolver 与 provider registry/catalog metadata。
6. 更新 zh-CN docs-site `/zh-cn/reference/adapters/` 与 `/zh-cn/reference/configuration/` 的 adapter id 契约。
