---
title: Capability Fallbacks
description: "How FrogProgsy uses explicit in-process helpers for hosted search and image description when a routed model lacks a native capability."
---

FrogProgsy prefers native provider capability. Claude, OpenAI, Grok, Gemini, and many routed models already accept images or hosted tools in their own wire format; those paths stay native.

Capability fallbacks exist for narrower cases: the selected routed model is text-only, or it cannot execute Claude Code's hosted `web_search` tool. These helpers are **in-process fallback calls**, not external apps, containers, or daemons.

> **Fallbacks are opt-in**
>
> `webSearchFallback` and `imageFallback` are disabled unless you enable them. They require an OpenAI Responses `forward` provider plus forwarded authorization from the incoming request.

## Decision policy

| Request condition | FrogProgsy behavior |
| --- | --- |
| Selected model supports the capability | Use the native provider path. |
| Capability is unknown | Try native first; do not silently downgrade. |
| Text-only model receives an image and `imageFallback.enabled` is false | Return a clear 400 explaining that the model cannot accept images. |
| Text-only model receives an image and `imageFallback.enabled` is true | Describe each image with the configured helper model, then send text to the routed model. |
| Hosted search is requested and `webSearchFallback.enabled` is false | Do not advertise or run synthetic search. |
| Hosted search is requested and `webSearchFallback.enabled` is true | Run the small synthetic-tool loop when forwarded credentials or a configured OpenAI Responses key provider exist. |

## Web-search fallback

When Claude Code requests hosted `web_search` and the selected routed model cannot execute that hosted tool, FrogProgsy can expose a synthetic function named `web_search(query)` to the routed model.

The loop is deliberately bounded:

1. remove the hosted search tool from the provider-bound request,
2. let the routed model decide whether it needs `web_search(query)`,
3. execute the real hosted search through the configured helper model,
4. inject citations and summarized findings as a tool result,
5. repeat until the model answers or `maxSearchesPerTurn` is reached.

| Phase | Actor | What happens |
| --- | --- | --- |
| Hosted tool request | Claude Code → FrogProgsy | Claude Code sends a request that includes hosted `web_search`. |
| Tool substitution | FrogProgsy | FrogProgsy removes the hosted tool for providers that cannot run it and exposes synthetic `web_search(query)`. |
| Decision | Routed model | The routed model either calls `web_search(query)` or answers without search. |
| Fallback execution | OpenAI Responses helper provider | The helper model performs the hosted search within `maxSearchesPerTurn` and `timeoutMs`. |
| Reinjection | FrogProgsy → routed model | FrogProgsy returns capped citations/findings as a tool result and resumes the routed turn. |

Real Claude Code tool calls such as shell, patch, or MCP tools are not swallowed by the loop; they finalize the turn so Claude Code receives them.

```json
{
  "webSearchFallback": {
    "enabled": true,
    "model": "gpt-5.4-mini",
    "reasoning": "low",
    "maxSearchesPerTurn": 3,
    "timeoutMs": 30000
  }
}
```

Search results are wrapped as untrusted data, length-capped, and deduplicated by URL. Structured-output turns receive compact JSON so the helper does not break the requested schema.

## Image fallback

When the selected model is explicitly classified as text-only, FrogProgsy can describe images before the main call. The routed model receives capped text descriptions instead of raw image parts.

- User images and tool-result images are supported.
- Data URLs must be allowed image types and within size limits.
- `https:` image URLs are passed to the helper backend; FrogProgsy does not download them itself.
- Descriptions run with bounded concurrency and preserve original message order.
- Ollama-style `:size` suffixes are tolerated when matching model capability entries.

```json
{
  "imageFallback": {
    "enabled": true,
    "model": "gpt-5.4-mini",
    "timeoutMs": 45000
  }
}
```

Mark provider/model capabilities explicitly:

```json
{
  "providers": {
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "modelCapabilities": {
        "glm-5.2": { "input": ["text"] },
        "gpt-oss": { "input": ["text"] },
        "kimi-k2.7-code": { "input": ["text", "image"] }
      }
    }
  }
}
```

## Turning helpers off

Leave `enabled` unset or set it to `false`. The fields are documented in [Configuration](/frog-progsy/reference/configuration/#capability-fallback-fields).
