---
title: 요청 실패 해결
description: "Claude Code 요청이 실패했을 때 안전한 기록, 실행 상태, 모델 선택, 인증, 대신 처리, 원복 순서로 확인하는 방법."
---

FrogProgsy의 전체 운영 문서는 docs-site의 `/ko/` 경로가 기준입니다. 이 가이드는 실패한 Claude Code 요청을
빠르게 분류하고, 인증 정보나 프롬프트를 노출하지 않는 안전한 정보만으로 복구하는 절차입니다.

## 0. 증상을 한 줄로 분류하기

| 증상 | 먼저 볼 곳 |
| --- | --- |
| Claude Code가 모델을 못 찾음 | 아래의 모델/기본 서비스 확인 |
| 요청이 즉시 401/403으로 실패 | 아래의 Auth/OAuth 확인 |
| 요청이 오래 멈추거나 응답 흐름이 끊김 | 아래의 대시보드 안전 기록 확인 |
| 이미지 또는 웹 검색 요청만 실패 | 아래의 대신 처리 기능 확인 |
| Claude Code를 원래 상태로 돌려야 함 | 아래의 원복 절차 |

## 1. 대시보드 안전 기록으로 단계 확인

대시보드를 엽니다.

```bash
frogp gui
```

**Activity** 화면에서 실패한 요청 id를 찾고 마지막 단계를 봅니다. 요청 기록은 비밀 저장소가 아니며 API
키, OAuth 토큰, 프롬프트 본문, 계정 정보를 저장하지 않습니다.

| 마지막 단계 | 의미 | 조치 |
| --- | --- | --- |
| `parse` | Claude Code 요청 모양이 FrogProgsy가 기대한 형태와 다름 | Claude Code 버전과 요청 재현 조건을 확인하고, 같은 요청이 기본 Claude에서 되는지 비교합니다. |
| `route` | 모델 이름을 AI 서비스로 해석하지 못함 | 기본 서비스, `provider/model` 값, 숨긴 모델 상태를 확인합니다. |
| `oauth` / `auth` | 인증 정보가 없거나 만료됨 | 서비스 로그인 상태와 `authMode`를 확인합니다. |
| `adapter_build` | 외부 서비스 요청을 만들 수 없음 | adapter id, baseUrl, 모델 지원 기능/옵션 제한을 확인합니다. |
| `upstream_connect` | 외부 서비스 연결 실패 | baseUrl, 네트워크, 서비스 상태, API 주소를 확인합니다. |
| `stream_bridge` | 외부 서비스 응답을 Claude Code 형식으로 바꾸는 중 실패 | 서비스가 도구/reasoning/스트림 형식을 바꿨는지 확인합니다. |
| `finalize` | 응답은 끝났고 기록/정리 단계 | 사용량/로그 쓰기 권한과 로컬 디스크 상태를 확인합니다. |

안전한 오류 요약만으로 부족하면 요청 본문을 복사하지 말고 모델 경로, AI 서비스, adapter, 단계, 상태 코드,
요청 id만 이슈에 적습니다.

## 2. 모델/기본 서비스 확인

FrogProgsy가 떠 있는지 먼저 확인합니다.

```bash
frogp status
```

- 실행 중이 아니면 `frogp start` 또는 대시보드에서 시작합니다.
- `frogp status`는 실행 여부만 알려줍니다. 실제 포트는 `~/.frogprogsy/config.json`의 `port`와 Claude Code 설정에 들어간 주소를 확인하세요.
- 요청 상태가 의심되면 대시보드 상태와 마지막 안전 오류를 함께 확인합니다.

다음으로 모델이 어느 AI 서비스로 가는지 확인합니다.

1. Dashboard **Providers**에서 `defaultProvider`가 실제로 존재하는 AI 서비스인지 확인합니다.
2. Claude Code에서 고른 모델이 `provider/model` 형태라면 `provider` 값이 `config.json`의 `providers` 값과 일치해야 합니다.
3. Dashboard **Models**에서 해당 모델이 숨김 상태가 아닌지 확인합니다.
4. `subagentModels`는 노출 순서만 바꾸며 새 연결을 만들지는 않습니다. 모델이 없으면 서비스 목록 동기화를 확인합니다.
5. 서비스가 live `/models`를 자주 실패하면 `liveModels: false`와 `models` 허용 목록으로 고정합니다.

Claude Code 모델 선택기가 오래된 목록을 보이면 활성 profile의 Claude Code catalog를 새로 고칩니다.

```bash
frogp claude reload-models <profile-id>
```

그다음 새 Claude Code 세션을 시작하거나 resume해서 `/v1/models`를 다시 가져오게 합니다. 이미 열린 `/model` 화면은 hot reload되지 않습니다. Proxy가 응답하지 않으면 먼저 `frogp refresh`를 실행한 뒤 profile catalog를 다시 불러옵니다.

## 3. 인증/OAuth 확인

401/403 또는 로그인 반복은 연결 종류별로 나눕니다.

| 연결 종류 | 확인할 것 | 복구 |
| --- | --- | --- |
| API 키 연결 | `apiKey`가 직접 값인지 `${ENV_VAR}` 참조인지, shell/runtime 환경에 env가 있는지 | Dashboard에서 서비스를 다시 저장하거나 `config.json` env 참조를 고칩니다. |
| OAuth 연결 | Dashboard OAuth 상태, `~/.frogprogsy/auth.json`에 서비스 토큰이 있는지 | `frogp login <provider>`를 다시 실행합니다. |
| 기존 로그인 전달 | Claude Code가 보낸 외부 서비스 호환 인증 헤더가 허용 목록에 있는지 | 기본 Claude/ChatGPT/Codex 로그인 상태를 확인하고 FrogProgsy를 재시작합니다. |
| 로컬 서버 | 키 없는 주소가 실제로 떠 있는지 | Ollama/vLLM/LM Studio 서버를 먼저 띄우고 baseUrl을 맞춥니다. |

OAuth 인증 정보를 수동으로 공유하거나 로그에 붙이지 마세요. 이슈에는 AI 서비스 이름, 인증 방식, 상태 코드,
마지막 안전 단계만 남깁니다.

## 4. 대신 처리 기능 확인

웹 검색과 이미지 요청은 선택한 AI 서비스가 직접 처리하지 못하면 대신 처리 기능이 필요할 수 있습니다.

### 웹 검색

- `webSearchFallback.enabled`가 `true`인지 확인합니다.
- 대신 처리 모델이 OpenAI Responses forward/key provider를 사용할 수 있어야 합니다.
- `maxSearchesPerTurn`이 너무 낮으면 검색 루프가 일찍 멈춥니다.
- `timeoutMs`가 너무 낮으면 외부 검색이 중간에 실패합니다.

### 이미지

- 텍스트 전용 모델이면 `imageFallback.enabled`가 `true`인지 확인합니다.
- `modelCapabilities.<model>.input`이 text-only이면 `imageFallback` 활성화 시 이미지가 본 요청 전에 텍스트 설명으로 바뀝니다.
- 대신 처리 `model`이 이미지를 이해할 수 있어야 합니다.
- Base64 이미지가 프롬프트 텍스트로 흘러가지 않아야 합니다. 안전한 기록에는 이미지 본문이 저장되지 않습니다.

대신 처리 기능이 불안정하면 기본 모델을 이미지/검색을 직접 지원하는 모델로 바꿔 재현해 보고, 실패가 대신 처리 기능에만 있는지
기본 AI 서비스에도 있는지 분리합니다.

## 5. 원복 절차

Claude Code를 원래 상태로 되돌릴 때는 좁은 경로부터 사용합니다.

| 목적 | 명령 | 보존되는 것 |
| --- | --- | --- |
| Claude Code 설정/모델 목록만 되돌림 | `frogp restore` | 실행 중 FrogProgsy, FrogProgsy 설정/인증 |
| FrogProgsy도 같이 내림 | `frogp stop` | FrogProgsy 설정/인증 |
| FrogProgsy 로컬 설정 제거 | `frogp uninstall` | 사용자의 다른 Claude Code 상태 |

`frogp restore`와 `frogp stop`은 FrogProgsy가 만든 Claude Code 설정/모델 목록 항목만 제거합니다. Claude Code
history remapping은 만들지 않으며, `frogp recover-history --legacy-openai`는 retired no-op입니다.

## 6. 재현 정보를 안전하게 남기기

이슈나 PR에 필요한 최소 정보:

- OS와 FrogProgsy 버전
- `frogp status`의 비밀값 없는 요약
- 실패 요청 id와 대시보드의 안전한 단계/상태
- AI 서비스 이름, adapter id, 인증 방식, 선택된 모델 id
- 대신 처리 기능 사용 여부(`webSearchFallback`, `imageFallback`)
- clean restore 후에도 재현되는지 여부

남기면 안 되는 정보:

- API key, OAuth token, session cookie
- 전체 프롬프트/요청 본문
- account email 또는 organization id
- provider dashboard screenshot에 credential/account가 보이는 이미지
