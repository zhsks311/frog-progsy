# Model Mixing SOT

Model mixing lets a single Claude Code-facing alias (`frogp/mix`, configurable) fan a request across
multiple providers/models inside ONE `/v1/messages` response. Disabled by default; existing routing is
byte-identical when `modelMixing.enabled` is false. It is NEVER the auto-mode safety classifier
(`07_classifier-routing.md`) — a separate quality/cost feature with its own loud fallbacks.

> **Acceptance status:** F1 and F2 remain experimental / not accepted, but the F3 research
> profile family (`f3-codex`: full-context + bounded multiround, `maxRounds: 2`, `branchFactor: 2`,
> `budgetCalls: 12`, codex-only 3-panel) is **accepted on local-suite-v1 (see caveats)** and is the
> first configuration to pass the pre-registered primary rule on the frozen suite; source: `f3-codex`,
> `artifacts/eval-runs/local-suite-v1/run-002-f3/stats.json`. The hard acceptance
> basis is statistically defensible improvement on the local frozen suite over the strongest single-model
> baseline, not Fable parity or external benchmark parity. S0 is frozen as `baseline-gpt55` (`codex/gpt-5.5`);
> `baseline-opus48` ties S0 with delta `0.000`, 95% CI `[-0.058, +0.067]`. Official F1 is `f1-codex` vs S0
> delta `+0.0265`, 95% CI `[-0.0553, +0.100]`, `passesPrimaryGate=false`, so F1 remains experimental and
> is rejected as an acceptance claim. F2 is not measurable on suite v1 because all tasks are self-contained
> and do not trigger search; F2 remains experimental until suite v2 adds search-eligible analysis tasks.
> F3 vs S0 delta is `+0.1333`, 95% CI `[+0.0583, +0.2000]`, `passesPrimaryGate=true`; category deltas are
> coding `+0.167`, reasoning `+0.021`, analysis `+0.375`, agent/protocol `0.000`. Caveats: hard-tag subset
> delta `0.000`, 95% CI `[-0.167, +0.167]`, so hard reasoning did not improve and gains concentrate in
> analysis/coding; single judge (`gpt-5.5`) with observed regrading variability around `±0.03`, though F3's
> delta exceeds that band; wall latency p50 `29s`/p95 `219s`, unsuitable for latency-sensitive use; suite v1
> only, with no cross-version claim. The frozen rule is paired bootstrap (`10000` resamples), CI lower bound
> `> 0`, and point delta `>= 0.03`.

## Config (`~/.frogprogsy/config.json` -> `FrogModelMixingConfig`, all optional/additive)

| Field | Purpose |
| --- | --- |
| `enabled` | Master switch. Default false. |
| `aliasId` | Model id that triggers mixing. Default `frogp/mix` (namespaced -> rides the routed-catalog lifecycle: featuring/disable/restore-strip). |
| `mode` | `coordinator` (an LLM picks) or `rules` (deterministic table, no LLM). Default `coordinator`. |
| `combine` | `route` (pick one) / `pipeline` (role chain) / `fusion` (panel+judge+synthesizer). Default `route`. |
| `coordinator` | `{provider,model}` for route-mode selection and the fusion judge/synth default. |
| `agents[]` | Roster `{provider,model,tasks?,difficulty?,role?,notes?}`. |
| `guidance` | Freeform text the coordinator reads. |
| `pipeline[]` | Explicit ordered `{role: thinker|worker|verifier, provider, model}` chain. |
| `fusion` | `{panel?: {provider,model}[] (1-8), judge?: {provider,model}, synthesizer?: {provider,model}, contextMode?: "task"|"full", judgeContextMode?: "task"|"full", panelWebSearch?: {...}, multiround?: {...}}`. `contextMode` controls panel context; `judgeContextMode` controls judge context independently. Both default to `task`. `panelWebSearch` and `multiround` are disabled by default. |
| `rules[]` | `{match?: {taskKeywords?, difficulty?, hint?}, provider, model}` deterministic table. |
| `timeoutMs` / `stageTimeoutMs` / `panelTimeoutMs` | Per-call / buffered pre-final stage / buffered panel-member timeouts. Default 15000. `stageTimeoutMs` and `panelTimeoutMs` apply only to buffered panel/judge/pipeline pre-final calls; they do not bound the final streamed synthesizer. |
| `surfaceStages` | Stream intermediate stages as live `thinking` blocks. Default true (opt-out with false). |
| `fusion.contextMode` | `task` preserves the existing latest-user-message-only panel prompt bytes. `full` embeds the original system prompt and complete message history in the panel prompt, without client tools. |
| `fusion.judgeContextMode` | `task` preserves the existing judge task-only prompt bytes. `full` embeds the original system prompt and complete message history in the judge prompt, without client tools. This does not inherit from `contextMode`; unset means `task`. |
| `fusion.panelWebSearch` | Opt-in synthetic/internal panel-only search: `{enabled?, maxSearchesPerPanel?, maxTotalSearches?, timeoutMs?, tiers?}`. `tiers` may contain only `"fallback_model"`, `"search_api"`, and `"no_key"`; provider-native hosted search is deliberately excluded because panel search is FrogProgsy-owned evidence injection, not a provider-hosted client-visible tool. |
| `fusion.multiround` | Opt-in bounded branch/refine/score loop after the initial panel: `{enabled?, maxRounds?, branchFactor?, budgetCalls?}`. Defaults are disabled; recommended first research profile values are `maxRounds:2`, `branchFactor:2`, `budgetCalls:12`. `budgetCalls` is a hard answer/scoring-call cap. |

## Modules (`src/model-mixing/`)

| File | Responsibility |
| --- | --- |
| `select.ts` | Pure: `mixAliasId`, `isModelMixingRequest`, `validMixAgents`, `extractTaskText`, coordinator prompt/choice parsing, exported `extractFirstJsonObject`. |
| `index.ts` | `resolveMix` (route/coordinator + `mode:"rules"` short-circuit), `cheapMixTarget`, `MixTarget`, `CoordinatorComplete`. |
| `fusion.ts` | Pure: `JudgeAnalysis`, `resolveFusionPlan`, `buildPanelPrompt`/`buildJudgePrompt`/`buildScorePrompt`/`buildRefinePrompt`/`buildSynthesisPrompt`, `parseJudgeAnalysis` (coerces wrong-typed nested; rejects bad top-level/enum). |
| `pipeline.ts` | Pure: `resolvePipelineStages` (explicit `pipeline[]` wins, else infer from `agents[].role`; dedupe; cap 3), `buildStagePrompt`, `buildVerifierInstruction`. |
| `rules.ts` | Pure: `resolveRulesTarget` (case-insensitive substring match over task text; first match wins; empty match = catch-all; loud no-match fallback). |
| `scan.ts` | Pure: `scanEventsForMix` (forwards all events; flags `hasRealToolCall`). |
| `orchestrate.ts` | Pure: `computeCallPlan` (per-mode upstream call counts). |
| `loop.ts` | `runWithMixing` (fusion + pipeline): one `mixedEvents` async generator -> one `bridgeToMessagesSSE`. Intermediates buffered + optionally surfaced as `thinking`; final stage streamed live. Reuses exported `SSE_HEADERS` from `web-search-fallback/loop.ts` (`replay` is not used by the mixing loop). |

## Server wiring (`src/server.ts`)

- `runCoordinatorCompletion` (route/coordinator) + `runMixTurn` (buffered + streamed dispatch for pipeline/fusion): resolve the target's own provider auth through `resolveProviderAuth`, then resolve the wire-protocol override and adapter. Each adapter receives the request-surface headers, but a grant-backed Anthropic adapter replaces/isolates auth and never merges incoming Claude credentials.
- `handleMessages`: after capturing `responseModelId = parsed.modelId` (kept as `frogp/mix` for stable transcripts/resume) and BEFORE `applyModelMixing`/`routeModel`:
  - `combine === "fusion" || "pipeline"` -> `runWithMixing(...)` (returns the single SSE Response).
  - else (`route`) -> `applyModelMixing` rewrites `parsed.modelId` to the chosen `provider/model` and the normal route path continues. `count_tokens` uses `applyModelMixingCheap` (no LLM).
- Catalog: `src/claude-catalog.ts` `mixingRoutedModel` injects the `frogp/mix` synthetic entry in `gatherRoutedModels`.

## Management API (`src/server.ts`)

`GET /api/model-mixing-settings` returns a normalized, non-mutating snapshot owned by
`src/model-mixing/settings.ts`:

- `modelMixing`: normalized `FrogModelMixingConfig`; defaults filled for `enabled:false`,
  `aliasId:"frogp/mix"`, `mode:"coordinator"`, `combine:"route"`, `agents:[]`, and `fusion:{}`.
- `providers`: every configured provider from `Object.keys(config.providers)`, with
  `{name, defaultModel, models, authMode, adapter, claudeGrantId?}`. `models` comes from the known-model list
  built from each provider's `defaultModel + models[]`; `claudeGrantId` is a non-secret readiness/binding id.
- `catalogAlias`: `{aliasId,namespaced,provider,id,exposed,disabled,hiddenPolicy}`. `exposed` is true
  only when `modelMixing.enabled === true` and `aliasId` is namespaced. `disabled` checks the exact
  `aliasId` in `disabledModels`. `hiddenPolicy` is always `"alias-id-specific"`.
- `presets`: exactly `low`, `balanced`, and `research`.
- `evidence`: `MIX_EVIDENCE` constants for `f3-codex` vs `baseline-gpt55`.

### Provider availability and Anthropic auth

Model Mixing never invents providers from Claude Code native state. A model can be selected only when its provider
exists in `config.providers`. Therefore Anthropic appears in Model Mixing and Model Picker only after an Anthropic
provider row exists (fresh configs include `anthropic` by default; upgraded/manual configs may need one added).

For `authMode:"forward"` providers, including the default Anthropic Claude row, frogprogsy does not store upstream
credentials. Each mixed sub-call receives the original Claude Code request headers. Anthropic Claude subscription
models work when the request came through a gateway-applied Claude Code home that supplies real `Authorization`
or `x-api-key` headers; API/headless callers without those headers need an API-key provider instead. Profile-scoped
Anthropic model listing is populated by `/v1/models` requests that include `X-Frogp-Claude-Profile` plus real
Anthropic auth; absent auth, the UI can still show configured `defaultModel`/`models[]`, but live subscription
catalog discovery has no token to use.
For `authMode:"claude-grant"`, every coordinator/panel/judge/synthesizer call resolves the isolated token
through `resolveProviderAuth`. The official Anthropic target is validated before broker/network access; incoming
forwarded headers and stored static keys are not merged into the grant request.

`PUT /api/model-mixing-settings` accepts `{ "modelMixing": { ...partial FrogModelMixingConfig } }`
and behaves like a PATCH even though the method is PUT. Unspecified fields are preserved. Nested plain
objects merge recursively; arrays such as `agents`, `pipeline`, `rules`, and `fusion.panel` replace only
when present. GUI-owned patches must preserve unknown future keys and GUI-unowned/manual fields unless
explicitly patched, including `rules`, `pipeline`, `surfaceStages`, `guidance`, and `timeoutMs`. Known bad
shapes, invalid enum/range values, unknown providers, and unknown model strings return `200` with
`warnings`; unknown model strings persist. Malformed JSON is the settings lane's `400` case. After a
successful patch the server calls `persistConfig(config)` and best-effort refreshes the Claude Code
catalog when `enabled` or `aliasId` changes.

`GET /api/model-mixing/call-plan` returns `{ ok:true, plan: computeCallPlan(config), warnings: [] }`
for the saved config. Optional `draft=<urlencoded JSON>` is a raw `modelMixing` patch, not a
`{modelMixing:{...}}` wrapper; the server applies it to an in-memory clone and never persists it.
Malformed draft JSON returns `400`; semantic problems are warning-only. This endpoint is a preview of
answer-call and search-call counts, not an execution trigger.

### Claude grants and Codex in one session (dual-auth)

Dual-auth (`structure/09_claude-dual-auth.md`) lets one Claude Code session and one mixing roster use two
credential families at once: Codex/GPT sub-calls resolve frogprogsy's own OAuth (`~/.frogprogsy/auth.json`),
while Anthropic Claude sub-calls resolve either a forwarded native Bearer (`authMode:"forward"`) from the
token-free interactive carrier or an isolated grant token (`authMode:"claude-grant"`). Each mixed sub-call resolves
its own provider's credential: a grant token attaches only to its bound provider and never reaches
codex/xai/kimi or the openai-responses fallback, and incoming Claude Code headers are never merged into a
`claude-grant` sub-call.

Because a grant carries its own subscription Bearer, a roster may hold two distinct Claude account contexts —
two `claude-grant` providers bound to two grants, or one grant plus one forward row — and each produces a
distinct `Authorization` value with its own per-grant refresh lockfile. Plain forward mode cannot give this
within one request: a forward row carries exactly one incoming Claude Bearer per session.

Grant-backed Anthropic sub-calls are ready for headless / `frogp/mix` fan-out that has no incoming Claude
Bearer, because the broker resolves the token from the grant's scoped store instead of the request headers.
Forward-mode Anthropic sub-calls still need a live Claude Code client that supplies real
`Authorization`/`x-api-key`; API/headless callers without those and without a grant need an Anthropic API-key
provider instead. Interactive enrollment is token-free and preserves the live client's native Bearer; isolated
grants remain the explicit way to use subscription auth for headless/server work without a live forwarding client.

## Presets, evidence, and alias visibility

The preset ids are server constants:

- `low`: fusion with `codex/gpt-5.5` and `codex/gpt-5.4-mini`, task panel context, task judge context,
  panel web-search disabled, multiround disabled.
- `balanced`: fusion with `codex/gpt-5.5`, `codex/gpt-5.4`, and `codex/gpt-5.4-mini`, full panel
  context, task judge context, panel web-search disabled, multiround disabled.
- `research`: matches `evals/fusion/profiles/f3-codex.json` except `enabled` and `aliasId` are omitted
  so applying the preset preserves the current switch and alias. It uses codex panel models
  `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`; judge and synthesizer `codex/gpt-5.5`; full panel and judge
  context; panel web-search `{enabled:true,maxSearchesPerPanel:1,maxTotalSearches:4,timeoutMs:10000,tiers:["no_key"]}`;
  multiround `{enabled:true,maxRounds:2,branchFactor:2,budgetCalls:12}`; `stageTimeoutMs:60000`; and
  `panelTimeoutMs:60000`. Its deterministic preview is `calls:11` and `searchCalls:3`.

Verified Codex model support (2026-07-20 corrected manual P0, NOT exhaustive): ChatGPT Codex rejected
`gpt-5.3-codex` with `400`, while `gpt-5.4` and `gpt-5.4-mini` returned `200` and remain supported preset panel
members. Only these ids were exercised against ChatGPT Codex during the probe session; this is not an exhaustive
enumeration and does not certify every configured model (for example `gpt-5.5` was not part of this check).
Recorded in `artifacts/claude-dual-auth/probe-picker-manual-2026-07-20.json`. A mixing roster member whose
provider is logged out is hidden from the `/model` picker on the next refresh (readiness-filtered export, see
`structure/05_gui-and-management-api.md`) while remaining visible/configurable in the management registry; a
stale or manually typed alias for a logged-out provider fails closed with typed `401 oauth_missing`.
The interactive picker/launch carrier doctrine — token-free as the implemented default vs the
sentinel rollback, plus the gateway-cache byte/mode contract — lives in `structure/02_config-and-claude-home.md`
and `structure/09_claude-dual-auth.md`; Model Mixing sub-call auth resolution is independent of that launch
carrier and unchanged by it. The Codex support results above are runtime probe observations from that session,
not a code-level model registry, and remain non-exhaustive.

`MIX_EVIDENCE` is intentionally sealed to `artifacts/eval-runs/local-suite-v1/run-002-f3/stats.json`:
`candidate:"f3-codex"`, `baseline:"baseline-gpt55"`, `candidateLabel:"f3-codex"`,
`baselineLabel:"codex/gpt-5.5"`, `qualityDelta:0.13333333333333341`,
`qualityDeltaCi95:[0.05833333333333335,0.20000000000000018]`, `passesPrimaryGate:true`, and
`latencyWallClockMs:{p50:28766,p95:219457}`. `tests/model-mixing-settings-api.test.ts` contains the
drift test comparing those exported constants to the stats artifact and the test proving the research
preset matches the `f3-codex` profile.

Alias hidden state is exact-alias-id state. If `frogp/mix` is hidden in Model Picker and `aliasId` is
changed to `team/router`, `disabledModels` is not migrated; `team/router` has its own visibility key and
may be exposed until the user hides that alias separately. The Model Picker remains the visibility
authority; the model-mixing API only reports alias status.

## Streaming contract

One `/v1/messages` request -> one Anthropic SSE via `bridgeToMessagesSSE` (`message_start` emitted immediately -> no dead-air). Intermediate stages (panel/judge, thinker/worker, and opt-in multiround score/refine) run buffered (`adapter.parseResponse`) and, when `surfaceStages` is on, are emitted as `thinking` blocks; multiround markers use `[round N score]` and `[round N refine]`. The final stage (synthesizer/verifier) streams live (`adapter.parseStream`) with the FULL original `parsed.context` + `parsed.options` + tools plus an appended instruction. A real tool call from a pre-final pipeline stage is relayed terminally (the proxy is stateless and cannot force a follow-up turn); the verifier is deferred with a loud warning. Fusion panel members never receive client tools. When `fusion.panelWebSearch.enabled:true`, panel members receive only FrogProgsy's synthetic `web_search` tool; FrogProgsy intercepts its `tool_use`, executes bounded internal evidence collection, injects a `toolResult`, and redispatches the same panel member. Synthetic search calls/results are never emitted to Claude Code SSE and are not available to judge or synthesizer. Multiround score/refine calls also never receive client tools; they use the judge/synthesizer targets in buffered mode and only the final synthesizer gets live streaming. By default, intermediate fusion stages receive only the bounded task text (latest user message, truncated to ~4000 chars) with no system prompt, history, or client tools — a deliberate cost/latency tradeoff. `fusion.contextMode:"full"` opt-in gives panel prompts the original system prompt and full message history; `fusion.judgeContextMode:"full"` does the same for judge/score/refine prompts independently. Full context still excludes client tools for pre-final stages. Only the final streamed stage gets the full original context, options, and client tools.

## Cost / fallbacks

- Calls: route = 1-2; pipeline = #stages (<=3); fusion `calls` reports answer/scoring model calls only: panel(1-8) + judge + synthesizer, plus multiround `score=maxRounds` and `refine=maxRounds*branchFactor` when enabled, capped by `budgetCalls`. Panel web-search is reported separately as `searchCalls` (`panelSize * maxSearchesPerPanel`, capped by `maxTotalSearches`) when `fusion.panelWebSearch.enabled:true`.
- Panel web-search budgets are hard caps. Duplicate queries reuse prior evidence instead of executing another search; over-budget calls get an internal insufficient-evidence tool result and a redispatch, not a Claude Code-visible tool event.
- Multiround budgets are hard answer/scoring-call caps. Before a score/refine/synthesize call would exceed `budgetCalls`, the loop aborts that extra work, logs a loud `console.error` with used/requested/budget counts, and falls back to synthesizing from the current best candidate. If even the final synthesizer cannot be called within budget, the current best candidate is returned directly with `done`; the over-budget path is never silent.
- Every degraded path is LOUD (`console.error("frogprogsy: model-mixing: ...")` + warning), never silent: panel survivors, judge-invalid -> synth from raw panel, synth failure -> best panel answer, empty roster -> first agent / default provider, no rule match -> first agent / default.

## Verification

- Unit: `tests/model-mixing.test.ts` (route/gating/catalog) + `tests/model-mixing-multimodel.test.ts` (fusion plan, judge parse incl. wrong-typed coercion, prompts, scan, call plan, pipeline stages, rules) + `tests/model-mixing-multiround.test.ts` (disabled byte invariance, score/refine loop, budget fallback, maxRounds, call-plan split).
- Live smoke (mock upstream, `FROGPROGSY_HOME` dir + `config.json`): `frogp/mix` in `/v1/models`; fusion -> thinking(panel x2 + judge) then text, N+2 calls, id echo; pipeline tool-less -> 3 calls, tool call -> `tool_use` relayed + verifier deferred; rules -> deterministic routing with 0 coordinator calls.
- Real-provider live e2e is a documented MANUAL gate (credential-gated).
