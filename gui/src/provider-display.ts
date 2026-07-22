export interface ProviderDisplayInfo {
  name: string;
  adapter: string;
  baseUrl: string;
  defaultModel?: string;
  authMode?: string;
  hasApiKey?: boolean;
}

export interface OAuthDisplayStatus {
  loggedIn?: boolean;
}

export type ProviderSetupState = "connected" | "forwardOnly" | "needsSetup";

export function providerSetupState(
  provider: ProviderDisplayInfo,
  oauthStatus?: OAuthDisplayStatus,
): ProviderSetupState {
  if (provider.authMode === "oauth") {
    return oauthStatus?.loggedIn ? "connected" : "needsSetup";
  }
  if (provider.hasApiKey) return "connected";
  if (provider.authMode === "forward") return "forwardOnly";
  return "needsSetup";
}

export function providerIsReady(
  provider: ProviderDisplayInfo,
  oauthStatus?: OAuthDisplayStatus,
): boolean {
  return providerSetupState(provider, oauthStatus) === "connected";
}

export function providerNeedsEndpointCheck(provider: Pick<ProviderDisplayInfo, "baseUrl">): boolean {
  try {
    const host = new URL(provider.baseUrl).hostname.toLowerCase();
    return host === "test" || host.endsWith(".test");
  } catch {
    return false;
  }
}
