---
title: 首次 Relay 运行
description: "从 frogp start、dashboard Add Provider、默认 provider/model 选择，到第一条 Claude Code request 的首次成功路径。"
---

## 1. 启动 relay

```bash
frogp start
```

Relay 会在默认端口 `http://localhost:10100` 启动。如果端口已被占用，FrogProgsy 会选择空闲本地端口，并同步 Claude Code gateway settings 与 model catalog。

## 2. 打开 dashboard

```bash
frogp gui
```

Dashboard 打开后添加第一个 provider。

1. 点击 **Add Provider**。
2. 选择 built-in provider，或输入 custom OpenAI-compatible endpoint。
3. 粘贴 API key，或完成 Codex/ChatGPT、xAI、Kimi OAuth 登录。Claude 订阅访问留在 Claude Code 中；多个 Claude home 通过 `frogp claude` 管理。
4. 确认可用模型，并把这个 provider/model 设为默认值。

如果 provider 有 model-listing endpoint，模型列表会自动 discovery，并与 configured/catalog hint 合并。保存默认 provider/model 后，新 provider 无需重启即可使用。

## 3. 发送第一条 Claude Code request

```bash
claude "写一个 Rust hello world"
```

省略模型时，FrogProgsy 会 route 到 dashboard 中选择的默认 provider/model。

只有需要显式 route 时才使用 `provider/model` 形式。

```bash
claude -m "anthropic/claude-opus-4-8" "Explain this stack trace"
claude -m "codex/gpt-5.5" "Draft a migration plan"
```

## 首次运行不包含的运营路径

- `frogp init` 是需要 CLI wizard 环境的替代配置路径。
- `frogp restore` 与 `frogp uninstall` 是把 Claude Code 或本地 FrogProgsy 状态恢复到干净基线的恢复命令。
- 直接编辑 `~/.frogprogsy/config.json` 由 configuration reference 覆盖；provider catalog 选择由 provider guide 覆盖。

下一步：[请求生命周期](/frog-progsy/zh-cn/getting-started/how-it-works/) 或 [Provider 设置](/frog-progsy/zh-cn/guides/providers/)。
