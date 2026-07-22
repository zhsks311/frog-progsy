# Rubric: v2-analysis-07

Category: `analysis`  
Grader: `rubric`

## Reference answer

Direct routing has the lowest latency and simplest contract but misses specialization and ensemble checks. A dispatch router can improve fit for log-heavy incidents but risks misclassification and opaque routing, so it needs routing telemetry and fallback. Two-stage synthesis can combine hypotheses and reduce blind spots but adds cost, latency, and leak risk; gate it with offline suite lift, per-category regression checks, and strict tool/secret boundaries.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

Use the reference answer as the anchor for pairwise or scalar judging. Prefer answers that identify the key tradeoffs and failure modes, stay within the requested scope, and avoid invented implementation details.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
