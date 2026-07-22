# Rubric: v2-analysis-11

Category: `analysis`  
Grader: `rubric`

## Reference answer

The answer should require a fresh isolated run home, explicit profile overlays, non-overwriting run directories, and canonical config hashing after deterministic backfills. It may copy only redacted or test-scoped configuration needed for the run and must sandbox caches, logs, sockets, and temporary credentials away from real user homes. It must not mutate ~/.claude, ~/.frogprogsy, system keychains, live provider catalogs, or shared global config during offline eval startup.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

Use the reference answer as the anchor for pairwise or scalar judging. Prefer answers that identify the key tradeoffs and failure modes, stay within the requested scope, and avoid invented implementation details.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
