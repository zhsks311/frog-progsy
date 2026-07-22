---
title: 부족한 기능 대신 처리
description: "선택한 모델이 웹 검색이나 이미지 이해를 못 할 때 다른 모델이 그 부분만 대신 처리하는 방식."
---

FrogProgsy는 선택한 AI 서비스가 직접 할 수 있는 기능을 먼저 씁니다. Claude, OpenAI, Grok, Gemini와 많은 모델은 이미 이미지나 웹 검색 도구를 직접 처리할 수 있습니다. 그런 경우에는 대신 처리 기능을 끼우지 않습니다.

부족한 기능 대신 처리는 더 좁은 경우를 위한 장치입니다. 선택한 모델이 텍스트만 받거나 Claude Code의 hosted `web_search` 도구를 실행할 수 없을 때만 사용합니다. 이 helper들은 **외부 앱/컨테이너/daemon이 아니라 FrogProgsy 프로세스 안에서 실행되는 보조 호출**입니다.

> **직접 켜야 합니다**
>
> `webSearchFallback`과 `imageFallback`은 직접 켜지 않는 한 비활성입니다. OpenAI Responses `forward` 연결과 들어온 요청의 전달 가능한 인증 정보가 필요합니다.

## 언제 대신 처리하나

| 요청 조건 | FrogProgsy 동작 |
| --- | --- |
| 선택된 모델이 기능을 지원 | 원래 AI 서비스가 직접 처리 |
| 지원 여부를 알 수 없음 | 먼저 직접 시도하고 조용히 낮춰 보내지 않음 |
| 텍스트 전용 모델에 이미지가 들어오고 `imageFallback.enabled`가 false | 이미지 입력을 받을 수 없다는 명확한 400 반환 |
| 텍스트 전용 모델에 이미지가 들어오고 `imageFallback.enabled`가 true | 설정된 보조 모델로 이미지를 설명한 뒤 선택 모델에 텍스트 전달 |
| hosted search가 요청됐고 `webSearchFallback.enabled`가 false | 대체 검색 도구를 노출하거나 실행하지 않음 |
| hosted search가 요청됐고 `webSearchFallback.enabled`가 true | 전달 가능한 인증과 호환 연결이 있을 때 제한된 대체 검색 루프 실행 |

## 웹 검색 대신 처리

Claude Code가 hosted `web_search`를 요청했지만 선택한 모델이 그 도구를 실행할 수 없으면, FrogProgsy는 선택한 모델에 합성 함수 `web_search(query)`를 보여줄 수 있습니다.

루프는 작고 제한적입니다.

1. 외부 서비스로 보낼 요청에서 hosted search 도구를 제거합니다.
2. 선택한 모델이 `web_search(query)`가 필요한지 결정합니다.
3. 설정된 보조 모델로 실제 hosted search를 실행합니다.
4. 출처와 요약 결과를 도구 결과로 다시 넣습니다.
5. 답변하거나 `maxSearchesPerTurn`에 도달할 때까지 반복합니다.

| 단계 | 담당 | 동작 |
| --- | --- | --- |
| Hosted tool request | Claude Code → FrogProgsy | Claude Code가 hosted `web_search`를 포함한 요청을 보냅니다. |
| Tool substitution | FrogProgsy | 실행 불가능한 hosted tool을 제거하고 대체 `web_search(query)`를 노출합니다. |
| Decision | 선택한 모델 | 선택한 모델이 검색을 호출하거나 검색 없이 답변합니다. |
| Fallback execution | OpenAI Responses helper provider | 보조 모델이 `maxSearchesPerTurn`과 `timeoutMs` 안에서 hosted search를 실행합니다. |
| Reinjection | FrogProgsy → 선택한 모델 | FrogProgsy가 제한된 출처/요약을 도구 결과로 반환하고 요청을 이어갑니다. |

Shell, patch, MCP 같은 실제 Claude Code tool call은 loop가 삼키지 않습니다. 그런 call이 나오면 turn을 종료해 Claude Code가 그대로 받게 합니다.

```json
{
  "webSearchFallback": {
    "enabled": true,
    "model": "gpt-5.4-mini",
    "reasoning": "low",
    "maxSearchesPerTurn": 3,
    "timeoutMs": 30000
  }
}
```

Search result는 untrusted data로 감싸고, 길이를 제한하며, URL 기준으로 dedupe합니다. Structured-output turn에는 compact JSON을 넣어 schema 응답을 깨지 않게 합니다.

## 이미지 대신 설명하기

선택한 모델이 텍스트 전용이면 FrogProgsy는 본 요청 전에 이미지를 설명할 수 있습니다. 선택한 모델은 원본 이미지 대신 길이 제한된 텍스트 설명을 받습니다.

- 사용자 이미지와 도구 결과 이미지를 지원합니다.
- Data URL은 허용된 이미지 형식과 크기 제한을 통과해야 합니다.
- `https:` 이미지 URL은 보조 모델 쪽에 전달되며 FrogProgsy가 직접 다운로드하지 않습니다.
- 설명 생성은 제한된 병렬 처리로 실행되고 원래 메시지 순서를 보존합니다.
- Ollama-style `:size` suffix는 model capability entry matching에서 허용됩니다.

```json
{
  "imageFallback": {
    "enabled": true,
    "model": "gpt-5.4-mini",
    "timeoutMs": 45000
  }
}
```

서비스/모델이 어떤 입력을 받을 수 있는지 명시하세요.

```json
{
  "providers": {
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "modelCapabilities": {
        "glm-5.2": { "input": ["text"] },
        "gpt-oss": { "input": ["text"] },
        "kimi-k2.7-code": { "input": ["text", "image"] }
      }
    }
  }
}
```

## 대신 처리 끄기

`enabled`를 생략하거나 `false`로 두면 됩니다. 전체 항목은 [설정](/frog-progsy/ko/reference/configuration/#capability-fallback-fields)에 있습니다.
