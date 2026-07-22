# Rubric: local-analysis-07

Category: `analysis`  
Grader: `rubric`

## Reference answer

Benefit is observability/no dead air; risk is leaking internal stage artifacts or confusing final answer. Keep one stream, mark intermediates as thinking, and keep quality judge focused on final answer.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

Use the reference answer as the anchor for pairwise or scalar judging. Prefer answers that identify the key tradeoffs and failure modes, stay within the requested scope, and avoid invented implementation details.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
