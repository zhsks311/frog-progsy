# Rubric: local-reasoning-18

Category: `reasoning`  
Grader: `rubric`

## Reference answer

The false step is confusing strong connectivity with balanced in/out degree. A strongly connected digraph can have vertices with unequal indegree/outdegree, so a walk can get stuck before using all edges. Necessary and sufficient: every vertex with nonzero degree lies in one strongly connected component and indegree(v)=outdegree(v) for every vertex.

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

Use the reference answer as the anchor for pairwise or scalar judging. Prefer answers that identify the key tradeoffs and failure modes, stay within the requested scope, and avoid invented implementation details.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
