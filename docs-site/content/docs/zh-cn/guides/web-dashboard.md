---
title: Dashboard 与 Activity
description: "覆盖 provider setup、model visibility、classifier routing、capability fallback choice、safe request activity、usage accounting、shutdown 的 FrogProgsy local control room。"
---

FrogProgsy 的完整运营文档以 docs-site 的 `/zh-cn/` 路径为准。Dashboard 是运行中的 FrogProgsy proxy 提供的 local React control room，在一个界面中处理 provider 添加、default route 决策、model visibility、classifier routing、capability fallback choice、request activity、usage summary 与 shutdown。

## 打开

```bash
frogp gui
```

它会打开 `http://localhost:<port>`，必要时先启动 proxy。开发中可以分开运行 proxy 与 GUI。

```bash
frogp start
cd gui && bun dev
```

## Operator 首先检查的 panels

| Panel | 用途 |
| --- | --- |
| **Dashboard** | Proxy status、version、uptime、provider count、search/image fallback settings、auto-mode classifier model settings |
| **Providers** | OAuth login、API-key providers、Anthropic Claude Code 目录行、custom endpoints、opt-in connection tests、default provider switch、removal |
| **Models** | Dashboard/API model-list reload：查看 routed model visibility、disabled models、Claude Code discovery 状态。它刷新 dashboard 与 `/v1/models` 暴露的列表，不是 Claude Code picker recovery 命令。 |
| **Claude Code 目录** | 命名 Claude Code 配置目录、pass-through auth state、inject/restore/refresh actions、按目录隔离的 model overlays；这不是模型选择器。Refresh 会准备 Claude Code picker recovery，并显示该 profile 稳定的 `frogp claude reload-models <profile-id>` 命令。 |
| **Activity** | Safe request phase traces、recent logs、按 day/model/provider 汇总的 local usage accounting |
| **Stop Proxy** | Graceful shutdown + native Claude Code restore |

## Model list refresh 与 Claude Code picker recovery

需要重新加载 dashboard/API 模型列表时，使用 **Models**。这个 refresh 影响 routed model visibility、disabled models，以及 FrogProgsy 提供的 `/v1/models` response。如果 proxy 已经停掉，先用 `frogp refresh` 恢复 proxy，再重新加载列表。

Claude Code 的 `/model` picker 显示旧列表时，使用 **Claude Code 目录**。刷新目标目录后，运行界面显示的 `frogp claude reload-models <profile-id>` 命令。Claude Code 不会 hot reload 已经打开的 `/model` 页面；请启动新的 Claude Code session，或 resume 该 profile，让 Claude Code 重新请求 `/v1/models`。

## Model Mixing 页面

当你想让 Claude Code 只显示一个 `frogp/mix`，但背后由多个模型一起回答时，使用 **Model Mixing** 页面。它不要求你编辑 JSON：选择预设，确认警告，启用，然后在 Claude Code 中选择 `frogp/mix` 即可。

这个页面会显示：

- **Low**、**Balanced**、**Research** 预设卡片，以及服务器计算出的答案调用/搜索调用估算；
- Research 证据横幅：F3 通过 frozen `local-suite-v1` 声明，同时标明 hard reasoning 没有改善、单一 judge 评分、p50 `29s` / p95 约 `3.7 分钟` 延迟、仅限 suite-v1 等 caveats；
- 实际参与回答的专家组模型、评审模型和合成者模型；
- 成本预览，让你在启用前看到“一次请求”会变成多次内部调用。

页面有两道防护，避免静默改动。预设如果会覆盖已有自定义设置，会先弹出确认；取消则不保存。Enable 开关也会先显示当前调用数和延迟警告；取消不保存，保存失败时开关会恢复原状。

这个页面和 classifier 卡片是两件事。Model Mixing 改变的是普通请求中 `frogp/mix` 生成答案的方式，不会路由或替代 Claude Code auto-mode 安全检查。

## 用 safe logs 缩小失败位置

Request log 被刻意设计得很窄，不会成为 secret store。它显示 timing、model、provider、status、endpoint、phase list、safe error code，并提供 status/provider/error filters 与行详情中的脱敏 route/upstream diagnostics；但不保存 API key、OAuth token、request body、prompt、email、account identity。

可以用 phase list 缩小失败位置：

- `parse` — Claude Messages payload shape
- `route` — model/provider selection
- `oauth` 或 `auth` — credential availability
- `adapter_build` — provider request construction
- `upstream_connect` — provider HTTP/SSE connection
- `stream_bridge` — conversion back to Claude Messages
- `finalize` — logging and cleanup

## Classifier model settings

Claude Code auto-mode permission checks 是独立的 Haiku-class side queries。当 main default provider 不是 Anthropic 时，可在 dashboard classifier panel 中把这些检查固定到轻量 provider/model，避免它们被静默路由到 heavyweight default model。

通常为每个 provider 设置 classifier model；只有所有 classifier side queries 都要走同一个 provider/model pair 时，才设置 cross-provider classifier fallback。


## 用 usage accounting 查看 local 使用量

Activity 的 usage section 是 local accounting，不是 provider invoice view。FrogProgsy 会在完成的 `/v1/messages` request 中，当 upstream response 提供 usage data 时，把记录写入 `~/.frogprogsy/usage.jsonl`。没有提供 usage 的 provider request 会归入 `unreported`，不会显示为 0 token。

该 tab 用于回答“通过这个 proxy，哪些 route/model 消耗了 token？”Account invoice、subscription quota、organization spend 应使用 provider 的 metering endpoint。这些 endpoint 在 provider 之间没有标准，且通常需要单独的 owner credential。

Claude Code 也可能调用 provider-specific usage endpoint，因此 FrogProgsy 在 `GET /api/usage`、`GET /api/oauth/usage`、`GET /usage` 提供 local summary JSON。未注册的 `/api/*` request 不会 fallback 到 dashboard HTML。


## UI 后面的 management API

多数运营应在 UI 中完成，只有自动化或 smoke check 需要时才直接调用下面的 endpoint。

| Endpoint | Purpose |
| --- | --- |
| `GET /api/provider-state` | non-secret provider/runtime summary |
| `GET /api/claude-status` | redacted Claude Code injection/Base URL、runtime/watchdog/external-supervisor、last `/v1/messages` status |
| `GET /api/providers` | configured provider summaries |
| `POST /api/providers` | 从 catalog/custom input 添加或更新 provider |
| `POST /api/providers/test` | opt-in single minimal-token provider connection test，返回 enum-only error results |
| `PUT /api/default-provider` | 修改 fallback provider |
| `DELETE /api/providers?name=…` | 删除 non-default provider |
| `GET /api/key-providers` | API-key provider catalog |
| `GET /api/oauth/providers` | OAuth-capable providers |
| `POST /api/oauth/login` / `GET /api/oauth/status` | 启动并轮询 OAuth login |
| `GET/POST/PATCH/DELETE /api/claude-profiles` | 管理 Claude Code 目录与按目录隔离的 model overlays。包含 `PATCH` 在内的 mutating methods 只允许 local origin |
| `POST /api/claude-profiles/:id/inject|refresh|restore` | 对单个 Claude Code 目录执行 inject、refresh 或 restore。`refresh` 会返回用于 Claude Code picker recovery 的 additive `modelReload` metadata；可用时包含稳定的 `frogp claude reload-models <profile-id>` 命令 |
| `GET /api/subagent-models` / `PUT /api/subagent-models` | 读取/设置 featured subagent models |
| `GET /api/fallback-settings` / `PUT /api/fallback-settings` | 读取/设置 capability fallback model choice |
| `GET /api/classifier-settings` / `PUT /api/classifier-settings` | 读取/设置 per-provider classifier models 与 cross-provider classifier fallback |
| `PUT /api/disabled-models` | 在 Claude Code discovery 中隐藏/显示 routed model |
| `GET /api/usage?range=30d` / `GET /api/oauth/usage` / `GET /usage` | 基于 `~/.frogprogsy/usage.jsonl` 的 local usage summary。`range` 支持 `7d`、`30d`、`all` |
| `POST /api/stop` | proxy stop、native Claude Code restore、exit |

> **Provider catalog entries**
>
> 添加 Ollama Cloud 等 catalog provider 时，包含 text-only model hint 的 model classification metadata 会复制到 config，用于 image fallback gating。
