# Rubric: v2-analysis-12

Category: `analysis`  
Grader: `rubric`

## Reference answer

The answer should require structured per-request logs with run ID, suite/rubric/grader/config hashes, profile identity, model alias, stage, prompt hash, response hash, latency breakdown, usage, stop reason, retry/fallback status, and redaction version. It should explain that raw responses alone are hard to compare, unsafe to share, and insufficient to reproduce routing decisions. It should recommend append-only/non-overwrite artifacts, schema versioning, and separate private traces from shareable summaries.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

Use the reference answer as the anchor for pairwise or scalar judging. Prefer answers that identify the key tradeoffs and failure modes, stay within the requested scope, and avoid invented implementation details.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
