# Rubric: v2-reasoning-20

Category: `reasoning`  
Grader: `rubric`

## Reference answer

A closed knight tour alternates colors and therefore must use the same number of black and white squares. A 5 by 5 board has 13 squares of one color and 12 of the other, so a cycle through all 25 squares is impossible. The proof fails by treating nearly equal color counts as sufficient for a closed alternating cycle.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

Use the reference answer as the anchor for pairwise or scalar judging. Prefer answers that identify the key tradeoffs and failure modes, stay within the requested scope, and avoid invented implementation details.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
