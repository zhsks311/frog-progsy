# Rubric: local-coding-03

Category: `coding`  
Grader: `schema`

## Reference answer

{
  "bug": "timeout not cleared on early settle",
  "fix": [
    "clearTimeout in finally",
    "remove abort listener when done"
  ],
  "test": "fake timers show no pending timer after success"
}

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

This item is intended for deterministic grading. Award full credit only when the required answer/fields/facts match the reference within the stated tolerance; otherwise award zero or the normalized partial score defined by the grader.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
