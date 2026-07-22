---
title: Claude Code App 模型选择器
description: frogprogsy 模型如何通过 gateway model discovery alias 出现在 Claude Code App、CLI、TUI 中。
---

FrogProgsy 的完整运营文档以 docs-site 的 `/zh-cn/` 路径为准。本 guide 聚焦于在 Claude Code App/CLI/TUI 中显示 routed model，以及选择器 stale 时的重新同步流程。

frogprogsy 不会 patch Claude Code App。它会向 Claude Code settings 写入 owned env key，并在本地 gateway 提供 Anthropic-style `/v1/models` discovery。Claude Code CLI/TUI/App 使用同一个 gateway discovery，因此 routed model 会以稳定 alias 显示。

## 运营路径

`frogp init`、`frogp start` 和 `frogp claude` profile action 会保持下面这些本地文件一致：

```text
<profile-home>/settings.json
~/.frogprogsy/claude-profiles/<cp_id>/claude-settings-backup.json
~/.frogprogsy/model-aliases.json
```

Settings injection 只写 owned env key：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:10100",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  }
}
```

Model discovery 返回 `claude-frogp-provider-model` 这样的 alias（仅当两个模型规整为同一名称时才附加短 hash 后缀），每个 `display_name` 保留精确的 `provider/model` route key。Operator-facing 文档与 runbook 应记录这个 route key，而不是选择器 alias。

Responses WebSocket support 在 Claude Messages 中已 retired。frogprogsy 不会广告 `supports_websockets`，Claude Code gateway traffic 使用 HTTP/SSE。

## 路由模型为什么会显示在选择器中

Claude Code model picker 期望 Claude Code shape 的 catalog entry。frogprogsy 会复制 native Claude Code model template，然后只替换 routed model identity：

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

复制出的 entry 会保留 reasoning level、shell type、API support flags、base instructions 等 strict parser fields。因此每个 routed entry 看起来都是可显示在选择器中的有效 Claude Code model。

## Subagent selection 决策

Claude Code 的 `spawn_agent` 只暴露 catalog 中优先级最高的前 5 个 model。通过 `subagentModels` 或 web dashboard 选择最多 5 个 `provider/model` 或 native model id 后，frogprogsy 会把这些 entry 排到 catalog 前面。

## 刷新 stale model state

如果选择器中残留旧 entry，请为目标 profile 重新加载 catalog，然后启动新的 Claude Code session 或 resume 现有 session，让 Claude Code 重新获取 `/v1/models`：

```bash
frogp claude reload-models <profile-id>
```

已经打开的 `/model` screen 不会在 catalog 改变后 hot reload。关闭该选择器，并从新启动或 resume 的 Claude Code session 中重新打开。Dashboard/API list reload 与 Claude Code picker recovery 是分开的：它用于 web/API view，不能替代 `frogp claude reload-models <profile-id>`。如果本地 proxy 已 down，请先用 `frogp refresh` 恢复，再重新加载 Claude Code picker。
