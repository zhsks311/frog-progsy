---
title: 模型路由
description: "FrogProgsy 如何为每个 Claude Code model request 选择 provider lane，并让 alias、short id 与 fallback 可预测。"
---

FrogProgsy 的完整运营文档以 docs-site 的 `/zh-cn/` 路径为准。本 guide 只覆盖 operator 判断“这个 request 为什么去了这个 provider？”的流程。

FrogProgsy 把所有 model id 都视为 routing lookup。无论 Claude Code 发送 gateway alias、`provider/model` route、short upstream id，还是 native-looking family name，都会在 adapter 执行前化简为一个 provider 与一个 upstream model。

## Operator 看到的 lookup order

| Step | Match | Result |
| --- | --- | --- |
| 1 | `model-aliases.json` 中的 gateway alias | 将 `claude-frogp-…` reverse-map 为保存的 `provider/model` route |
| 2 | 显式 `provider/model` | 选择 provider，并移除 prefix 后发送 model id 到 upstream |
| 3 | provider `defaultModel` | 使用 default 与 request id 完全一致的 provider |
| 4 | provider `models[]` | 使用显式拥有该 id 的 provider |
| 5 | built-in family prefix | 将 common family route 到已配置的 `anthropic`、`openai`、`groq` 等 provider |
| 6 | `defaultProvider` | 最后 fallback；model id 原样发送 |

如果无法解析且没有 default provider，FrogProgsy 会早失败，而不是猜测。

## 运营默认：优先使用显式 route

```txt
anthropic/claude-sonnet-4-6  → provider: anthropic    upstream model: claude-sonnet-4-6
codex/gpt-5.5                → provider: codex        upstream model: gpt-5.5
local-test/local-model       → provider: local-test   upstream model: local-model
```

Claude Code picker 可能显示 stable alias，但 `display_name` 会保留用于调试的原始 `provider/model` route。Dashboard 添加 provider 后，runbook、issue、内部文档也应优先记录显式 route；即使 provider catalog 重叠也更安全。

## Short id 需要 owner

`gpt-5.5` 这样的 short id 很方便，但只有一个 provider 明确拥有它时才安全。请用 `defaultModel` 或 `models[]` 指定 owner。

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

`defaultModel` 优先于 `models[]`。Prefix routing 只是 common family 的便利功能，不会创建未配置的 provider。

## Secret 在 route 之后解析

```json
{
  "apiKey": "${OPENAI_API_KEY}"
}
```

`resolveEnvValue()` 在构建 request 时展开 `${NAME}` 与 `$NAME`。因此 config file 可以在没有真实 secret 的情况下共享。

## Route debugging 顺序

1. 在 dashboard request log 中查看 chosen model、provider、status、endpoint、phase、safe error code。
2. 区分 request model 是 `provider/model`、gateway alias，还是 short id。
3. 检查静态 config 的 `defaultProvider`、各 provider 的 `defaultModel`、`models[]`、`disabledModels`。
4. 如果涉及 alias，检查 `~/.frogprogsy/model-aliases.json`。
5. 仍无法解决时，进入 [配置参考](/frog-progsy/zh-cn/reference/configuration/) 的对应字段。
