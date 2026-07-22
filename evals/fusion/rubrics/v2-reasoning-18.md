# Rubric: v2-reasoning-18

Category: `reasoning`  
Grader: `rubric`

## Reference answer

The induction step fails at the transition from one marble to two marbles. The two size-one subbags obtained by removing one marble at a time have no overlapping marble, so there is no shared element that transfers color equality between them. For larger bags an overlap exists, but induction requires every step, including the base-to-two step, to be valid.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

Use the reference answer as the anchor for pairwise or scalar judging. Prefer answers that identify the key tradeoffs and failure modes, stay within the requested scope, and avoid invented implementation details.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
