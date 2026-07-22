---
title: Claude 앱에 모델 보이기
description: FrogProgsy로 연결한 모델이 Claude Code App, CLI, TUI에 나타나는 방식.
---

FrogProgsy의 전체 운영 문서는 docs-site의 `/ko/` 경로가 기준입니다. 이 가이드는 Claude Code
App/CLI/TUI에 연결 모델을 보이게 하고, 선택기에 오래된 항목이 남았을 때 다시 맞추는 절차에 집중합니다.

frogprogsy는 Claude Code App을 패치하지 않습니다. Claude Code 설정에 소유 env 키를 쓰고
로컬 FrogProgsy에서 Anthropic-style `/v1/models` 목록을 제공합니다. Claude Code CLI/TUI/App이
같은 모델 목록을 사용하므로 연결 모델은 안정적인 표시 이름으로 나타납니다.

## 운영 경로

`frogp init`, `frogp start`, `frogp claude` profile action은 다음 로컬 파일을 맞춰 둡니다:

```text
<profile-home>/settings.json
~/.frogprogsy/claude-profiles/<cp_id>/claude-settings-backup.json
~/.frogprogsy/model-aliases.json
```

설정 주입은 FrogProgsy가 소유한 env 키만 기록합니다:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:10100",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  }
}
```

모델 목록은 `claude-frogp-provider-model` 같은 표시 이름을 반환하고, 두 모델이 같은 이름으로 정리되는 경우에만 짧은 해시 접미사가 붙습니다. 또한
각 `display_name`은 정확한 `provider/model` 값을 보존합니다. 운영 문서와
runbook에는 선택기 표시 이름보다 이 `provider/model` 값을 기록하세요.

Responses WebSocket 지원은 Claude Messages에서 더 이상 쓰지 않습니다. frogprogsy는
`supports_websockets`를 광고하지 않으며 Claude Code 요청은 HTTP/SSE를 사용합니다.

## 선택기에 연결 모델이 표시되는 이유

Claude Code 모델 선택기는 Claude Code 형식의 모델 항목을 기대합니다. frogprogsy는 기본 Claude Code 모델
템플릿을 복제한 뒤 연결 모델 정보만 바꿔 해당 항목을 만듭니다:

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

복제된 항목은 reasoning 레벨, shell 타입, API 지원 플래그, base instructions 같은 필수
필드를 유지합니다. 그래서 각 연결 항목은 선택기에 표시 가능한 유효한 Claude Code 모델처럼 보입니다.

## 하위 작업 모델 순서 정하기

Claude Code의 `spawn_agent`는 모델 목록에서 우선순위가 높은 처음 5개 모델만 노출합니다. `subagentModels`
또는 웹 대시보드에서 최대 5개의 `provider/model` 또는 기본 모델 id를 고르면 frogprogsy가 해당
항목을 모델 목록 앞쪽에 정렬합니다.

## 오래된 모델 목록 새로고침

선택기에 오래된 항목이 남아 있으면 대상 프로필의 모델 목록을 다시 로드한 뒤 Claude Code를 새로 시작하거나 기존 세션을 resume하여 Claude Code가 `/v1/models`를 다시 가져오게 하세요:

```bash
frogp claude reload-models <profile-id>
```

이미 열려 있는 `/model` 화면은 모델 목록 변경을 hot reload하지 않습니다. 해당 선택기를 닫고 새로 시작했거나 resume한 Claude Code 세션에서 다시 여세요. Dashboard/API 목록 reload는 Claude Code 선택기 복구와 별개입니다. 웹/API 화면에는 그 절차를 쓰되, `frogp claude reload-models <profile-id>`의 대체 수단으로 보지 마세요. 로컬 proxy가 내려가 있으면 Claude Code 선택기를 다시 로드하기 전에 `frogp refresh`로 복구하세요.
