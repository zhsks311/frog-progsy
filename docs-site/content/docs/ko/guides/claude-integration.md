---
title: Claude Code 연결
description: "FrogProgsy가 Claude Code 설정에 무엇을 추가하고, 모델 목록을 어떻게 보여주며, 어떻게 원복하는지."
---

FrogProgsy의 전체 운영 문서는 docs-site의 `/ko/` 경로가 기준입니다. 이 가이드는 Claude Code에
무엇을 쓰고, 무엇을 쓰지 않으며, 문제가 생겼을 때 어떻게 되돌리는지에 집중합니다.

FrogProgsy는 Claude Code가 이미 읽는 경로로 연결됩니다. Claude Code 실행 파일을 고치지 않고,
현재 연결 방식에서 `config.toml`에 `model_provider` table을 설치하지도 않습니다. 다만 매일 쓰는
명령이 `frogp claude run`이 되지 않도록 `claude`, `claude-work` 같은 launcher shim은 생성합니다.

## FrogProgsy가 만든 설정만 쓴다

`frogp init`, `frogp start`, 시작 과정은 `~/.claude/settings.json`의 `env` 아래에 FrogProgsy가 소유한 키만 씁니다.

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:10100",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  }
}
```

관련 없는 설정은 건드리지 않습니다. 처음 쓰기 전에 기존 값은
`~/.frogprogsy/claude-profiles/<cp_id>/claude-settings-backup.json`에 프로필별로 저장되고, restore가 그 값을 되돌립니다.
백업이 없을 때도 restore는 명확히 FrogProgsy가 만든 항목만 제거합니다. 모델 목록 표시와 함께 남은
로컬 `ANTHROPIC_BASE_URL`, 선택적으로 쓰인 로컬 FrogProgsy 인증 표시값, `X-Frogp-Claude-Profile` header,
그리고 현재 또는 과거 릴리스가 만든 기본 모델 표시 이름만 정리합니다. 관련 없는 설정은
지우지 않으므로 Claude Code 계정 연결은 계속 동작합니다.

## Claude Code에 모델 목록 보여주기

모델 목록 표시가 켜지면 Claude Code는 로컬 FrogProgsy의 `/v1/models`를 호출합니다. FrogProgsy는 Claude Code가
받아들일 수 있는 Anthropic-style 이름을 돌려줍니다.
Claude Code는 세션을 시작하거나 resume할 때 `/v1/models`를 다시 가져오며, 이미 열려 있는 `/model` 화면을 다시 여는 것만으로 picker가 hot reload되지는 않습니다.

```txt
claude-frogp-codex-gpt-5-5
```

사람이 읽는 `display_name`은 `codex/gpt-5.5` 같은 원래 `provider/model` 값을 보존합니다. 표시 이름 상태는
`~/.frogprogsy/model-aliases.json`에 저장되며, 파일이 없어도 FrogProgsy는 설정된 이름을 다시 만들 수 있습니다.
Claude Messages 요청은 HTTP/SSE를 사용하며, 이 Claude Code 연결에서는 오래된 Responses WebSocket 경로를 광고하지 않습니다.
모델 변경 후 Claude Code picker를 복구하려면 `frogp claude reload-models <profile-id>`를 실행합니다. proxy가 꺼져 있던 뒤 proxy 쪽 모델 목록을 복구할 때는 `frogp refresh`를 사용합니다.

Anthropic Claude alias가 보이려면 frogprogsy에 Anthropic provider 행이 있어야 합니다. forward-auth 모드의
provider 행은 Claude 토큰을 저장하지 않습니다. 모델 목록 조회는 활성 Claude Code 홈이 보낸 실제
`Authorization` 또는 `x-api-key`를 사용할 수 있고, 결과는 `X-Frogp-Claude-Profile`별로 캐시됩니다. Anthropic
provider 행이 없으면 Claude Code의 원래 Claude 계정은 그대로 있어도 frogprogsy가 Model Picker나 Model
Mixing에 보여줄 라우팅된 Anthropic 모델이 없습니다.

## Claude 구독 연결: Forward와 Claude grant

frogprogsy는 여러분의 Claude 구독을 두 가지 방식으로 씁니다. 어느 쪽도 native Claude Code 홈(`~/.claude` 등)과 여러 계정 로그인을 바꾸지 않습니다.

**Forward(기본, 토큰 보관 안 함).** 위에서 설명한 forward-auth provider 행이 기본값입니다. frogprogsy는 Claude 토큰을 저장하지 않고, native 저장소를 읽거나 쓰지 않으며, Anthropic 요청은 활성 Claude Code 홈이 보낸 실제 `Authorization`/`x-api-key` 헤더를 그대로 재사용합니다. 그래서 로그인·주입된 Claude Code 홈이 헤더를 보낼 때만 동작합니다.

**Claude grant(선택, 격리 보관).** 헤더를 직접 보내지 않는 호출(스크립트/API, headless)에서도 구독을 쓰고 싶을 때 고르는 opt-in 방식입니다. grant는 frogprogsy 전용으로 격리된 credential 하나를 별도 설정 디렉터리(`CLAUDE_CONFIG_DIR`)에 두고, 여러분의 **진짜 Claude 실행 파일**로 **여러분이 직접** 로그인해 채웁니다. `frogp claude grants add`는 grant 기록과 격리 디렉터리를 만들고, 검증된 실제 실행 파일용 로그인 명령을 출력하기만 합니다(관리형 launcher면 거부). add 자체는 credential을 검증하지 않습니다. 여러분이 그 명령으로 직접 로그인한 뒤 `frogp claude grants status`나 대시보드가 기대한 격리 credential이 실제로 생겼는지 검증합니다. frogprogsy는 로그인을 대신 실행하지 않고 브라우저도 열지 않으며, native `~/.claude` 홈과 전역(unscoped) 로그인은 어느 단계에서도 쓰지 않습니다.

```bash
frogp claude grants add "업무용"
```

출력된 로그인 명령을 터미널에서 직접 실행한 뒤 상태를 확인합니다.

```bash
frogp claude grants status
```

준비된 grant를 Anthropic provider에 연결합니다.

```bash
frogp providers set anthropic --auth claude-grant --grant <cg_id>
```

대시보드에서도 같은 흐름을 씁니다. **Claude Profiles** 페이지에서 grant를 만들면 터미널에서 직접 실행할 로그인 명령이 출력되고, **Providers** 페이지에서 Anthropic provider의 인증 모드를 `claude-grant`로 바꿔 grant를 연결합니다.

provider에 grant를 연결(binding)하면 Codex OAuth와 똑같이 일반 세션과 Model Mixing에서 Anthropic이 동작합니다. grant 토큰은 연결된 provider에만 붙습니다. codex·xai·kimi 같은 다른 provider나 fallback 경로는 Anthropic 토큰을 받지 못하고, 들어온 요청 헤더도 grant 요청에 섞이지 않습니다. Codex OAuth 로그인은 계속 별개로 유지됩니다.

grant 인증은 **fail-closed**입니다. 만료 5분 전 안쪽의 토큰은 사용 전에 새로 고치고, refresh가 `invalid_grant`이면 `reauth_required`로 막은 뒤 `CLAUDE_CONFIG_DIR=<grant-dir>` 실행 파일 재로그인 명령만 안내합니다. 만료된 토큰은 절대 전송하지 않습니다. binding이 없거나 grant 저장소가 없으면 provider와 grant 이름을 담아 typed 에러로 실패하고, forward 헤더나 다른 grant, API 키로 몰래 넘어가지 않습니다. 진단은 `frogp doctor claude`(읽기 전용)로 볼 수 있습니다.

상태·진단·API·GUI·로그 어디에도 raw 토큰 값은 나오지 않습니다. credential 증거는 `sha256`(앞 8자리)+길이 형태로만 표시되며, 토큰·OAuth 코드·이메일·절대 홈 경로는 기록하지 않습니다.

grant는 격리 credential을 보관하는 **선택**입니다. 명시적 동의는 grant를 opt-in할 때와 `frogp claude auth probe-b --live --yes` 진단을 돌릴 때 필요하며, 연결된 provider로 가는 정상 요청마다 확인창이 뜨는 것은 아닙니다. 네트워크 호출이 구독 인증을 실어 나르므로 Anthropic 약관·계정·사용량(quota)에 영향을 줄 수 있고, 이 위험은 되돌릴 수 없습니다. 구독 보관을 원치 않거나 headless/API 인증이 필요하면 Anthropic **API 키** provider가 항상 대안입니다.

grant를 지우면(`frogp claude grants remove <id>` 또는 대시보드) frogprogsy가 보관한 격리 credential과 그 디렉터리·기록만 삭제됩니다. Anthropic 서버 쪽 취소(revoke)나 native 로그아웃은 하지 않습니다. native Claude 홈과 전역 Keychain 로그인은 byte 단위로 그대로 남습니다(Anthropic 쪽 grant 로그인 해제는 사람이 하는 `claude` 로그아웃 몫입니다). provider가 삭제된 grant를 여전히 가리키면 dangling 상태로 요청 시 typed 에러가 나고, GUI/doctor가 경고합니다. 다른 grant나 헤더, API 키로 자동 재연결하지 않습니다. 여러 native Claude 홈은 명시적 선택으로 보존되며, frogprogsy는 전역 로그인을 가로채지 않습니다.

## Claude Code 실행

`frogp start`와 `frogp refresh`는 기본 Claude Code 홈용 `~/.frogprogsy/bin/claude`와 configured home에서 파생한 `claude-work`, `claude-personal` 같은 alias를 다시 만듭니다. `~/.frogprogsy/bin`을 native Claude Code binary보다 PATH 앞에 두거나, package가 제공하는 `claude` bin이 PATH에서 먼저 잡히게 쓰면 됩니다. 각 launcher는 실제 Claude Code 실행 파일을 `FROGP_REAL_CLAUDE`로 고정한 뒤 저수준 `frogp claude run <cp_id>` 경로를 호출하므로 frogprogsy shim이나 임시 cmux shim으로 재귀하지 않습니다. Proxy가 꺼져 있으면 선택한 Claude 홈 env만 유지하고 native Claude Code로 통과합니다.

## 모델 목록 동기화가 하는 일

FrogProgsy는 Claude Code 모델 목록을 “연결한 모델을 보여주는 화면”으로 사용합니다.

1. 원본 백업을 `~/.frogprogsy/catalog-backup.json`에 한 번 저장합니다.
2. 각 AI 서비스의 `/models`를 가져오고, 실패하면 캐시나 설정된 `models[]`를 사용합니다.
3. Claude Code가 받아들이는 형식으로 연결 모델 항목을 만듭니다.
4. `disabledModels`에 있는 항목을 제거합니다.
5. 하위 작업에 먼저 보여줄 모델을 앞에 정렬합니다.
6. 합쳐진 모델 목록을 다시 씁니다.

## 하위 작업 모델 순서 정하기

`spawn_agent`가 먼저 볼 연결 모델은 `subagentModels`로 지정합니다.

```json
{
  "subagentModels": [
    "anthropic/claude-opus-4-8",
    "codex/gpt-5.5",
    "xai/grok-4.3"
  ]
}
```

FrogProgsy는 지정한 모델을 다른 연결 모델보다 앞에 두고, 기본 Claude Code 모델은 그 뒤에 둡니다. 대시보드에서도
같은 목록을 편집할 수 있습니다.

## 깨끗하게 원복하기

`frogp stop`은 FrogProgsy를 멈추고 FrogProgsy가 만든 설정, 모델 목록/캐시 항목,
예전 `config.toml`/profile 연결을 제거합니다. 관리형 launcher는 남아 있고 활성 proxy가 없을 때 native Claude Code로 통과합니다. `frogp restore`는 실행 중인 프로세스를 멈추지 않고
같은 Claude Code 정리를 수행합니다.

```bash
frogp stop
frogp restore
```
