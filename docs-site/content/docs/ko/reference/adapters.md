---
title: 연결 방식 세부
description: "FrogProgsy가 각 AI 서비스의 요청/응답 형식을 Claude Code 형식으로 바꾸는 세부 규칙."
---

이 문서 사이트의 `/ko/` 경로가 FrogProgsy의 공식 전체 문서입니다. README는 첫 성공 빠른 시작만
다루며, 연결 방식의 세부 규칙은 이 문서를 기준으로 유지합니다.

FrogProgsy 어댑터는 Claude Code 요청과 `config.json`에서 선택한 AI 서비스 사이에 놓입니다. 역할은 세 가지입니다.

1. 한 프로토콜 계열에 맞는 upstream request를 만든다.
2. Credential을 새지 않게 지키면서 upstream stream 또는 JSON response를 읽는다.
3. Bridge가 다시 Claude Code 호환 Messages JSON/SSE로 바꿀 수 있는 FrogProgsy `AdapterEvent`를 낸다.

소스 진입점은 `src/adapters/base.ts`입니다. 런타임 계약은 작게 유지됩니다.
`buildRequest(...)`는 `{ url, method, headers, body }`를 만들고, `parseStream(...)`과 선택적
`parseResponse(...)`는 upstream 출력을 text, thinking, raw reasoning, tool-call, usage, error, done
이벤트로 바꿉니다.

## Adapter event contract

| Event | Meaning | Bridge obligation |
| --- | --- | --- |
| `text_delta` | Assistant visible text delta | Anthropic text content block으로 방출 |
| `thinking_delta` | Summary 가능한 reasoning/thinking text | Thinking block으로 방출하거나 숨김 정책 적용 |
| `reasoning_raw_delta` | Provider raw reasoning trace | 가능한 경우 thinking path에 보존하되 user-visible leak 정책을 지킴 |
| `tool_call_start` | Tool call id/name 시작 | Claude `tool_use` content block 시작 |
| `tool_call_delta` | Tool arguments JSON fragment | Incremental `input_json_delta`로 축적 |
| `tool_call_end` | Tool call 종료 | Tool block을 닫고 `stop_reason: "tool_use"` 설정 |
| `done` | 정상 종료와 optional usage | Final usage와 `message_stop` 방출 |
| `error` | Upstream/protocol failure | Proxy stack trace 없이 Anthropic-style error payload |

모든 어댑터는 streaming과 non-streaming이 같은 semantic event sequence를 만들도록 유지해야 합니다.

## 레인 지도

| Adapter id | Provider protocol | Auth modes | Contract |
| --- | --- | --- | --- |
| `openai-chat` | `/chat/completions` 호환 API | `key` 또는 local keyless | 범용 OpenAI-compatible routing, tool-call 보정, 모델 정체성 정리, provider option clamp |
| `openai-responses` | `/responses` 또는 `/v1/responses` | `forward`, `key`, `oauth` | OpenAI Responses, ChatGPT/Codex backend, allowlisted forward headers, Responses item parsing |
| `anthropic` | `/v1/messages` | `key`, `forward` | Claude-native Messages, pass-through auth boundary, extended-thinking token budget, tool name compatibility |
| `google` | Gemini `generateContent` / `streamGenerateContent` | `key` | Gemini contents/parts, inline image 변환, synthetic tool-call id |
| `azure-openai` | Azure OpenAI Responses-compatible endpoint | `key` | Azure API-key header와 `api-version` query 처리. `azure`는 legacy alias입니다. |

## Common invariants

- Adapter는 API key, OAuth token, full prompt body를 log에 남기지 않습니다.
- Adapter는 provider-specific failure를 bridge가 처리할 수 있는 `error` event 또는 safe error payload로 바꿉니다.
- Tool namespaced path는 `namespacedToolName(namespace, name)` 규칙으로 flatten하고 return path에서 복원합니다.
- Provider가 거부하는 option은 모델/provider gate에서 제거하거나 낮춥니다. Unsupported 값을 그대로 보내지 않습니다.
- Claude Code ingress는 Anthropic Messages입니다. FrogProgsy는 `/v1/responses`를 Claude Code-facing public ingress로 광고하지 않습니다.

## `openai-chat`: 호환 채팅 레인

xAI, Kimi, DeepSeek, GLM, Groq, OpenRouter, Ollama, vLLM, LM Studio 같은 OpenAI-compatible Chat
Completions endpoint에 쓰는 레인입니다.

Request shaping:

- Claude Code의 developer/system context는 provider가 이해하는 system/developer role message로 재배치됩니다.
- Tool은 namespace-safe 이름을 가진 OpenAI function tool로 변환됩니다.
- Provider가 거부할 수 있는 standalone tool-result turn은 synthetic assistant `tool_call`로 보정됩니다.
- Claude Code의 GPT-5 정체성 문장은 중립화되어 routed non-OpenAI model이 잘못된 vendor identity를 주장하지 않습니다.
- Temperature, top-p, penalty, tool-choice mode, `reasoning_effort`는 provider/model별 지원 목록에 맞춰 gate됩니다.

Response parsing:

- Streaming delta는 `text_delta`, optional `thinking_delta`, `tool_call_*`, usage event로 접힙니다.
- Tool-call argument fragment는 JSON fragment 그대로 축적하되 bridge가 Claude Messages shape로 닫을 수 있어야 합니다.
- `preserveReasoningContentModels`에 들어간 모델은 assistant reasoning history를 provider가 기대하는 필드로 보존합니다.

## `openai-responses`: Responses upstream 레인

OpenAI Responses shape 또는 ChatGPT/Codex OAuth backend를 사용할 때의 레인입니다.

Request target:

- `forward` 모드는 `{baseUrl}/responses`를 대상으로 하고 incoming request에서 명시 allowlist header만 복사합니다.
- `key` 모드는 보통 `{baseUrl}/v1/responses`를 대상으로 합니다.
- Codex backend URL은 의도적으로 backend `/responses` route를 사용합니다.

Request safety:

- Raw reasoning echo가 이후 턴에서 backend 400을 만들지 않도록 reasoning input content를 정리합니다.
- Codex backend 요청은 FrogProgsy가 안전하게 재생할 수 있는 field만 남깁니다: model, input, instructions,
  stream, tools, tool choice, `store: false`, bounded reasoning options.
- Forwarded header는 allowlist로 제한합니다. Local FrogProgsy marker token을 upstream credential처럼 전달하지 않습니다.

Response parsing:

- Message output은 text event가 됩니다.
- Reasoning summary는 thinking event가 됩니다.
- Function/custom/search call output은 tool-call event가 됩니다.
- Usage block은 final `done` event에 붙습니다.

## `anthropic`: Claude-native 레인

Anthropic API key, Anthropic-compatible gateway, Claude Code pass-through profile에 쓰는 레인입니다. Claude Code가 이미
Anthropic Messages를 말하므로 translation이 가장 적지만, local relay stability를 위한 보정은 여전히 필요합니다.

- Forward-auth 요청은 local `Bearer local-frogprogsy` marker token을 무시하고 실제 Anthropic auth header만 전달합니다.
- 명시적으로 설정한 custom oauth-mode route가 있을 때만 built-in tool 호환성을 위해 tool name prefix를 붙이거나 제거할 수 있습니다.
- Tool-result image는 Anthropic native content block으로 유지하고, orphan tool result는 invalid standalone
  `tool_result` 대신 text로 보존합니다.
- Extended thinking에서는 `max_tokens`가 항상 `thinking.budget_tokens`보다 크도록 조정하고, Anthropic이
  거부하는 temperature/top-p를 제거합니다.

Stream parser는 Anthropic 이벤트 이름(`content_block_start`, `content_block_delta`, `message_delta`,
`message_stop`)을 따라 FrogProgsy event를 냅니다.

## `google`: Gemini 레인

Gemini API용 레인입니다. 요청은 Gemini `contents[]`로 재구성됩니다.

- System prompt는 `systemInstruction`이 됩니다.
- Assistant turn은 Gemini `model` turn이 됩니다.
- Tool은 `functionDeclarations`가 됩니다.
- Data-URL image는 `inline_data`가 됩니다.
- Remote image는 MIME 데이터가 없으므로 작은 marker로 낮춥니다.

Gemini는 Claude Code와 같은 stable tool-call id를 돌려주지 않으므로 FrogProgsy가 relay-local call id를
만들어 bridge에 넘깁니다.

## `azure-openai`: Azure wrapper 레인

Azure는 Responses adapter의 request/response 처리를 재사용한 뒤 wire shape만 조정합니다.

- `Authorization`을 `api-key`로 바꿉니다.
- URL이 이미 `/v1/` route가 아니면 `api-version` query를 붙입니다.
- Provider header가 덮어쓰지 않으면 기본 API version은 `2025-04-01-preview`입니다.

## Image helper utilities

`src/adapters/image.ts`에는 media 공유 helper가 있습니다.

- `parseDataUrl(url)`은 Claude Code inline image를 Anthropic/Gemini용 `{ mediaType, base64 }`로 나눕니다.
- `contentPartsToText(content)`는 text-only tool-result lane에서 content를 평탄화하고, 설명되지 않은 이미지는
  base64를 prompt에 쏟지 않고 `[image]` marker로 치환합니다.

## 새 어댑터 체크리스트

새 adapter를 추가할 때는 public recipe가 아니라 runtime contract를 먼저 맞춥니다.

1. `ProviderAdapter`를 구현하고 `name`을 config `adapter` id와 일치시킵니다.
2. `buildRequest`에서 auth header, URL, body field를 provider protocol에 맞게 제한합니다.
3. Streaming parser와 non-streaming parser가 같은 `AdapterEvent` 의미를 내도록 만듭니다.
4. Tool-call start/delta/end, reasoning, usage, error path를 모두 bridge 가능한 형태로 보존합니다.
5. `server.ts` adapter resolver와 provider registry/catalog metadata를 함께 갱신합니다.
6. Korean docs-site `/ko/reference/adapters/`와 `/ko/reference/configuration/`의 adapter id 계약을 갱신합니다.
