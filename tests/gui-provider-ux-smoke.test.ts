import { describe, expect, test } from "bun:test";
import React from "../gui/node_modules/react/index.js";
import { renderToStaticMarkup } from "../gui/node_modules/react-dom/server.bun.js";
import { parseExtraApiKeys, sanitizeVisibleText } from "../gui/src/components/AddProviderModal";
import { parseConfig, ProviderMetadataList, AnthropicAuthEditor } from "../gui/src/pages/Providers";
import {
  ClaudeGrantsCard,
  parseGrants,
  grantStateChip,
  grantUsable,
  grantReauthCommand,
  isVerifiedRealClaudePath,
  realClaudeReady,
  grantErrorText,
  type ClaudeGrantSummary,
} from "../gui/src/pages/ClaudeProfiles";
import { en } from "../gui/src/i18n/en";

function t(key: keyof typeof en, vars?: Record<string, string | number>): string {
  let value = en[key];
  for (const [name, replacement] of Object.entries(vars ?? {})) value = value.split(`{${name}}`).join(String(replacement));
  return value;
}

describe("G004 GUI provider UX smoke", () => {
  test("mock rendered provider status shows normalized metadata without raw secrets", () => {
    const rawSecrets = ["sk-live-secret-1111", "sk-second-secret-2222"];
    const parsed = parseConfig({
      port: 19999,
      defaultProvider: "primary",
      providers: {
        primary: {
          adapter: "openai-chat",
          baseUrl: "https://primary.example/v1",
          defaultModel: "primary-model",
          authMode: "key",
          hasApiKey: true,
          apiKeyCount: 2,
          balanceSupported: false,
          apiKey: rawSecrets[0],
          apiKeys: [rawSecrets[1]],
        },
      },
    });
    const provider = parsed.providers.primary!;
    const safeMessage = sanitizeVisibleText(
      `Connected via ${rawSecrets[0]} and ${rawSecrets[1]}`,
      rawSecrets,
      "Connected",
    );

    const markup = renderToStaticMarkup(
      React.createElement("section", { "data-testid": "provider-card" },
        React.createElement("h2", null, "primary"),
        React.createElement(ProviderMetadataList, {
          provider,
          testResult: { status: "ok", message: safeMessage, modelCount: 3 },
          t,
        }),
      ),
    );

    expect(parseExtraApiKeys(`${rawSecrets[1]}\n sk-third-secret-3333,sk-fourth-secret-4444`)).toEqual([
      rawSecrets[1],
      "sk-third-secret-3333",
      "sk-fourth-secret-4444",
    ]);
    expect(sanitizeVisibleText("overlap sk-secret-long sk-secret", ["sk-secret", "sk-secret-long"], "fallback")).toBe("overlap [redacted] [redacted]");
    expect(markup).toContain("primary");
    expect(markup).toContain("API keys");
    expect(markup).toContain(">2<");
    expect(markup).toContain("Balance support");
    expect(markup).toContain("not supported");
    expect(markup).toContain("Connected via [redacted] and [redacted] · 3 models");
    for (const secret of rawSecrets) expect(markup).not.toContain(secret);
  });
});

const SAMPLE_GRANTS: ClaudeGrantSummary[] = [
  { id: "cg_ready01", label: "work-subscription", state: "ok", boundProviders: ["anthropic"], realClaudeReady: true, reauthCommand: `CLAUDE_CONFIG_DIR="$HOME/.frogprogsy/claude-grants/cg_ready01" "$HOME/.local/bin/claude" auth login --claudeai` },
  { id: "cg_reauth9", label: "personal", state: "reauth_required", boundProviders: [], realClaudeReady: true, reauthCommand: `CLAUDE_CONFIG_DIR="$HOME/.frogprogsy/claude-grants/cg_reauth9" "$HOME/.local/bin/claude" auth login --claudeai` },
  { id: "cg_new0000", label: "spare", state: "none", boundProviders: [], realClaudeReady: true, statusError: "status_unavailable", reauthCommand: `CLAUDE_CONFIG_DIR="$HOME/.frogprogsy/claude-grants/cg_new0000" "$HOME/.local/bin/claude" auth login --claudeai` },
];

describe("Branch B Claude grant pure helpers", () => {
  test("parseGrants keeps the contract shape and fails closed on bad state", () => {
    const parsed = parseGrants({
      grants: [
        { id: "cg_a", label: "A", state: "ok", boundProviders: ["anthropic"], realClaudeReady: true, expiresAt: "2026-08-01T00:00:00Z" },
        { id: "cg_c", label: "C", state: "expiring", boundProviders: [], realClaudeReady: true, expiresAt: 1800000000 },
        { id: "cg_b", label: "B", state: "totally-bogus", boundProviders: "nope", realClaudeReady: "yes" },
        { id: 5, label: "no id" },
        "junk",
      ],
      realClaude: { ready: true, name: "claude" },
    });
    expect(parsed.grants).toHaveLength(3);
    expect(parsed.grants[0]).toMatchObject({ id: "cg_a", state: "ok", boundProviders: ["anthropic"], realClaudeReady: true, expiresAt: "2026-08-01T00:00:00Z" });
    // numeric epoch (seconds) expiry is normalized to a safe ISO display string
    expect(parsed.grants[1]).toMatchObject({ id: "cg_c", state: "expiring", expiresAt: new Date(1800000000 * 1000).toISOString() });
    // unknown state fails closed to "unreadable"; non-array boundProviders → []; non-true readiness → false
    expect(parsed.grants[2]).toMatchObject({ id: "cg_b", state: "unreadable", boundProviders: [], realClaudeReady: false });
    // a bare basename "claude" is not a verified path, so it is dropped and treated as not-ready
    expect(parsed.realClaude).toEqual({ ready: true });
  });

  test("state chips and usability follow readiness", () => {
    expect(grantStateChip("ok").label).toBe("Ready");
    expect(grantStateChip("expiring").label).toBe("Expiring soon");
    expect(grantStateChip("reauth_required").label).toBe("Re-auth required");
    expect(grantStateChip("none").cls).toBe("badge-muted");
    expect(grantUsable({ id: "x", label: "x", state: "ok", boundProviders: [], realClaudeReady: true })).toBe(true);
    expect(grantUsable({ id: "x", label: "x", state: "ok", boundProviders: [], realClaudeReady: false })).toBe(false);
    expect(grantUsable({ id: "x", label: "x", state: "reauth_required", boundProviders: [], realClaudeReady: true })).toBe(false);
  });

  test("re-auth command is consumed verbatim from the server and never rebuilt client-side", () => {
    // The server owns the $HOME-tokenized command (built by grantSetup); parseGrants surfaces it
    // as-is — even a NON-default FROGPROGSY_HOME path the old client fabrication ($HOME/.frogprogsy)
    // could never have produced.
    const serverCmd = `CLAUDE_CONFIG_DIR="$HOME/.frogprogsy-custom/claude-grants/cg_ready01" "$HOME/.local/bin/claude" auth login --claudeai`;
    const parsed = parseGrants({
      grants: [{ id: "cg_ready01", label: "work", state: "reauth_required", boundProviders: [], realClaudeReady: true, reauthCommand: serverCmd }],
      realClaude: { ready: true, name: "$HOME/.local/bin/claude" },
    });
    // The GUI keeps the exact server string; it never reconstructs the default-home path.
    expect(parsed.grants[0].reauthCommand).toBe(serverCmd);
    expect(grantReauthCommand(parsed.grants[0])).toBe(serverCmd);
    expect(grantReauthCommand(parsed.grants[0])).not.toContain(".frogprogsy/claude-grants");
    expect(grantReauthCommand(parsed.grants[0])).not.toContain("/Users/");
    // No server command → the GUI offers nothing (it cannot invent a scoped config path).
    expect(grantReauthCommand({ id: "cg_x", label: "x", state: "ok", boundProviders: [], realClaudeReady: true })).toBe("");
    // A non-string server value is rejected (fail-closed), never coerced into a fabricated path.
    expect(parseGrants({ grants: [{ id: "cg_y", label: "y", state: "ok", boundProviders: [], realClaudeReady: true, reauthCommand: 42 }] }).grants[0].reauthCommand).toBeUndefined();

    // The card renders the re-auth affordance only when the server supplied the command.
    const cardProps = { t, realClaude: parsed.realClaude, loadFailed: false, busy: false, onSetup: async () => null, onRemove: () => undefined };
    const withCmd = renderToStaticMarkup(React.createElement(ClaudeGrantsCard, { ...cardProps, grants: parsed.grants }));
    expect(withCmd).toContain("Re-auth guide");
    const withoutCmd = renderToStaticMarkup(React.createElement(ClaudeGrantsCard, { ...cardProps, grants: parsed.grants.map(g => ({ ...g, reauthCommand: undefined })) }));
    expect(withoutCmd).not.toContain("Re-auth guide");
  });

  test("verified-path / readiness / error helpers fail closed", () => {
    expect(isVerifiedRealClaudePath("$HOME/.local/bin/claude")).toBe(true);
    expect(isVerifiedRealClaudePath("/usr/local/bin/claude")).toBe(true);
    expect(isVerifiedRealClaudePath("claude")).toBe(false);
    expect(isVerifiedRealClaudePath(undefined)).toBe(false);
    expect(realClaudeReady({ ready: true, name: "$HOME/.local/bin/claude" })).toBe(true);
    expect(realClaudeReady({ ready: true, name: "claude" })).toBe(false);
    expect(realClaudeReady({ ready: false, name: "$HOME/.local/bin/claude" })).toBe(false);
    // object errors render message + code safely; strings pass through; unknown shapes fall back
    expect(grantErrorText({ code: "grant_bound", message: "grant is bound" }, "fallback")).toBe("grant is bound (grant_bound)");
    expect(grantErrorText("plain error", "fallback")).toBe("plain error");
    expect(grantErrorText({ nope: 1 }, "fallback")).toBe("fallback");
  });
});

describe("Claude Grants card (readiness-first, no secrets)", () => {
  const render = (props: Partial<Parameters<typeof ClaudeGrantsCard>[0]> = {}) =>
    renderToStaticMarkup(
      React.createElement(ClaudeGrantsCard, {
        t,
        grants: SAMPLE_GRANTS,
        realClaude: { ready: true, name: "$HOME/.local/bin/claude" },
        loadFailed: false,
        busy: false,
        onSetup: async () => null,
        onRemove: () => undefined,
        ...props,
      }),
    );

  test("leads with bindings/usability and hides diagnostics behind a disclosure", () => {
    const markup = render();
    expect(markup).toContain("Claude Grants");
    // readiness-first: bound providers and usability lead the default view
    expect(markup).toContain("Bound providers");
    expect(markup).toContain("work-subscription");
    expect(markup).toContain("Ready");
    expect(markup).toContain("Usable now");
    expect(markup).toContain("anthropic");
    // verified real Claude → ready badge and a guided re-auth affordance
    expect(markup).toContain("Real Claude ready");
    expect(markup).toContain("Re-auth guide");
    // state chips for every state present in the sample
    expect(markup).toContain("Re-auth required");
    expect(markup).toContain("Not set up");
    // Set up (create) affordance with a plain label field (not a secret)
    expect(markup).toContain("Set up grant");
    expect(markup).toContain("New grant label");
    // ToS / account risk and the API-key alternative are stated
    expect(markup).toContain("Terms-of-Service");
    expect(markup).toContain("API-key");
    // Advanced diagnostics disclosure carries redacted metadata + doctor pointer
    expect(markup).toContain("<details");
    expect(markup).toContain("Advanced diagnostics");
    expect(markup).toContain("frogp doctor claude");
    // absolutely no secret input fields and no leaked absolute home paths
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain("/Users/");
    expect(markup).not.toContain("credentials.json");
  });

  test("real-Claude-not-ready and load-failure states are fail-closed", () => {
    const notReady = render({ realClaude: { ready: false, name: "$HOME/.local/bin/claude" } });
    expect(notReady).toContain("Real Claude not verified");
    expect(notReady).toContain("needs a verified real Claude executable");
    // a bare basename is not a verified path → not ready and no re-auth command is offered
    const bareReady = render({ realClaude: { ready: true, name: "claude" } });
    expect(bareReady).toContain("Real Claude not verified");
    expect(bareReady).not.toContain("Re-auth guide");

    const failed = render({ loadFailed: true, grants: [], realClaude: undefined });
    expect(failed).toContain("Claude grants are unavailable");
    // fail-closed: no grant rows or diagnostics rendered when the API failed
    expect(failed).not.toContain("Advanced diagnostics");
  });
});

describe("Anthropic auth selector (Forward / API key / Claude grant)", () => {
  const render = (provider: { authMode?: string; claudeGrantId?: string }, extra: { grants?: ClaudeGrantSummary[]; grantsFailed?: boolean } = {}) =>
    renderToStaticMarkup(
      React.createElement(AnthropicAuthEditor, {
        t,
        name: "anthropic",
        provider,
        grants: extra.grants ?? SAMPLE_GRANTS,
        grantsFailed: extra.grantsFailed ?? false,
        busy: false,
        onSave: () => undefined,
      }),
    );

  test("offers all three modes and never renders a secret field", () => {
    const markup = render({ authMode: "forward" });
    expect(markup).toContain("Forward (default)");
    expect(markup).toContain("API key");
    expect(markup).toContain("Claude grant");
    // forward copy preserves the zero-custody meaning
    expect(markup).toContain("stores no Claude token");
    expect(markup).not.toContain('type="password"');
  });

  test("claude-grant mode shows the grant picker, binding and unready warning", () => {
    const markup = render({ authMode: "claude-grant", claudeGrantId: "cg_reauth9" });
    // grant picker lists selectable grants
    expect(markup).toContain("Select a grant");
    expect(markup).toContain("work-subscription");
    // bound-grant readiness surfaced and unready grant warned before save
    expect(markup).toContain("Bound grant");
    expect(markup).toContain("is not ready");
    // grant auth routes through Anthropic's official endpoint
    expect(markup).toContain("api.anthropic.com");
    expect(markup).not.toContain('type="password"');
  });

  test("grant auth surfaces the official Anthropic endpoint and server status errors", () => {
    const markup = render({ authMode: "claude-grant", claudeGrantId: "cg_new0000" });
    // grant auth routes through Anthropic's official endpoint (no third-party endpoint)
    expect(markup).toContain("api.anthropic.com");
    // server-reported status error for the bound/selected grant is shown, redacted-safe
    expect(markup).toContain("Anthropic reported a problem verifying this grant");
    expect(markup).toContain("status_unavailable");
    expect(markup).not.toContain('type="password"');
  });

  test("dangling binding to an unknown grant is warned", () => {
    const markup = render({ authMode: "claude-grant", claudeGrantId: "cg_missing" });
    expect(markup).toContain("dangling");
  });

  test("grant API failure disables verification without breaking the row", () => {
    const markup = render({ authMode: "claude-grant", claudeGrantId: "cg_ready01" }, { grants: [], grantsFailed: true });
    expect(markup).toContain("Claude grants are unavailable");
  });
});
