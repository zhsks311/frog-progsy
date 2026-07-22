import type { FrogInputModality, FrogModelCapabilities, FrogProviderConfig } from "./types";
import { getJawcodeModelMetadata, getJawcodeModelMetadataCaseInsensitive, resolveJawcodeProvider } from "./generated/jawcode-model-metadata";
import { shouldCaseFoldMetadataModelId } from "./providers/derive";
import { getStaleCached } from "./model-cache";

export type CapabilitySource = "config" | "live" | "metadata" | "unknown";

export interface ResolvedModelCapabilities {
  input?: FrogInputModality[];
  inputSource: CapabilitySource;
  imageFallback?: FrogModelCapabilities["imageFallback"];
  imageFallbackSource: CapabilitySource;
  webSearch?: FrogModelCapabilities["webSearch"];
  webSearchSource: CapabilitySource;
}

export function modelRecordValue<T>(record: Record<string, T> | undefined, modelId: string): T | undefined {
  if (!record) return undefined;
  if (Object.prototype.hasOwnProperty.call(record, modelId)) return record[modelId];
  const colon = modelId.indexOf(":");
  if (colon > 0) {
    const family = modelId.slice(0, colon);
    if (Object.prototype.hasOwnProperty.call(record, family)) return record[family];
  }
  return undefined;
}

function normalizeInputModalities(input: readonly string[] | undefined): FrogInputModality[] | undefined {
  if (!input) return undefined;
  const out = input.filter((value): value is FrogInputModality => value === "text" || value === "image");
  return out.length > 0 ? [...new Set(out)] : undefined;
}

function cachedInputFor(providerName: string, modelId: string): FrogInputModality[] | undefined {
  const models = getStaleCached(providerName);
  if (!models) return undefined;
  const direct = models.find(model => model.id === modelId);
  const colon = modelId.indexOf(":");
  const family = colon > 0 ? models.find(model => model.id === modelId.slice(0, colon)) : undefined;
  return normalizeInputModalities((direct ?? family)?.inputModalities);
}

function metadataFor(providerName: string, modelId: string): FrogInputModality[] | undefined {
  const metadataProvider = resolveJawcodeProvider(providerName) ?? providerName;
  const metadata = getJawcodeModelMetadata(metadataProvider, modelId)
    ?? (shouldCaseFoldMetadataModelId(providerName) ? getJawcodeModelMetadataCaseInsensitive(metadataProvider, modelId) : undefined);
  return metadata?.input;
}

export function resolveModelCapabilities(
  providerName: string,
  provider: FrogProviderConfig,
  modelId: string,
): ResolvedModelCapabilities {
  const configured = modelRecordValue(provider.modelCapabilities, modelId);
  const configuredInput = normalizeInputModalities(configured?.input);
  const configuredWebSearch = typeof configured?.webSearch === "boolean" ? configured.webSearch : undefined;
  const configuredWebSearchSource: CapabilitySource = configuredWebSearch === undefined ? "unknown" : "config";
  if (configuredInput) {
    return {
      input: configuredInput,
      inputSource: "config",
      imageFallback: configured?.imageFallback,
      imageFallbackSource: configured?.imageFallback ? "config" : "unknown",
      webSearch: configuredWebSearch,
      webSearchSource: configuredWebSearchSource,
    };
  }
  const liveInput = cachedInputFor(providerName, modelId);
  if (liveInput) {
    return {
      input: liveInput,
      inputSource: "live",
      imageFallback: configured?.imageFallback,
      imageFallbackSource: configured?.imageFallback ? "config" : "unknown",
      webSearch: configuredWebSearch,
      webSearchSource: configuredWebSearchSource,
    };
  }
  const metadataInput = metadataFor(providerName, modelId);
  return {
    ...(metadataInput ? { input: [...metadataInput] } : {}),
    inputSource: metadataInput ? "metadata" : "unknown",
    imageFallback: configured?.imageFallback,
    imageFallbackSource: configured?.imageFallback ? "config" : "unknown",
    webSearch: configuredWebSearch,
    webSearchSource: configuredWebSearchSource,
  };
}

export function supportsImageInput(capabilities: ResolvedModelCapabilities): boolean | undefined {
  if (!capabilities.input) return undefined;
  return capabilities.input.includes("image");
}
export function supportsNativeWebSearch(capabilities: ResolvedModelCapabilities): boolean | undefined {
  return capabilities.webSearch;
}
