# Rubric: pilot-agent-01

Category: `agent_protocol`  
Grader: `facts`

## Reference answer

{
  "facts": [
    "qualityScore",
    "proxyContractScore",
    "separate",
    "SSE",
    "one request",
    "thinking",
    "final stream"
  ]
}

Prompt scenario is self-contained: Pilot agent protocol scenario: The eval harness grades two independent dimensions: `qualityScore` for final answer usefulness and `proxyContractScore` for Anthropic proxy-contract safety. A stateless fusion proxy receives one client request and may run intermediate model stages before producing the final answer. For the `streaming-boundary`, what must the proxy do so the client still sees a valid response? Return JSON with decision, boundary, proxyContractScoreRequired.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

This item is intended for deterministic grading. Award full credit only when the required answer/fields/facts match the reference within the stated tolerance; otherwise award zero or the normalized partial score defined by the grader.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
