import { resolveEnvValue } from "./config";
import type { FrogConfig, FrogProviderConfig } from "./types";

const REDACTED = "[REDACTED]";
const REDACTED_URL = "[REDACTED_URL]";

export interface ProviderTestErrorNormalizationContext {
  provider?: FrogProviderConfig;
  secrets?: string[];
  httpStatus?: number;
}

export interface NormalizedProviderTestError {
  code: string;
  message: string;
  httpStatus?: number;
}

export function maskSecretForDisplay(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value.length <= 8) return "...";
  return `${value.slice(0, 3)}...${value.slice(-4)}`;
}

function collectValueSecret(value: string | undefined, secrets: Set<string>): void {
  if (!value) return;
  secrets.add(value);
  const resolved = resolveEnvValue(value);
  if (resolved) secrets.add(resolved);
}

export function collectProviderSecrets(provider: FrogProviderConfig | undefined, extraSecrets: string[] = []): string[] {
  const secrets = new Set<string>();
  for (const secret of extraSecrets) collectValueSecret(secret, secrets);
  if (!provider) return [...secrets].filter(Boolean);

  collectValueSecret(provider.apiKey, secrets);
  for (const key of provider.apiKeys ?? []) collectValueSecret(key, secrets);
  for (const value of Object.values(provider.headers ?? {})) collectValueSecret(value, secrets);
  return [...secrets].filter(Boolean);
}

function maskConfiguredSecret(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return maskSecretForDisplay(resolveEnvValue(value) ?? value) ?? "";
}

function redactHeadersForApi(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, maskConfiguredSecret(value) ?? ""]));
}

export function redactProviderForApi(provider: FrogProviderConfig): FrogProviderConfig {
  return {
    ...provider,
    ...(provider.apiKey !== undefined ? { apiKey: maskConfiguredSecret(provider.apiKey) } : {}),
    ...(provider.apiKeys !== undefined ? { apiKeys: provider.apiKeys.map(key => maskConfiguredSecret(key) ?? "") } : {}),
    ...(provider.headers !== undefined ? { headers: redactHeadersForApi(provider.headers) } : {}),
  };
}

export function redactConfigForApi(config: FrogConfig): Record<string, unknown> {
  return {
    ...config,
    providers: Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => [name, {
      ...redactProviderForApi(provider),
      hasApiKey: !!resolveEnvValue(provider.apiKey) || (provider.apiKeys ?? []).some(key => !!resolveEnvValue(key)),
    }])),
    ...(config.localAccess ? {
      localAccess: {
        ...config.localAccess,
        ...(config.localAccess.keys ? {
          keys: config.localAccess.keys.map(key => ({
            ...key,
            secretHash: REDACTED,
          })),
        } : {}),
      },
    } : {}),
    ...(config.webSearchFallback?.searchProviders ? {
      webSearchFallback: {
        ...config.webSearchFallback,
        searchProviders: Object.fromEntries(Object.entries(config.webSearchFallback.searchProviders).map(([name, provider]) => [name, {
          ...provider,
          apiKey: undefined,
          hasApiKey: !!resolveEnvValue(provider.apiKey),
          baseUrl: undefined,
          hasBaseUrl: !!provider.baseUrl,
        }])),
      },
    } : {}),
    ...(config.claudeGrants ? {
      claudeGrants: {
        schemaVersion: config.claudeGrants.schemaVersion,
        // Allowlist non-secret grant metadata only; never spread the raw record (drops configDir
        // absolute path plus any credential/service/token/refresh/marker fields).
        grants: config.claudeGrants.grants.map(grant => ({
          id: grant.id,
          label: grant.label,
          createdAt: grant.createdAt,
        })),
      },
    } : {}),
  };
}

function redactUrls(message: string): string {
  return message.replace(/https?:\/\/[^\s"'<>`]+/gi, REDACTED_URL);
}

function redactRequestDumps(message: string): string {
  return message.replace(
    /\b(url|headers?|body)\s*[:=]\s*(\{[^}]*\}|\[[^\]]*\]|"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    (_match, label: string) => `${label}: ${REDACTED}`,
  );
}

function normalizeThrowableMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Provider connection test failed";
}

function normalizeThrowableCode(error: unknown, httpStatus: number | undefined): string {
  if (httpStatus !== undefined) return "http_error";
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && /timeout|aborted|abort/i.test(error.name)) return "timeout";
  if (error instanceof Error && /timeout|aborted|abort/i.test(error.message)) return "timeout";
  if (error instanceof TypeError) return "network_error";
  return "provider_test_error";
}

export function redactDiagnosticMessage(message: string, secrets: string[]): string {
  let redacted = message;
  const uniqueSecrets = [...new Set(secrets.filter(secret => secret.length > 0))]
    .sort((a, b) => b.length - a.length);
  for (const secret of uniqueSecrets) {
    redacted = redacted.split(secret).join(REDACTED);
  }
  return redacted;
}

export function normalizeProviderTestError(
  error: unknown,
  context: ProviderTestErrorNormalizationContext = {},
): NormalizedProviderTestError {
  const secrets = collectProviderSecrets(context.provider, context.secrets ?? []);
  const rawMessage = normalizeThrowableMessage(error);
  const message = redactRequestDumps(redactUrls(redactDiagnosticMessage(rawMessage, secrets))) || "Provider connection test failed";
  return {
    code: normalizeThrowableCode(error, context.httpStatus),
    message,
    ...(context.httpStatus !== undefined ? { httpStatus: context.httpStatus } : {}),
  };
}
