---
title: Provider 设置
description: "连接 FrogProgsy provider：OAuth accounts、Claude header native relay、API key route、local endpoint 与 safe dashboard operations。"
---

FrogProgsy 的完整运营文档以 docs-site 的 `/zh-cn/` 路径为准。本 guide 只覆盖首次连接 provider 并选择默认 route 的 workflow；字段级完整 schema 请以 [配置参考](/frog-progsy/zh-cn/reference/configuration/) 为准。

FrogProgsy 把 provider 视为 local `frogp` gateway 后面的 **upstream route**。Claude Code 继续发送 Anthropic Messages；每条 route 决定到 upstream 的方式：adapter、base URL、auth source、optional headers，以及要暴露的 model list。

## 首先：在 dashboard 中添加 provider

Provider setup 最安全的运营方式是 dashboard。

1. 用 `frogp gui` 打开 dashboard。
2. 在 **Providers → Add provider** 中选择 OAuth、API-key catalog、custom URL 或 local server。
3. 可用的 catalog provider 会打开 key page，验证 key，然后在 `~/.frogprogsy/config.json` 的 `providers` 下写入 node。
4. 用 **Make default** 设置 Claude Code 没有发送显式 route 时使用的 `defaultProvider`。
5. 在 **Models** 中确认 default provider 的 `defaultModel` 与暴露模型，隐藏不需要的条目。
6. 在 **Activity** 中确认 `parse`、`route`、`oauth`/`auth`、`adapter_build`、`upstream_connect`、`stream_bridge` phase。

Dashboard 操作后，也请配合 `/zh-cn/` 文档中的 [模型路由](/frog-progsy/zh-cn/guides/model-routing/) 与 [Dashboard 与 Activity](/frog-progsy/zh-cn/guides/web-dashboard/) 检查运营状态。

## 选择哪条 lane

| Lane | 适合场景 | 认证来源 | 常见 adapter |
| --- | --- | --- | --- |
| **Bring-through** | Claude Code request 已经带有 compatible upstream headers。 | 只使用 incoming request 中的 allowlisted header。 | `anthropic`, `openai-responses` |
| **Account sign-in** | 希望 FrogProgsy refresh provider account token。 | `~/.frogprogsy/auth.json` OAuth store。 | `openai-responses`, `openai-chat` |
| **Key-backed node** | provider 提供 API dashboard 或 standard bearer key。 | literal key 或 `~/.frogprogsy/config.json` 中的 `${ENV_VAR}`。 | 多数 `openai-chat`，少数 `anthropic` |
| **Local node** | 使用 Ollama、vLLM、LM Studio 等本地 OpenAI 兼容服务器。 | 通常 blank key 或 local-only key。 | `openai-chat` |

直接编辑高级设置时的字段级 schema 见 [配置参考](/frog-progsy/zh-cn/reference/configuration/)。

## AI Accounts 与 Claude Code Homes 的区别

**AI Accounts** 决定 frogprogsy 可以 route 到哪些 upstream provider。**Claude Code Homes** 管理
`~/.claude`、`~/.claude-work` 这样的 Claude Code 配置目录；这些目录提供 Claude 订阅认证，并接收本地
`settings.json` gateway 注入。

如果要在 Model Picker 或 Model Mixing 中使用 Anthropic，需要两部分同时存在：AI Accounts 中有 Anthropic
provider 行；使用订阅认证时，对应 Claude Code home 已登录。forward mode 下 frogprogsy 不存储 Claude
token；它只转发 incoming Claude Code request 中真实的 `Authorization` 或 `x-api-key`。不会发送这些 header
的 headless/API caller 应改用 Anthropic API-key provider。

## Bring-through lane：不保存 key

新配置会 seed 一个 Anthropic bring-through provider，因为 Claude Code 的 native data plane 是 Anthropic Messages。这条 lane **不保存 provider key**，只 relay incoming request 中已经存在的 upstream-compatible headers。

```json
{
  "anthropic": {
    "adapter": "anthropic",
    "baseUrl": "https://api.anthropic.com",
    "authMode": "forward",
    "defaultModel": "claude-sonnet-4-6"
  }
}
```

运营备注：

- Anthropic bring-through 只 forward 实际存在的 `authorization` 或 `x-api-key`。
- `ANTHROPIC_AUTH_TOKEN=local-frogprogsy` 是内部 Claude Code local marker，会在发送 upstream 前移除。
- OpenAI Responses forward mode 为 compatible upstream 与 capability fallback path 使用 curated header set。
- 有 compatible credential 时，[web search 与 image fallback](/frog-progsy/zh-cn/guides/capability-fallbacks/) 也可以运行。

如果希望 FrogProgsy 负责 route 与 translate，但不拥有 provider secret，请使用这条 lane。

在仪表盘选择 **Anthropic Claude** 时，FrogProgsy 默认使用 Claude Code 目录流程，而不是要求订阅 token。这条 provider 行会让 Claude 模型可被选择；认证位置字段默认填入 `~/.claude`，请先在那里运行 `claude login`。如需第二个 Claude 账号，请登录到单独目录，并再添加一条 Anthropic provider：

```bash
CLAUDE_CONFIG_DIR=~/.claude-work claude login
frogp claude add work --home ~/.claude-work
frogp refresh
claude-work "hello"
```


## Account sign-in lane：FrogProgsy 负责 refresh

OAuth account 存在 `~/.frogprogsy/auth.json`，并在过期前 refresh。Claude 订阅认证不是这里的 OAuth lane；请留在 Claude Code 中，需要分开的 Claude Code 配置目录时使用 `frogp claude` 目录。可从 CLI 或 [Dashboard 与 Activity](/frog-progsy/zh-cn/guides/web-dashboard/) 启动支持的登录。

```bash
frogp login codex        # ChatGPT/Codex account，route 到 Codex backend
frogp login xai          # xAI Grok
frogp login kimi         # Moonshot Kimi
frogp logout <provider>
```

| Account lane | FrogProgsy 创建的 route | 为什么重要 |
| --- | --- | --- |
| `codex` | 到 `https://chatgpt.com/backend-api/codex` 的 `openai-responses` route | 不修改 Claude Code，把 Messages request 转换为 Codex Responses call。 |
| `xai` | 到 `https://api.x.ai/v1` 的 `openai-chat` route | 在 adapter boundary 处理 Grok 不支持 reasoning param 等差异。 |
| `kimi` | 到 `https://api.kimi.com/coding/v1` 的 `openai-chat` route | Kimi coding model 进入同一份 FrogProgsy catalog。 |

普通 OpenAI API key billing 与 ChatGPT/Codex OAuth 是分开的。

```bash
frogp login openai          # openai-apikey preset alias
frogp login openai-apikey   # explicit preset id
```

## Key-backed lane：catalog node

优先通过 dashboard 的 **Add provider** 流程添加。直接编辑 config file 更适合 catalog 中没有 provider，或必须绕过自动验证的高级运营。

| Shape | Providers |
| --- | --- |
| Hosted OpenAI-compatible APIs | Ollama Cloud, Mistral, DeepSeek, Cerebras, Together, Fireworks, Hugging Face, NVIDIA NIM |
| Coding-oriented gateways | Z.AI / GLM Coding, Qwen Portal, Kilo, GitHub Copilot, GitLab Duo |
| Regional or specialty APIs | MiniMax, MiniMax CN, Moonshot, Kimi coding, Xiaomi MiMo |
| Gateway wrappers | Cloudflare AI Gateway, Vercel AI Gateway, Venice, NanoGPT, Synthetic, Qianfan, Alibaba, Parallel, ZenMux, LiteLLM |

多数是使用 bearer key 的 `openai-chat` node。少数只提供 Anthropic-shaped endpoint 的 provider 使用 `anthropic` adapter 与 `x-api-key`。

> **订阅 gateway 不是普通 API-key provider**
>
> GitHub Copilot 与 GitLab Duo 通过 OpenAI-compatible gateway endpoint 通信，但使用 subscription token 认证。Copilot 可能需要在 provider `headers` 中设置 `User-Agent`；Cloudflare AI Gateway 的 URL template 需要 account 与 gateway id。

## Local lane：route 到本机

可以让 FrogProgsy 保持 Claude Code contract，由本地 server 负责 inference。

| Runtime | Base URL |
| --- | --- |
| Ollama local | `http://localhost:11434/v1` |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |

在 dashboard 选择 **Custom**，或在 `frogp init` 中选择 `custom` 并输入 base URL。只有本地 server 允许时才使用 blank key。

## Advanced CLI/config operations

CLI 与 config 编辑用于自动化或恢复 dashboard 已确认的 route。

- OAuth route 用 `frogp login <provider>` / `frogp logout <provider>` 管理。
- 初始 custom provider 可在 `frogp init` 中创建。
- 已连接 provider 的 `defaultModel`、`models[]`、`disabledModels`、`headers` 可在 `~/.frogprogsy/config.json` 中调整。
- 编辑后用 dashboard **Models** 与 **Activity** 确认实际 route selection。

## Decision shortcuts

- 不想保存 provider secret：使用 **bring-through**。
- 需要 ChatGPT/Codex account route：`frogp login codex`。
- 需要普通 OpenAI API billing：`frogp login openai`。
- 标准 OpenAI-compatible service：使用 **key-backed node**。
- 本地 inference：使用 **local node**。
- Text-only route 需要 web search/image understanding：使用 **capability fallback**。
