# Rubric: v2-coding-13

Category: `coding`  
Grader: `rubric`

## Reference answer

HTTP header lookup must be consistently case-insensitive, especially for authorization, content-type, accept, and provider-specific keys. The answer should recommend one canonical normalization boundary, collision handling, and tests using mixed-case and duplicate-case headers.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
