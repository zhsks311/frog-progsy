# Rubric: v2-analysis-06

Category: `analysis`  
Grader: `rubric`

## Reference answer

A strong answer names at least four current provider catalog patterns, such as dated model IDs, family aliases, snapshot IDs, regional deployment names, and capability-tier names. It should distinguish user-facing stable aliases from provider raw IDs, require explicit capability metadata for context window, tool use, streaming, modalities, pricing class, and deprecation state, and avoid silently repointing aliases across quality or safety boundaries. It should propose catalog hashing, compatibility tests, rollout gates, and clear audit logs for any alias change.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

Use the reference answer as the anchor for pairwise or scalar judging. Prefer answers that identify the key tradeoffs and failure modes, stay within the requested scope, and avoid invented implementation details.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
