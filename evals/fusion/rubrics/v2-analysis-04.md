# Rubric: v2-analysis-04

Category: `analysis`  
Grader: `rubric`

## Reference answer

A strong answer compares current Bun and Node capabilities without reducing the decision to benchmark anecdotes. It should cover Node LTS stability, undici/fetch/Web Streams behavior, AbortSignal semantics, diagnostics and OpenTelemetry support, Bun performance and compatibility gains, package/native-addon edge cases, and platform hosting constraints. It should recommend runtime-agnostic adapters and conformance tests for SSE framing, backpressure, abort cleanup, TLS/proxy behavior, and deployment rollback before switching a proxy’s default runtime.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

Use the reference answer as the anchor for pairwise or scalar judging. Prefer answers that identify the key tradeoffs and failure modes, stay within the requested scope, and avoid invented implementation details.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
