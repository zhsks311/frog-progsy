# Rubric: v2-coding-15

Category: `coding`  
Grader: `rubric`

## Reference answer

The answer should reject raw-string traversal checks because decoding, separators, and normalization can bypass them. Resolve and normalize the candidate path, verify it remains under the public root, reject symlinks or encoded traversal as appropriate, and test encoded `..` cases.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
