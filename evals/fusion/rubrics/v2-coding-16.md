# Rubric: v2-coding-16

Category: `coding`  
Grader: `rubric`

## Reference answer

Chunk boundaries are not JSON message boundaries, but swallowing parse errors can hide real malformed input. The patch should buffer until a complete framed JSON unit is available, surface invalid complete frames loudly, and test split objects plus genuinely malformed frames.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
