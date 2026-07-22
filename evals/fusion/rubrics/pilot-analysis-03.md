# Rubric: pilot-analysis-03

Category: `analysis`  
Grader: `rubric`

## Reference answer

CLI start may refresh Claude Code catalog/cache, inject settings, start watchdog, and touch user home. Eval serve should set isolated FROGPROGSY_HOME and import startServer directly only.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

Use the reference answer as the anchor for pairwise or scalar judging. Prefer answers that identify the key tradeoffs and failure modes, stay within the requested scope, and avoid invented implementation details.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
