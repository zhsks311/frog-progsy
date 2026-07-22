# Rubric: v2-analysis-10

Category: `analysis`  
Grader: `rubric`

## Reference answer

The answer should require deny-by-default redaction for Authorization, API keys, OAuth tokens, cookies, tenant/account identifiers, and raw prompt or tool payloads unless explicitly approved for a private trace. Useful retained metadata can include hashed run/request IDs, provider family, model alias, stage name, latency, token counts, stop reason, retry class, and redacted error category. It should distinguish unredacted canonical hashes kept locally from shareable artifacts and require tests that fixtures contain no token literals.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

Use the reference answer as the anchor for pairwise or scalar judging. Prefer answers that identify the key tradeoffs and failure modes, stay within the requested scope, and avoid invented implementation details.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
