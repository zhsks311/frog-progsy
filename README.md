<p align="center">
  <img src="assets/banner.png" alt="frogprogsy — Universal provider gateway for Claude Code" width="820">
</p>

<p align="center">
  <b>English</b> · <a href="README.ko.md">한국어</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="https://zhsks311.github.io/frog-progsy/"><b>Full documentation</b></a>
</p>

frogprogsy is a local provider gateway in front of Claude Code. Connect a provider in the dashboard first, then keep using Claude Code normally.

## Quick start: connect your first provider in the dashboard

### 1. Install

```bash
git clone https://github.com/zhsks311/frog-progsy.git
cd frog-progsy
bun add -g .
frogp --help
```

`bun add -g frogprogsy` is the command to use after the package is published to the registry. It is not published there yet.

frogprogsy runs on [Bun](https://bun.sh) 1.1 or newer. If `frogp` is not found, make sure Bun is on your `PATH`.

<details>
<summary><b>Missing Bun?</b> Install it first</summary>

```bash
# macOS / Linux / WSL
curl -fsSL https://bun.sh/install | bash

# Windows PowerShell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Open a new terminal, then run the `bun add -g .` step again.

</details>

### 2. Start the local relay

```bash
frogp start
```

The default dashboard URL is `http://localhost:3764` — `3764` spells FROG on a phone keypad. If another port is used, the next step's `frogp gui` opens the current dashboard.

<details>
<summary><b>Running the proxy in Docker?</b></summary>

Build and run the included Docker Compose service:

```bash
docker compose up --build
```

The Compose file sets `FROGP_EXTERNAL_SUPERVISOR=1`, binds the proxy to `0.0.0.0` inside the container, publishes `3764`, and persists config in the `frogprogsy-config` volume. Docker's restart policy owns crash recovery, so frogprogsy does not start its own watchdog inside the container.

Point Claude Code at the host-exposed gateway, for example `ANTHROPIC_BASE_URL=http://localhost:3764`.

</details>

### 3. Add a provider in the dashboard

```bash
frogp gui
```

In the dashboard, connect your first provider:

1. Open **Add Provider**.
2. Pick a built-in provider or enter an OpenAI-compatible endpoint.
3. Save an API key, or use OAuth for supported providers such as Codex/ChatGPT, xAI, and Kimi. For Anthropic Claude, keep subscription auth in Claude Code homes; adding the Anthropic provider creates a forward-auth model-picker entry without storing a Claude token in frogprogsy.
4. Choose the default provider and model.
5. Confirm the models appear in the Claude Code model picker.
If the Claude Code model picker looks stale after changing providers or models, refresh the Claude Code profile list and reopen the picker from a fresh Claude Code session or a resumed session:

```bash
frogp claude reload-models <profile-id>
```

Already-open `/model` screens do not hot reload; start a new `claude` session or resume one so Claude Code refetches `/v1/models`.

`frogp start`/`frogp refresh` generate launcher shims in `~/.frogprogsy/bin` (`claude` for the default home plus aliases such as `claude-work` or `claude-personal`). Put that directory before the native Claude Code binary in `PATH`, or use the package-provided `claude` bin when it wins PATH resolution. If the proxy is stopped, those launchers pass through to native Claude Code for the selected home.

### 4. Send your first Claude Code request

```bash
claude "Explain this project's entry points"
```

To route to another model or use a `provider/model` alias, continue with [model routing](https://zhsks311.github.io/frog-progsy/guides/model-routing/).

## Optional: connect a Claude subscription (dual-auth grant)

By default the Anthropic provider runs in **forward** mode: frogprogsy stores no Claude token and reuses the subscription auth from your active Claude Code home at request time. Nothing extra is needed, and your native `~/.claude*` homes and multiple Claude accounts stay untouched.

If you want a Claude subscription to answer alongside Codex in the same session or `frogp/mix` roster — without depending on a logged-in Claude Code home for every call — add an optional, isolated **Claude grant**:

```bash
frogp claude grants add "Work Claude"     # prints a login command; frogprogsy never runs it
frogp claude grants status                # ok / reauth required / unreadable / none — no secrets
frogp providers set anthropic --auth claude-grant --grant <cg_id>
```

- A grant is a separate Claude login you run yourself with your real `claude` executable into a frogprogsy-owned `CLAUDE_CONFIG_DIR`. `frogp claude grants add` creates the grant record and scoped directory and prints the `CLAUDE_CONFIG_DIR=<grant-dir> claude auth login --claudeai` command; it never automates the login, opens a browser, copies tokens, or takes over a native `~/.claude*` home or the global Keychain login. After you log in, `frogp claude grants status` (or the dashboard) verifies the scoped credential appeared.
- Grant custody is isolated and fail-closed: the grant token serves only its bound Anthropic provider, Codex OAuth stays a separate credential, and if refresh fails the provider returns a typed re-auth error instead of falling back to another credential.
- You consent to a grant when you set it up (and again for any live subscription-authenticated diagnostic, via an explicit `--yes`/dashboard confirmation), not on every routed request. That consented custody hands frogprogsy a subscription token, so subscription-authenticated calls carry Anthropic ToS, account, and quota risk that no safeguard can undo. If you do not want that, use an Anthropic API-key provider instead — it also covers headless/API callers.

See the [Claude Code wiring guide](https://zhsks311.github.io/frog-progsy/guides/claude-integration/) for grant readiness states, re-auth, and `frogp doctor claude`.

## Model-mixing profiles

You can now use the dashboard **Model Mixing** tab to apply Low, Balanced, or Research presets and enable `frogp/mix` without editing JSON. See the user guide for the dashboard-first flow and caveats: [Model Mixing guide](https://zhsks311.github.io/frog-progsy/guides/model-mixing/).

Model mixing is opt-in and remains off until you enable it. The dashboard presets are: Low (4 answer calls, 0 search calls), Balanced (5 answer calls, 0 search calls), and Research (11 answer calls, up to 3 search calls). Applying a preset does not enable it automatically; the Enable toggle is a separate confirmation step, and Claude Code shows the mixed route as `frogp/mix` once enabled.

Research/F3 passed the frozen 60-question `local-suite-v1` evaluation against the strongest single-model baseline (`gpt-5.5`) with delta `+0.1333`, 95% CI `[+0.0583, +0.2000]`. Caveats: hard reasoning did not improve, gains concentrate in analysis/coding, scoring used a single judge, response latency was about p50 `29s` / p95 `3.7m`, and the claim is suite-v1 only.

| Profile | Intended use | Answer calls per request | Search calls |
| --- | --- | ---: | ---: |
| Low | Small expert panel without search | `4` | `0` |
| Balanced | More comparison when quality matters more than speed | `5` | `0` |
| Research | Analysis/coding work where quality matters and waiting is acceptable | `11` | up to `3` |

## Read next

This README only covers the first-success path. The official full documentation lives in the docs site.

| Task | Doc |
| --- | --- |
| Check install behavior and first-run files | [Install frogp](https://zhsks311.github.io/frog-progsy/getting-started/installation/) |
| Walk through the first relay launch | [Launch and verify](https://zhsks311.github.io/frog-progsy/getting-started/quickstart/) |
| Configure providers, OAuth, API keys, local endpoints | [Provider setup](https://zhsks311.github.io/frog-progsy/guides/providers/) |
| Inspect dashboard, activity, and usage | [Dashboard and Activity](https://zhsks311.github.io/frog-progsy/guides/web-dashboard/) |
| Read CLI, config JSON, adapter references | [CLI reference](https://zhsks311.github.io/frog-progsy/reference/cli/) · [Configuration reference](https://zhsks311.github.io/frog-progsy/reference/configuration/) · [Adapter reference](https://zhsks311.github.io/frog-progsy/reference/adapters/) |

Advanced topics such as `frogp init`, config JSON, provider matrices, and capability fallbacks are intentionally kept out of the README happy path and maintained in the docs above.

License: MIT
