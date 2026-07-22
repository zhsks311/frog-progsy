# Rubric: local-coding-10

Category: `coding`  
Grader: `facts`

## Reference answer

{
  "bug": "false positive tool_use detection in text JSON",
  "fix": [
    "inspect structured content_block_start/type only",
    "ignore plain text payloads"
  ],
  "test": "text containing tool_use is not terminal relay"
}

## Scoring focus

Score factual correctness, completeness, instruction following, and risk handling. Do not reward verbosity, broad speculation, ornamental prose, or unsupported confidence. Concise answers that satisfy the reference and constraints should beat long answers with extra claims.

## Automatic grading notes

This item is intended for deterministic grading. Award full credit only when the required answer/fields/facts match the reference within the stated tolerance; otherwise award zero or the normalized partial score defined by the grader.

## Risk handling

Penalize answers that change product behavior beyond the prompt, assume credentials or external state, hide uncertainty where the reference requires a caveat, or propose unsafe tool/streaming behavior.
