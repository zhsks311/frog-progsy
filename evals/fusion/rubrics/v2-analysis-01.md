# Rubric: v2-analysis-01

Category: `analysis`  
Grader: `rubric`

## Reference answer

A strong answer compares at least four named current provider surfaces, such as Anthropic, OpenAI, Google Gemini, and AWS Bedrock or Azure OpenAI, without depending on exact volatile quota numbers. It should distinguish request-rate, token-rate, concurrency, cached-input/output-token, reasoning-token, and image/tool-call billing dimensions; explain per-stage budget enforcement before fanout; and require auditable usage attribution for partial successes and failures. It should recommend conservative caps, provider-specific adapters, retry-after handling, and user-visible cost/latency reporting rather than silent best-effort overrun.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

Use the reference answer as the anchor for pairwise or scalar judging. Prefer answers that identify the key tradeoffs and failure modes, stay within the requested scope, and avoid invented implementation details.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
