---
title: Model Mixing
description: "Use the Model Mixing dashboard tab to turn several models into one frogp/mix choice. Presets work without editing JSON; advanced config remains available."
---

Model Mixing lets Claude Code use a team of models through one model name: `frogp/mix`. You do not need to know the config JSON to use it. Open the dashboard, choose a preset, enable it, then select `frogp/mix` in Claude Code.

> Model Mixing is a quality/cost feature. It is completely separate from the auto-mode safety classifier.

## What it does

Think of it as asking several experts the same question, then having an editor compare their answers and write the final version.

The default dashboard presets use the `fusion` flow:

1. **Panel answers** — several participating models answer the same request at the same time.
2. **Judge compares** — a judge model reviews the panel answers and points out strengths, gaps, and conflicts.
3. **Synthesizer writes** — a synthesizer model writes the final answer that Claude Code receives.

The **Research** preset also adds a rewrite round (`multiround`) and panel web search. Multiround means FrogProgsy can ask for bounded revisions before the final answer. Panel web search is internal to the panel; it is not exposed to Claude Code as a client tool.

With the dashboard **Mode** selector set to **Dispatch**, frogprogsy asks no panel at all: a dispatcher model reads the request and hands it to the single best-suited model from the list — 1–2 calls per request, fast and cheap. The dispatcher follows the per-model notes and the dispatch rules you write.

## When to turn it on or off

| Choice | Speed | Cost / usage | Quality fit |
| --- | --- | --- | --- |
| Off | Fastest | One normal model request | Use when you want quick answers, are debugging latency, or do not need extra comparison. |
| Low | Slower than one model | 4 answer calls per user request, 0 search calls | Good first try when you want a small expert panel without search. |
| Balanced | Slower than Low | 5 answer calls per user request, 0 search calls | Use when quality matters more than speed, but you do not need Research search/rewrite behavior. |
| Research | Slowest | 11 answer calls per user request, up to 3 panel search calls | Use for analysis and coding work where quality matters and waiting is acceptable. |

In plain terms: one Claude Code request can become several internal model calls. Low turns one request into 4 answer calls; Balanced turns it into 5; Research turns it into 11 plus up to 3 internal search calls. That usually means more usage and more waiting.

In plain terms: on an internal 60-question test set (`local-suite-v1`), the Research preset scored about 13% higher than the best single model (`gpt-5.5`), and at least 6% higher even accounting for the margin of error (in statistical notation: delta `+0.1333`, 95% CI `[+0.0583, +0.2000]`). The hardest reasoning tasks did not improve; gains concentrate in analysis and coding. Scoring was done by a single `gpt-5.5` model. Half of the responses arrived within 29 seconds (p50 = median) and 95 out of 100 within about 3 minutes 42 seconds (p95 = near worst case). The claim is limited to that test set.

## Use it from the dashboard

1. Run `frogp gui` and open the local dashboard.
2. Open the **Model Mixing** tab.
3. Pick **Low**, **Balanced**, or **Research**. Preset cards show the server-calculated answer-call and search-call estimate before you apply them.
4. If the preset would overwrite an existing custom Model Mixing setup, the dashboard asks for confirmation. Canceling leaves the saved config unchanged.
5. Turn on **Enable**. The dashboard shows the current estimated call count and latency warning before saving. Canceling saves nothing; if saving fails, the toggle rolls back.
6. In Claude Code, select `frogp/mix` from the model list.

Applying a preset does **not** enable Model Mixing by itself. Enabling is always a separate toggle so that reviewing or editing a preset cannot silently change Claude Code behavior.

The page also shows and edits the answerer list, the judge, the final answerer, and advanced settings. Most users can ignore the advanced fields and use the presets.

Model visibility is managed on the **Model Picker / Models** page, not by Model Mixing. The mixing model's name (`aliasId`) can be renamed in the **Model name** panel at the bottom of the page; the name must contain a `/` to appear in the model list. If you rename it, hidden/shown state does not follow the old name; the new alias is treated as a new model-list item.

## Using Anthropic in a mix

The provider list on this page comes from configured AI Accounts, not from every Claude Code native model. If
Anthropic is missing, add **Anthropic Claude** under AI Accounts first. Fresh configs include an `anthropic`
forward-auth provider by default, but older or hand-written configs may not.

Anthropic behaves differently in a mix depending on its auth mode:

**Forward (default).** frogprogsy stores no Claude token. Mixed Anthropic sub-calls reuse the same real
`Authorization` or `x-api-key` header that Claude Code sent to the gateway, so Anthropic answers only when the
request comes from an injected/logged-in Claude Code home. A headless script or API caller that selects
`frogp/mix` without forwarding Anthropic auth has no Claude credential in forward mode and needs an Anthropic
API-key provider instead.

**Claude grant (opt-in dual-auth).** If you add an isolated Claude grant (`frogp claude grants add`, then bind
it with `frogp providers set anthropic --auth claude-grant --grant <cg_id>`), frogprogsy holds a consented,
scoped subscription token for that one provider. Anthropic can then answer in the same `frogp/mix` roster as
your Codex OAuth even for headless callers, because the grant supplies readiness without a forwarded Claude
Code home. The grant token is per-provider isolated: it attaches only to its bound Anthropic provider, and the
Codex/xAI/Kimi answerers, judge, and synthesizer never receive it. If the grant can't refresh, that Anthropic
leg fails closed with a re-auth hint rather than falling back to a forwarded header or an API key. A grant
carries Anthropic ToS/account/quota risk (see the [Claude Code wiring guide](/frog-progsy/guides/claude-integration/));
Anthropic API-key providers stay the alternative.

The built-in Low/Balanced/Research presets are the measured Codex profiles. Anthropic can be added manually as an
answerer, judge, or synthesizer, but Claude+Codex quality is not covered by the F3 evaluation claim below.

## Dashboard advanced settings

Every control in the **Advanced settings** panel maps to a `modelMixing` config field:

| Dashboard control | Meaning | Config field |
| --- | --- | --- |
| What answerers see | Whether answerers see only the current request or the whole conversation. Default is "current request only". Whole conversation can improve quality but increases usage. | `fusion.contextMode` (`task`/`full`) |
| What the judge sees | The same choice, applied to the judge. Default is "current request only". | `fusion.judgeContextMode` (`task`/`full`) |
| Web search | Lets answerers search the web before answering. Internal to the answerers; never exposed as a Claude Code tool. | `fusion.panelWebSearch.enabled` |
| Web search limits | Separate caps for one answerer and for all answerers combined per request. Example: 1 per answerer and 3 combined means even four answerers search at most 3 times in total. | `fusion.panelWebSearch.maxSearchesPerPanel`, `.maxTotalSearches` |
| Add a rewrite step | Adds a bounded polish step before the final answer. More calls, more polish. | `fusion.multiround.enabled` |
| Rewrite limits | Max repeats / drafts per round / extra call cap. | `fusion.multiround.maxRounds`, `.branchFactor`, `.budgetCalls` |
| Time limits | Timeout for one whole step / one answerer, in milliseconds. Never limits the final streamed answer. | `stageTimeoutMs`, `panelTimeoutMs` |

## Advanced: edit JSON directly

Dashboard presets are the recommended path. Direct JSON is useful for automation, review, or carrying a known configuration between machines.

Add a `modelMixing` block to `~/.frogprogsy/config.json`, restart the proxy, then choose `frogp/mix` in Claude Code. Every request to that alias goes through the mixing path; all other models route normally.

## Combine modes

| Mode | What happens | Upstream answer calls |
| --- | --- | ---: |
| `route` (default) | Pick exactly one model. `mode: "coordinator"` uses one coordinator call; `mode: "rules"` is deterministic and uses no coordinator call. | 1–2 |
| `fusion` | A panel answers in parallel, a judge analyzes the panel, then a synthesizer writes the final answer. | panel + 2 |
| `pipeline` | Fixed Thinker → Worker → Verifier chain. | up to 3 |

Intermediate stages are surfaced as `thinking` blocks by default (`surfaceStages: true`). Set `surfaceStages: false` to hide them.

## Fusion context and timeout rules

`fusion.contextMode` controls panel prompt context and `fusion.judgeContextMode` controls judge prompt context. Each is independent and defaults to `"task"`. Set either to `"full"` to include the original system prompt and message history in that pre-final prompt. Pre-final stages still do not receive client tools.

`stageTimeoutMs` and `panelTimeoutMs` apply only to buffered pre-final stages: panel, judge, pipeline pre-final calls, multiround score/refine. They do **not** bound the final streamed synthesizer. The final synthesizer streams with the original request context and client tools and is bounded by client abort/SSE idle behavior.

## Example profiles

All profiles below are opt-in. Low and Balanced are convenience presets. Research/F3 is accepted on `local-suite-v1` only, with the caveats above. Answer-call estimates exclude separate judge-grading calls from the eval harness.

| Profile | Intended use | Answer calls per request | Search calls |
| --- | --- | ---: | ---: |
| Low | Small full-context fusion panel | `4` | `0` |
| Balanced | Larger full-context fusion panel | `5` | `0` |
| Research | Full context, panel search, bounded multiround; F3 accepted on `local-suite-v1` with caveats | `11` | up to `3` |

```jsonc
{
  "modelMixing": {
    "enabled": true,
    "aliasId": "frogp/mix",
    "combine": "fusion",
    "coordinator": { "provider": "codex", "model": "gpt-5.5" },
    "stageTimeoutMs": 60000,
    "fusion": {
      "contextMode": "full",
      "judgeContextMode": "full",
      "panel": [
        { "provider": "codex", "model": "gpt-5.5" },
        { "provider": "codex", "model": "gpt-5.4" },
        { "provider": "codex", "model": "gpt-5.4-mini" }
      ],
      "judge": { "provider": "codex", "model": "gpt-5.5" },
      "synthesizer": { "provider": "codex", "model": "gpt-5.5" },
      "panelWebSearch": {
        "enabled": true,
        "maxSearchesPerPanel": 1,
        "maxTotalSearches": 3,
        "tiers": ["no_key"],
        "timeoutMs": 10000
      },
      "multiround": {
        "enabled": true
      }
    }
  }
}
```

`panelWebSearch` is synthetic/internal panel-only search. It supports only `fallback_model`, `search_api`, and `no_key` tiers and is never exposed to Claude Code as a client tool.

`multiround` is a bounded branch/refine/score loop after the initial panel. It is disabled unless the selected preset or config enables it.

## Cost and eval notes

- Fusion panel size `N` costs `N + 2` answer calls before any multiround additions.
- Panel search calls are capped by `panelSize * maxSearchesPerPanel` and `maxTotalSearches`; the Research dashboard preset caps them at up to `3`.
- The Research evidence in plain terms: on an internal 60-question test set, it scored about 13% above the best single model (`gpt-5.5`), and at least 6% above even accounting for the margin of error (delta `+0.1333`, 95% CI `[+0.0583, +0.2000]`). The evidence is limited to that test set (suite-v1).
- The hard-reasoning subset did not improve; use Research mainly when analysis/coding quality matters more than latency.
- The evaluated profile mixed Codex-family models only. Cross-provider rosters (for example Claude together with Codex) are supported functionally but have not been measured for quality.
- The eval server uses an isolated `FROGPROGSY_HOME` and starts through the eval-only `serve` helper that imports `startServer()` directly; it does not use `frogp start` and must not touch user `~/.claude` or default `~/.frogprogsy`.

All fields are documented in [Configuration](/frog-progsy/reference/configuration/#model-mixing-fields).
