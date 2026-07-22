---
title: 설정 파일 항목
description: "~/.frogprogsy/config.json에서 포트, AI 서비스, 모델 목록, 대신 처리 기능, 안전 운영 항목을 설정하는 방법."
---

문서 사이트의 `/ko/` 경로가 FrogProgsy의 공식 전체 문서입니다. README는 첫 성공 빠른 시작만 제공하고, `~/.frogprogsy/config.json`의 항목 설명은 이 문서를 기준으로 유지합니다.

FrogProgsy는 시작 시 `~/.frogprogsy/config.json`을 읽습니다. 설정 마법사와 대시보드가 이 파일을 쓰지만 일반 JSON이라 직접 편집할 수 있습니다. 파일이 없거나 잘못되면 단일 Anthropic 기존 로그인 전달 설정으로 시작합니다.

Dashboard와 문서에서 쓰는 public schema 이름은 `ProviderConfig`와 `WebSearchFallbackConfig`입니다.

## 파일과 쓰기 규칙

| Path | Role |
| --- | --- |
| `~/.frogprogsy/config.json` | Relay, provider, catalog, capability fallback 설정 |
| `~/.frogprogsy/auth.json` | OAuth provider access/refresh token store |
| `~/.frogprogsy/claude-profiles/<cp_id>/claude-settings-backup.json` | 프로필별 FrogProgsy-owned Claude Code settings restore 백업 |
| `~/.frogprogsy/model-aliases.json` | Claude Code-visible routed model alias map |

FrogProgsy는 config와 backup file을 temp-file + rename 방식으로 씁니다. API key는 literal보다 `${ENV_VAR}` 또는 `$ENV_VAR` reference를 권장합니다.

## 런타임 타입 기준

JSON 필드는 `providers.*` 아래의 런타임 `ProviderConfig` 객체와 `webSearchFallback` 아래의 `WebSearchFallbackConfig` 객체에 대응합니다. 설정 예시를 바꿀 때도 이 공개 타입 이름은 안정적으로 유지합니다.

## Top-level fields

| Field | Type | Default | Role |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | Local relay listen port |
| `hostname` | `string` | `"127.0.0.1"` | Bind hostname. `0.0.0.0`은 모든 interface에 노출하므로 명시적으로만 사용합니다. |
| `providers` | object | fallback provider | Named provider lanes. key가 route prefix가 됩니다. |
| `defaultProvider` | `string` | `"anthropic"` | 모델 id에 provider prefix가 없을 때 쓰는 routing fallback lane |
| `subagentModels` | `string[]` | default GPT native list | Claude Code subagent picker 앞쪽에 먼저 보여줄 최대 5개 routed/native model id |
| `disabledModels` | `string[]` | — | Catalog와 `/v1/models`에서 숨길 routed models |
| `modelCacheTtlMs` | `number` | `300000` | Provider `/models` cache freshness window |
| `stallTimeoutSec` | `number` | `90` | Upstream data silence 후 incomplete/error로 닫는 시간(초), 최소 1 |
| `connectTimeoutMs` | `number` | `30000` | Upstream DNS/TCP/TLS/response-header timeout(ms) |
| `webSearchFallback` | object | auto when compatible forward/key provider exists | Hosted web-search helper 설정 |
| `imageFallback` | object | auto when compatible forward/key provider exists | Text-only lane용 image-description helper 설정 |
| `classifierFallback` | object | — | Claude Code auto-mode classifier side query용 cross-provider override. `{ provider, model }`은 provider별 `classifierModel`보다 우선합니다. |
| `modelMixing` | object | — | `frogp/mix` 별칭 뒤의 모델 섞어 쓰기(route/fusion/pipeline). `enabled: true` 전에는 비활성. [Model mixing fields](#model-mixing-fields) 참고. |
| `websockets` | `boolean` | `false` | Legacy ignored compatibility field; Claude Messages data plane은 HTTP/SSE 사용 |
| `syncResumeHistory` | `boolean` | `false` | Legacy ignored/no-op; Claude Code history는 건드리지 않음 |

## Provider lane fields

`providers`의 각 key는 route namespace입니다. 예를 들어 `openrouter` provider의 `qwen/qwen3-coder` 모델은 Claude Code에서 `openrouter/qwen/qwen3-coder` route로 노출됩니다.

| Field | Type | Role |
| --- | --- | --- |
| `adapter` | string | `openai-chat`, `openai-responses`, `anthropic`, `google`, `azure-openai` 중 하나. `azure`도 legacy alias로 처리됩니다. |
| `baseUrl` | string | Upstream API base URL |
| `authMode` | `"key" \| "oauth" \| "forward"` | 인증 방식. 생략하면 `key`입니다. |
| `apiKey` | string | Literal key 또는 `${ENV_VAR}` / `$ENV_VAR` reference |
| `headers` | object | Extra static upstream headers. 인증 header를 여기로 우회하지 마세요. |
| `defaultModel` | string | Provider-owned short model id. Prefix 없는 request 또는 provider default에 사용됩니다. |
| `classifierModel` | string | 이 provider가 기본 provider이거나 `classifierFallback`으로 선택됐을 때 Claude Code auto-mode classifier side query에 쓸 경량 모델 |
| `models` | string[] | Seed/fallback model list. `liveModels: false`일 때 exact allowlist입니다. |
| `liveModels` | boolean | Start/sync에서 live `/models` fetch 여부. 기본 `true`입니다. |
| `contextWindow` | number | Provider-wide Claude-visible context cap |
| `modelContextWindows` | object | Model-specific context cap. Live metadata를 올리지는 않고 낮추는 cap으로만 동작합니다. |
| `modelCapabilities` | object | Provider/model capability map. 예: `{ "model-a": { "input": ["text", "image"] } }`; `imageFallback`는 `reject` 또는 `describe`입니다. |
| `reasoningEfforts` | string[] | Provider-wide Claude Code-visible reasoning tiers (`low`, `medium`, `high`, `xhigh`) |
| `modelReasoningEfforts` | object | Model-specific visible reasoning tiers. 빈 배열은 effort 미노출입니다. |
| `reasoningEffortMap` | object | Claude Code effort label → upstream wire value mapping |
| `modelReasoningEffortMap` | object | Model-specific effort mapping |
| `noReasoningModels` | string[] | Reasoning/thinking parameter를 보내면 안 되는 models |
| `noTemperatureModels` | string[] | Caller temperature를 거부하는 models |
| `noTopPModels` | string[] | Caller top_p를 거부하는 models |
| `noPenaltyModels` | string[] | Presence/frequency penalty를 거부하는 models |
| `autoToolChoiceOnlyModels` | string[] | Forced/named tool choice를 `auto`/`none`으로 내려야 하는 models |
| `preserveReasoningContentModels` | string[] | Chat history에서 assistant `reasoning_content` 보존이 필요한 models |
| `escapeBuiltinToolNames` | boolean | Wire에서는 built-in tool name prefix를 붙이고 return path에서는 strip해야 하는 Anthropic-compatible gateways |

## Auth modes

| Mode | Contract |
| --- | --- |
| `key` | `apiKey` 또는 env reference를 Bearer/API-key 형태로 upstream에 보냅니다. 대부분의 API-key catalog provider가 사용합니다. |
| `oauth` | `~/.frogprogsy/auth.json`의 저장 OAuth token을 resolve/refresh해서 Bearer로 보냅니다. |
| `forward` | 들어온 Claude Code 요청의 allowlisted upstream-compatible auth header만 복사합니다. Anthropic과 OpenAI Responses 계열에서 사용합니다. |

## Classifier routing fields

Claude Code auto-mode 권한 확인은 별도의 작은 모델 side query입니다. `defaultProvider`가 Anthropic이 아닐 때는 이 확인이 heavyweight `defaultModel`로 조용히 가는 일을 막기 위해 경량 classifier route를 설정하세요.

권한 확인 한 번의 흐름:

```text
메인 모델이 행동을 시도 (예: Bash 명령)
  → Claude Code가 Haiku급 id(claude-haiku-*)로 side query 전송
  → FrogProgsy가 라우팅: classifierFallback → provider classifierModel → defaultModel (+ warning)
  → 라우팅된 모델이 Claude Code auto-mode 지침을 기준으로 판정 → 허용 / 차단
```

| Field | Scope | Role |
| --- | --- | --- |
| `classifierModel` | provider | Haiku-class classifier request에 쓸 provider-local model |
| `classifierFallback.provider` | top level | 모든 classifier side query를 받을 provider |
| `classifierFallback.model` | top level | fallback provider와 함께 쓸 model id |

둘 다 설정하지 않으면 FrogProgsy는 요청을 계속 라우팅하되, Haiku-class classifier id가 `defaultModel`로 fallback될 때 warning을 남깁니다.

모델 선택은 Claude Code 내장 auto-mode 지침(`allow` / `soft_deny` / `hard_deny` 카테고리)을 얼마나 엄격하게 해석하는지를 바꿉니다 — 프런티어 모델은 과잉 차단하고, 경량 모델이 원래 Haiku 보정에 가깝습니다. 지침 자체는 여기서 설정하지 않습니다. Claude Code에서 `claude auto-mode defaults` / `claude auto-mode config`로 확인·조정하세요 (`autoMode.allow` 항목은 신뢰하는 `soft_deny` 명령을 해제하며, `hard_deny` 카테고리는 어떤 모델이 심사하든 항상 차단됩니다).

## Model capability fields

FrogProgsy는 provider별 `modelCapabilities`로 Claude Code catalog hint와 image fallback 동작을 맞춥니다.

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

- `modelCapabilities.<model>.input`은 Claude Code model picker/catalog에 보이는 input modality hint입니다.
- Text-only model에 image 요청이 들어오고 `imageFallback.enabled`가 true이면 helper가 image를 text description으로 바꿀 수 있습니다.
- 알 수 없는 model은 먼저 native input으로 시도하고, 입력 동작을 아는 model만 명시적으로 분류합니다.

## Static catalog lane

`liveModels: false`는 provider catalog가 너무 크거나 느릴 때 Claude Code에 pinned model만 노출합니다.

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

## 부족한 기능 대신 처리 설정

`webSearchFallback`와 `imageFallback`는 별도 daemon이 아니라 FrogProgsy 프로세스 안에서 실행되는 보조 경로입니다. 둘 다 호환되는 OpenAI Responses forward/key provider가 있을 때 자동으로 활성화될 수 있습니다.

| Field | Applies to | Role |
| --- | --- | --- |
| `enabled` | both | Master switch. 생략하면 compatible forward/key provider 존재 여부로 자동 판단합니다. |
| `model` | both | Helper model id |
| `timeoutMs` | both | Helper fetch timeout(ms) |
| `reasoning` | web search | Hosted search helper에 보낼 reasoning effort. `low` 또는 `minimal`처럼 가벼운 값을 권장합니다. |
| `maxSearchesPerTurn` | web search | Main-model turn당 hosted search 실행 수 loop guard |

## Model mixing fields

`modelMixing`은 여러 제공자/모델을 `frogp/mix` 별칭 뒤에 둡니다. `enabled: true` 전에는 비활성이고, auto-mode 안전 분류기와는 무관합니다. 예시는 [모델 섞어 쓰기](/frog-progsy/ko/guides/model-mixing/) 가이드를 보세요.

| 항목 | 타입 | 역할 |
| --- | --- | --- |
| `enabled` | boolean | 마스터 스위치. 기본 false. 꺼지면 라우팅 불변이고 `frogp/mix`도 노출 안 됨. |
| `aliasId` | string | 믹싱을 트리거하는 모델 id. 기본 `frogp/mix`. |
| `mode` | string | `coordinator`(LLM이 `guidance`로 선택) 또는 `rules`(결정적 표, 추가 호출 없음). 기본 `coordinator`. |
| `combine` | string | `route`(하나 선택), `fusion`(패널 + judge + synthesizer), `pipeline`(thinker → worker → verifier). 기본 `route`. |
| `coordinator` | object | route/coordinator 선택과 fusion judge/synthesizer 기본값으로 쓰는 `{ provider, model }`. |
| `agents` | array | 코디네이터가 고를 수 있는 `{ provider, model, tasks?, difficulty?, role?, notes? }` 로스터. fusion 패널 기본값이기도 함. |
| `guidance` | string | 코디네이터가 읽는 자연어 라우팅 지침. |
| `fusion` | object | `{ panel?: [{provider,model}] (1–8), judge?: {provider,model}, synthesizer?: {provider,model}, contextMode?: "task"|"full", judgeContextMode?: "task"|"full", panelWebSearch?: {...}, multiround?: {...} }`. judge/synthesizer 기본값은 `coordinator`, 패널 기본값은 `agents`. `contextMode`, `judgeContextMode`, `panelWebSearch`, `multiround`는 frozen-suite acceptance 전까지 experimental입니다. |
| `fusion.contextMode` | `"task"` \| `"full"` | Experimental. 패널 prompt context입니다. `task`는 최신 user message만 쓰는 기존 prompt bytes를 보존하고, `full`은 system prompt와 전체 message history를 포함합니다. 기본 `task`. |
| `fusion.judgeContextMode` | `"task"` \| `"full"` | Experimental. Judge prompt context입니다. `task` 또는 `full`이며 `fusion.contextMode`와 독립적입니다. 패널 context가 `full`이어도 기본은 `task`. |
| `fusion.panelWebSearch` | object | Experimental. 기본 disabled이며 `enabled: true`일 때만 활성화됩니다. 패널 전용 synthetic/internal web search: `{ enabled?, maxSearchesPerPanel?, maxTotalSearches?, timeoutMs?, tiers? }`. `tiers`는 `fallback_model`, `search_api`, `no_key`만 허용합니다. fusion panel member에만 적용되고 judge/synthesizer나 client-visible tool에는 적용되지 않습니다. |
| `fusion.multiround` | object | Experimental. 기본 disabled이며 `enabled: true`일 때만 활성화됩니다. 제한된 branch/refine/score loop: `{ enabled?, maxRounds?, branchFactor?, budgetCalls? }`. 활성화 시 시작 기본값은 `maxRounds: 2`, `branchFactor: 2`, `budgetCalls: 12`입니다. `budgetCalls`는 answer/scoring call의 hard cap이며 초과 시 조용히 추가 호출하지 않고 loud fallback합니다. |
| `pipeline` | array | 순서 있는 `[{ role: "thinker"|"worker"|"verifier", provider, model }]` 체인(중복 제거, 최대 3). |
| `rules` | array | 작업 텍스트와 대소문자 무시 부분일치로 맞추는 결정적 표 `[{ match?: { taskKeywords?, difficulty?, hint? }, provider, model }]`. 먼저 매칭되는 게 이김. |
| `surfaceStages` | boolean | 중간 단계를 `thinking` 블록으로 실시간 노출. 기본 true(끄려면 false). |
| `timeoutMs` / `stageTimeoutMs` / `panelTimeoutMs` | number | 호출별 / buffered pre-final stage / buffered panel-member timeout. 기본 15000. `stageTimeoutMs`와 `panelTimeoutMs`는 buffered panel/judge/pipeline pre-final call에만 적용되고 final streamed synthesizer는 제한하지 않습니다. final streamed synthesizer는 client abort와 SSE idle handling에만 묶입니다. |

모든 열화 경로는 조용하지 않고 경고를 남기며(never silent), Claude Code가 보는 모델 id는 `frogp/mix`로 유지됩니다.

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

`frogp restore`, `frogp stop`, `frogp uninstall`은 FrogProgsy가 쓴 Claude Code settings/catalog entry만 제거합니다. 다른 Claude Code 설정, history, credential은 삭제하지 않습니다. 설정이 꼬인 경우 운영 절차는 [`/ko/guides/troubleshooting/`](/frog-progsy/ko/guides/troubleshooting/)의 clean restore path를 따르세요.
