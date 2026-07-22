# Fusion evaluation framework

Status: **F3 accepted on local-suite-v1 (see caveats)**. F1 and F2 remain experimental / not accepted; do not claim Fable parity or external benchmark parity.

## Acceptance rule

The hard acceptance target is **local frozen-suite improvement over the strongest single-model baseline**. Do not claim Fable parity or external benchmark parity.

Primary rule for a pre-registered candidate:

- metric: weighted mean `qualityScore`
- comparison: candidate vs frozen S0 on identical task ids
- statistic: paired bootstrap with `10000` resamples
- pass threshold: 95% CI lower bound `> 0` and point delta `>= 0.03`
- secondary comparisons are reported separately and cannot override a failed primary gate
- `proxyContractScore` is a hard non-regression gate

Current measured status from `artifacts/eval-runs/local-suite-v1/run-002-f3/stats.json`:

- S0 is frozen as `baseline-gpt55` (`codex/gpt-5.5`). `baseline-opus48` ties S0: delta `0.000`, 95% CI `[-0.058, +0.067]`.
- F1 official candidate is `f1-codex`. F1 vs S0 delta is `+0.0265`, 95% CI `[-0.0553, +0.100]`; `passesPrimaryGate=false`, so F1 remains experimental and is rejected as an acceptance claim.
- The earlier `+0.0598` interim value is invalid for acceptance and may be cited only as an observed judge regrading-variability case.
- F2 is not measurable on suite v1 because every task is self-contained and does not trigger search; F2 remains experimental until suite v2 adds search-eligible analysis tasks.
- F3 official candidate is `f3-codex` (research profile: full-context + bounded multiround, `maxRounds: 2`, `branchFactor: 2`, `budgetCalls: 12`, codex-only 3-panel). F3 is the first configuration to pass the pre-registered primary rule on frozen suite v1: delta `+0.1333`, 95% CI `[+0.0583, +0.2000]`, `passesPrimaryGate=true`; category deltas are coding `+0.167`, reasoning `+0.021`, analysis `+0.375`, agent/protocol `0.000`.
- F3 caveats: hard-tag subset delta `0.000`, 95% CI `[-0.167, +0.167]`, so the designed hard-reasoning target did not improve and gains concentrate in analysis/coding; the protocol uses a single judge (`gpt-5.5`) with observed regrading variability around `±0.03`, though F3's delta is larger than that band; latency is high (wall p50 `29s`, p95 `219s`), unsuitable for latency-sensitive use; claims are limited to suite v1 only, with no cross-version claim.

## R1 dispatch diagnostic (run-003, not an acceptance claim)

`run-003-r1-dispatch` measured the dispatch path (`combine: "route"`, coordinator `gpt-5.4-mini`) with a mixed anthropic+codex roster (`r1-dispatch-mixed` profile: `gpt-5.5` coding/analysis, `claude-opus-4-8` hard reasoning, `gpt-5.4-mini` easy tasks) against a fresh paired `baseline-gpt55` on frozen suite v1. Fixture: `fixtures/local-suite-v1-run-003-r1-stats.json`; per-task routing: `fixtures/local-suite-v1-run-003-r1-dispatch-distribution.json`.

Headline: quality delta `-0.1945`, 95% CI `[-0.2791, -0.1122]`, `passesPrimaryGate=false`. Decomposition shows the loss is **not** the dispatch mechanism:

- **Dispatch accuracy**: routing followed guidance — coding 17/18 and analysis 11/12 to `gpt-5.5`, hard-tag reasoning 15/18 to `claude-opus-4-8`, all 6 agent/protocol to `gpt-5.4-mini`.
- **Mechanism-neutral**: on the 31 tasks dispatched to `gpt-5.5` (same model as baseline), dispatch scored `0.548` vs baseline `0.500` — no dispatch-path penalty.
- **Latency**: wall p50 `11.2s` vs baseline `10.6s` (coordinator overhead ≈ `0.6s` p50); p95 `30.9s` ≈ baseline `32.0s`. Far below fusion/F3 (p50 `29s`, p95 `219s`).
- **Loss source 1 — token budgets vs opus style** (11/16 opus tasks): `claude-opus-4-8` writes long worked solutions; suite reasoning tasks cap `maxTokens` at 300, so answers were truncated before the final result (`0.000` vs baseline `0.591` on those tasks).
- **Loss source 2 — grader format strictness** (untruncated opus, 5 tasks, `0.400` vs `0.800`): exact/numeric graders reject LaTeX-formatted correct answers (e.g. `\boxed{\dfrac{3}{11}}` vs reference `3/11`).
- **Loss source 3 — mini leakage** (5 reasoning tasks routed to `gpt-5.4-mini`): `0.200` vs baseline `1.000`; genuine coordinator mistakes, fixable via stricter guidance ("never route reasoning to the mini model").
- **Proxy bugs found in the anthropic lane** (follow-ups, not fixed in this run): (a) non-streaming `/v1/messages` ignores `max_tokens` for `claude-opus-4-8` (`max_tokens: 20` returned 2656 output tokens); (b) when the streamed cap does apply, the truncation is reported as `stop_reason: "end_turn"` instead of `"max_tokens"`.

Verdict: the dispatch mechanism works (correct routing, negligible latency overhead, no same-model penalty), but a mixed anthropic+codex roster cannot be quality-claimed on suite v1 until the anthropic `max_tokens` bugs are fixed and either the roster or the guidance compensates for opus's verbose format. Cost profile is `~2` calls/request vs fusion's `9–11`.

## Run-004 post-data-plane diagnostic (not an acceptance claim)

`run-004-r1-after-data-plane` re-ran the same paired comparison (`baseline-gpt55` vs `r1-dispatch-mixed`) on frozen suite v1 **after** the anthropic data-plane fixes (caller-cap preservation `e4bf5bf`, truthful `stop_reason` propagation `d03ea0c`/`a8fa7f6`) and the anti-leak dispatch guidance (`5929f4d`). Fixtures: `fixtures/local-suite-v1-run-004-stats.json`, `fixtures/local-suite-v1-run-004-diagnostics.json`.

Headline: quality delta `-0.2598`, 95% CI `[-0.3417, -0.1780]`, `passesPrimaryGate=false` (consistent with run-003's `-0.1945`, CI `[-0.2791, -0.1122]`). The loss decomposition is now **machine-readable** via the new `diagnostics` command and confirms the run-003 hypothesis with truthful truncation data:

- **Truncation is the loss** (`diagnostics.json` `truncation`): all 16 `stop_reason: "max_tokens"` rows in the run are dispatch rows routed to `claude-opus-4-8` (16/23 opus rows truncated at the suite's 300-token reasoning caps). Baseline `gpt-5.5` rows: 0 truncations. Reasoning category collapsed to `0.083` vs baseline `0.625` (22/24 dispatch reasoning rows scored 0).
- **Dispatch accuracy held**: merged routing distribution `gpt-5.5` 29, `claude-opus-4-8` 23, `gpt-5.4-mini` 8 — the same shape as run-003, and **zero reasoning tasks leaked to the mini model** after the anti-leak guidance (run-003 had 5 leaked).
- **Latency**: wall p50 `11.5s` vs run-003 `11.2s`; `proxyContract` score `0.9` is byte-identical to run-003 (a known route-mode scoring artifact: dispatch responses have no fusion thinking stage, so the fusion-shaped fifth contract check fails; not a regression).
- **Both run-003 anthropic proxy bugs are confirmed fixed**: caps are enforced (`max_tokens` cap respected on every row) and truncation is truthfully reported (`stop_reason: "max_tokens"` instead of `"end_turn"`).

Operational findings (disclosed for auditability):

- **Anthropic auth regression + fix**: the Claude pass-through redesign (`7a47b94`) removed `anthropic` from `OAUTH_PROVIDERS`, so the legacy `authMode: "oauth"` anthropic provider config hard-401s (`Unknown OAuth provider: anthropic`). The supported path is `authMode: "forward"` (relay the caller's credentials). During this run we also found and fixed a forward-mode gap: Anthropic rejects forwarded subscription Bearer tokens whose first system block is not the Claude Code identity (surfaced as a misleading `429 rate_limit_error`); the anthropic adapter now applies the oauth request shape (identity block + oauth beta) to forwarded Bearer tokens (`tests/anthropic-forward-auth.test.ts`). The eval harness passes forward credentials via the `EVAL_FORWARD_BEARER` env var — never persisted in artifacts.
- **Two config epochs**: 60 baseline + 37 dispatch rows ran under the epoch-1 config (`config.sha256`, anthropic `oauth`, 23 dispatch rows failed 401); the 23 failed pairs were re-run with `--append --skip-existing` under the epoch-2 config (`config.epoch2.sha256`, anthropic `forward`). The only config difference is the anthropic auth mode, which cannot affect rows that already succeeded. `diagnostics.json` carries an honest `insufficient_log_entries` warning because per-task log mapping covers only the epoch-2 tail; the routing distribution above is computed from both log snapshots (`api-logs.epoch1.snapshot.json`, `api-logs.epoch2.snapshot.json`) using `requestedModelLabel` to attribute profiles, which needs no row mapping.
- Cost: 120 answer calls + 23 re-run answers, 58 judge calls, 2 adjudications, 0 searches.

Verdict: the dispatch mechanism remains sound and the data plane is now honest; the remaining loss is structural suite-v1 unfairness to visible-reasoning styles (300-token caps + format-strict graders). Quality claims for mixed rosters move to suite v2.

### Diagnostics command

`bun tools/eval-fusion.ts diagnostics --run <runDir> --logs-url http://127.0.0.1:<port>/api/logs` — run it immediately after `run` and **before** `grade` (judge calls pollute `/api/logs`, retention 200). It maps `responses.jsonl` rows to `/v1/messages` request-log entries chronologically (`mappingMethod: "chronological-tail"`) and writes `<runDir>/diagnostics.json` with truncation aggregates (`stopReason === "max_tokens"`) and routing aggregates by profile/category/task/routed-model/provider/route-kind, the same-model subset, propagated adapter diagnostics, and search counts. `mappingWarnings` entries carry `severity`; `"info"` warnings are deterministically excluded from aggregate-distortion conclusions, `"warning"` severity means aggregates may be partial (e.g. `insufficient_log_entries`).

## Suite v2: equalized benchmark contract

`local-suite-v2.jsonl` is a 60-task suite that preserves the v1 category shape (reasoning 24 / coding 18 / analysis 12 / agent-protocol 6, weights 0.40/0.30/0.20/0.10) under an **equalized benchmark contract**:

- **Answer equalizer**: every reasoning exact/numeric task carries an `answerInstruction` ("final answer only, plain integer/decimal/simplified fraction, one line, no working, no LaTeX") serialized by the harness as a second user content block. This is a **benchmark contract, NOT default Claude Code behavior** — it exists so providers with visible-reasoning styles face the same short-answer contract instead of being structurally truncated.
- **Moderately raised budgets**: reasoning short 700 (v1: 300), reasoning rubric 1200, coding 1200, analysis 1500, agent-protocol 900.
- **Format-tolerant grading**: v2 exact/numeric tasks are graded through the `format-tolerant` canonicalization in `grade.ts` (LaTeX unwrapping, exact rational equivalence, conflicting-candidate rejection). v1 grading is byte-identical strict.
- **Search-eligible analysis**: 6 of 12 analysis tasks are tagged `search-eligible` (current-ecosystem questions where grounded 2026 knowledge helps); the harness never forces search.
- **Provenance**: `suites/local-suite-v2.provenance.json` records the full contract (quotas, equalizer, normalization, baseline-selection rule, per-task origin/rationale/author/reviewer, suite sha256). Quota actuals: 34 `modified_from_v1_concept` + 4 `control_from_v1_concept` (38 v1-concept derived, bound 30–42), 22 `new_task` (bound 18–30), 0 verbatim v1 copies, 6 search-eligible new analysis tasks. Enforced by `bun test tests/eval-fusion-provenance.test.ts`.
- **Rubric convention fix**: v2 `rubricId` values are extension-less (`v2-reasoning-17`), so rubric files actually load. (Latent v1 quirk disclosed: v1 `rubricId` values include `.md` while the grader appends another `.md`, so all v1 rubric-grader items silently used the generic fallback rubric text. v1 stays frozen; this is a v2 convention fix, not a code change.)
- **Non-comparability**: v2 scores are not comparable to v1 scores, and v2 does not measure default Claude Code behavior — it measures performance under the equalized benchmark contract above.

**Authoring smoke (smoke-001, 12 top-level calls)**: 6 reasoning short-answer tasks × `baseline-gpt55` + `baseline-opus48`, isolated home (anthropic `authMode: "forward"`). Result: 12/12 correct under tolerant grading, **0 truncations** (max output 258 tokens vs the 700 budget), and `claude-opus-4-8` followed the answer-only instruction exactly — confirming the equalizer removes v1's opus truncation penalty. Smoke evidence would even support a 500 budget; 700 is kept as safety margin for harder items.

**Freeze rule**: after the first approved v2 candidate run, `local-suite-v2.jsonl`, v2 rubrics, the provenance artifact (`frozenAt` set), weights, graders, the baseline-selection rule, and the profile set are frozen; any correction requires a v3.

**Phase C pre-registration** (recorded in the provenance artifact before any measurement): baselines `baseline-gpt55` and `baseline-opus48` on identical v2 task ids; metric = weighted mean qualityScore over paired rows; tie band 0.005 absolute with deterministic tie-break to `baseline-gpt55`; disqualification on response errors or `proxyContract.passed=false` (both → Phase C blocked); `baseline-selection.json` must exist and be cited before any candidate call; the candidate run lists the selected baseline **first** (grade.ts anchors the first row as pairwise baseline); `diagnostics.json` is required for each run and non-`info` `mappingWarnings` are acceptance-blocking.

### Phase C status: v2 acceptance measurement failed honestly

**Routing pitfall found during Phase C**: profile `targetModel` values that are bare model slugs (e.g. `claude-opus-4-8`) do not error when the slug is not resolvable in the isolated home — the proxy silently routes them `client-default` to the home's default provider. In `run-001-baselines` (codex-default home) **all 60 `baseline-opus48` rows actually ran on `gpt-5.5`** (verified: `api-logs.snapshot.json`, `requested=claude-opus-4-8 routed=gpt-5.5 client-default` × 60), so the recorded baseline selection compared gpt-5.5 with itself and is **void** (`baseline-selection.json` carries `invalidatedAt`/`invalidationReason`). Fixes landed: both baseline profiles now use provider-qualified targets (`anthropic/claude-opus-4-8`, `codex/gpt-5.5`), and the `diagnostics` command emits a **warning-severity `routed_model_mismatch`** for any direct-model request whose routed model differs from the requested model. Historical note: v1's "`baseline-opus48` ties S0" result predates this discovery and is likely the same artifact (its logs were not retained; treat that v1 claim as unverified).

The formal corrected v2 measurement used `run-005-corrected-baselines-formal` for pre-registered baseline selection, then `run-006-r1-acceptance-final` for the candidate. Fixtures: `fixtures/local-suite-v2-run-005-baselines-stats.json`, `fixtures/local-suite-v2-run-005-baselines-diagnostics.json`, `fixtures/local-suite-v2-run-005-baseline-selection.json`, `fixtures/local-suite-v2-run-006-r1-stats.json`, and `fixtures/local-suite-v2-run-006-r1-diagnostics.json`.

Baseline selection: `baseline-gpt55` was selected before the final candidate run. Weighted quality was `0.7222` for `baseline-gpt55` vs `0.4661` for real `baseline-opus48`; no tie-break was needed. Diagnostics for the corrected baseline had 0 mapping warnings and showed 24/120 truncations, all in the real opus lane.

Final candidate verdict: `r1-dispatch-mixed` **failed** the v2 acceptance gate against selected `baseline-gpt55`. Quality delta was `-0.0917`, 95% CI `[-0.1639, -0.0250]`, `passesPrimaryGate=false`, and `proxyContract.passed=false` (`score=0.90`, the known route-mode/fusion-shape contract artifact). Candidate diagnostics had 0 mapping warnings and 1/120 truncations. Routing was `gpt-5.5` 92 / `claude-opus-4-8` 23 / `gpt-5.4-mini` 5, with no mini leakage on reasoning tasks; the loss is concentrated in reasoning (`-0.25`) while coding slightly improved (`+0.0278`) and analysis/protocol were flat.

Cost disclosure for the formal corrected pair: 240 answer calls, 60 judge calls, 4 adjudications, 0 search calls. Earlier invalidated/superseded Phase C attempts consumed additional calls and are not acceptance evidence. Phase C acceptance verdict: **rejected on local-suite-v2**; no v2 quality acceptance claim is made.

## Suite weights

`local-suite-v1.jsonl` is the frozen 60-task suite:

| Category | Tasks | Weight |
| --- | ---: | ---: |
| Coding | 18 | 0.30 |
| Reasoning | 24 | 0.40 |
| Analysis | 12 | 0.20 |
| Agent/protocol | 6 | 0.10 |

Formula: `0.30 * CodingMean + 0.40 * ReasoningMean + 0.20 * AnalysisMean + 0.10 * AgentProtocolMean`.

## Eval server isolation

Acceptance runs must hit local frogprogsy over HTTP through `/v1/messages`; direct upstream calls are diagnostics only.

The eval server must be started through the eval-only `serve` helper, which imports `startServer()` directly. Do **not** use `frogp start` or `bun run src/cli.ts start` for acceptance runs because those paths can refresh Claude Code catalog/cache/settings and touch user state.

Isolation rules:

- `FROGPROGSY_HOME` points at the run directory's isolated `home/`.
- User `~/.claude` and default `~/.frogprogsy` are not modified.
- OAuth auth is shared by explicit `--auth-file` / `FROGPROGSY_AUTH_FILE`; do not copy `auth.json` into the isolated home because refresh tokens rotate.
- `serve` owns only the eval server process and pid file in the run directory.

## Canonical config and hash invariants

`prepare-home` merges the base config with a profile overlay, applies startup canonicalization, writes `home/config.json`, writes a redacted `config.snapshot.json`, and records `config.sha256` over the unredacted canonical config.

The config hash must be checked:

1. before server start,
2. immediately after server health passes,
3. after run/grade/stats complete.

Any hash mismatch means `startServer()` mutated config after canonicalization; the run is invalid. After the first candidate run for a suite version, suite tasks, references, rubrics, weights, graders, config profiles, and baseline selection are frozen. Corrections require a new suite version.

## Command sequence

Use one run directory, e.g. `artifacts/eval-runs/local-suite-v1/<runId>`.

Use the dispatcher `bun tools/eval-fusion.ts <cmd> [args]`. The required order is:

1. **prepare-home** — create isolated canonical home and `config.sha256`.
2. **hash-config** — verify the prepared `home/config.json` hash before start.
3. **serve** — start eval-only server from `startServer()` with isolated home and optional shared auth file; it is a long-running process, so run it in a dedicated terminal or supervised background job.
4. **health** — check `/healthz` and `/v1/models`, expecting `frogp/mix`.
5. **run** — run the suite against `http://127.0.0.1:<port>`.
6. **grade** — grade responses with fixed rubrics and position-swap where configured.
7. **stats** — compute weighted deltas, paired bootstrap CI, cost/call/latency summaries.
8. **hash-config** — verify config remains unchanged after the run.
9. **stop-server** — terminate by the run directory pid file.

Example argv shape:

```bash
# prepare-home
bun tools/eval-fusion.ts prepare-home \
  --base ~/.frogprogsy/config.json \
  --overlay evals/fusion/profiles/f3-codex.json \
  --suite evals/fusion/suites/local-suite-v1.jsonl \
  --canonicalize-startup \
  --out artifacts/eval-runs/local-suite-v1/<runId>/home \
  --snapshot artifacts/eval-runs/local-suite-v1/<runId>/config.snapshot.json \
  --hash-out artifacts/eval-runs/local-suite-v1/<runId>/config.sha256

# hash-config
bun tools/eval-fusion.ts hash-config \
  --config artifacts/eval-runs/local-suite-v1/<runId>/home/config.json \
  --expect-file artifacts/eval-runs/local-suite-v1/<runId>/config.sha256

# serve
bun tools/eval-fusion.ts serve \
  --home artifacts/eval-runs/local-suite-v1/<runId>/home \
  --host 127.0.0.1 \
  --port 10190 \
  --pid-file artifacts/eval-runs/local-suite-v1/<runId>/server.pid \
  --auth-file ~/.frogprogsy/auth.json

# health
bun tools/eval-fusion.ts health --proxy http://127.0.0.1:10190 --expect-model frogp/mix

# run
bun tools/eval-fusion.ts run \
  --suite evals/fusion/suites/local-suite-v1.jsonl \
  --proxy http://127.0.0.1:10190 \
  --profiles evals/fusion/profiles/baseline-gpt55.json,evals/fusion/profiles/f3-codex.json \
  --out artifacts/eval-runs/local-suite-v1/<runId>

# grade
bun tools/eval-fusion.ts grade \
  --run artifacts/eval-runs/local-suite-v1/<runId> \
  --rubrics evals/fusion/rubrics \
  --position-swap \
  --max-adjudication-rate 0.10 \
  --max-judge-retries 1

# stats
bun tools/eval-fusion.ts stats \
  --run artifacts/eval-runs/local-suite-v1/<runId> \
  --baseline strongest-single \
  --primary f3-codex \
  --bootstrap 10000 \
  --alpha 0.05 \
  --secondary-correction holm

# final hash-config, then stop-server
bun tools/eval-fusion.ts stop-server \
  --pid-file artifacts/eval-runs/local-suite-v1/<runId>/server.pid
```

## Manual live e2e checklist

Use this before citing a run as live evidence:

1. Start the eval-only server with isolated `FROGPROGSY_HOME` and shared `FROGPROGSY_AUTH_FILE`.
2. Probe `/healthz` and `/v1/models`; confirm `frogp/mix` appears.
3. Send one `/v1/messages` request through the proxy using the target profile.
4. Confirm SSE markers: immediate `message_start`, optional surfaced `thinking` stage markers, final streamed text, and `message_stop`.
5. Confirm final synthesizer behavior: `stageTimeoutMs`/`panelTimeoutMs` apply to buffered pre-final calls only; final streamed synthesizer is bounded by client abort/SSE idle, not by `stageTimeoutMs`.
6. Re-run `hash-config` and confirm the config hash is unchanged.
7. Stop the eval server by pid file.

## Cost scale reminders

- Fusion panel size `N` costs `N + 2` answer calls per task (panel + judge + synthesizer). At 60 tasks, a 4-panel fusion profile is about `360` answer calls before grading.
- `fusion.panelWebSearch` search calls are capped by `panelSize * maxSearchesPerPanel` and `maxTotalSearches`.
- `fusion.multiround` defaults to a recommended `budgetCalls: 12` cap for answer/scoring calls when enabled in research profiles; panel search remains separately capped by `maxTotalSearches`.
- Field definition: in serialized `cost.json`/`stats.json`, `answerCalls` counts **top-level eval request records** (`taskId × profile` rows through `/v1/messages`). It does NOT count internal fusion fan-out; worst-case upstream work per request is described by `computeCallPlan` (panel `N + 2`, multiround `budgetCalls`), and executed panel searches are reported separately as `searchCalls` with `searchCallsSource` provenance.
