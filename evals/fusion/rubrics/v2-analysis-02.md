# Rubric: v2-analysis-02

Category: `analysis`  
Grader: `rubric`

## Reference answer

A strong answer uses current named examples from at least four model or proxy APIs and separates upstream transport support from the downstream client contract. It should note why SSE remains common for one-way token streams, where WebSockets or realtime APIs fit low-latency bidirectional audio/tool sessions, and what HTTP/2/proxy buffering/backpressure constraints imply. It should recommend a stable event schema, heartbeat/error semantics, and preserving tool-use boundaries instead of converting bidirectional protocols into ambiguous text chunks.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

Use the reference answer as the anchor for pairwise or scalar judging. Prefer answers that identify the key tradeoffs and failure modes, stay within the requested scope, and avoid invented implementation details.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
