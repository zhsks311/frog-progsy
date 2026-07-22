# Rubric: v2-reasoning-19

Category: `reasoning`  
Grader: `rubric`

## Reference answer

The argument is false because strictly decreasing positive terms need not cross zero. For example x_n=1/n remains positive for every n and satisfies x_{n+1}<x_n. The missing condition would need a uniform decrease or another lower-bound-crossing guarantee, not mere monotone decrease.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

Use the reference answer as the anchor for pairwise or scalar judging. Prefer answers that identify the key tradeoffs and failure modes, stay within the requested scope, and avoid invented implementation details.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
