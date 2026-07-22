# Rubric: v2-analysis-08

Category: `analysis`  
Grader: `rubric`

## Reference answer

The answer should define a single outer deadline and smaller nested budgets for routing, provider calls, streaming, and judging so inner work cannot outlive the client or corrupt artifacts. It should require abort propagation, timer cleanup, clear stop reasons, and no silent conversion of timed-out partial streams into successful answers. It should separate quality failures from proxy-contract failures and record which layer expired with enough metadata for reproducible diagnosis.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

Use the reference answer as the anchor for pairwise or scalar judging. Prefer answers that identify the key tradeoffs and failure modes, stay within the requested scope, and avoid invented implementation details.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
