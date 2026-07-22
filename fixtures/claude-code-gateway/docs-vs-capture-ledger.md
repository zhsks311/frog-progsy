# Claude Code docs-vs-capture ledger

Authority order: official Claude Code gateway docs, official Anthropic Messages API docs, then local sanitized request fixtures. GitHub proxy/router projects are comparison aids only and are not protocol authority.

Unresolved release-blocking conflicts: none.

## Scenario outcomes

| Scenario | Expected route | Outcome | Evidence |
| --- | --- | --- | --- |
| model-discovery | GET /v1/models | environment-blocked | Safe default fixture set generated without launching Claude Code or probing real user Claude state. Run `bun tools/capture-claude-code-fixtures.ts --capture` on an approved local machine to attempt live capture with fake HOME and the local mock gateway. |
| basic-message | POST /v1/messages | environment-blocked | Safe default fixture set generated without launching Claude Code or probing real user Claude state. Run `bun tools/capture-claude-code-fixtures.ts --capture` on an approved local machine to attempt live capture with fake HOME and the local mock gateway. |
| streaming-message | POST /v1/messages | environment-blocked | Safe default fixture set generated without launching Claude Code or probing real user Claude state. Run `bun tools/capture-claude-code-fixtures.ts --capture` on an approved local machine to attempt live capture with fake HOME and the local mock gateway. |
| tool-use-turn | POST /v1/messages | environment-blocked | Safe default fixture set generated without launching Claude Code or probing real user Claude state. Run `bun tools/capture-claude-code-fixtures.ts --capture` on an approved local machine to attempt live capture with fake HOME and the local mock gateway. |
| count-tokens | POST /v1/messages/count_tokens | environment-blocked | Safe default fixture set generated without launching Claude Code or probing real user Claude state. Run `bun tools/capture-claude-code-fixtures.ts --capture` on an approved local machine to attempt live capture with fake HOME and the local mock gateway. |
| error-401 | POST /v1/messages | environment-blocked | Safe default fixture set generated without launching Claude Code or probing real user Claude state. Run `bun tools/capture-claude-code-fixtures.ts --capture` on an approved local machine to attempt live capture with fake HOME and the local mock gateway. |
| error-429 | POST /v1/messages | environment-blocked | Safe default fixture set generated without launching Claude Code or probing real user Claude state. Run `bun tools/capture-claude-code-fixtures.ts --capture` on an approved local machine to attempt live capture with fake HOME and the local mock gateway. |
| error-overloaded-529 | POST /v1/messages | environment-blocked | Safe default fixture set generated without launching Claude Code or probing real user Claude state. Run `bun tools/capture-claude-code-fixtures.ts --capture` on an approved local machine to attempt live capture with fake HOME and the local mock gateway. |
| malformed-sse | POST /v1/messages | environment-blocked | Safe default fixture set generated without launching Claude Code or probing real user Claude state. Run `bun tools/capture-claude-code-fixtures.ts --capture` on an approved local machine to attempt live capture with fake HOME and the local mock gateway. |
| mid-stream-error | POST /v1/messages | environment-blocked | Safe default fixture set generated without launching Claude Code or probing real user Claude state. Run `bun tools/capture-claude-code-fixtures.ts --capture` on an approved local machine to attempt live capture with fake HOME and the local mock gateway. |

## Non-target confirmation

This fixture gate did not use Claude.ai account login, Bedrock, Vertex, hosted/cloud proxy deployment, billing, team/admin/org flows, remote settings sync, or unapproved proxy/MITM capture. Blocked scenarios must stay blocked instead of falling back to real HOME or real ~/.claude.
