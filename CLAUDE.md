# CLAUDE.md — frogprogsy 작업 합의 (working agreements)

이 파일은 이 저장소에서 에이전트가 지켜야 할 **반복 요청·선호·자주 하던 실수** 모음이다.
`AGENTS.md`가 이 파일을 참조한다. 새 세션에서 먼저 읽고 따른다.

## 소통
- **한국어로 답한다.**
- 전문용어는 풀어서 설명하고, 필요하면 표/예시로 보여준다. ("이게 무슨 말인지 모르겠다"가 안 나오게.)
- 미루는 표현 금지("~할게요", "다음엔~") — 할 수 있는 건 이번 턴에 바로 하고 결과로 보고.
- **과장된 표현·용어 사용 금지.** 사실만 담백하게. 마케팅성·부풀림·불필요한 형용사/감탄("완벽", "대단히", "혁신적" 등) 배제하고, 검증된 것만 그 수준으로만 말한다.

## 조사 · 주장 (가장 중요)
- **추측 금지.** 소스를 읽고 도구(실행/테스트/grep)로 **직접 확인한 근거**로만 결론 낸다. 기본 태도는 "차근차근 확인하고 진짜 원인 파악".
- 단정 전에 재현·실행으로 검증한다. (예: 라우팅 주장은 실제 `routeModel`을 돌려 확인, 정책 주장은 `claude auto-mode defaults` 같은 1차 소스로 확인.)

## 단순함 · 안전
- **가장 단순한 올바른 해법을 먼저.** 과설계 금지.
- 어떤 방안이 사실상 더 단순한 방안과 동일하면(예: "결국 정적으로 관리되는 건 마찬가지") 그 사실을 솔직히 말한다.
- 안전에 민감한 결정(권한 분류기 등)은 **결정적·검증가능·오버라이드 가능**해야 한다. 런타임 자동 추측·가격 기반 자동 선택 금지.

## 정직 · 상태 구분
- **"구현·커밋됨" vs "계획" vs "런타임 전용(.gjc, gitignore)"** 를 명확히 구분해서 말한다. 임시/런타임 상태를 "저장됨/완료"로 오인·과장하지 않는다.
- 완료 주장 전 검증: `bun run typecheck` + `bun test --isolate ./tests`(전체) + GUI 변경 시 `bun run build:gui` 가 그린인지 실제로 확인하고 수치로 보고.

## Git / 랜딩
- 변경은 **별도 브랜치 + worktree**에서 하고, 거기서 커밋한 뒤 **`main`에 머지**한다. 머지 후 worktree/브랜치 정리.
- **원격 `push`는 명시 요청 없이는 하지 않는다.** (`저장`/`커밋`/`머지`와 `push`는 별개.)
- 사용자의 **진행 중 머지/충돌을 임의로 해결·커밋·revert 하지 않는다** (명시 요청 시에만). 요청받으면 검증 후 안전하게 랜딩한다.
- `.gjc/**`는 런타임 소유(gitignore) — 직접 편집 금지, `gjc` CLI로만. **durable 명세와 유지보수 결정은 `structure/`에만** 남긴다.

## 프로젝트 사실 (frogprogsy)
- product = **frogprogsy**, bin = **`frogp`**, config = `~/.frogprogsy/`. 문서 base 는 `/frog-progsy`.
- 유지보수 SOT = `structure/*.md`, 공개 문서 = `docs-site/`와 루트 다국어 README, 런타임 상태 = `.gjc/`(비추적). `docs/`와 `artifacts/`는 로컬 조사·검증용이며 gitignore하고 커밋하지 않는다.
- **분류기 라우팅** SOT = `structure/07_classifier-routing.md`. 원칙: Haiku-class 분류기 모델은 명시 config(`classifierFallback`→제공자 `classifierModel`) 우선, 미구성 시 `defaultModel` + 경고로 **안전 열화**. 런타임 모델명 자동 추측/가격 기반 선택은 안 한다(기각된 방향).
- frogprogsy 런타임은 `~/.claude`를 함부로 읽거나 수정하지 않는다(공인 inject 경로만).

## Bun 개발 패키징 · 설치

- 의존성 설치, 로컬 검사, GUI 빌드, 패키지 생성, 전역 설치·업데이트, 패키지만 제거하는 작업은 **Bun으로 통일**한다. 로컬 npm 병행 경로를 다시 만들지 않는다.
- 개발 패키지 명령은 `bun run dev:package`를 사용한다. 주요 흐름은 `build`, `install --yes`, `reinstall --yes`, `status`, `uninstall --yes`다.
- 개발 빌드는 Git common directory 아래에 불변 tarball과 SHA-256 manifest로 기록되어 모든 연결 worktree가 공유한다. 설치본이 최신인지 추측하지 말고 `bun run dev:package status`로 `current`/`outdated` 상태와 build id를 확인한다.
- 개발 패키지의 `uninstall`은 Bun 전역 패키지/링크만 제거해야 한다. `~/.frogprogsy`, Claude 홈, Keychain, grant, 자격증명을 읽거나 삭제하지 않으며, 제품 수준의 `frogp uninstall`로 대체하지 않는다.
- npm CLI는 실제 배포 GitHub Actions lane에서만 허용한다. 일반 배포는 OIDC Trusted Publishing으로 Bun이 만든 정확한 tarball을 업로드한다. 최초 package bootstrap만 명시적 1회 입력과 단기 secret을 허용하며, 성공 즉시 credential과 secret을 제거한다. 유지보수 기준은 `structure/06_docs-and-release.md`.
- 배포 전략의 단일 원본은 `structure/06_docs-and-release.md`, 실행 강제 장치는 `.github/workflows/release.yml`이다. README와 이 파일에 전체 절차를 중복하지 않는다.
- 정식 배포 전 해당 **정확한 release SHA**의 Cross-platform CI와 Package lifecycle 성공, release dry-run, Bun tarball 해시 검증을 모두 요구한다.
- `preview`는 prerelease SemVer, `latest`는 stable SemVer에만 사용한다. 공개된 버전·tarball·`v<version>` 태그는 재사용하거나 강제로 이동하지 않고 다음 버전으로 수정 배포한다.
- 폐기한 이전 제품명과 worktree 이름을 활성 소스·스크립트·테스트·사용자 문서에 다시 넣지 않는다.

## 자주 하던 실수 (반복 금지)
- 검증 전에 추측으로 답함 → **소스/실행으로 먼저 확인**.
- 과설계 제안(예: 불필요한 "생성기") → **단순 대안부터** 제시.
- 증거 아티팩트를 요구 스키마와 다르게 생성(CLI replay 허용목록 위반, 브라우저 트랜스크립트 `tool`/`type` 필드 누락) → **요구 스키마를 정확히** 맞춘다.
- 런타임 전용 산출물(.gjc)을 "커밋됨"으로 오인 → **git 추적 상태를 확인**한 뒤 말한다.
