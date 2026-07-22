# Rubric: v2-coding-14

Category: `coding`  
Grader: `rubric`

## Reference answer

Explicit process environment should win over file defaults so CI and isolated runs remain controllable. The safer design defines a single precedence order, records the source only in diagnostics without leaking secrets, and tests that a process env model override survives file loading.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
