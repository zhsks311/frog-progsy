---
title: frogp 설치
description: "FrogProgsy 명령을 설치하고, 첫 실행 전 필요한 준비물을 확인합니다."
---

`frogp`는 FrogProgsy를 실행하는 명령입니다. Claude Code 앞에서 로컬 연결을 열고, 요청을 사용자가 고른 AI 서비스로 보냅니다. 이 페이지는 설치까지만 다룹니다. 첫 AI 서비스와 기본 모델은 다음 단계에서 대시보드로 설정합니다.

## 필요 항목

| 필요 항목 | 설명 |
| --- | --- |
| Bun 1.1+ | `frogp` 실행에 필요합니다. 소스 checkout에서 설치하더라도 Bun이 `PATH`에 있어야 합니다. |
| Claude Code | CLI, App, SDK 모두 지원합니다. FrogProgsy는 Claude Code 실행 파일을 고치지 않습니다. |
| 연결할 AI 서비스 | API 키, OAuth 계정, 기존 로그인 전달, 로컬 서버, OpenAI 호환 서버 중 하나 |

## 설치

패키지를 레지스트리에 공개하기 전까지는 소스 checkout에서 설치합니다:

```bash
git clone https://github.com/zhsks311/frog-progsy.git
cd frog-progsy
bun add -g .
frogp --help
```

패키지를 공개한 뒤에는 다음 명령을 사용할 수 있습니다:

```bash
bun add -g frogprogsy
```

설치가 끝났으면 로컬 연결을 바로 시작합니다.

```bash
frogp start
```

`frogp start`는 로컬 연결을 열고 Claude Code가 볼 모델 목록을 맞춥니다.
AI 서비스 추가, 기본 AI 서비스/모델 선택, 첫 `claude` 요청은 [처음 실행하기](/frog-progsy/ko/getting-started/quickstart/)에서 이어집니다.

## Docker Compose

저장소에는 컨테이너 서비스로 실행하기 위한 검증된 `Dockerfile`과 `docker-compose.yml`이 포함되어 있습니다.

```bash
docker compose up --build
```

컨테이너는 FrogProgsy 상태를 `/config`에 쓰고, 이 경로는 `frogprogsy-config` 볼륨으로 보존됩니다. Entrypoint는 Docker 포트 공개가 프록시에 닿도록 `config.json`의 `hostname`을 `"0.0.0.0"`으로 준비하고, Compose 파일은 `FROGP_EXTERNAL_SUPERVISOR=1`을 설정해 crash 복구를 프로세스 내부 watchdog이 아니라 Docker가 맡게 합니다.

기본 host 주소는 `http://localhost:10100`입니다. 컨테이너 포트는 그대로 두고 host 포트만 바꾸려면 다음처럼 실행하세요.

```bash
FROGP_HOST_PORT=10190 docker compose up --build
```

Claude Code는 호스트에 열린 gateway를 보게 설정하세요. 예: `ANTHROPIC_BASE_URL=http://localhost:10100`.

## 처음 설치할 때는 넘겨도 되는 것

- `frogp init`은 터미널에서 하나씩 설정하고 싶을 때 쓰는 다른 방법입니다. 처음에는 `frogp gui` 대시보드로 시작하는 흐름을 권장합니다.
- `frogp restore`와 `frogp uninstall`은 문제가 생겼을 때 되돌리는 명령이며, 자세한 내용은 [frogp 명령](/frog-progsy/ko/reference/cli/)에 있습니다.
- `config.json`을 직접 고쳐야 하는 경우는 [설정 파일 항목](/frog-progsy/ko/reference/configuration/)에서 다룹니다.
- 소스 checkout과 대시보드 개발 서버 실행은 기여자/개발 작업에만 필요합니다.

다음: [처음 실행하기](/frog-progsy/ko/getting-started/quickstart/).
