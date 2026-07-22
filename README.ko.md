<p align="center">
  <img src="assets/banner.png" alt="frogprogsy — 어떤 LLM이든 Claude Code에서 사용" width="820">
</p>

<p align="center">
  <a href="README.md">English</a> · <b>한국어</b> · <a href="README.zh-CN.md">简体中文</a> · <a href="https://zhsks311.github.io/frog-progsy/ko/"><b>전체 문서</b></a>
</p>

frogprogsy는 Claude Code는 그대로 두고 여러 AI 서비스와 모델을 연결해 주는 로컬 도구입니다. 먼저 대시보드에서 AI 서비스를 연결하고, Claude Code는 평소처럼 실행하세요.

## 빠른 시작: 대시보드에서 첫 AI 서비스 연결하기

### 1. 설치

```bash
git clone https://github.com/zhsks311/frog-progsy.git
cd frog-progsy
bun add -g .
frogp --help
```

`bun add -g frogprogsy`는 패키지를 레지스트리에 공개한 뒤에 사용할 명령입니다. 현재는 아직 공개되지 않았습니다.

frogprogsy는 [Bun](https://bun.sh) 1.1 이상에서 실행됩니다. `frogp` 명령을 찾지 못하면 Bun이 `PATH`에 있는지 확인하세요.

<details>
<summary><b>Bun이 없나요?</b> 먼저 설치하세요</summary>

```bash
# macOS / Linux / WSL
curl -fsSL https://bun.sh/install | bash

# Windows PowerShell
powershell -c "irm bun.sh/install.ps1 | iex"
```

설치 후 터미널을 새로 열고 위의 `bun add -g .`를 다시 실행하세요.

</details>

### 2. 로컬 연결 시작

```bash
frogp start
```

기본 대시보드 주소는 `http://localhost:3764`입니다. `3764`는 전화 키패드에서 FROG를 나타냅니다. 다른 포트를 사용하게 되더라도 다음 단계의 `frogp gui`가 현재 대시보드를 엽니다.

<details>
<summary><b>Docker에서 프록시를 실행하나요?</b></summary>

포함된 Docker Compose 서비스를 빌드하고 실행합니다.

```bash
docker compose up --build
```

Compose 파일은 `FROGP_EXTERNAL_SUPERVISOR=1`을 설정하고, 컨테이너 안의 프록시를 `0.0.0.0`에 바인딩하며, `3764` 포트를 공개하고, 설정을 `frogprogsy-config` 볼륨에 보존합니다. Crash 복구는 Docker restart policy가 맡으므로 컨테이너 안에서는 frogprogsy 자체 watchdog을 띄우지 않습니다.

Claude Code는 호스트에 열린 gateway를 보게 설정하세요. 예: `ANTHROPIC_BASE_URL=http://localhost:3764`.

</details>

### 3. 대시보드에서 AI 서비스 추가

```bash
frogp gui
```

대시보드에서 다음 순서로 첫 AI 서비스를 연결하세요.

1. **Add Provider**를 엽니다.
2. 내장 항목을 선택하거나 OpenAI 호환 서버 주소를 입력합니다.
3. API 키를 저장하거나, OAuth를 지원하는 서비스(Codex/ChatGPT, xAI, Kimi)는 로그인합니다. Anthropic Claude는 구독 인증을 Claude Code 홈에 남기고, Anthropic provider를 추가하면 frogprogsy가 Claude 토큰을 저장하지 않는 forward-auth 모델 선택 항목이 생깁니다.
4. 기본으로 사용할 AI 서비스와 모델을 선택합니다.
5. 모델 목록이 Claude Code 모델 선택기에 반영되는지 확인합니다.
Provider나 모델을 바꾼 뒤 Claude Code 모델 선택기가 예전 목록처럼 보이면, Claude Code profile의 모델 목록을 새로고침한 다음 새 Claude Code 세션을 시작하거나 기존 세션을 resume해서 선택기를 다시 여세요.

```bash
frogp claude reload-models <profile-id>
```

이미 열려 있는 `/model` 화면은 hot reload되지 않습니다. 새 `claude` 세션을 시작하거나 resume해야 Claude Code가 `/v1/models`를 다시 가져옵니다.

`frogp start`/`frogp refresh`는 `~/.frogprogsy/bin`에 launcher shim을 생성합니다. 기본 홈은 `claude`, 각 홈은 `claude-work`나 `claude-personal` 같은 alias를 받습니다. 이 디렉터리를 native Claude Code binary보다 PATH 앞에 두거나, package가 제공하는 `claude` bin이 PATH에서 먼저 잡히게 쓰면 됩니다. Proxy가 꺼져 있으면 이 launcher들은 선택한 홈의 native Claude Code로 그대로 통과합니다.

### 4. 첫 Claude Code 요청 보내기

```bash
claude "이 프로젝트의 진입점을 설명해 줘"
```

다른 모델로 보내거나 `provider/model` 값을 직접 쓰는 방법은 [모델 선택 규칙](https://zhsks311.github.io/frog-progsy/ko/guides/model-routing/)에서 이어서 확인하세요.

## Claude 구독 연결: 기본은 Forward, 선택은 Claude grant

frogprogsy는 두 가지 방식으로 여러분의 Claude 구독을 씁니다. 두 방식 모두 native Claude Code 홈(`~/.claude`, `claude-work` 같은 홈)과 여러 계정 로그인은 그대로 보존합니다.

**기본값 — Forward(토큰 보관 안 함).** Anthropic provider를 forward 모드로 추가하면 frogprogsy는 Claude 토큰을 저장하지 않습니다. Anthropic으로 가는 요청은 로그인된 Claude Code 홈이 보낸 실제 `Authorization`/`x-api-key` 헤더를 그대로 다시 씁니다. 별도 로그인이 필요 없고, Claude Code에서 평소처럼 로그인해 두면 됩니다.

**선택 — Claude grant(격리 보관).** 스크립트/API처럼 Claude 헤더를 직접 보내지 않는 호출에서도 구독을 쓰고 싶다면, frogprogsy 전용으로 격리된 grant를 하나 만들 수 있습니다. grant는 여러분의 진짜 Claude 실행 파일과 별도 설정 디렉터리로 **여러분이 직접** 로그인합니다. frogprogsy는 로그인을 대신 실행하지 않고, 브라우저도 열지 않으며, native `~/.claude` 홈이나 전역 로그인은 건드리지 않습니다.

```bash
frogp claude grants add "업무용"      # grant를 만들고, 직접 실행할 로그인 명령을 출력
# 출력된 로그인 명령을 터미널에서 직접 실행한 뒤:
frogp claude grants status            # ok/none/unreadable/reauth_required/dangling 확인(비밀값 없음)
frogp providers set anthropic --auth claude-grant --grant cg_ab12cd   # provider에 grant 연결(binding)
```

provider에 grant를 연결(binding)하면 Codex OAuth와 똑같이 일반 세션과 Model Mixing에서 Anthropic을 쓸 수 있습니다. grant 토큰은 연결된 provider에만 붙고, Codex OAuth 로그인은 계속 별개로 유지됩니다. 만료가 임박한 토큰은 사용 전에 새로 고치고, 재로그인이 필요하면(`reauth_required`) frogprogsy가 직접 실행할 로그인 명령만 안내합니다.

grant는 frogprogsy 전용 격리 credential을 보관하는 **선택**입니다. 명시적 동의는 grant를 opt-in할 때와 `probe-b --live --yes` 진단을 돌릴 때 필요하고, 연결된 provider로 가는 정상 요청마다 확인창이 뜨지는 않습니다. 네트워크 호출이 구독 인증을 실어 나르므로 Anthropic 약관·계정·사용량(quota)에 영향을 줄 수 있습니다. 구독 보관을 원치 않거나 headless/API 인증이 필요하면 Anthropic **API 키** provider가 항상 대안으로 남아 있습니다. grant를 지우면(`frogp claude grants remove`) frogprogsy가 보관한 격리 credential·디렉터리·기록만 지워지고, Anthropic 서버 쪽 취소나 native 로그아웃·전역 로그인 변경은 일어나지 않습니다.

## model-mixing 프로필

이제 대시보드의 **Model Mixing** 탭에서 JSON을 직접 고치지 않고 Low, Balanced, Research 프리셋을 적용하고 `frogp/mix`를 켤 수 있습니다. 대시보드 중심 사용법과 캐비앗은 [모델 섞어 쓰기 가이드](https://zhsks311.github.io/frog-progsy/ko/guides/model-mixing/)에서 확인하세요.

Model mixing은 켜기 전까지 아무것도 바꾸지 않는 opt-in 기능입니다. 대시보드 프리셋은 Low(답변 호출 4번, 검색 0번), Balanced(답변 호출 5번, 검색 0번), Research(답변 호출 11번, 검색 최대 3번)입니다. 프리셋을 적용해도 자동으로 켜지지 않고, Enable 토글을 별도로 확인해야 합니다. 켜면 Claude Code 모델 목록에 `frogp/mix`가 나타납니다.

Research/F3는 frozen 60문항 `local-suite-v1` 평가에서 최강 단일 모델 기준선(`gpt-5.5`) 대비 delta `+0.1333`, 95% CI `[+0.0583, +0.2000]`로 통과했습니다. 캐비앗: hard reasoning은 개선되지 않았고 이득은 분석·코딩에 집중됐습니다. 단일 judge 채점이며, 응답 지연은 대략 p50 `29s` / p95 `3.7분`이고, 주장은 suite-v1에만 한정됩니다.

| 프로필 | 용도 | 요청당 답변 호출 | 검색 호출 |
| --- | --- | ---: | ---: |
| Low | 검색 없이 작은 전문가 패널 사용 | `4` | `0` |
| Balanced | 속도보다 품질이 중요할 때 더 많이 비교 | `5` | `0` |
| Research | 기다릴 수 있고 분석·코딩 품질이 중요할 때 | `11` | 최대 `3` |

## 다음에 볼 문서

README는 첫 성공 경로만 다룹니다. 공식 전체 문서는 docs-site입니다.

| 할 일 | 문서 |
| --- | --- |
| 설치와 첫 실행 파일 확인 | [frogp 설치](https://zhsks311.github.io/frog-progsy/ko/getting-started/installation/) |
| 처음 실행 절차 자세히 보기 | [처음 실행하기](https://zhsks311.github.io/frog-progsy/ko/getting-started/quickstart/) |
| AI 서비스, OAuth, API 키, 로컬 서버 설정 | [AI 서비스 연결](https://zhsks311.github.io/frog-progsy/ko/guides/providers/) |
| 대시보드, 요청 기록, 사용량 확인 | [대시보드와 사용 기록](https://zhsks311.github.io/frog-progsy/ko/guides/web-dashboard/) |
| frogp 명령, 설정 파일, 연결 방식 세부 | [frogp 명령](https://zhsks311.github.io/frog-progsy/ko/reference/cli/) · [설정 파일 항목](https://zhsks311.github.io/frog-progsy/ko/reference/configuration/) · [연결 방식 세부](https://zhsks311.github.io/frog-progsy/ko/reference/adapters/) |

`frogp init`, config JSON, 서비스 목록, 부족한 기능 대신 처리 같은 고급 주제는 README의 기본 경로가 아니라 위 문서에서 관리합니다.

라이선스: MIT
