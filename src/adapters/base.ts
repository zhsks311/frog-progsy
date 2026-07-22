import type { AdapterEvent, FrogParsedRequest } from "../types";

/** Metadata about the caller's incoming request, for auth-forwarding adapters. */
export interface IncomingMeta {
  headers: Headers;
}

export interface ProviderAdapter {
  name: string;

  buildRequest(parsed: FrogParsedRequest, incoming?: IncomingMeta): {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  };

  /**
   * True only for adapters whose upstream response can use native relay on a same-wire inbound route.
   * This is not an auth mode and not a claim that Claude Code's Anthropic Messages request is sent
   * upstream unchanged. The normal Claude Code /v1/messages path always parses into FrogParsedRequest
   * first, then each adapter builds its own upstream wire body.
   */
  nativeRelay?: true;

  parseStream(response: Response): AsyncGenerator<AdapterEvent>;
  parseResponse?(response: Response): Promise<AdapterEvent[]>;
}
