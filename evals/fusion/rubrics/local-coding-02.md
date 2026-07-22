# Rubric: local-coding-02

Category: `coding`  
Grader: `facts`

## Reference answer

{
  "bug": "lexicographic semver ordering",
  "fix": [
    "numeric major/minor/patch compare",
    "missing patch treated as 0"
  ],
  "test": "2.10.0 sorts after 2.9.9"
}

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

This item is intended for deterministic grading. Award full credit only when the required answer/fields/facts match the reference within the stated tolerance; otherwise award zero or the normalized partial score defined by the grader.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
