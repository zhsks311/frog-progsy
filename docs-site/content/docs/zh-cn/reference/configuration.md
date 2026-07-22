---
title: 配置
description: "FrogProgsy config.json 完整契约：relay defaults、provider lanes、model catalog controls、reasoning/capability gates、capability fallbacks、safe operations。"
---

文档站点的 `/zh-cn/` 路径是 FrogProgsy 的官方完整文档表面。README 只提供第一次成功的 quickstart；`~/.frogprogsy/config.json` 的字段契约以本参考页为准。

FrogProgsy 启动时读取 `~/.frogprogsy/config.json`。Setup wizard 与 dashboard 会写入该文件，但它是 plain JSON，可直接编辑。文件缺失或 invalid 时会 fallback 到单个 Anthropic forward provider。

Dashboard 与文档使用的 public schema 名称是 `ProviderConfig` 和 `WebSearchFallbackConfig`。

## 文件与写入规则

| Path | Role |
| --- | --- |
| `~/.frogprogsy/config.json` | Relay、provider、catalog、capability fallback 设置 |
| `~/.frogprogsy/auth.json` | OAuth provider access/refresh token store |
| `~/.frogprogsy/claude-profiles/<cp_id>/claude-settings-backup.json` | 按 profile 隔离的 FrogProgsy-owned Claude Code settings restore 备份 |
| `~/.frogprogsy/model-aliases.json` | Claude Code-visible routed model alias map |

FrogProgsy 通过 temp-file + rename 写入 config 与 backup file。API key 建议使用 `${ENV_VAR}` 或 `$ENV_VAR` reference，而不是 literal key。

## 运行时类型锚点

JSON 字段对应 `providers.*` 下的运行时 `ProviderConfig` 对象，以及 `webSearchFallback` 下的 `WebSearchFallbackConfig` 对象。更新配置示例时，请保持这些公开类型名稳定。

## Top-level fields

| Field | Type | Default | Role |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | Local relay listen port |
| `hostname` | `string` | `"127.0.0.1"` | Bind hostname。`0.0.0.0` 会暴露到所有 interface，只应显式使用。 |
| `providers` | object | fallback provider | Named provider lanes。key 会成为 route prefix。 |
| `defaultProvider` | `string` | `"anthropic"` | model id 没有 provider prefix 时使用的 routing fallback lane |
| `subagentModels` | `string[]` | default GPT native list | Claude Code subagent picker 前面优先显示的最多 5 个 routed/native model id |
| `disabledModels` | `string[]` | — | 从 catalog 与 `/v1/models` 隐藏的 routed models |
| `modelCacheTtlMs` | `number` | `300000` | Provider `/models` cache freshness window |
| `stallTimeoutSec` | `number` | `90` | Upstream data silence 后以 incomplete/error 关闭的秒数，最小 1 |
| `connectTimeoutMs` | `number` | `30000` | Upstream DNS/TCP/TLS/response-header timeout(ms) |
| `webSearchFallback` | object | auto when compatible forward/key provider exists | Hosted web-search helper 设置 |
| `imageFallback` | object | auto when compatible forward/key provider exists | Text-only lane 的 image-description helper 设置 |
| `classifierFallback` | object | — | Claude Code auto-mode classifier side query 的 cross-provider override；`{ provider, model }` 优先于每个 provider 的 `classifierModel`。 |
| `modelMixing` | object | — | `frogp/mix` 别名背后的模型混合（route/fusion/pipeline）。`enabled: true` 前为禁用。见 [Model mixing fields](#model-mixing-fields)。 |
| `websockets` | `boolean` | `false` | Legacy ignored compatibility field；Claude Messages data plane 使用 HTTP/SSE |
| `syncResumeHistory` | `boolean` | `false` | Legacy ignored/no-op；不修改 Claude Code history |

## Provider lane fields

`providers` 的每个 key 都是 route namespace。例如 `openrouter` provider 的 `qwen/qwen3-coder` model 会在 Claude Code 中暴露为 `openrouter/qwen/qwen3-coder` route。

| Field | Type | Role |
| --- | --- | --- |
| `adapter` | string | `openai-chat`、`openai-responses`、`anthropic`、`google`、`azure-openai` 之一。`azure` 也作为 legacy alias 处理。 |
| `baseUrl` | string | Upstream API base URL |
| `authMode` | `"key" \| "oauth" \| "forward"` | 认证方式。省略时为 `key`。 |
| `apiKey` | string | Literal key 或 `${ENV_VAR}` / `$ENV_VAR` reference |
| `headers` | object | Extra static upstream headers。不要用它绕过认证 header。 |
| `defaultModel` | string | Provider-owned short model id。用于 prefix-less request 或 provider default。 |
| `classifierModel` | string | 当该 provider 是 default provider 或被 `classifierFallback` 选中时，用于 Claude Code auto-mode classifier side query 的轻量模型 |
| `models` | string[] | Seed/fallback model list。`liveModels: false` 时是 exact allowlist。 |
| `liveModels` | boolean | start/sync 时是否 fetch live `/models`。默认 `true`。 |
| `contextWindow` | number | Provider-wide Claude-visible context cap |
| `modelContextWindows` | object | Model-specific context cap。只会作为降低上限的 cap，不会上调 live metadata。 |
| `modelCapabilities` | object | Provider/model capability map，例如 `{ "model-a": { "input": ["text", "image"] } }`；`imageFallback` 可为 `reject` 或 `describe`。 |
| `reasoningEfforts` | string[] | Provider-wide Claude Code-visible reasoning tiers（`low`、`medium`、`high`、`xhigh`） |
| `modelReasoningEfforts` | object | Model-specific visible reasoning tiers。空数组表示不暴露 effort。 |
| `reasoningEffortMap` | object | Claude Code effort label → upstream wire value mapping |
| `modelReasoningEffortMap` | object | Model-specific effort mapping |
| `noReasoningModels` | string[] | 不应接收 reasoning/thinking parameter 的 models |
| `noTemperatureModels` | string[] | 拒绝 caller temperature 的 models |
| `noTopPModels` | string[] | 拒绝 caller top_p 的 models |
| `noPenaltyModels` | string[] | 拒绝 presence/frequency penalty 的 models |
| `autoToolChoiceOnlyModels` | string[] | Forced/named tool choice 必须降为 `auto`/`none` 的 models |
| `preserveReasoningContentModels` | string[] | 需要在 chat history 中保留 assistant `reasoning_content` 的 models |
| `escapeBuiltinToolNames` | boolean | Anthropic-compatible gateways：wire 上要加 built-in tool name prefix，return path 再 strip |

## Auth modes

| Mode | Contract |
| --- | --- |
| `key` | 将 `apiKey` 或 env reference 以 Bearer/API-key 形式发送到 upstream。多数 API-key catalog provider 使用它。 |
| `oauth` | 解析/刷新 `~/.frogprogsy/auth.json` 中保存的 OAuth token，并以 Bearer 发送。 |
| `forward` | 只复制 incoming Claude Code request 中明确 allowlisted、upstream-compatible 的 auth header。Anthropic 与 OpenAI Responses 系列使用它。 |

## Classifier routing fields

Claude Code auto-mode permission checks 是独立的小模型 side queries。当 `defaultProvider` 不是 Anthropic 时，应设置轻量 classifier route，避免这些检查静默使用 heavyweight `defaultModel`。

一次权限检查的流程：

```text
主模型尝试执行某个操作（例如 Bash 命令）
  → Claude Code 以 Haiku 级 id（claude-haiku-*）发送 side query
  → FrogProgsy 路由：classifierFallback → provider classifierModel → defaultModel（+ warning）
  → 被路由到的模型依据 Claude Code auto-mode 策略判定 → 允许 / 拦截
```

| Field | Scope | Role |
| --- | --- | --- |
| `classifierModel` | provider | Haiku-class classifier request 使用的 provider-local model |
| `classifierFallback.provider` | top level | 接收所有 classifier side queries 的 provider |
| `classifierFallback.model` | top level | 与 fallback provider 一起使用的 model id |

如果两个字段都未配置，FrogProgsy 仍会路由请求，但 Haiku-class classifier id fallback 到 `defaultModel` 时会发出 warning。

模型选择改变的是 Claude Code 内置 auto-mode 策略（`allow` / `soft_deny` / `hard_deny` 类别）被解释的严格程度 — 前沿模型会过度拦截，轻量模型更接近原始 Haiku 校准。策略本身不在此处配置：请在 Claude Code 中通过 `claude auto-mode defaults` / `claude auto-mode config` 查看和调整（`autoMode.allow` 条目可放行你信任的 `soft_deny` 命令；`hard_deny` 类别无论由哪个模型审查都始终拦截）。

## Model capability fields

FrogProgsy 使用每个 provider 的 `modelCapabilities`，让 Claude Code catalog hint 与 image fallback 行为保持一致。

```json
{
  "providers": {
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "apiKey": "${OLLAMA_API_KEY}",
      "modelCapabilities": {
        "glm-5.2": { "input": ["text"], "imageFallback": "describe" },
        "qwen3-vl": { "input": ["text", "image"] }
      }
    }
  }
}
```

- `modelCapabilities.<model>.input` 是显示给 Claude Code model picker/catalog 的 input modality hint。
- Text-only model 收到 image request 且 `imageFallback.enabled` 为 true 时，helper 可把 image 转为 text description。
- 未知 model 先尝试 native input；只显式标记已知输入能力的 model。

## Static catalog lane

`liveModels: false` 在 provider catalog 太大或太慢时，只向 Claude Code 暴露 pinned model。

```json
{
  "providers": {
    "openrouter": {
      "adapter": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "liveModels": false,
      "models": ["deepseek/deepseek-v4-flash", "qwen/qwen3-coder-plus"]
    }
  }
}
```

## Capability fallback fields

`webSearchFallback` 与 `imageFallback` 不是单独 daemon，而是在 relay process 内运行的 helper path。两者在存在 compatible OpenAI Responses forward/key provider 时都可自动启用。

| Field | Applies to | Role |
| --- | --- | --- |
| `enabled` | both | Master switch。省略时按 compatible forward/key provider 是否存在自动判断。 |
| `model` | both | Helper model id |
| `timeoutMs` | both | Helper fetch timeout(ms) |
| `reasoning` | web search | 发送给 hosted search helper 的 reasoning effort。建议使用 `low` 或 `minimal` 等轻量值。 |
| `maxSearchesPerTurn` | web search | 每个 main-model turn 的 hosted search 执行数 loop guard |

## Model mixing fields

`modelMixing` 把多个提供方/模型放在 `frogp/mix` 别名后面。`enabled: true` 前禁用，且绝不充当 auto-mode 安全分类器。示例见[模型混合](/frog-progsy/zh-cn/guides/model-mixing/)指南。

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `enabled` | boolean | 总开关。默认 false；关闭时路由不变，且不暴露 `frogp/mix`。 |
| `aliasId` | string | 触发混合的模型 id。默认 `frogp/mix`。 |
| `mode` | string | `coordinator`（LLM 依据 `guidance` 选择）或 `rules`（确定性表，无额外调用）。默认 `coordinator`。 |
| `combine` | string | `route`（选一个）、`fusion`（面板 + judge + synthesizer）或 `pipeline`（thinker → worker → verifier）。默认 `route`。 |
| `coordinator` | object | 用于 route/coordinator 选择、以及作为 fusion judge/synthesizer 默认值的 `{ provider, model }`。 |
| `agents` | array | 协调器可选择的 `{ provider, model, tasks?, difficulty?, role?, notes? }` 名册；也是 fusion 面板的默认值。 |
| `guidance` | string | 协调器读取的自然语言路由指引。 |
| `fusion` | object | `{ panel?: [{provider,model}] (1–8), judge?: {provider,model}, synthesizer?: {provider,model}, contextMode?: "task"|"full", judgeContextMode?: "task"|"full", panelWebSearch?: {...}, multiround?: {...} }`。judge/synthesizer 默认使用 `coordinator`，panel 默认使用 `agents`。`contextMode`、`judgeContextMode`、`panelWebSearch`、`multiround` 在 frozen-suite acceptance 前均为 experimental。 |
| `fusion.contextMode` | `"task"` \| `"full"` | Experimental。面板 prompt context：`task` 保留只使用最新 user message 的现有 prompt bytes；`full` 嵌入 system prompt 与完整 message history。默认 `task`。 |
| `fusion.judgeContextMode` | `"task"` \| `"full"` | Experimental。Judge prompt context：`task` 或 `full`，与 `fusion.contextMode` 相互独立。即使 panel context 为 `full`，默认仍为 `task`。 |
| `fusion.panelWebSearch` | object | Experimental。默认 disabled；仅在 `enabled: true` 时启用。仅面板使用的 synthetic/internal web search：`{ enabled?, maxSearchesPerPanel?, maxTotalSearches?, timeoutMs?, tiers? }`。`tiers` 只能包含 `fallback_model`、`search_api`、`no_key`。它只作用于 fusion panel members，不作用于 judge/synthesizer，也不是 client-visible tool。 |
| `fusion.multiround` | object | Experimental。默认 disabled；仅在 `enabled: true` 时启用。有界 branch/refine/score loop：`{ enabled?, maxRounds?, branchFactor?, budgetCalls? }`。启用时起始默认值为 `maxRounds: 2`、`branchFactor: 2`、`budgetCalls: 12`。`budgetCalls` 是 answer/scoring calls 的 hard cap；超出时会 loud fallback，而不是静默追加调用。 |
| `pipeline` | array | 有序的 `[{ role: "thinker"|"worker"|"verifier", provider, model }]` 链（去重、上限 3）。 |
| `rules` | array | 与任务文本做（大小写不敏感的）子串匹配的确定性表 `[{ match?: { taskKeywords?, difficulty?, hint? }, provider, model }]`。第一个匹配者获胜。 |
| `surfaceStages` | boolean | 将中间阶段作为 `thinking` 块实时呈现。默认 true（设 false 关闭）。 |
| `timeoutMs` / `stageTimeoutMs` / `panelTimeoutMs` | number | 每次调用 / buffered pre-final stage / buffered panel-member timeout。默认 15000。`stageTimeoutMs` 与 `panelTimeoutMs` 只适用于 buffered panel/judge/pipeline pre-final calls；它们不限制 final streamed synthesizer，后者只受 client abort 与 SSE idle handling 约束。 |

每条降级路径都会记录警告（绝不静默），且面向 Claude Code 的模型 id 始终保持为 `frogp/mix`。

## Full example

```json
{
  "port": 10100,
  "hostname": "127.0.0.1",
  "defaultProvider": "anthropic",
  "providers": {
    "anthropic": {
      "adapter": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "authMode": "forward",
      "defaultModel": "claude-sonnet-4-6"
    },
    "openai-forward": {
      "adapter": "openai-responses",
      "baseUrl": "https://api.openai.com/v1",
      "authMode": "forward",
      "defaultModel": "gpt-5.5"
    },
    "codex": {
      "adapter": "openai-responses",
      "baseUrl": "https://chatgpt.com/backend-api/codex",
      "authMode": "oauth",
      "defaultModel": "gpt-5.5",
      "classifierModel": "gpt-5.4-mini"
    },
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "apiKey": "${OLLAMA_API_KEY}",
      "defaultModel": "glm-5.2",
      "models": ["glm-5.2", "gpt-oss", "qwen3-coder"],
      "modelCapabilities": {
        "glm-5.2": { "input": ["text"], "imageFallback": "describe" },
        "gpt-oss": { "input": ["text"], "imageFallback": "reject" },
        "qwen3-coder": { "input": ["text", "image"] }
      },
      "noReasoningModels": ["gpt-oss"]
    }
  },
  "subagentModels": ["anthropic/claude-sonnet-4-6", "ollama-cloud/glm-5.2"],
  "disabledModels": ["ollama-cloud/experimental-model"],
  "classifierFallback": {
    "provider": "codex",
    "model": "gpt-5.4-mini"
  },
  "webSearchFallback": {
    "enabled": true,
    "model": "gpt-5.5",
    "reasoning": "low",
    "maxSearchesPerTurn": 3,
    "timeoutMs": 30000
  },
  "imageFallback": {
    "enabled": true,
    "model": "gpt-5.5",
    "timeoutMs": 30000
  }
}
```

## Safe restore expectations

`frogp restore`、`frogp stop`、`frogp uninstall` 只移除 FrogProgsy 写入的 Claude Code settings/catalog entry。它们不会删除其他 Claude Code settings、history 或 credential。设置混乱时，请按 [`/zh-cn/guides/troubleshooting/`](/frog-progsy/zh-cn/guides/troubleshooting/) 的 clean restore path 操作。
