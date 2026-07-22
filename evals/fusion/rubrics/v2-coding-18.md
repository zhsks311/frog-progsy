# Rubric: v2-coding-18

Category: `coding`  
Grader: `rubric`

## Reference answer

Lowercasing alone is not a Unicode-safe canonical form and storing only the derived id loses auditability. The safer path should apply explicit Unicode normalization/case-folding at alias lookup, detect collisions, preserve the original id in artifacts, and test composed versus decomposed ids.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
