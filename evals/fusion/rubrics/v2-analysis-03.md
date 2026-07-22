# Rubric: v2-analysis-03

Category: `analysis`  
Grader: `rubric`

## Reference answer

A strong answer names several current provider or cloud identity examples and treats OAuth device flow as provider-dependent rather than universal. It should cover short-lived access tokens, refresh-token rotation where available, least-privilege scopes, local OS keychain or encrypted store use, revocation/logout, PKCE/device-code polling limits, and clear separation between human login flows and noninteractive CI keys. It must require redaction and hashing boundaries so tokens, authorization headers, tenant IDs, and user profile paths do not leak into eval logs or shared artifacts.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

Use the reference answer as the anchor for pairwise or scalar judging. Prefer answers that identify the key tradeoffs and failure modes, stay within the requested scope, and avoid invented implementation details.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
