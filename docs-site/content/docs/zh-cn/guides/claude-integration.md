---
title: Claude Code 接入
description: "FrogProgsy 拥有的本地 hook：settings env key、gateway discovery、catalog alias、subagent ranking、clean restore。"
---

FrogProgsy 的完整运营文档以 docs-site 的 `/zh-cn/` 路径为准。本 guide 聚焦于 FrogProgsy 会写入 Claude Code 的内容、不会写入的内容，以及出现问题时如何恢复。

FrogProgsy 通过 Claude Code 已经读取的 gateway path 接入。它不 patch Claude Code binary，也不会在 active integration path 中向 `config.toml` 安装 `model_provider` table。不过它会生成 launcher shim，让日常使用可以走 `claude`、`claude-work` 等命令，而不是要求用户输入 `frogp claude run`。

## 只写 owned settings

`frogp init`、`frogp start` 和 startup path 只会在 `~/.claude/settings.json` 的 `env` 下写入 FrogProgsy-owned key。

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:10100",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  }
}
```

无关 settings 不会被改动。首次写入前，owned key 的旧值会按 profile 保存到 `~/.frogprogsy/claude-profiles/<cp_id>/claude-settings-backup.json`，restore path 会只为该 profile 精确还原这些值。即使没有 backup，restore 也只移除能明确识别为 FrogProgsy 残留的条目：和 gateway discovery 一起留下的 local `ANTHROPIC_BASE_URL`、可选的本地 FrogProgsy auth marker、`X-Frogp-Claude-Profile` header，以及当前或历史 release 创建的 routed default model alias。无关 settings 不会被删除，因此 Claude Code account connector 会继续工作。

## 用 gateway discovery 显示模型

Gateway discovery 启用后，Claude Code 会调用 local relay 的 `/v1/models`。FrogProgsy 返回 Claude Code 可接受的 Anthropic-style alias。
Claude Code 会在 session start 或 resume 时重新请求 `/v1/models`；仅重新打开已经打开的 `/model` screen 不会让 picker hot reload。

```txt
claude-frogp-codex-gpt-5-5
```

人类可读的 `display_name` 会保留 `codex/gpt-5.5` 这样的原始 route key。Alias state 存在 `~/.frogprogsy/model-aliases.json`；文件缺失时，router 仍可根据配置重建 alias。Claude Messages traffic 使用 HTTP/SSE；此 Claude Code integration 不会广告旧 Responses WebSocket path。
模型变更后要恢复 Claude Code picker，请运行 `frogp claude reload-models <profile-id>`；proxy 曾经 down、需要恢复 proxy-side model list 时使用 `frogp refresh`。

要显示 Anthropic Claude alias，frogprogsy 中必须有 Anthropic provider 行。forward-auth mode 下，这一行不
存储 Claude token；模型列表 discovery 可以使用当前 Claude Code home 发送的真实 `Authorization` 或 `x-api-key`，
并按 `X-Frogp-Claude-Profile` 缓存结果。如果没有配置 Anthropic 行，Claude Code 原生 Claude 账号仍然存在，
但 frogprogsy 没有可在 Model Picker 或 Model Mixing 中展示的 routed Anthropic model。

## 默认 forward 与可选 isolated grant

上面描述的 forward-auth 是默认行为，也是零托管：在 `authMode: "forward"` 以及每一个 native `~/.claude*` 登录下，frogprogsy 都不保存 Claude token，也不读写 native store。你的 native Claude homes 和多账户选择保持不变。

如果需要在无人值守或脚本场景使用 Claude 订阅，可以另外发放一个 **isolated grant**（Branch B）。它是一份 opt-in、经你同意托管的独立订阅凭据，仅供 frogprogsy 使用，存放在 frogprogsy 自己的 `~/.frogprogsy/claude-grants/<cg_id>` 下，凭据来源是与该目录绑定的 scoped 存储（scoped Keychain service，或该目录内的 `.credentials.json`）。它绝不会写入 native `~/.claude*` home 或全局/非 scoped 的 Keychain 登录。

```bash
frogp claude grants add "工作订阅"
```

亲自运行打印出的登录命令后，检查 scoped 凭据状态：

```bash
frogp claude grants status
```

将已就绪的 grant 绑定到 Anthropic provider：

```bash
frogp providers set anthropic --auth claude-grant --grant <cg_id>
```

- **手动登录，真实可执行文件**：`grants add` 不会自动登录，也不当场验证。它只创建 grant 记录和隔离目录，先把 real claude 解析为一个已验证的绝对路径（拒绝 managed launcher），再打印一条使用隔离 `CLAUDE_CONFIG_DIR` 的手动登录命令，由你亲自完成 Claude 登录。scoped 凭据是否就绪，由随后的 `frogp claude grants status`（或仪表盘 / `frogp doctor claude`）核对，而不是 add 步骤。
- **provider 绑定**：登录后用 `frogp providers set <name> --auth claude-grant --grant <id>` 把某个 provider 绑到该 grant。绑定只改这个 provider 的 authMode，不碰任何 OAuth 或 API-key 登录，也不会在 grant 被删除时自动重绑。
- **就绪状态，做了脱敏**：`frogp claude grants status` 按 grant 报告 `ok`/`none`/`unreadable`/`reauth_required`/`dangling`，不显示任何 token；`frogp doctor claude` 也会给出同样的 warning。
- **fail-closed 刷新**：token 会在临近过期时刷新，且只写回 scoped 存储；刷新遇到 `invalid_grant` 会返回 `reauth_required`，引导你用 `CLAUDE_CONFIG_DIR=<grant-dir>` 的真实可执行文件重新登录；过期 token 绝不会被发送。frogprogsy 永远不会替你自动登录。
- **与 Codex 并存**：绑定后的 grant 可与 Codex OAuth 在同一 session 和 model mixing 中一起使用；Codex OAuth 保持独立，grant token 只会附加到它绑定的 provider（见[模型混合](/frog-progsy/zh-cn/guides/model-mixing/)）。

Grant 是 opt-in 的托管选择：携带订阅认证的网络请求可能触及 Anthropic 服务条款，并带来 account/quota 层面的后果。显式同意用于选择启用 grant，以及 `frogp claude auth probe-b --grant <id> --live --yes` 这类实时订阅诊断，而不是每个正常 provider 请求都弹确认。不想托管订阅、或需要纯 headless/API 认证时，Anthropic API-key provider 仍是随时可用的替代方案。删除 grant（`frogp claude grants remove <id>`）只删除 frogprogsy 自己拥有的本地 scoped credential、隔离目录和记录；它不会在 Anthropic 服务端撤销该登录，也不会登出你的 native 账户。

> Grant 与项目级 enrollment 无关。`frogp claude project enroll` 只写入 `<project>/.claude/settings.local.json` 里的一个本地 frogprogsy token，Claude 账户/home 的选择仍由 Claude Code 掌控。frogprogsy 不发布任何 no-custody discovery-header enrollment，也不声称原生 OAuth 能与 Codex 共用 dual header。

## 启动 Claude Code

`frogp start` 和 `frogp refresh` 会重新生成默认 Claude Code 目录的 `~/.frogprogsy/bin/claude`，以及从已配置目录派生的 alias，例如 `claude-work`、`claude-personal`。把 `~/.frogprogsy/bin` 放到 native Claude Code binary 之前的 `PATH`，或使用 package 提供且在 PATH 中优先命中的 `claude` bin。每个 launcher 都会调用底层 `frogp claude run <cp_id>` 路径，并把真实 Claude Code 可执行文件固定到 `FROGP_REAL_CLAUDE`，跳过 frogprogsy 和临时 cmux shim，避免递归。Proxy 停止时，launcher 只保留所选 Claude 目录 env 并直通 native Claude Code。

## Catalog sync 要做什么

FrogProgsy 把 Claude Code catalog 用作 routed model presentation layer。

1. 在 `~/.frogprogsy/catalog-backup.json` 保存一次 pristine backup。
2. 拉取每个 provider 的 `/models`，并使用 cache/configured `models[]` fallback。
3. 从 native Claude Code catalog template 创建 namespaced routed entry。
4. 移除 `disabledModels` 中的条目。
5. 将 featured subagent model 排到前面。
6. 写回 merged catalog。

## Subagent ranking 决策

`spawn_agent` 优先看到的 routed model 由 `subagentModels` 指定。

```json
{
  "subagentModels": [
    "anthropic/claude-opus-4-8",
    "codex/gpt-5.5",
    "xai/grok-4.3"
  ]
}
```

FrogProgsy 会把 featured entry 排在其他 routed entry 前面，native entry 排在后面。Dashboard 也可以编辑同一列表。

## 用 clean restore 恢复

`frogp stop` 会停止 proxy，并移除 FrogProgsy-owned settings、routed catalog/cache entry、legacy `config.toml`/profile wiring。托管 launcher 会保留；没有 active proxy 时它们直通 native Claude Code。`frogp restore` 不停止正在运行的 process，但执行同样的 Claude Code cleanup。

```bash
frogp stop
frogp restore
```
