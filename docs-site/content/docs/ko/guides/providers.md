---
title: AI 서비스 연결
description: "OAuth 계정, API 키, 로컬 서버, OpenAI 호환 서버를 FrogProgsy에 연결하는 방법."
---
FrogProgsy의 전체 운영 문서는 docs-site의 `/ko/` 경로가 기준입니다. 이 가이드는 AI 서비스를 처음
연결하고 기본 모델을 정하는 작업만 다룹니다. 설정 파일의 모든 항목은
[설정 파일 항목](/frog-progsy/ko/reference/configuration/)에서 확인하세요.

FrogProgsy는 각 AI 서비스를 로컬 `frogp` 뒤에 붙는 **연결 대상**으로 다룹니다. Claude Code는
평소처럼 요청을 보내고, FrogProgsy가 어떤 주소로 보낼지, 어떤 인증을 쓸지, 어떤 모델을 보여줄지 결정합니다.

## 가장 먼저 할 일: 대시보드에서 AI 서비스 추가

AI 서비스 연결은 대시보드에서 하는 게 가장 안전합니다.

1. `frogp gui`로 대시보드를 엽니다.
2. **Providers → Add provider**에서 OAuth 로그인, API 키, 직접 입력한 URL, 로컬 서버 중 하나를 고릅니다.
3. 목록에 있는 서비스는 키 입력 페이지를 열고, 키를 검증한 뒤 `~/.frogprogsy/config.json`에 저장합니다.
4. **Make default**로 Claude Code가 모델을 따로 지정하지 않을 때 쓸 기본 서비스를 정합니다.
5. **Models**에서 기본 모델과 Claude Code에 보여줄 모델을 확인하고, 필요 없는 항목은 숨깁니다.
6. **Activity**에서 요청이 어느 단계까지 갔는지 확인합니다. 단계 이름은 문제를 좁힐 때만 보면 됩니다.

대시보드 작업 뒤에는 [모델 선택 규칙](/frog-progsy/ko/guides/model-routing/)과
[대시보드와 사용 기록](/frog-progsy/ko/guides/web-dashboard/)을 이어서 보면 됩니다.

## 어떤 연결 방식을 쓸지 고르기

| 연결 방식 | 적합한 경우 | 인증 출처 | 내부 처리 방식 |
| --- | --- | --- | --- |
| **기존 로그인 전달** | Claude Code 요청에 외부 서비스 인증 헤더가 이미 있습니다. | 허용된 헤더만 전달. | `anthropic`, `openai-responses` |
| **계정 로그인** | FrogProgsy가 로그인 토큰을 갱신하게 하고 싶습니다. | `~/.frogprogsy/auth.json` OAuth 저장소. | `openai-responses`, `openai-chat` |
| **API 키 연결** | 서비스가 API 키를 제공합니다. | 직접 입력한 키 또는 `~/.frogprogsy/config.json`의 `${ENV_VAR}`. | 대부분 `openai-chat`, 일부 `anthropic` |
| **로컬 서버** | Ollama, vLLM, LM Studio 같은 로컬 OpenAI 호환 서버를 씁니다. | 보통 빈 키 또는 로컬 전용 키. | `openai-chat` |

고급 설정을 직접 편집할 때의 항목별 설명은 [설정 파일 항목](/frog-progsy/ko/reference/configuration/)에 있습니다.

## AI 계정과 Claude Code 홈의 차이

**AI 계정**은 frogprogsy가 어디로 라우팅할 수 있는지를 정하는 provider 목록입니다. **Claude Code 홈**은
`~/.claude`, `~/.claude-work` 같은 Claude Code 설정 디렉터리를 관리합니다. 이 홈이 Claude 구독 인증을
가지고 있고, 로컬 `settings.json` gateway 주입도 이 홈에 적용됩니다.

Anthropic 모델을 Model Picker나 Model Mixing에서 쓰려면 두 가지가 모두 필요합니다. AI 계정에는 Anthropic
provider 행이 있어야 하고, 구독 인증을 쓸 때는 Claude Code 홈이 로그인되어 있어야 합니다. forward 모드에서
frogprogsy는 Claude 토큰을 저장하지 않고, 들어온 Claude Code 요청의 실제 `Authorization` 또는 `x-api-key`만
전달합니다. 이 헤더를 보내지 않는 headless/API 호출은 Anthropic API-key provider를 따로 써야 합니다.

## 기존 로그인 전달: 키를 저장하지 않음

새 설정은 Anthropic 기존 로그인 전달 방식을 기본으로 준비합니다. Claude Code가 원래 Anthropic Messages를
쓰기 때문입니다. 이 방식은 **서비스 키를 저장하지 않고**, 들어온 요청에 이미 있는 호환 인증 헤더만 전달합니다.

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

운영 메모:

- Anthropic 기존 로그인 전달은 실제로 존재하는 `authorization` 또는 `x-api-key`만 전달합니다.
- `ANTHROPIC_AUTH_TOKEN=local-frogprogsy`는 내부 표시값이라 외부 서비스로 보내기 전에 제거됩니다.
- OpenAI Responses 전달 방식은 호환 서비스와 대신 처리 기능에 필요한 헤더만 골라 보냅니다.
- 호환 인증이 있으면 [웹 검색 및 이미지 대신 처리](/frog-progsy/ko/guides/capability-fallbacks/)도 사용할 수 있습니다.

FrogProgsy가 요청 변환은 하되 서비스 비밀키를 저장하지 않게 하려면 이 방식을 쓰세요.

대시보드에서 **Anthropic Claude**를 선택하면 구독 토큰을 요구하지 않고 이 Claude Code 홈 방식을 기본으로 씁니다. 이 provider 행이 Claude 모델을 선택 가능하게 만들고, 인증 위치 입력칸은 `~/.claude`로 채워집니다. 먼저 그 위치에서 `claude login`이 되어 있어야 합니다. Claude 계정을 하나 더 쓰려면 별도 홈에 로그인하고 Anthropic 프로바이더 행을 하나 더 추가합니다.

```bash
CLAUDE_CONFIG_DIR=~/.claude-work claude login
frogp claude add work --home ~/.claude-work
frogp refresh
claude-work "hello"
```


## 계정 로그인: FrogProgsy가 토큰을 갱신

OAuth 계정은 `~/.frogprogsy/auth.json`에 저장되고 만료 전에 갱신됩니다. Claude 구독 인증은 여기서 OAuth lane이 아닙니다. Claude Code에 남기고 별도 Claude Code 설정 디렉터리가 필요하면 `frogp claude` 홈을 사용하세요. CLI 또는
[대시보드와 사용 기록](/frog-progsy/ko/guides/web-dashboard/)에서 지원되는 로그인을 시작할 수 있습니다.

```bash
frogp login codex        # ChatGPT/Codex 계정, Codex backend로 route
frogp login xai          # xAI Grok
frogp login kimi         # Moonshot Kimi
frogp logout <provider>
```

| 로그인 서비스 | FrogProgsy가 연결하는 주소 | 중요한 이유 |
| --- | --- | --- |
| `codex` | `https://chatgpt.com/backend-api/codex`의 `openai-responses` 연결 | Claude Code를 바꾸지 않고 Codex/ChatGPT 계정으로 요청을 보냅니다. |
| `xai` | `https://api.x.ai/v1`의 `openai-chat` 연결 | Grok 쪽 차이는 FrogProgsy가 연결 경계에서 맞춥니다. |
| `kimi` | `https://api.kimi.com/coding/v1`의 `openai-chat` 연결 | Kimi 코딩 모델을 같은 모델 목록에 넣습니다. |

일반 OpenAI API key billing은 ChatGPT/Codex OAuth와 분리됩니다.

```bash
frogp login openai          # OpenAI API 키 preset
frogp login openai-apikey   # preset id를 직접 지정
```

## API 키 연결: 목록에서 고르기

대시보드의 **Add provider** 흐름으로 먼저 추가하세요. 직접 설정 파일을 만지는 방식은
목록에 없거나 자동 검증을 우회해야 하는 고급 운영에서만 쓰는 편이 안전합니다.

| 종류 | 예시 서비스 |
| --- | --- |
| OpenAI 호환 API | Ollama Cloud, Mistral, DeepSeek, Cerebras, Together, Fireworks, Hugging Face, NVIDIA NIM |
| 코딩용 서비스 | Z.AI / GLM Coding, Qwen Portal, Kilo, GitHub Copilot, GitLab Duo |
| 지역/특화 API | MiniMax, MiniMax CN, Moonshot, Kimi coding, Xiaomi MiMo |
| 게이트웨이형 서비스 | Cloudflare AI Gateway, Vercel AI Gateway, Venice, NanoGPT, Synthetic, Qianfan, Alibaba, Parallel, ZenMux, LiteLLM |

대부분은 bearer key를 쓰는 `openai-chat` 연결입니다. Anthropic 형태의 주소만 제공하는 일부
서비스는 `anthropic` adapter와 `x-api-key`를 씁니다.

> **구독형 서비스는 일반 API 키 연결과 다릅니다**
>
> GitHub Copilot과 GitLab Duo는 OpenAI 호환 주소를 통하지만 구독 토큰으로 인증합니다.
> Copilot은 서비스 `headers`에 `User-Agent`가 필요할 수 있고, Cloudflare AI Gateway는 URL template에
> 계정과 gateway id가 들어가야 합니다.

## 로컬 서버: 내 머신으로 보내기

Claude Code와 맞추는 일은 FrogProgsy가 맡고, 실제 답변 생성은 로컬 서버가 처리하게 할 수 있습니다.

| 실행 도구 | 기본 주소 |
| --- | --- |
| Ollama local | `http://localhost:11434/v1` |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |

대시보드에서 **Custom**을 선택하거나 `frogp init`에서 `custom`을 고른 뒤 base URL을 입력하세요.
로컬 서버가 허용할 때만 빈 키를 사용하세요.

## 명령줄/설정 파일로 고급 조정

명령줄과 설정 파일 편집은 대시보드에서 확인한 연결을 자동화하거나 복구할 때 사용하세요.

- OAuth 로그인은 `frogp login <provider>` / `frogp logout <provider>`로 관리합니다.
- 초기 직접 입력 서비스는 `frogp init`에서 만들 수 있습니다.
- 이미 연결한 서비스의 `defaultModel`, `models[]`, `disabledModels`, `headers`는
  `~/.frogprogsy/config.json`에서 조정할 수 있습니다.
- 편집 뒤에는 대시보드 **Models**와 **Activity**로 실제 모델 선택을 확인합니다.

## 빠른 선택 기준

- 서비스 비밀키를 저장하지 않으려면 **기존 로그인 전달**.
- ChatGPT/Codex 계정 연결이 필요하면 `frogp login codex`.
- 일반 OpenAI API 과금이 필요하면 `frogp login openai`.
- 표준 OpenAI 호환 서비스면 **API 키 연결**.
- 로컬 생성 서버면 **로컬 서버**.
- 텍스트 전용 모델에 웹 검색/이미지 설명이 필요하면 **부족한 기능 대신 처리**.
