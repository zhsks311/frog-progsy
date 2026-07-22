---
title: Dashboard & Activity
description: "The local FrogProgsy control room for provider setup, model visibility, classifier routing, capability fallback choices, safe request activity, usage accounting, and shutdown."
---

The dashboard is a local React control room served by the running FrogProgsy proxy. It covers provider setup, default route selection, model visibility, classifier routing, capability fallback choices, request activity, usage summaries, and shutdown from one place.

## Open it

```bash
frogp gui
```

The command opens `http://localhost:<port>` and starts the proxy first when needed. During development, run the proxy and GUI separately:

```bash
frogp start
cd gui && bun dev
```

## Panels operators check first

| Panel | Use it for |
| --- | --- |
| **Dashboard** | Proxy status, version, uptime, provider count, search/image fallback settings, and auto-mode classifier model settings. |
| **Providers** | OAuth login, API-key providers, Anthropic Claude Code home rows, custom endpoints, opt-in connection tests, default provider switching, and removal. |
| **Models** | Dashboard/API model-list reload: routed model visibility, disabled models, and Claude Code discovery state. This reloads what the dashboard and `/v1/models` expose; it is not the Claude Code picker recovery command. |
| **Claude Code Homes** | Named Claude Code config directories, pass-through auth state, inject/restore/refresh actions, and per-home model overlays. Refresh prepares Claude Code picker recovery and shows the stable `frogp claude reload-models <profile-id>` command for that home. |
| **Activity** | Safe request phase traces, recent logs, and local usage accounting grouped by day, model, and provider. |
| **Stop Proxy** | Graceful shutdown plus native Claude Code restore. |

## Model list refresh vs Claude Code picker recovery

Use **Models** when you need to reload the dashboard/API model list. That refresh affects routed model visibility, disabled models, and the `/v1/models` response served by FrogProgsy. If the proxy is down, run `frogp refresh` as proxy recovery first, then reload the list again.

Use **Claude Code Homes** when Claude Code's `/model` picker is stale. Refresh the target home, then run the displayed `frogp claude reload-models <profile-id>` command for that profile. Claude Code does not hot reload an already-open `/model` screen; start a new Claude Code session or resume the profile so Claude Code refetches `/v1/models`.

## Model Mixing page

Use **Model Mixing** when you want Claude Code to show one `frogp/mix` model that combines several models behind the scenes. It is designed to be usable without editing JSON: choose a preset, review the warning, enable it, then select `frogp/mix` in Claude Code.

The page shows:

- preset cards for **Low**, **Balanced**, and **Research**, including server-calculated answer-call and search-call estimates;
- the Research evidence banner: F3 passed the frozen `local-suite-v1` claim with caveats, including no hard-reasoning improvement, single-judge scoring, p50 `29s` / p95 about `3.7m` latency, and suite-v1-only scope;
- the panel members that will answer, plus the judge and synthesizer models;
- a cost preview so “one request” is visible as several internal calls before you enable it.

Two safeguards prevent silent changes. If a preset would overwrite a custom setup, the dashboard asks first; canceling saves nothing. Enabling also shows the current call-count and latency warning; canceling saves nothing, and a failed save rolls the toggle back.

This page is separate from the classifier card. Model Mixing changes how `frogp/mix` answers normal requests; it does not route or replace Claude Code auto-mode safety checks.

## Use safe logs to isolate failures

The request log is intentionally narrow so it does not become a secret store. It shows timing, model, provider, status, endpoint, phase list, and safe error codes, with status/provider/error filters and row details for sanitized route/upstream diagnostics. It does not store API keys, OAuth tokens, request bodies, prompts, emails, or account identities.

Use the phase list to isolate failures:

- `parse` — Claude Messages payload shape
- `route` — model/provider selection
- `oauth` or `auth` — credential availability
- `adapter_build` — provider request construction
- `upstream_connect` — provider HTTP/SSE connection
- `stream_bridge` — conversion back to Claude Messages
- `finalize` — logging and cleanup

## Classifier model settings

Claude Code auto-mode permission checks are separate Haiku-class side queries. When the main default provider is non-Anthropic, use the dashboard classifier panel to keep those checks on a lightweight provider/model instead of silently routing them to the heavyweight default model.

Use per-provider classifier models for normal routing, or set a cross-provider classifier fallback when all classifier side queries should use one provider/model pair.


## Usage accounting

The Activity usage section is local accounting, not a provider invoice view. FrogProgsy records completed `/v1/messages` requests to `~/.frogprogsy/usage.jsonl` when the upstream response includes usage data. Requests without provider-reported usage are counted as `unreported` instead of being displayed as zero tokens.

Use it to answer “which route/model consumed tokens through this proxy?” For account invoices, subscription quota, or organization spend, use the provider's own metering endpoints. Those endpoints are not standardized across providers and often require separate owner credentials.

Claude Code may also call provider-specific usage endpoints. FrogProgsy exposes the local summary at `GET /api/usage`, `GET /api/oauth/usage`, and `GET /usage` so clients receive JSON. Unknown `/api/*` requests do not fall through to dashboard HTML.

## Management API behind the UI

Most operations should stay in the UI. Use these endpoints only for automation or smoke checks.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/provider-state` | Non-secret provider and runtime summary. |
| `GET /api/claude-status` | Redacted Claude Code injection/base URL, runtime/watchdog/external-supervisor, and last `/v1/messages` status. |
| `GET /api/providers` | Configured provider summaries. |
| `POST /api/providers` | Add or update a provider from catalog/custom input. |
| `POST /api/providers/test` | Opt-in single minimal-token provider connection test with enum-only error results. |
| `PUT /api/default-provider` | Change the fallback provider. |
| `DELETE /api/providers?name=…` | Remove a non-default provider. |
| `GET /api/key-providers` | API-key provider catalog. |
| `GET /api/oauth/providers` | OAuth-capable providers. |
| `POST /api/oauth/login` / `GET /api/oauth/status` | Start and poll OAuth login. |
| `GET/POST/PATCH/DELETE /api/claude-profiles` | Manage Claude Code homes and per-home model overlays. Mutating methods, including `PATCH`, require a local origin. |
| `POST /api/claude-profiles/:id/inject|refresh|restore` | Apply, refresh, or restore one Claude Code home. `refresh` returns additive `modelReload` metadata for Claude Code picker recovery, including the stable `frogp claude reload-models <profile-id>` command when available. |
| `GET /api/subagent-models` / `PUT /api/subagent-models` | Read and set featured subagent models. |
| `GET /api/fallback-settings` / `PUT /api/fallback-settings` | Read and set capability fallback model choices. |
| `GET /api/classifier-settings` / `PUT /api/classifier-settings` | Read and set per-provider classifier models plus the cross-provider classifier fallback. |
| `PUT /api/disabled-models` | Hide or show routed models in Claude Code discovery. |
| `GET /api/usage?range=30d` / `GET /api/oauth/usage` / `GET /usage` | Local usage summary from `~/.frogprogsy/usage.jsonl`; `range` supports `7d`, `30d`, and `all`. |
| `POST /api/stop` | Stop the proxy, restore native Claude Code, then exit. |

> **Provider catalog entries**
>
> Adding a catalog provider such as Ollama Cloud can copy model classification metadata into your config, including text-only model hints used by image fallback gating.
