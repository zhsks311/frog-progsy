# Rubric: v2-coding-11

Category: `coding`  
Grader: `rubric`

## Reference answer

Require an idempotent finalizer that records exactly one terminal state and one latency per request. The safer patch should guard with a closed-over boolean or atomic state, keep whichever terminal path wins first, and test simultaneous error/close paths do not double-write the log.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
