---
title: 诊断失败请求
description: "按 safe logs、frogp status、route/default provider、auth/OAuth、capability fallback helper、restore path 的顺序缩小 Claude Code 请求失败原因。"
---

FrogProgsy 的完整运营文档以 docs-site 的 `/zh-cn/` 路径为准。本 guide 用于快速分类失败的 Claude Code request，并只用不会暴露 credential 或 prompt 的 safe evidence 恢复。

## 0. 用一句话分类症状

| 症状 | 先看哪里 |
| --- | --- |
| Claude Code 找不到 provider model | 下面的 Route/default provider 检查 |
| Request 立刻以 401/403 失败 | 下面的 Auth/OAuth 检查 |
| Request 长时间卡住或 stream 断开 | 下面的 Dashboard safe log phase 检查 |
| 只有 image 或 web search request 失败 | 下面的 Capability fallback helper 检查 |
| 需要把 Claude Code 恢复到原始状态 | 下面的 Clean restore path |

## 1. 用 dashboard safe log 查看 phase

打开 dashboard。

```bash
frogp gui
```

在 **Activity** panel 找到失败的 request id，并查看最后一个 phase。Request log 不是 secret store，不会保存 API key、OAuth token、prompt body、account identity。

| 最后 phase | 含义 | 处理 |
| --- | --- | --- |
| `parse` | Claude Messages payload shape 与 relay 预期不一致 | 检查 Claude Code version 与复现条件，并比较同一 request 在 native Claude 中是否可用。 |
| `route` | model id 无法解释为 provider lane | 检查 default provider、provider prefix、disabled model 状态。 |
| `oauth` / `auth` | credential 缺失或过期 | 检查 provider login 状态与 `authMode`。 |
| `adapter_build` | 无法构造 provider request | 检查 adapter id、baseUrl、model capability/option gate。 |
| `upstream_connect` | provider HTTP/SSE 连接失败 | 检查 baseUrl、network、provider status、API endpoint path。 |
| `stream_bridge` | 转换 upstream output 为 Claude Messages 时失败 | 检查 provider 是否改变了 tool/reasoning/stream shape。 |
| `finalize` | 响应已结束，处于 cleanup/logging 阶段 | 检查 usage/log write 权限与 local disk 状态。 |

如果 safe error summary 不够，不要复制 request body；issue 中只写 route、provider、adapter、phase、status code、request id。

## 2. 检查 route/default provider

先确认 relay 是否运行。

```bash
frogp status
```

- 如果 not running，运行 `frogp start` 或从 dashboard 启动。
- `frogp status` 只按 PID 判断运行状态。实际 port 请检查 `~/.frogprogsy/config.json` 的 `port` 与注入到 Claude Code settings 的 endpoint。
- 如果怀疑 request health，请同时查看 dashboard status 与 proxy log 的最后一个 safe error。

接着检查 provider route。

1. 在 dashboard **Providers** 中确认 `defaultProvider` 是真实存在的 provider。
2. 如果 Claude Code 选择的 model 是 `provider/model` 形式，`provider` key 必须与 `config.json` 的 `providers` key 一致。
3. 在 dashboard **Models** 中确认该 routed model 没有 disabled。
4. `subagentModels` 只改变显示顺序，不创建 route。模型缺失时检查 provider catalog sync。
5. 如果 provider 经常无法 live `/models`，用 `liveModels: false` 与 `models` allowlist 固定它。

如果 Claude Code model picker 显示旧列表，请刷新当前 profile 的 Claude Code catalog。

```bash
frogp claude reload-models <profile-id>
```

然后启动新的 Claude Code session 或 resume，让它重新获取 `/v1/models`。已经打开的 `/model` 页面不会 hot reload。如果 proxy 没有响应，先运行 `frogp refresh`，再重新加载 profile catalog。

## 3. 检查 Auth/OAuth

401/403 或 login loop 按 provider 类型拆分。

| Provider type | 检查项 | 恢复 |
| --- | --- | --- |
| API-key provider | `apiKey` 是 literal 还是 `${ENV_VAR}` reference，shell/runtime 环境中是否有 env | 在 dashboard 重新保存 provider，或修正 `config.json` env reference。 |
| OAuth provider | Dashboard OAuth status，`~/.frogprogsy/auth.json` 中是否有 provider token | 重新运行 `frogp login <provider>`。 |
| Forward auth provider | Claude Code 发送的 upstream-compatible auth header 是否在 allowlist 中 | 检查 Native Claude/ChatGPT/Codex login 状态并 restart relay。 |
| Local provider | keyless endpoint 是否实际运行 | 先启动 Ollama/vLLM/LM Studio server，并校正 baseUrl。 |

不要手动分享 OAuth credential，也不要贴到日志里。Issue 中只保留 provider name、auth mode、status code、last safe phase。

## 4. 检查 capability fallback

Web search 与 image request 在 main provider 不能直接处理时，可能需要 capability fallback。

### Web search

- 确认 `webSearchFallback.enabled` 为 `true`。
- Capability fallback model 必须能使用 OpenAI Responses forward/key provider。
- `maxSearchesPerTurn` 太低时，search loop 会过早停止。
- `timeoutMs` 太低时，upstream search 会中途失败。

### Image fallback

- Text-only target model 需要 `imageFallback.enabled` 为 `true`。
- `modelCapabilities.<model>.input` 为 text-only 时，启用 `imageFallback` 后 image 会在 main call 前转为 text description。
- Capability fallback `model` 必须 vision-capable。
- Base64 image 不应流入 prompt text。Safe log 不保存 image body。

Capability fallback 不稳定时，先把 main route 改成 native 支持 vision/search 的 model 复现，区分问题只在 capability fallback，还是 main provider 也失败。

## 5. Clean restore path

把 Claude Code 恢复为 native 状态时，先使用最窄 path。

| 目的 | Command | 保留内容 |
| --- | --- | --- |
| 只恢复 Claude Code settings/catalog | `frogp restore` | 运行中的 proxy、FrogProgsy config/auth |
| 同时停止 proxy | `frogp stop` | FrogProgsy config/auth |
| 移除 FrogProgsy 管理痕迹 | `frogp uninstall` | 用户其他 Claude Code 状态 |

`frogp restore` 与 `frogp stop` 只移除 FrogProgsy-owned Claude Code settings/catalog entry。它们不会创建 Claude Code history remapping；`frogp recover-history --legacy-openai` 是 retired no-op。

## 6. 安全记录复现信息

Issue 或 PR 需要的最小信息：

- OS 与 FrogProgsy version
- `frogp status` 的 non-secret summary
- 失败 request id 与 dashboard safe phase/status
- provider key name、adapter id、auth mode、routed model id
- 是否使用 capability fallback（`webSearchFallback`、`imageFallback`）
- clean restore 后是否仍可复现

不要留下的信息：

- API key、OAuth token、session cookie
- full prompt/request body
- account email 或 organization id
- provider dashboard screenshot 中可见 credential/account 的图片
