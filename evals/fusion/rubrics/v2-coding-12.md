# Rubric: v2-coding-12

Category: `coding`  
Grader: `rubric`

## Reference answer

The review should flag unbounded memory growth and writes after client disconnect. The fix should await the writer/backpressure signal, stop on abort or close, and test a slow downstream does not accumulate unlimited queued chunks.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
