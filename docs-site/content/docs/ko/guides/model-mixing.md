---
title: 모델 섞어 쓰기
description: "Model Mixing 대시보드 탭에서 여러 모델을 frogp/mix 하나로 묶어 씁니다. JSON을 몰라도 프리셋으로 바로 설정할 수 있습니다."
---

모델 섞어 쓰기는 Claude Code에서 `frogp/mix`라는 모델 하나를 고르면, 그 뒤에서 여러 모델이 함께 답을 만들게 하는 기능입니다. 설정 JSON을 몰라도 됩니다. 대시보드에서 프리셋을 고르고, 켠 뒤, Claude Code에서 `frogp/mix`를 선택하면 됩니다.

> 모델 섞어 쓰기는 품질과 비용을 조절하는 기능입니다. auto 모드 안전 분류기와는 완전히 별개입니다.

## 이게 뭐하는 기능인가

한 질문을 여러 전문가에게 동시에 묻고, 편집장이 답들을 비교한 뒤 최종본을 써 주는 방식이라고 생각하면 됩니다.

대시보드 프리셋은 기본적으로 `fusion` 흐름을 씁니다.

1. **답변기 답변** — 답변기 여러 개가 같은 요청에 동시에 답합니다.
2. **분류기 비교** — 분류기가 답변들의 장점, 빠진 점, 충돌하는 점을 비교합니다.
3. **최종 답변기 작성** — 최종 답변기가 Claude Code로 돌아갈 최종 답변을 씁니다.

**Research** 프리셋은 여기에 고쳐쓰기 단계(`multiround`)와 웹 검색을 더합니다. 고쳐쓰기 단계는 최종 답변 전 제한된 횟수 안에서 답을 고쳐 보게 하는 절차입니다. 웹 검색은 답변기 안에서만 쓰는 내부 검색이며 Claude Code의 client tool로 노출되지 않습니다.

대시보드의 **방식** 선택에서 **골라서 맡기기(분배)** 를 고르면 여러 명에게 묻는 대신, 분배기가 요청을 읽고 목록에서 가장 알맞은 모델 하나에게 맡깁니다. 요청 1번당 호출 1~2회라 빠르고 저렴합니다. 각 모델에 적어 둔 설명과 분배 지침을 분배기가 참고합니다.

## 언제 켜고 언제 끌 것인가

| 선택 | 속도 | 비용/사용량 감각 | 잘 맞는 경우 |
| --- | --- | --- | --- |
| 끄기 | 가장 빠름 | 일반 모델 요청 1번 | 빠른 답이 필요하거나, 지연 문제를 확인 중이거나, 여러 답 비교가 필요 없을 때 |
| Low | 단일 모델보다 느림 | 사용자 요청 1번이 답변 호출 4번, 검색 0번 | 검색 없이 작은 전문가 패널을 써 보고 싶을 때 |
| Balanced | Low보다 느림 | 사용자 요청 1번이 답변 호출 5번, 검색 0번 | 속도보다 품질이 중요하지만 Research의 검색/고쳐쓰기는 필요 없을 때 |
| Research | 가장 느림 | 사용자 요청 1번이 답변 호출 11번, 패널 검색 최대 3번 | 기다릴 수 있고 분석·코딩 품질이 중요할 때 |

쉽게 말해 Claude Code 요청 1번이 내부적으로 여러 번의 모델 호출이 됩니다. Low는 답변 호출 4번, Balanced는 5번, Research는 11번에 내부 검색 최대 3번입니다. 그만큼 느려지고 사용량도 늘어납니다.

Research 프리셋은 사내 60문항 시험(`local-suite-v1`)에서 가장 좋은 단일 모델(`gpt-5.5`)보다 점수가 약 13% 높았습니다. 오차 범위를 감안해도 최소 6% 이상 높았습니다(통계 표기로는 delta `+0.1333`, 95% CI `[+0.0583, +0.2000]`). 다만 아주 어려운 추론 문제는 나아지지 않았고 이득은 분석·코딩에 집중됐습니다. 채점은 `gpt-5.5` 모델 하나가 맡았습니다. 응답 속도는 절반이 29초 안(p50 = 중간값), 100번 중 95번이 약 3분 42초 안(p95 = 거의 최악)이었습니다. 이 결과는 이 시험에만 한정됩니다.

## 대시보드에서 쓰는 법

1. `frogp gui`를 실행해 로컬 대시보드를 엽니다.
2. **Model Mixing** 탭으로 갑니다.
3. **Low**, **Balanced**, **Research** 중 하나를 고릅니다. 프리셋 카드에는 서버가 계산한 답변 호출 수와 검색 호출 수가 표시됩니다.
4. 프리셋이 기존 커스텀 Model Mixing 설정을 덮어쓰는 경우 확인창이 뜹니다. 취소하면 저장된 설정은 그대로입니다.
5. **Enable** 토글을 켭니다. 대시보드는 현재 예상 호출 수와 지연 경고를 보여준 뒤 저장합니다. 취소하면 아무것도 저장하지 않고, 저장 실패 시 토글은 원래 상태로 돌아갑니다.
6. Claude Code에서 `frogp/mix`를 선택합니다.

프리셋을 적용해도 자동으로 켜지지는 않습니다. Enable은 항상 별도 토글입니다. 그래서 프리셋을 살펴보거나 수정하는 것만으로 Claude Code 동작이 조용히 바뀌지 않습니다.

이 페이지에서는 답변기 목록, 분류기, 최종 답변기와 고급 설정도 볼 수 있고 바꿀 수 있습니다. 대부분의 사용자는 고급 설정을 몰라도 프리셋만으로 충분합니다.

모델 숨김/표시는 **Model Picker / Models** 페이지에서 관리합니다. 섞어 쓰기 모델의 이름(`aliasId`)은 페이지 아래 **모델 이름** 패널에서 바꿀 수 있으며, 이름에 `/`가 들어가야 모델 목록에 나타납니다. 이름을 바꾸면 기존 숨김 상태가 따라가지 않습니다. 새 이름은 모델 목록에서 새 항목으로 취급됩니다.

## Anthropic을 섞어 쓰기에 넣는 법

이 페이지의 provider 목록은 Claude Code가 원래 가진 모든 모델이 아니라, AI 계정에 설정된 provider에서 옵니다.
Anthropic이 보이지 않으면 먼저 AI 계정에서 **Anthropic Claude**를 추가해야 합니다. 새 설정은 기본으로
`anthropic` forward-auth provider를 포함하지만, 오래된 설정이나 직접 작성한 설정에는 없을 수 있습니다.

Claude 구독을 Model Mixing에 쓰는 방식은 두 가지이며, headless 여부에 따라 준비 상태(readiness)가 다릅니다.

**Forward(기본).** frogprogsy는 Claude 토큰을 저장하지 않고, Anthropic 내부 호출은 Claude Code가 게이트웨이로 보낸 실제 `Authorization` 또는 `x-api-key` 헤더를 그대로 재사용합니다. 그래서 로그인·주입된 Claude Code 홈에서 온 요청일 때만 Model Mixing 안에서 Anthropic이 동작합니다. `frogp/mix`를 호출하는 스크립트/API가 Anthropic 헤더를 보내지 않으면 forward로는 Anthropic 단계를 채울 수 없습니다.

**Claude grant(선택).** grant는 frogprogsy 전용으로 격리된 credential을 보관하므로, 헤더가 없는 headless `frogp/mix` 호출에서도 Anthropic이 바로 준비됩니다(readiness). Anthropic provider를 grant에 연결(binding)해 두면 됩니다. 만드는 방법은 [Claude Code 연결](/frog-progsy/ko/guides/claude-integration/)의 grant 절을 참고하세요. 두 방식 다 원치 않고 구독 보관을 피하려면 Anthropic API-key provider를 따로 쓰면 됩니다.

인증은 provider별로 격리됩니다. grant 토큰은 연결된 Anthropic provider에만 붙고, 답변기·심판·최종 답변기·fallback으로 쓰인 codex·xai·kimi 같은 다른 provider는 Anthropic 토큰을 받지 않습니다. 반대로 Codex OAuth 로그인은 Anthropic 단계에 쓰이지 않고 계속 별개로 유지됩니다.

내장 Low/Balanced/Research 프리셋은 측정된 Codex 프로필입니다. Anthropic은 답변기, 심판, 최종 답변기로 직접
추가할 수 있지만, Claude+Codex 조합 품질은 아래 F3 평가 주장에 포함되지 않습니다.

## 대시보드 고급 설정

**고급 설정** 패널의 각 항목은 `modelMixing` 설정 필드와 다음과 같이 대응합니다.

| 대시보드 항목 | 의미 | 설정 필드 |
| --- | --- | --- |
| 답변기가 보는 범위 | 답변기가 현재 요청만 볼지, 대화 전체를 볼지 정합니다. 기본값은 '현재 요청만'입니다. 대화 전체는 품질이 좋아질 수 있지만 사용량이 늘어납니다. | `fusion.contextMode` (`task`/`full`) |
| 분류기가 보는 범위 | 같은 선택을 분류기에 적용합니다. 기본값은 '현재 요청만'입니다. | `fusion.judgeContextMode` (`task`/`full`) |
| 웹 검색 | 답변기가 답하기 전에 웹 검색을 할 수 있게 합니다. 답변기 내부에서만 쓰이고 Claude Code 도구로 노출되지 않습니다. | `fusion.panelWebSearch.enabled` |
| 웹 검색 횟수 제한 | 답변기 1개당 최대 횟수와 요청 전체 합계 최대 횟수를 따로 정합니다. 예: 답변기당 1회·전체 3회면 답변기가 4개여도 검색은 총 3번까지입니다. | `fusion.panelWebSearch.maxSearchesPerPanel`, `.maxTotalSearches` |
| 고쳐쓰기 단계 추가 | 최종 답변 전에 답을 다듬는 단계를 제한된 범위에서 추가합니다. 호출이 늘어나는 대신 완성도가 올라갑니다. | `fusion.multiround.enabled` |
| 고쳐쓰기 제한 | 최대 반복 횟수 / 회당 초안 수 / 추가 호출 상한입니다. | `fusion.multiround.maxRounds`, `.branchFactor`, `.budgetCalls` |
| 제한 시간 | 단계 전체 / 답변기 1개 기준 제한 시간(밀리초)입니다. 최종 답변 작성에는 적용되지 않습니다. | `stageTimeoutMs`, `panelTimeoutMs` |

## 고급/자동화: JSON 직접 편집

대시보드 프리셋을 권장합니다. JSON 직접 편집은 자동화, 리뷰, 이미 검토한 설정을 다른 환경으로 옮길 때 쓰면 됩니다.

`~/.frogprogsy/config.json`에 `modelMixing` 블록을 넣고 프록시를 재시작한 뒤 Claude Code에서 `frogp/mix`를 고릅니다. 이 별칭으로 가는 요청만 믹싱 경로를 타고, 나머지 모델은 평소대로 라우팅됩니다.

## 조합 방식

| 방식 | 동작 | 상위 답변 호출 |
| --- | --- | ---: |
| `route`(기본) | 모델 하나를 고릅니다. `mode: "coordinator"`는 coordinator 호출 1번을 쓰고, `mode: "rules"`는 결정적으로 고릅니다. | 1–2 |
| `fusion` | 패널이 병렬로 답하고, 심판이 분석한 뒤, 합성자가 최종 답을 씁니다. | panel + 2 |
| `pipeline` | Thinker → Worker → Verifier 고정 체인입니다. | 최대 3 |

중간 단계는 기본적으로 `thinking` 블록으로 노출됩니다(`surfaceStages: true`). 숨기려면 `surfaceStages: false`를 씁니다.

## Fusion 컨텍스트와 타임아웃

`fusion.contextMode`는 패널 프롬프트 컨텍스트를, `fusion.judgeContextMode`는 심판 프롬프트 컨텍스트를 제어합니다. 둘은 독립이고 기본값은 `"task"`입니다. `"full"`로 설정하면 해당 pre-final 프롬프트에 원래 system prompt와 message history를 포함합니다. 그래도 pre-final 단계에는 client tools가 제공되지 않습니다.

`stageTimeoutMs`와 `panelTimeoutMs`는 buffered pre-final 단계(panel, judge, pipeline pre-final, multiround score/refine)에만 적용됩니다. Final streamed synthesizer에는 적용되지 않습니다. Final synthesizer는 원래 요청 컨텍스트와 client tools를 가진 채 streaming되며 client abort/SSE idle 동작에 묶입니다.

## 예시 프로필

아래 프로필은 모두 opt-in입니다. Low와 Balanced는 편의 프리셋입니다. Research/F3는 위 캐비앗을 전제로 `local-suite-v1`에서만 accepted입니다. 답변 호출 추정에는 eval harness의 별도 judge-grading calls가 포함되지 않습니다.

| 프로필 | 용도 | 요청당 답변 호출 | 검색 호출 |
| --- | --- | ---: | ---: |
| Low | 작은 full-context fusion 패널 | `4` | `0` |
| Balanced | 더 큰 full-context fusion 패널 | `5` | `0` |
| Research | full context, 패널 검색, 제한된 multiround; 캐비앗 전제로 `local-suite-v1` accepted | `11` | 최대 `3` |

```jsonc
{
  "modelMixing": {
    "enabled": true,
    "aliasId": "frogp/mix",
    "combine": "fusion",
    "coordinator": { "provider": "codex", "model": "gpt-5.5" },
    "stageTimeoutMs": 60000,
    "fusion": {
      "contextMode": "full",
      "judgeContextMode": "full",
      "panel": [
        { "provider": "codex", "model": "gpt-5.5" },
        { "provider": "codex", "model": "gpt-5.4" },
        { "provider": "codex", "model": "gpt-5.4-mini" }
      ],
      "judge": { "provider": "codex", "model": "gpt-5.5" },
      "synthesizer": { "provider": "codex", "model": "gpt-5.5" },
      "panelWebSearch": {
        "enabled": true,
        "maxSearchesPerPanel": 1,
        "maxTotalSearches": 3,
        "tiers": ["no_key"],
        "timeoutMs": 10000
      },
      "multiround": {
        "enabled": true
      }
    }
  }
}
```

`panelWebSearch`는 synthetic/internal panel-only search입니다. `fallback_model`, `search_api`, `no_key` tier만 지원하며 Claude Code client tool로 노출되지 않습니다.

`multiround`는 초기 패널 이후의 제한된 branch/refine/score loop입니다. 선택한 프리셋이나 설정에서 켠 경우에만 동작합니다.

## 비용과 평가 메모

- Fusion panel size `N`은 multiround 추가분을 빼고 `N + 2` answer calls입니다.
- Panel search calls는 `panelSize * maxSearchesPerPanel`과 `maxTotalSearches`로 제한됩니다. Research 대시보드 프리셋은 최대 `3`번으로 제한합니다.
- Research 근거를 쉽게 말하면: 사내 60문항 시험에서 가장 좋은 단일 모델(`gpt-5.5`)보다 점수가 약 13% 높았고, 오차를 감안해도 최소 6% 이상 높았습니다(통계 표기로는 delta `+0.1333`, 95% CI `[+0.0583, +0.2000]`). 이 근거는 해당 시험(suite-v1)에만 한정됩니다.
- hard reasoning 서브셋은 개선되지 않았습니다. Research는 지연보다 분석·코딩 품질이 중요할 때 쓰세요.
- 평가된 프로필은 Codex 계열 모델끼리 섞은 조합뿐입니다. Claude+Codex 같은 교차 프로바이더 구성은 기능상 지원되지만 품질은 측정되지 않았습니다.
- Eval server는 isolated `FROGPROGSY_HOME`과 `startServer()`를 직접 import하는 eval-only `serve` helper를 사용합니다. `frogp start`를 쓰지 않고 사용자 `~/.claude`나 기본 `~/.frogprogsy`를 건드리면 안 됩니다.

전체 항목은 [설정](/frog-progsy/ko/reference/configuration/#model-mixing-fields)에 있습니다.
