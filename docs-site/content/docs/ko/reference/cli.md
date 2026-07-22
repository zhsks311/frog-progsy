---
title: frogp 명령
description: "설정, 시작/종료, 로그인, refresh, models, 대시보드, 복구, 업데이트, 도움말에 쓰는 frogp 명령."
---

이 문서 사이트의 `/ko/` 경로가 FrogProgsy의 공식 전체 문서입니다. README는 첫 성공까지의
빠른 시작만 다루며, 명령의 전체 목록은 이 문서를 기준으로 유지합니다.

`frogp`는 로컬 FrogProgsy 연결을 제어하는 명령입니다. 명령은 크게 세 범주입니다.

- 로컬 relay process를 시작하거나 멈춘다.
- FrogProgsy가 소유한 Claude Code settings/catalog/cache entry를 주입하거나 갱신하거나 복원한다.
- provider credential, 모델 가시성, dashboard, diagnostic output을 관리한다.

Help, status, models, version 계열은 read-only입니다. `start`, `stop`, `restore`, `refresh`, `init`, `login`, `logout`,
`uninstall`은 로컬 상태를 바꿉니다.

## 기본 문법과 공통 규칙

```bash
frogp <command> [options]
frogp <command> --help
frogp help [command]
frogp --version
```

- 알려지지 않은 command는 실패 exit code를 반환하므로 스크립트가 결과를 신뢰할 수 있습니다. 오타가 가까우면 `Did you mean: frogp <command>?` 제안을 함께 출력합니다(같은 제안 엔진이 `frogp login`의 provider 오타에도 적용됩니다).
- `--help`, `-h`, 또는 command 뒤의 `help`는 해당 command usage를 출력합니다. `frogp help <command>`도 같은 usage를 출력합니다.
- 기본 relay port는 `10100`입니다. `frogp start --port <port>`로 이번 실행의 listen port를 지정할 수 있습니다.
- Claude Code에 주입되는 endpoint는 loopback relay를 가리키며, restore 경로는 FrogProgsy-owned change만 제거합니다.

### 기계 출력과 색상

- `frogp status --json`과 `frogp models --json`이 기계 출력 모드입니다. JSON 모드에서 stdout에는 JSON 문서 정확히 하나(+개행)만 나오고, 진단 메시지는 전부 stderr로 가며, JSON에는 ANSI 색상 코드가 절대 포함되지 않습니다.
- 사람용 출력은 최소한의 ANSI 팔레트를 쓸 수 있습니다. 색상은 TTY 출력에서만 켜지고, `NO_COLOR`가 비어 있지 않은 값으로 설정되면 항상 꺼지며(최우선), 파이프/리다이렉트(non-TTY)에서는 기본적으로 꺼지고, `FORCE_COLOR=1`이면 non-TTY에서도 강제로 켜집니다(단 비어 있지 않은 `NO_COLOR`가 이깁니다).
- `status`/`models`의 알 수 없는 플래그는 exit code 1과 stderr usage 안내로 실패합니다.

## Setup and relay lifecycle

| Command | Mutates | Effect |
| --- | --- | --- |
| `frogp init` | config, 선택적 Claude Code settings | Provider와 port setup wizard를 엽니다. 빈 입력(Enter)은 문서화된 기본 provider(`codex`)를 선택하고, 잘못된 입력은 custom 설정으로 새지 않고 다시 묻습니다. 모든 답이 검증된 뒤에만 저장하는 all-or-nothing 방식이라 EOF/중단 시 아무 파일도 쓰지 않고 비제로로 종료합니다. Claude Code 주입은 검증된 yes일 때만 저장 후 실행됩니다. |
| `frogp start [--port <port>]` | PID guard, Claude Code catalog/cache, launcher shim | Local relay를 시작하고 model discovery/catalog sync와 관리형 `claude`/profile launcher 재생성을 수행합니다. 이미 healthy PID가 있으면 `frogp stop`을 먼저 요구하고 종료합니다. |
| `frogp refresh` | 필요 시 relay, Claude Code catalog/cache, launcher shim | Relay가 떠 있는지 확인하고 없으면 detached로 시작한 뒤, 설정된 모든 Claude Code 홈의 config/catalog/model cache/launcher를 다시 동기화합니다. |
| `frogp stop` | process, Claude Code settings/catalog | Proxy를 중지하고 설정된 모든 Claude Code 홈을 native Claude Code 상태로 restore합니다. 관리형 launcher는 남아 있고 proxy가 꺼진 동안 native Claude Code로 통과합니다. |
| `frogp restore` | Claude Code settings/catalog | 실행 중인 proxy는 그대로 두고 설정된 모든 Claude Code 홈에서 FrogProgsy-owned Claude Code settings/catalog entry를 제거합니다. 활성 proxy가 없으면 관리형 launcher는 native Claude Code로 통과합니다. |
| `frogp uninstall` | config, Claude Code settings/catalog, launcher shim, installed package | FrogProgsy 로컬 설정을 제거하고 native Claude Code 상태로 복원하며 관리형 launcher가 들어 있는 config directory와 글로벌 패키지도 제거합니다. |
| `frogp status [--json]` | 없음 | PID guard를 출력하고 active port로 relay health를 확인하며 dashboard URL을 알려줍니다. PID는 있는데 응답이 없으면 `frogp refresh`, 꺼져 있으면 `frogp start`를 안내합니다. `--json`은 안정 스키마 스냅샷을 출력합니다: `running`, `healthy`, `pid`, `port`, `dashboardUrl`, `recovery`, 고정 필드 `watchdog` 객체(`present`, `attempts`, `gaveUpAt`, `unreadable`) — watchdog 파일의 raw 필드는 절대 노출되지 않습니다. 꺼져 있어도 exit code는 0입니다. |

## Provider and account

| Command | Mutates | Effect |
| --- | --- | --- |
| `frogp login --list` | 없음 | read-only provider 목록: OAuth 그룹(codex, xai, kimi), API-key 그룹, `openai` 별칭 설명을 출력하고 exit 0. |
| `frogp login codex` | OAuth store, config | OpenAI Codex/ChatGPT OAuth lane을 생성합니다. |
| `frogp login openai` | config | OpenAI API-key provider를 저장합니다(`openai`는 `openai-apikey`의 별칭이고 ChatGPT 계정 로그인은 `codex`). |
| `frogp login xai` | OAuth store, config | xAI OAuth lane을 생성합니다. |
| `frogp login kimi` | OAuth store, config | Kimi OAuth lane을 생성합니다. |
| `frogp login <catalog-provider>` | config 또는 OAuth store | Provider registry에 있는 API-key/OAuth/local provider를 추가합니다. 오타가 가까우면 `Did you mean: frogp login <provider>?` 제안이 나오고, OAuth 실패는 raw 스택트레이스 대신 `Login failed for <provider>: <원인>` + 재시도 안내로 보고됩니다. |
| `frogp logout <provider>` | OAuth store | 해당 provider의 저장 OAuth credential을 제거합니다. 인자가 없거나 로그인돼 있지 않은 provider면 실패하고 현재 저장된 로그인 목록을 보여줍니다. API-key provider 삭제가 아니라 OAuth logout입니다. |

Credential 위치와 노출 규칙:

- OAuth credential은 `~/.frogprogsy/auth.json`에 저장됩니다.
- API-key provider는 `~/.frogprogsy/config.json`에 저장됩니다.
- 직접 편집할 때는 literal key보다 `${ENV_VAR}` 또는 `$ENV_VAR` reference를 권장합니다.
- Request log, usage log, dashboard safe log에는 API key, OAuth token, prompt body, account identity를 저장하지 않습니다.

## Claude Code 홈

| Command | Mutates | Effect |
| --- | --- | --- |
| `frogp claude list` | 필요 시 config migration | 이름이 있는 Claude Code 설정 홈을 stable id, 대상 디렉터리, injection state, auth state와 함께 나열합니다. |
| `frogp claude add <name> --home <path>` | config | `~/.claude-work` 같은 특정 Claude Code 설정 디렉터리용 사용자 이름 홈을 추가합니다. |
| `frogp claude rename <name-or-id> <new-name>` | config | header, backup, model overlay, status에 쓰는 stable `cp_...` id는 유지하고 표시 이름만 바꿉니다. |
| `frogp claude remove <name-or-id>` | config | 마지막 하나가 아닌 홈을 제거합니다. |
| `frogp claude inject|refresh|restore <name-or-id>` | 대상 Claude Code 홈 | 선택한 홈만 주입, 새로고침, 복원합니다. Header injection은 관련 없는 `ANTHROPIC_CUSTOM_HEADERS` 항목을 보존합니다. |
| `frogp claude reload-models <profile-id>` | 대상 Claude Code 홈 catalog/cache | Proxy를 자동 시작하지 않고 선택한 Claude Code 홈의 gateway picker catalog/cache만 다시 빌드합니다. Proxy가 꺼져 있으면 `frogp refresh` 복구 안내를 출력합니다. |
| `frogp claude run <name-or-id> -- <claude args...>` | process env only | 해당 홈의 `CLAUDE_CONFIG_DIR`, `ANTHROPIC_BASE_URL`, gateway discovery, `X-Frogp-Claude-Profile`을 설정해 `claude`를 실행하는 저수준 escape hatch입니다. 일반 사용은 plain `claude` 또는 `claude-work`/`claude-personal` 같은 생성된 alias가 기준입니다. |

Claude Code가 Claude 구독 로그인을 소유합니다. FrogProgsy는 Claude 구독 OAuth token을 저장, 가져오기, 갱신, 기록, 표시하지 않습니다.

`frogp start`/`frogp refresh`는 `~/.frogprogsy/bin`에 launcher shim을 생성합니다. 기본 홈은 `claude`, 각 홈은 profile 이름과 home basename에서 안전하게 만든 `claude-work`, `claude-personal` 같은 alias를 받습니다. 이 디렉터리를 native Claude Code binary보다 PATH 앞에 두거나, package가 제공하는 `claude` bin이 PATH에서 먼저 잡히게 쓰면 됩니다. Launcher는 실제 Claude Code 실행 파일을 `FROGP_REAL_CLAUDE`로 고정해 frogprogsy shim이나 임시 cmux shim으로 재귀하지 않습니다. Proxy가 꺼져 있으면 선택한 Claude 홈 env만 유지하고 native Claude Code로 통과합니다.

## Models

| Command | Mutates | Effect |
| --- | --- | --- |
| `frogp models [--json]` | 없음 | 라우팅된 모델 목록의 온라인 전용 뷰입니다. 실행 중인 proxy가 필요하고 기존 `GET /api/models`를 그대로 읽습니다 — 대시보드와 Claude Code catalog가 쓰는 것과 같은 목록입니다. 텍스트 출력은 provider별로 그룹화하고 응답 필드(`disabled`, context window, modality, reasoning effort)를 그대로 표시합니다. `--json`은 `/api/models` 배열을 변형 없이 출력합니다. relay가 꺼져 있으면 `frogp start` 안내와 함께 실패하고, 기록은 있는데 응답이 없으면 `frogp status`/`frogp refresh`를 안내합니다. 오프라인 모델 목록을 합성하지 않습니다. |

## Catalog and Claude Code cache

`frogp refresh`는 provider별 `/models` 결과와 `config.json`의 static model list를 합쳐 Claude Code가 볼
`provider/model` alias를 만든 뒤, 설정된 모든 Claude Code 홈의 model cache를 invalidate합니다. `frogp claude reload-models <profile-id>`는 더 좁은 명령으로, proxy를 자동 시작하지 않고 한 Claude Code 홈의 gateway picker catalog/cache만 준비합니다. Proxy가 꺼져 있으면 출력되는 `frogp refresh` 안내로 relay를 먼저 복구합니다.
`disabledModels`는 catalog와 `/v1/models`에서 제외되고, `subagentModels`는 Claude Code subagent picker의 앞쪽 slot에 우선 배치됩니다.
Claude Code는 session을 시작하거나 resume할 때 `/v1/models`를 다시 가져옵니다. 이미 열린 `/model` 화면을 다시 여는 동작은 picker를 hot reload하지 않으므로, 새 Claude Code session을 시작하거나 resume해서 models endpoint를 다시 가져오게 해야 합니다. Dashboard/API model list reload는 Claude Code picker 복구와 별개입니다.

## Dashboard

| Command | Mutates | Effect |
| --- | --- | --- |
| `frogp gui` | 필요 시 relay process | Local dashboard를 엽니다. proxy가 없으면 auto-start하고 healthy 상태가 될 때까지 기다린 뒤, 실제 active listen port로 URL을 엽니다. |

Dashboard는 config, route, safe request log, usage summary를 보는 운영 표면입니다. 실패 요청을 진단할 때는
[`/ko/guides/troubleshooting/`](/frog-progsy/ko/guides/troubleshooting/)와 함께 사용합니다.

## Recovery

| Command | Mutates | Effect |
| --- | --- | --- |
| `frogp restore` | Claude Code settings/catalog | 가장 좁은 clean restore path입니다. |
| `frogp stop` | process + restore | relay까지 내릴 때 사용합니다. |
| `frogp uninstall` | config + restore + package | FrogProgsy 설치 흔적을 제거할 때 사용합니다. |

## Update, version, and help

| Command | Mutates | Effect |
| --- | --- | --- |
| `frogp update [--no-restart]` | installed package | Bun으로 공개된 최신 버전으로 업데이트하고 proxy를 재시작합니다(`--no-restart`로 재시작 생략). 패키지 레지스트리에서 패키지를 찾지 못하면 아무것도 바꾸지 않고 명시적으로 실패하며, source checkout에는 `git pull && bun install`을 안내합니다. |
| `frogp version` | 없음 | 설치된 frogprogsy version을 출력합니다(`--version` / `-v`도 동일). |
| `frogp help [command]` | 없음 | 전체 command map 또는 특정 command usage를 출력합니다. |
| `frogp <command> --help` | 없음 | 해당 command usage를 출력합니다. |
