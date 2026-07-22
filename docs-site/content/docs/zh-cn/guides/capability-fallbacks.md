---
title: Capability Fallbacks
description: "当路由模型缺少原生能力时，FrogProgsy 如何用显式的进程内 helper 处理 hosted search 和图像描述。"
---

FrogProgsy 优先使用 provider 的原生能力。Claude、OpenAI、Grok、Gemini 以及许多路由模型已经能用自己的 wire format 处理图像或 hosted tools；这些路径保持原生，不会插入 fallback。

Capability fallback 只面向更窄的情况：所选路由模型是 text-only，或不能执行 Claude Code 的 hosted `web_search` tool。这些 helper 是**进程内 fallback call**，不是外部 app、container 或 daemon。

> **Fallback 需要显式启用**
>
> `webSearchFallback` 和 `imageFallback` 默认关闭。它们需要 OpenAI Responses `forward` provider，以及来自请求的 forwarded authorization。

## 决策策略

| 请求条件 | FrogProgsy 行为 |
| --- | --- |
| 所选模型支持该能力 | 使用原生 provider path |
| 能力未知 | 先尝试原生路径，不静默降级 |
| text-only 模型收到图像且 `imageFallback.enabled` 为 false | 返回清晰的 400，说明模型不能接收图像 |
| text-only 模型收到图像且 `imageFallback.enabled` 为 true | 用配置的 helper model 描述图像，再把文本交给路由模型 |
| 请求 hosted search 且 `webSearchFallback.enabled` 为 false | 不广告也不运行 synthetic search |
| 请求 hosted search 且 `webSearchFallback.enabled` 为 true | 在有 forwarded credentials 或已配置 API key 的 OpenAI Responses provider 时运行 bounded synthetic-tool loop |

## Web-search fallback

当 Claude Code 请求 hosted `web_search`，但所选路由模型不能执行该 hosted tool 时，FrogProgsy 可以向路由模型暴露一个合成函数 `web_search(query)`。

Loop 会保持很小且有边界：

1. 从发往 provider 的请求中移除 hosted search tool；
2. 让路由模型决定是否需要 `web_search(query)`；
3. 通过配置的 helper model 执行真实 hosted search；
4. 将 citations 和摘要 findings 作为 tool result 注入；
5. 直到模型回答或达到 `maxSearchesPerTurn`。

| Phase | Actor | 发生什么 |
| --- | --- | --- |
| Hosted tool request | Claude Code → FrogProgsy | Claude Code 发送包含 hosted `web_search` 的请求。 |
| Tool substitution | FrogProgsy | FrogProgsy 移除不可执行的 hosted tool，并暴露 synthetic `web_search(query)`。 |
| Decision | Routed model | 路由模型调用搜索或不搜索直接回答。 |
| Fallback execution | OpenAI Responses helper provider | Helper model 在 `maxSearchesPerTurn` 和 `timeoutMs` 内执行 hosted search。 |
| Reinjection | FrogProgsy → routed model | FrogProgsy 返回 capped citations/findings 作为 tool result，并恢复路由 turn。 |

Shell、patch、MCP 等真实 Claude Code tool call 不会被 loop 吞掉；出现这些调用时，turn 会结束并交给 Claude Code。

```json
{
  "webSearchFallback": {
    "enabled": true,
    "model": "gpt-5.4-mini",
    "reasoning": "low",
    "maxSearchesPerTurn": 3,
    "timeoutMs": 30000
  }
}
```

搜索结果会被标记为 untrusted data、限制长度，并按 URL 去重。Structured-output turn 会收到 compact JSON，避免破坏请求的 schema。

## Image fallback

当所选模型被明确标记为 text-only 时，FrogProgsy 可以在主调用前描述图像。路由模型会收到长度受限的文本描述，而不是 raw image parts。

- 支持 user images 和 tool-result images。
- Data URL 必须通过允许的 image type 和 size limit。
- `https:` 图像 URL 会传给 helper backend；FrogProgsy 不会自行下载。
- 描述以 bounded concurrency 执行，并保留原始 message order。
- Model capability entry matching 会容忍 Ollama-style `:size` suffix。

```json
{
  "imageFallback": {
    "enabled": true,
    "model": "gpt-5.4-mini",
    "timeoutMs": 45000
  }
}
```

显式标记 provider/model capabilities：

```json
{
  "providers": {
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "modelCapabilities": {
        "glm-5.2": { "input": ["text"] },
        "gpt-oss": { "input": ["text"] },
        "kimi-k2.7-code": { "input": ["text", "image"] }
      }
    }
  }
}
```

## 关闭 helper

省略 `enabled` 或设置为 `false` 即可。完整字段见 [配置](/frog-progsy/zh-cn/reference/configuration/#capability-fallback-fields)。
