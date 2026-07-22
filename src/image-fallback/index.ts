import type { FrogConfig, FrogContentPart, FrogMessage, FrogParsedRequest, FrogProviderConfig, FrogTextContent } from "../types";
import { resolveModelCapabilities, supportsImageInput } from "../model-capabilities";
import { isOpenAIResponsesFallbackProvider } from "../fallback-openai-responses";
import { describeImage, type VisionSettings } from "./describe";

export { describeImage } from "./describe";

const DEFAULT_VISION_MODEL = "gpt-5.4-mini";
const DEFAULT_TIMEOUT_MS = 45_000;
/** Max images described in parallel — keeps first-token latency bounded without flooding the backend. */
const VISION_CONCURRENCY = 3;
/** Per-image description hard cap (chars) so multi-image turns can't blow the main model's context. */
const DESC_MAX_CHARS = 2000;
/** User-text context passed to the describer, capped. */
const CONTEXT_MAX_CHARS = 800;

function hasUsableForwardAuthorization(headers: Headers): boolean {
  const value = headers.get("authorization")?.trim();
  return !!value && value !== "local-frogprogsy" && !/^Bearer\s+local-frogprogsy$/i.test(value);
}

/** Run `worker` over `items` with bounded concurrency, preserving input order in the result array. */
async function runBounded<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runner = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[description truncated]`;
}

/** Configured OpenAI Responses helper provider — forward-auth, OAuth, or API-key backed. */
function findForwardProviderEntry(config: FrogConfig, preferredName?: string): { name: string; provider: FrogProviderConfig } | undefined {
  if (preferredName && isOpenAIResponsesFallbackProvider(config.providers[preferredName])) {
    return { name: preferredName, provider: config.providers[preferredName] };
  }
  for (const [name, prov] of Object.entries(config.providers)) {
    if (isOpenAIResponsesFallbackProvider(prov)) return { name, provider: prov };
  }
  return undefined;
}

/** A user/developer/toolResult message can carry images (toolResult: e.g. Claude Code view_image output). */
function carriesImages(role: string): boolean {
  return role === "user" || role === "developer" || role === "toolResult";
}

function messagesHaveImage(parsed: FrogParsedRequest): boolean {
  return parsed.context.messages.some(m =>
    carriesImages(m.role) && Array.isArray(m.content) && (m.content as FrogContentPart[]).some(p => p.type === "image"));
}

function textOnlyMessage(qualifiedModel: string, source: string, explicitReject: boolean): string {
  const reason = explicitReject
    ? "its modelCapabilities.imageFallback policy is \"reject\""
    : "imageFallback.enabled is false";
  return `Image input rejected: model "${qualifiedModel}" is configured as text-only (${source}) and ${reason}. Choose a model whose modelCapabilities.input includes "image", or enable Dashboard → Image fallback with an OpenAI Responses forward/OAuth/key provider.`;
}

export type ImageFallbackDecision =
  | { action: "none" }
  | { action: "reject"; message: string; code: "text_only_model" | "fallback_unavailable" }
  | { action: "describe"; forwardProvider: FrogProviderConfig; forwardProviderName: string; settings: VisionSettings };

export function decideImageFallback(
  config: FrogConfig,
  providerName: string,
  provider: FrogProviderConfig,
  modelId: string,
  parsed: FrogParsedRequest,
  incomingHeaders: Headers,
): ImageFallbackDecision {
  if (!messagesHaveImage(parsed)) return { action: "none" };

  const capabilities = resolveModelCapabilities(providerName, provider, modelId);
  const imageSupport = supportsImageInput(capabilities);
  if (imageSupport !== false) return { action: "none" };

  const qualifiedModel = `${providerName}/${modelId}`;
  const cfg = config.imageFallback ?? {};
  if (cfg.enabled !== true || capabilities.imageFallback === "reject") {
    return {
      action: "reject",
      code: "text_only_model",
      message: textOnlyMessage(qualifiedModel, `capability source: ${capabilities.inputSource}, input: ${JSON.stringify(capabilities.input)}`, capabilities.imageFallback === "reject"),
    };
  }

  const forwardProviderEntry = findForwardProviderEntry(config, cfg.provider);
  if (!forwardProviderEntry) {
    return {
      action: "reject",
      code: "fallback_unavailable",
      message: `Image fallback unavailable for text-only model "${qualifiedModel}": no OpenAI Responses forward/OAuth/key provider is configured${cfg.provider ? ` for "${cfg.provider}"` : ""}. Add one in Providers or choose a vision-capable model.`,
    };
  }
  if (forwardProviderEntry.provider.authMode === "forward" && !hasUsableForwardAuthorization(incomingHeaders)) {
    return {
      action: "reject",
      code: "fallback_unavailable",
      message: `Image fallback unavailable for text-only model "${qualifiedModel}": the request does not include usable forwarded OpenAI/ChatGPT authorization. Choose a vision-capable model, configure an OpenAI Responses OAuth/key provider, or call through a client/session that forwards compatible credentials.`,
    };
  }

  return {
    action: "describe",
    forwardProvider: forwardProviderEntry.provider,
    forwardProviderName: forwardProviderEntry.name,
    settings: { model: cfg.model ?? DEFAULT_VISION_MODEL, timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  };
}

interface ImageJob {
  imageUrl: string;
  detail?: string;
  contextText: string;
}

/** Render one describe outcome as the replacement text part (clamped to the per-image budget). */
function renderDescription(out: { text: string; error?: string }): FrogTextContent {
  return {
    type: "text",
    text: out.error
      ? `[An image was attached but could not be processed: ${out.error}]`
      : `[Image content — described by a vision model because you cannot see images directly:\n${clamp(out.text.trim(), DESC_MAX_CHARS)}]`,
  };
}

/**
 * Replace every image part in the request with a gpt-described text part, so a text-only model can
 * reason about it. Mutates `parsed.context.messages` in place; uses the message's own text as the
 * description context. All images are described with bounded concurrency (not serially) so a
 * multi-image turn doesn't pay the sum of per-image latencies. Failures degrade to a short marker.
 */
export async function describeImagesInPlace(
  parsed: FrogParsedRequest,
  forwardProvider: FrogProviderConfig,
  forwardProviderName: string | undefined,
  incomingHeaders: Headers,
  settings: VisionSettings,
  abortSignal?: AbortSignal,
): Promise<void> {
  // 1. Gather every image part across messages, each with its own message's text as context.
  const jobs: ImageJob[] = [];
  const targets: { msg: FrogMessage; parts: FrogContentPart[] }[] = [];
  for (const msg of parsed.context.messages) {
    if (!carriesImages(msg.role) || !Array.isArray(msg.content)) continue;
    const parts = msg.content as FrogContentPart[];
    if (!parts.some(p => p.type === "image")) continue;
    const contextText = parts
      .filter((p): p is FrogTextContent => p.type === "text")
      .map(p => p.text)
      .join(" ")
      .slice(0, CONTEXT_MAX_CHARS);
    for (const p of parts) {
      if (p.type === "image") jobs.push({ imageUrl: p.imageUrl, detail: p.detail, contextText });
    }
    targets.push({ msg, parts });
  }
  if (jobs.length === 0) return;

  // 2. Describe all images with bounded concurrency (order preserved).
  const outcomes = await runBounded(jobs, VISION_CONCURRENCY, j =>
    describeImage(j.imageUrl, j.detail, j.contextText, forwardProvider, forwardProviderName, incomingHeaders, settings, abortSignal));

  // 3. Rebuild each message, replacing image parts with their descriptions in order.
  let oi = 0;
  for (const { msg, parts } of targets) {
    const newParts: FrogContentPart[] = [];
    for (const p of parts) newParts.push(p.type === "image" ? renderDescription(outcomes[oi++]) : p);
    msg.content = newParts;
  }
}
