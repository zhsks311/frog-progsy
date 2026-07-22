# Rubric: v2-analysis-09

Category: `analysis`  
Grader: `rubric`

## Reference answer

The answer should reject silent best-draft success because it hides degraded quality, breaks paired comparisons, and can leak intermediate artifacts as final output. Safer semantics include explicit degraded status, auditable fallback reason, preserved stage traces with redaction, and a policy deciding whether fallback answers are scored, excluded, or separately bucketed. It should allow deterministic local fallback only when registered before the run and visible in manifests and user-facing status.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

Use the reference answer as the anchor for pairwise or scalar judging. Prefer answers that identify the key tradeoffs and failure modes, stay within the requested scope, and avoid invented implementation details.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
