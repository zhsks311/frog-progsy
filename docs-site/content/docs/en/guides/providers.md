---
title: Provider Setup
description: "Connect FrogProgsy providers through OAuth accounts, Claude header forwarding, API-key routes, local endpoints, and safe dashboard operations."
---

This guide focuses on the operator workflow for adding a provider and choosing the default route. The field-level schema lives in the [Configuration reference](/frog-progsy/reference/configuration/).

FrogProgsy treats providers as **upstream routes** behind the local `frogp` gateway. Claude Code keeps speaking Anthropic Messages; each route decides how FrogProgsy reaches upstream: adapter, base URL, auth source, optional headers, and the model list to expose.

## First action: add a provider in the dashboard

Provider setup is safest from the dashboard.

1. Open the dashboard with `frogp gui`.
2. In **Providers → Add Provider**, choose OAuth, API-key catalog, custom URL, or local server.
3. Catalog providers can open the provider key page, validate the key when possible, and write a node under `providers` in `~/.frogprogsy/config.json`.
4. Use **Make default** to choose the `defaultProvider` Claude Code receives when it does not request a specific route.
5. In **Models**, review the default provider's `defaultModel`, exposed models, and hidden entries.
6. In **Activity**, confirm the `parse`, `route`, `oauth`/`auth`, `adapter_build`, `upstream_connect`, and `stream_bridge` phases.

After the dashboard flow, use [Model Routing](/frog-progsy/guides/model-routing/) and [Dashboard & Activity](/frog-progsy/guides/web-dashboard/) to verify the live operating state.

## Pick the right lane

| Lane | Best when | Auth source | Typical adapter |
| --- | --- | --- | --- |
| **Bring-through** | Claude Code already supplied compatible upstream headers. | Incoming allowlisted headers only. | `anthropic`, `openai-responses` |
| **Account sign-in** | You want FrogProgsy to refresh provider account tokens. | OAuth store in `~/.frogprogsy/auth.json`. | `openai-responses`, `openai-chat` |
| **Key-backed node** | A provider exposes an API dashboard or standard bearer key. | Literal key or `${ENV_VAR}` from `~/.frogprogsy/config.json`. | Mostly `openai-chat`; some `anthropic` |
| **Local node** | You run Ollama, vLLM, LM Studio, or another local OpenAI-compatible server. | Usually blank or local-only key. | `openai-chat` |

Advanced direct configuration is documented in the [Configuration reference](/frog-progsy/reference/configuration/).

## AI Accounts vs Claude Code Homes

Use **AI Accounts** to decide which upstream providers frogprogsy can route to. Use **Claude Code Homes** to manage
Claude Code config directories such as `~/.claude` or `~/.claude-work`; those homes supply Claude subscription
auth and receive the local `settings.json` gateway injection.

Anthropic needs both pieces when you want it in the Model Picker or Model Mixing: an Anthropic provider row in AI
Accounts, plus a Claude Code home that is logged in when you use subscription auth. In forward mode frogprogsy
stores no Claude token; it forwards the real `Authorization` or `x-api-key` from the incoming Claude Code request.
Headless/API callers that do not send those headers must use an Anthropic API-key provider instead.

## Bring-through lane: no key stored

Fresh setups seed an Anthropic bring-through provider because Claude Code's native data plane is Anthropic Messages. This lane stores **no provider key** and relays only upstream-compatible headers already present on the incoming request.

```json
{
  "anthropic": {
    "adapter": "anthropic",
    "baseUrl": "https://api.anthropic.com",
    "authMode": "forward",
    "defaultModel": "claude-sonnet-4-6"
  }
}
```

Operational notes:

- Anthropic bring-through forwards only `authorization` or `x-api-key` when they are present.
- `ANTHROPIC_AUTH_TOKEN=local-frogprogsy` is an internal Claude Code local marker and is removed before upstream traffic is sent.
- OpenAI Responses forward mode uses a curated header set for compatible upstream and capability fallback paths.
- Forward-compatible credentials can power [web-search and image fallbacks](/frog-progsy/guides/capability-fallbacks/).

Use this lane when FrogProgsy should route and translate without owning that provider secret.

When you choose **Anthropic Claude** in the dashboard, FrogProgsy defaults to this Claude Code home flow instead of asking for a subscription token. The provider row makes Claude models selectable; the auth location field starts as `~/.claude`, and you should run `claude login` there first. For a second Claude account, log into a separate home and add another Anthropic provider row:

```bash
CLAUDE_CONFIG_DIR=~/.claude-work claude login
frogp claude add work --home ~/.claude-work
frogp refresh
claude-work "hello"
```


## Account sign-in lane: FrogProgsy owns refresh

OAuth accounts live in `~/.frogprogsy/auth.json` and refresh before expiry. Claude subscription auth is not an OAuth lane here; keep it in Claude Code and use `frogp claude` homes for separate Claude Code config directories. Start supported sign-in from the CLI or [Dashboard & Activity](/frog-progsy/guides/web-dashboard/).

```bash
frogp login codex        # ChatGPT/Codex account, routed through the Codex backend
frogp login xai          # xAI Grok
frogp login kimi         # Moonshot Kimi
frogp logout <provider>
```

| Account lane | Route FrogProgsy creates | Why it matters |
| --- | --- | --- |
| `codex` | `openai-responses` route to `https://chatgpt.com/backend-api/codex` | Claude Messages requests become Codex Responses calls without changing Claude Code. |
| `xai` | `openai-chat` route to `https://api.x.ai/v1` | Grok model quirks, including unsupported reasoning params, are handled at the adapter boundary. |
| `kimi` | `openai-chat` route to `https://api.kimi.com/coding/v1` | Kimi coding models join the same FrogProgsy catalog. |

Normal OpenAI API-key billing is separate from ChatGPT/Codex OAuth.

```bash
frogp login openai          # openai-apikey preset alias
frogp login openai-apikey   # explicit preset id
```

## Key-backed lane: catalog node

Start with the dashboard **Add Provider** flow. Direct configuration edits are safer to reserve for providers not in the catalog or for advanced operations that must bypass automatic validation.

| Shape | Providers |
| --- | --- |
| Hosted OpenAI-compatible APIs | Ollama Cloud, Mistral, DeepSeek, Cerebras, Together, Fireworks, Hugging Face, NVIDIA NIM |
| Coding-oriented gateways | Z.AI / GLM Coding, Qwen Portal, Kilo, GitHub Copilot, GitLab Duo |
| Regional or specialty APIs | MiniMax, MiniMax CN, Moonshot, Kimi coding, Xiaomi MiMo |
| Gateway wrappers | Cloudflare AI Gateway, Vercel AI Gateway, Venice, NanoGPT, Synthetic, Qianfan, Alibaba, Parallel, ZenMux, LiteLLM |

Most nodes use `openai-chat` with a bearer key. Some Anthropic-shaped endpoints use the `anthropic` adapter and `x-api-key` instead.

> **Subscription gateways are not plain API-key providers**
>
> GitHub Copilot and GitLab Duo speak through OpenAI-compatible gateway endpoints but authenticate with subscription tokens. Copilot may need a `User-Agent` header in the provider's `headers`, and Cloudflare AI Gateway requires account and gateway ids in the URL template.

## Local lane: route to your machine

FrogProgsy can preserve the Claude Code contract while your local server handles inference.

| Runtime | Base URL |
| --- | --- |
| Ollama local | `http://localhost:11434/v1` |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |

Choose **Custom** in the dashboard or `custom` in `frogp init`, then enter the base URL. Use a blank key only when the local server allows it.

## Advanced CLI/config operations

Use CLI and config edits to automate or recover routes already verified through the dashboard.

- Manage OAuth routes with `frogp login <provider>` / `frogp logout <provider>`.
- Create an initial custom provider with `frogp init` when the dashboard is unavailable.
- Adjust a connected provider's `defaultModel`, `models[]`, `disabledModels`, and `headers` in `~/.frogprogsy/config.json`.
- After edits, confirm actual route selection in dashboard **Models** and **Activity**.

## Decision shortcuts

- Need zero stored provider secret? Use **bring-through**.
- Need ChatGPT/Codex account routing? Use `frogp login codex`.
- Need normal OpenAI API billing? Use `frogp login openai`.
- Need a standard OpenAI-compatible service? Add a **key-backed node**.
- Need local inference? Add a **local node**.
- Need web search or image understanding for a text-only route? Configure a **capability fallback**.
