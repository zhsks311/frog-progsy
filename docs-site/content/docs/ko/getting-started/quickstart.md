---
title: 처음 실행하기
description: "frogp start, 대시보드 Add Provider, 기본 AI 서비스/모델 선택, 첫 Claude Code 요청까지의 빠른 경로."
---

## 1. 로컬 연결 시작

```bash
frogp start
```

FrogProgsy가 기본 주소 `http://localhost:10100`에서 시작됩니다. 이미 포트가 사용 중이면 빈 로컬 포트를 고르고, Claude Code 설정과 모델 목록을 맞춥니다.

## 2. 대시보드 열기

```bash
frogp gui
```

대시보드가 열리면 첫 AI 서비스를 추가합니다.

1. **Add Provider**를 누릅니다.
2. 내장 항목을 고르거나 직접 OpenAI 호환 서버 주소를 입력합니다.
3. API 키를 붙여넣거나 Codex/ChatGPT, xAI, Kimi OAuth 로그인을 완료합니다. Claude 구독 접근은 Claude Code에 남기고 여러 Claude home은 `frogp claude`로 관리합니다.
4. 사용할 모델을 확인하고 기본 AI 서비스/모델로 선택합니다.

모델 목록은 가능한 경우 자동으로 가져오고, 이미 알려진 목록과 합칩니다. 기본 AI 서비스/모델을 저장하면 재시작 없이 바로 사용할 수 있습니다.

## 3. 첫 Claude Code 요청 보내기

```bash
claude "Write a hello world in Rust"
```

모델을 생략하면 FrogProgsy는 대시보드에서 고른 기본 AI 서비스/모델로 보냅니다.

특정 서비스와 모델을 꼭 지정해야 할 때만 `provider/model` 형태를 사용합니다.

```bash
claude -m "anthropic/claude-opus-4-8" "Explain this stack trace"
claude -m "codex/gpt-5.5" "Draft a migration plan"
```

## 첫 실행에서는 몰라도 되는 것

- `frogp init`은 터미널에서 하나씩 설정하고 싶을 때 쓰는 다른 방법입니다.
- `frogp restore`와 `frogp uninstall`은 문제가 생겼을 때 Claude Code 설정을 되돌리거나 FrogProgsy 로컬 설정을 지우는 명령입니다.
- `~/.frogprogsy/config.json`을 직접 고치는 방법은 설정 문서에서, AI 서비스 목록 선택은 연결 가이드에서 다룹니다.

다음: [요청 흐름](/frog-progsy/ko/getting-started/how-it-works/) 또는 [AI 서비스 연결](/frog-progsy/ko/guides/providers/).
