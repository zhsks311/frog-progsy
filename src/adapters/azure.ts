import type { ProviderAdapter } from "./base";
import type { FrogParsedRequest, FrogProviderConfig } from "../types";
import { createResponsesAdapter } from "./openai-responses";

export function createAzureAdapter(provider: FrogProviderConfig): ProviderAdapter & { nativeRelay: true } {
  const inner = createResponsesAdapter({
    ...provider,
    baseUrl: provider.baseUrl,
  });

  return {
    ...inner,
    name: "azure-openai",

    buildRequest(parsed: FrogParsedRequest) {
      const request = inner.buildRequest(parsed);
      const headers = { ...request.headers };
      if (provider.apiKey) {
        headers["api-key"] = provider.apiKey;
        delete headers["Authorization"];
      }
      let url = request.url;
      if (!url.includes("/v1/")) {
        const apiVersion = (provider.headers?.["api-version"]) ?? "2025-04-01-preview";
        const separator = url.includes("?") ? "&" : "?";
        url = `${url}${separator}api-version=${apiVersion}`;
      }
      return { ...request, url, headers };
    },
  };
}
