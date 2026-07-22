# Rubric: v2-reasoning-22

Category: `reasoning`  
Grader: `rubric`

## Reference answer

The parity invariant is false: heap size 4 is winning because the first player can subtract 4 and move to 0. Computing losing positions gives 0, 2, 5, 7, and 10 up to 10, with the pattern repeating modulo 5 as residues 0 and 2. The repaired invariant should track heap size modulo 5, not parity.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

Use the reference answer as the anchor for pairwise or scalar judging. Prefer answers that identify the key tradeoffs and failure modes, stay within the requested scope, and avoid invented implementation details.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
