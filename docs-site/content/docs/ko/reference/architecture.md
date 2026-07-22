---
title: 내부 구조
description: "Claude Code 요청이 FrogProgsy 내부에서 읽히고, 모델을 고르고, 변환되어 돌아오는 구조."
---

이 문서 사이트의 `/ko/` 경로가 FrogProgsy의 공식 전체 문서입니다. README는 첫 성공 빠른 시작만
다루며, 내부 구조 설명은 이 문서를 기준으로 유지합니다.

FrogProgsy는 범용 클라우드 프록시가 아니라 내 컴퓨터에서 실행되는 Claude Code 연결 도구입니다. 메인 프로세스는 Claude Code의
Anthropic Messages 요청을 받아 AI 서비스와 모델을 고르고, 다시 Claude Code가 이해하는
Anthropic-compatible JSON 또는 SSE를 돌려줍니다. 외부 서비스 쪽은 Anthropic, OpenAI 호환 chat,
OpenAI Responses, Gemini, Azure OpenAI, 또는 프로세스 안의 대신 처리 기능이 될 수 있습니다.

## 경계 지도

```txt
Claude Code
  └─ Anthropic Messages ingress
      ├─ /v1/messages
      ├─ /v1/messages/count_tokens
      └─ dashboard + config용 management /api/*

FrogProgsy core
  ├─ server.ts                    HTTP ingress, lifecycle, safe request/usage logs
  ├─ messages/parser.ts           Claude Messages → FrogParsedRequest
  ├─ router.ts                    model id → provider lane + adapter
  ├─ adapters/*                   provider wire builder + stream/JSON parser
  ├─ messages/bridge.ts           AdapterEvent → Claude Messages JSON/SSE
  ├─ claude-catalog.ts            Claude Code용 routed model alias materialization
  ├─ claude-inject.ts             owned env/settings injection + restore
  ├─ model-cache.ts               provider /models cache and stale fallback
  ├─ web-search-fallback/*                 hosted-search replacement capability fallback
  └─ image-fallback/*                     text-only lane용 image-description capability fallback
```

## Data plane contract

Claude Code-facing ingress는 Anthropic Messages입니다.

| Route | Role |
| --- | --- |
| `/v1/messages` | Main Claude Code request path. Streaming과 JSON response를 모두 지원합니다. |
| `/v1/messages/count_tokens` | Claude Code token counting compatibility path. |
| `/v1/models` | Active routed catalog view. `disabledModels`는 제외됩니다. |
| `/api/*` | Dashboard/config/diagnostic management path. Local 운영 표면입니다. |

FrogProgsy는 `/v1/responses`를 Claude Code-facing public ingress contract로 만들지 않습니다. Responses는
provider-facing adapter protocol입니다.

## 요청이 흐르는 방식

1. `server.ts`가 local port에서 Claude Code traffic을 받고 request-log phase event를 붙입니다.
2. `messages/parser.ts`가 Anthropic Messages payload를 검증해 `FrogParsedRequest`를 만듭니다.
3. `router.ts`가 request model id를 configured provider, adapter, upstream model id로 해석합니다.
4. Web-search 요청이나 image capability fallback 필요성이 있으면 in-process helper path가 main turn 앞/중간에서 실행됩니다.
5. 선택된 adapter가 upstream HTTP request를 만듭니다. Forward-auth adapter는 명시 allowlist header만 복사합니다.
6. Provider output은 text, thinking, raw reasoning, tool-call, usage, error, done `AdapterEvent`로 파싱됩니다.
7. `messages/bridge.ts`가 Claude Code로 Anthropic Messages JSON 또는 SSE를 방출합니다.
8. Claude Code가 요청을 취소하면 upstream request와 helper request도 함께 중단됩니다.

## Parser 계약

`messages/parser.ts`는 provider translation 전에 Claude Code 의미를 보존합니다.

- `system` block은 internal developer context가 됩니다.
- User/developer text와 image part는 normalized content part가 됩니다.
- Assistant `text`, `thinking`, `redacted_thinking`, `tool_use` block은 assistant content로 round-trip됩니다.
- User `tool_result` block은 대응되는 `tool_use` id에 연결됩니다.
- `tools[]`와 `tool_choice`는 internal tool definition과 choice policy로 보존됩니다.
- Anthropic `thinking.budget_tokens`는 FrogProgsy reasoning effort level로 매핑됩니다.
- Provider-internal Responses-shaped raw body는 Responses-compatible lane 재사용을 위해 보존하지만 public ingress가 되지는 않습니다.

## Routing contract

Model id 해석은 route prefix를 기준으로 합니다.

| Input model id | Resolution |
| --- | --- |
| `provider/model` | `config.providers.provider` lane으로 routing하고 upstream에는 provider-owned `model`을 보냅니다. |
| `model` | `defaultProvider` lane으로 routing하고 provider default/model id로 해석합니다. |
| Disabled route | Catalog와 `/v1/models`에서 숨기고 선택기 노출을 막습니다. |
| Unknown provider prefix | Routing error로 safe error payload를 반환합니다. |

`reasoning-effort.ts`는 Claude Code가 허용하는 effort label을 provider wire value로 번역하고,
unsupported level을 clamp하며, effort를 받을 수 없는 model에서는 완전히 제거합니다.

## Stream bridge

Bridge는 Claude Code로 돌아가는 경로를 소유합니다. Adapter event를 Claude Code가 기대하는 Anthropic
Messages stream 형태로 변환합니다.

| Adapter event | Claude Messages output |
| --- | --- |
| `text_delta` | text `content_block_start` → text `content_block_delta` → `content_block_stop` |
| `thinking_delta` / `reasoning_raw_delta` | Summary가 숨겨지지 않은 경우 thinking block delta |
| `tool_call_start` | `tool_use`가 담긴 `content_block_start` |
| `tool_call_delta` | Incremental `input_json_delta` |
| `tool_call_end` | `tool_use` block을 닫고 `stop_reason: "tool_use"` 설정 |
| `done` | `message_delta`에 final usage, 이후 `message_stop` |
| `error` | Proxy stack trace 없이 Anthropic-style error payload |

Upstream silence 중에는 bridge가 무해한 SSE comment heartbeat(`: frogprogsy keepalive`)를 보내 Claude Code
stream을 유지합니다. Non-streaming response도 같은 event sequence에서 조립하므로 streaming과 JSON mode는
하나의 behavior path를 공유합니다.

## Catalog와 cache 상태

- `model-cache.ts`는 provider별 `/models` 결과를 짧게 캐시하고, model endpoint가 잠깐 실패하면 stale cache entry로 fallback합니다.
- `claude-catalog.ts`는 routed model을 Claude Code catalog에 materialize합니다.
- `subagentModels`는 Claude Code subagent picker 앞쪽에 우선 배치됩니다.
- `disabledModels`는 injected catalog와 `/v1/models` response에서 제외됩니다.
- FrogProgsy는 자신이 건드리기 전 백업으로 pristine catalog를 복원할 수 있습니다.

## 부족한 기능 대신 처리

부족한 기능 대신 처리는 대상 AI 서비스가 기능을 직접 제공하지 않아도 Claude Code 쪽 동작을 유지하는
프로세스 내부 경로입니다.

| 대신 처리 기능 | Module | Trigger | Contract |
| --- | --- | --- | --- |
| Web search capability fallback | `web-search-fallback/*` | Claude Code가 hosted `web_search` tool을 요청했지만 routed provider가 직접 실행할 수 없음 | Compatible OpenAI Responses forward/key provider를 사용해 bounded search loop를 실행하고 compact result/tool_result를 main model에 제공합니다. |
| Image fallback | `image-fallback/*` | `modelCapabilities.<model>.input`이 text-only인 target model에 image input이 들어옴 | Vision-capable helper model로 image description을 만든 뒤 main text-only lane에 안전한 text marker를 제공합니다. |

대신 처리 요청도 main adapter와 같은 인증 전달, timeout, abort, safe logging 규칙을 따릅니다.

## Management plane and dashboard

Dashboard는 local 운영 표면입니다. Config provider lanes, route/default state, model catalog, safe request log,
usage summary를 보여줍니다. 실패 요청을 볼 때 dashboard log는 prompt body나 credential이 아니라 다음과 같은
safe metadata만 제공합니다.

- request id
- phase/status
- provider/model route
- duration
- safe error summary
- provider-reported token usage가 있는 경우의 aggregate count

운영 절차는 [`/ko/guides/troubleshooting/`](/frog-progsy/ko/guides/troubleshooting/)에 유지합니다.

## 운영 guardrail

FrogProgsy는 자신이 쓴 settings와 catalog entry만 소유합니다. `frogp restore`, `frogp stop`,
`frogp uninstall`은 사용자의 다른 Claude Code 상태를 지우지 않고 owned change만 제거합니다.

Log privacy invariant:

- Request log에는 API key, OAuth token, request body, prompt, account identity를 저장하지 않습니다.
- Usage accounting은 request id, timestamp, provider, model, status, duration, provider-reported token count만 저장합니다.
- Error response는 upstream/provider failure를 설명하되 proxy stack trace와 credential material을 내보내지 않습니다.

## Core type surface

내부 모델은 `types.ts`에 있습니다: `FrogParsedRequest`, `FrogContext`, `FrogMessage`, `FrogContentPart`,
`FrogToolCall`, `FrogTool`, `AdapterEvent`, `FrogConfig`, `FrogProviderConfig`.

`namespacedToolName()`과 `modelInList()` 같은 helper는 adapter, capability fallback, catalog sync, test 전반에서
툴 이름과 provider model list를 일관되게 유지합니다.
