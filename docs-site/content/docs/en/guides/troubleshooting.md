---
title: Troubleshooting failed requests
description: "Narrow Claude Code request failures through safe logs, frogp status, route/default provider checks, auth/OAuth, capability fallbacks, and clean restore."
---

This guide classifies failed Claude Code requests and recovers them using safe evidence only. Do not copy credentials, OAuth tokens, prompts, request bodies, or account screenshots into issues.

## 0. Classify the symptom in one line

| Symptom | Check first |
| --- | --- |
| Claude Code cannot find a provider model | Route/default provider checks below |
| Request immediately fails with 401/403 | Auth/OAuth checks below |
| Request hangs or stream disconnects | Dashboard safe log phase below |
| Only image or web search requests fail | Capability fallback checks below |
| Claude Code must return to native state | Clean restore path below |

## 1. Check the dashboard safe log phase

Open the dashboard:

```bash
frogp gui
```

In **Activity**, find the failed request id and check the last phase. The request log is not a secret store; it does not save API keys, OAuth tokens, prompt bodies, or account identities.

| Last phase | Meaning | Action |
| --- | --- | --- |
| `parse` | Claude Messages payload shape did not match what the relay expected. | Check Claude Code version and reproduction conditions; compare whether the same request works against native Claude. |
| `route` | Model id did not resolve to a provider lane. | Check default provider, provider prefix, and disabled model state. |
| `oauth` / `auth` | Credentials are missing or expired. | Check provider login state and `authMode`. |
| `adapter_build` | FrogProgsy could not build the provider request. | Check adapter id, baseUrl, and model option gates. |
| `upstream_connect` | Provider HTTP/SSE connection failed. | Check baseUrl, network, provider status, and endpoint path. |
| `stream_bridge` | Provider output failed while converting back to Claude Messages. | Check whether the provider changed tool, reasoning, or stream shape. |
| `finalize` | Response finished and cleanup/logging is running. | Check usage/log write permissions and local disk state. |

If the safe error summary is not enough, report only route, provider, adapter, phase, status code, and request id.

## 2. Check route/default provider

First confirm the relay is running:

```bash
frogp status
```

- If it is not running, start it with `frogp start` or from the dashboard.
- `frogp status` is PID-based. For port mismatches, check `~/.frogprogsy/config.json` and the endpoint injected into Claude Code settings.
- If request health is unclear, compare dashboard status with the latest safe proxy log error.

Then check the provider route:

1. In dashboard **Providers**, confirm `defaultProvider` points to a provider that exists.
2. If Claude Code selected `provider/model`, the `provider` prefix must match a key under `providers` in `config.json`.
3. In dashboard **Models**, confirm the routed model is not disabled.
4. `subagentModels` changes exposure order only; it does not create routes.
5. If a provider's live `/models` call is unreliable, pin it with `liveModels: false` and a `models` allowlist.

For a stale Claude Code model picker, refresh the Claude Code catalog for the active profile:

```bash
frogp claude reload-models <profile-id>
```

Then start a new Claude Code session or resume so `/v1/models` is fetched again. Already-open `/model` screens do not hot reload. If the proxy is not answering, run `frogp refresh` first, then reload the profile catalog.

## 3. Check Auth/OAuth

Split 401/403 and login loops by provider type.

| Provider type | Check | Recovery |
| --- | --- | --- |
| API-key provider | Whether `apiKey` is a literal or `${ENV_VAR}` reference, and whether the shell/runtime environment has that env value. | Save the provider again in the dashboard or fix the env reference in `config.json`. |
| OAuth provider | Dashboard OAuth status and whether `~/.frogprogsy/auth.json` has a provider token. | Run `frogp login <provider>` again. |
| Forward auth provider | Whether Claude Code sent an allowlisted upstream-compatible auth header. | Check native Claude/ChatGPT/Codex login state and restart the relay. |
| Local provider | Whether the keyless endpoint is actually running. | Start Ollama/vLLM/LM Studio first and match `baseUrl`. |

Never share OAuth credentials manually or paste them into logs. Issues should contain provider name, auth mode, status code, and last safe phase only.

## 4. Check capability fallbacks

Web search and image requests may require capability fallbacks when the main provider cannot handle them directly.

### Web search

- Confirm `webSearchFallback.enabled` is `true`.
- The capability fallback model must be able to use an OpenAI Responses forward/key provider.
- If `maxSearchesPerTurn` is too low, the search loop may stop early.
- If `timeoutMs` is too low, upstream search may fail mid-turn.

### Image fallback

- For a text-only target model, confirm `imageFallback.enabled` is `true`.
- If `modelCapabilities.<model>.input` is text-only, images are converted to text descriptions before the main call when `imageFallback` is enabled.
- The capability fallback `model` must support vision.
- Base64 images must not leak into prompt text. Safe logs do not store image bodies.

If capability fallbacks are unstable, reproduce with a search/vision-native main route to separate capability fallback failure from main provider failure.

## 5. Clean restore path

Use the narrowest command that returns Claude Code to the state you need.

| Purpose | Command | Preserves |
| --- | --- | --- |
| Restore Claude Code settings/catalog only | `frogp restore` | Running proxy, FrogProgsy config/auth |
| Stop proxy too | `frogp stop` | FrogProgsy config/auth |
| Remove FrogProgsy-managed traces | `frogp uninstall` | Other Claude Code user state |

`frogp restore` and `frogp stop` remove only FrogProgsy-owned Claude Code settings and catalog entries. They do not remap Claude Code history; `frogp recover-history --legacy-openai` is a retired no-op.

## 6. Record safe reproduction details

Useful issue/PR details:

- OS and FrogProgsy version
- Non-secret `frogp status` summary
- Failed request id and dashboard safe phase/status
- Provider key name, adapter id, auth mode, and routed model id
- Whether `webSearchFallback` or `imageFallback` was used
- Whether the issue reproduces after clean restore

Do not include:

- API keys, OAuth tokens, or session cookies
- Full prompt or request body
- Account email or organization id
- Provider dashboard screenshots that expose credentials or account details
