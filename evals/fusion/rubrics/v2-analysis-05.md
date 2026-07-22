# Rubric: v2-analysis-05

Category: `analysis`  
Grader: `rubric`

## Reference answer

A strong answer references current OpenTelemetry GenAI semantic-convention concepts and at least three named backend or provider surfaces without requiring exact attribute spellings. It should define spans for client request, routing, provider call, streaming, tool-boundary, fallback, and grading stages; metrics for latency, token usage, cost estimate, retries, errors, and cache hits; and logs/events for SSE lifecycle. It must require redaction of prompts, tool payloads, headers, API keys, OAuth tokens, and provider account identifiers while preserving hashed correlation IDs and enough stage metadata to debug regressions.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

Use the reference answer as the anchor for pairwise or scalar judging. Prefer answers that identify the key tradeoffs and failure modes, stay within the requested scope, and avoid invented implementation details.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
