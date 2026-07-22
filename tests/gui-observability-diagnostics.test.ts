import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("GUI observability and diagnostics", () => {
  test("Providers exposes opt-in connection test without automatic retry plumbing", () => {
    const providers = read("gui/src/pages/Providers.tsx");
    expect(providers).toContain("/api/providers/test");
    expect(providers).toContain("testProvider = async");
    expect(providers).toContain("JSON.stringify({ name })");
    expect(providers).toContain("prov.testConnection");
    expect(providers).toContain("ProviderTestCode");
    expect(providers).not.toContain("setInterval(testProvider");
    expect(providers).not.toContain("retryProviderTest");
  });

  test("Logs has row expansion plus status/provider/error filtering with redacted details", () => {
    const logs = read("gui/src/pages/Logs.tsx");
    expect(logs).toContain("statusFilter");
    expect(logs).toContain("providerFilter");
    expect(logs).toContain("errorFilter");
    expect(logs).toContain("log-filter-bar");
    expect(logs).toContain("aria-expanded={isExpanded}");
    expect(logs).toContain("detailJson(log)");
    expect(logs).toContain("logs.col.details");
    expect(logs).not.toContain("JSON.stringify(log");
    expect(logs).not.toContain("Authorization");
    expect(logs).not.toContain("apiKey");
  });
  test("server log and OAuth status management boundaries are redacted", () => {
    const server = read("src/server.ts");
    const providers = read("gui/src/pages/Providers.tsx");
    expect(server).toContain("requestLogManagementSnapshot");
    expect(server).toContain("return jsonResponse(requestLogManagementSnapshot())");
    expect(server).toContain("loggedIn: status.loggedIn === true");
    expect(server).not.toContain("return jsonResponse(status)");
    expect(providers).not.toContain("email?:");
    expect(providers).not.toContain("st.email");
    expect(server).toContain('error: "oauth_login_failed"');
    expect(server).not.toContain("error: status.error");
    expect(server).not.toContain("err.message : String(err) }, 409)");
    expect(providers).not.toContain("error: s.error");
    expect(providers).not.toContain("notify(data.error || t(\"prov.loginFailStart\"");
  });

  test("Details renders Claude status and runtime diagnostics from the redacted API", () => {
    const details = read("gui/src/pages/DeveloperDetails.tsx");
    expect(details).toContain("/api/claude-status");
    expect(details).toContain("runtimeDiagnostics");
    expect(details).toContain("externalSupervisorMode");
    expect(details).toContain("watchdog.giveUp");
    expect(details).toContain("lastMessages");
    expect(details).toContain("expectedBaseUrl");
    expect(details).toContain("authToken");
  });

  test("visible diagnostics strings stay localized across en/ko/zh", () => {
    const en = read("gui/src/i18n/en.ts");
    const ko = read("gui/src/i18n/ko.ts");
    const zh = read("gui/src/i18n/zh.ts");
    for (const key of [
      "prov.testConnection",
      "prov.testCode.providerNon2xx",
      "logs.filter.status",
      "logs.col.details",
      "dev.runtimeDiagnostics",
      "dev.externalSupervisor",
      "dev.lastMessages",
      "common.yes",
      "common.no",
      "prov.oauthLoginFailed",
    ]) {
      expect(en).toContain(`"${key}"`);
      expect(ko).toContain(`"${key}"`);
      expect(zh).toContain(`"${key}"`);
    }
  });
  test("public dashboard docs mention new diagnostics management surfaces", () => {
    const docs = [
      read("docs-site/content/docs/en/guides/web-dashboard.md"),
      read("docs-site/content/docs/ko/guides/web-dashboard.md"),
      read("docs-site/content/docs/zh-cn/guides/web-dashboard.md"),
    ].join("\n");
    expect(docs).toContain("/api/claude-status");
    expect(docs).toContain("/api/providers/test");
    expect(docs).toContain("connection test");
  });
});
