# Rubric: v2-coding-17

Category: `coding`  
Grader: `rubric`

## Reference answer

An idempotency key does not make every observed failure safe to replay once the upstream may have accepted work. Retry only pre-send or connection-establishment failures, never after response headers or bytes, and test the accepted-then-disconnected case returns a loud error.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
