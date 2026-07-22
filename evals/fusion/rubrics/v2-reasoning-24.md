# Rubric: v2-reasoning-24

Category: `reasoning`  
Grader: `rubric`

## Reference answer

The fallacy is changing the modulus without changing the number of residue classes. Six integers force a repeated residue modulo 5, but modulo 6 there are six classes and six integers can occupy all of them. A counterexample is {0,1,2,3,4,5}, where no two distinct numbers have difference divisible by 6; the corrected statement for modulus 6 needs seven integers.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

Use the reference answer as the anchor for pairwise or scalar judging. Prefer answers that identify the key tradeoffs and failure modes, stay within the requested scope, and avoid invented implementation details.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
