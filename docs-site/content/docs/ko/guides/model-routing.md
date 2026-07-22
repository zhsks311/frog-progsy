---
title: 모델 선택 규칙
description: "Claude Code 요청이 어느 AI 서비스와 모델로 가는지 FrogProgsy가 정하는 순서."
---

FrogProgsy의 전체 운영 문서는 docs-site의 `/ko/` 경로가 기준입니다. 이 가이드는
“이 요청이 왜 이 AI 서비스로 갔는가?”를 판단하는 흐름만 다룹니다.

FrogProgsy는 Claude Code가 보낸 모델 이름을 정해진 순서로 해석합니다. Claude Code가 짧은 모델 이름,
`provider/model`, 자동으로 만든 표시 이름 중 무엇을 보내든, 실제로 호출할 AI 서비스와 모델 하나로 정합니다.

## 선택 순서

| 단계 | 무엇을 보나 | 결과 |
| --- | --- | --- |
| 1 | `model-aliases.json`의 표시 이름 | `claude-frogp-…`를 저장된 `provider/model` 값으로 되돌림 |
| 2 | 명시적 `provider/model` | 서비스를 고르고 모델 이름만 외부 서비스에 보냄 |
| 3 | 서비스의 `defaultModel` | 요청 모델과 기본 모델이 같은 서비스를 사용 |
| 4 | 서비스의 `models[]` | 모델 목록에 그 이름을 가진 서비스를 사용 |
| 5 | 기본 모델군 이름 | `anthropic`, `openai`, `groq` 같은 설정된 서비스로 보냄 |
| 6 | `defaultProvider` | 마지막 기본 선택. 모델 이름은 그대로 보냄 |

아무 규칙에도 맞지 않고 기본 서비스도 없으면 FrogProgsy는 추측하지 않고 바로 실패합니다.

## 가장 안전한 방법: `provider/model`을 직접 쓰기

```txt
anthropic/claude-sonnet-4-6  → provider: anthropic    upstream model: claude-sonnet-4-6
codex/gpt-5.5                → provider: codex        upstream model: gpt-5.5
local-test/local-model       → provider: local-test   upstream model: local-model
```

Claude Code 모델 선택기는 자동으로 만든 표시 이름을 보여줄 수 있지만, 세부 정보에는 원래
`provider/model` 값이 남습니다. 대시보드에서 AI 서비스를 추가한 뒤에도 운영 메모, 이슈,
내부 문서에는 겹치지 않는 `provider/model` 값을 우선 기록하세요.

## 짧은 id에는 소유자가 필요합니다

`gpt-5.5` 같은 short id는 편하지만, 한 provider가 명확히 소유할 때만 안전합니다.
`defaultModel` 또는 `models[]`로 소유자를 지정하세요.

```json
{
  "providers": {
    "codex": {
      "defaultModel": "gpt-5.5",
      "models": ["gpt-5.5", "gpt-5.4-mini"]
    }
  }
}
```

`defaultModel`은 `models[]`보다 먼저 이깁니다. Prefix routing은 common family 편의 기능일 뿐이며,
설정되지 않은 provider를 만들어내지 않습니다.

## 비밀키 확인은 모델 선택 뒤에 합니다

```json
{
  "apiKey": "${OPENAI_API_KEY}"
}
```

`resolveEnvValue()`는 요청을 만들 때 `${NAME}`과 `$NAME`을 확장합니다. 그래서 설정 파일은 실제
비밀키 없이 공유할 수 있습니다.

## 모델 선택이 이상할 때

1. 대시보드 요청 기록에서 선택된 모델, AI 서비스, 상태, 주소, 단계, 안전한 오류 코드를 확인합니다.
2. 요청 모델이 `provider/model`인지, 자동 표시 이름인지, 짧은 이름인지 구분합니다.
3. 정적 설정의 `defaultProvider`, 각 provider의 `defaultModel`, `models[]`, `disabledModels`를 확인합니다.
4. alias가 관련된 경우 `~/.frogprogsy/model-aliases.json`을 확인합니다.
5. 해결되지 않으면 [설정 파일 항목](/frog-progsy/ko/reference/configuration/)의 해당 항목을 확인합니다.
