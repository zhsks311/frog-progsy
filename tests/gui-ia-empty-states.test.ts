import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("GUI IA and empty states", () => {
  test("Home setup checklist appears only while setup is incomplete", () => {
    const home = read("gui/src/pages/Home.tsx");
    const en = read("gui/src/i18n/en.ts");
    const ko = read("gui/src/i18n/ko.ts");
    const zh = read("gui/src/i18n/zh.ts");

    expect(home).toContain('const setupIncomplete = status.tone !== "ok"');
    expect(home).toContain("{setupIncomplete && (");
    expect(home).toContain("home.setupChecklistTitle");
    expect(home).toContain("home.setupProxy");
    expect(home).toContain("home.setupAccount");
    expect(home).toContain("home.setupModels");
    for (const source of [en, ko, zh]) {
      expect(source).toContain("home.setupChecklistTitle");
      expect(source).toContain("home.setupChecklistBadge");
      expect(source).toContain("home.setupDone");
    }
  });

  test("Home no longer shows advanced warning affordance when healthy", () => {
    const home = read("gui/src/pages/Home.tsx");

    expect(home).not.toContain('<IconAlert style={{ width: 18, height: 18, color: "var(--amber)" }} /></div>');
    expect(home).toContain('status.tone !== "ok" && <IconAlert');
    expect(home).toContain("home.advancedHintProblem");
    expect(home).toContain("home.claudeConnected");
  });

  test("empty-account CTA routes to Accounts-owned add-provider modal", () => {
    const home = read("gui/src/pages/Home.tsx");
    const providers = read("gui/src/pages/Providers.tsx");
    const navigation = read("gui/src/navigation.ts");

    expect(navigation).toContain('"account-add-provider"');
    expect(home).toContain('providers.length === 0');
    expect(home).toContain('navigate("accounts", "account-add-provider")');
    expect(home).toContain('providers.length === 0 ? "account-add-provider" : "account-login"');
    expect(home).not.toContain("frogp init");
    expect(home).toContain("home.connectAccount");
    expect(providers).toContain('target === "account-add-provider"');
    expect(providers).toContain("setAdding(true)");
    expect(providers).toContain("<AddProviderModal");
    for (const source of [read("gui/src/i18n/en.ts"), read("gui/src/i18n/ko.ts"), read("gui/src/i18n/zh.ts")]) {
      expect(source).toContain("home.connectAccount");
    }
  });

  test("Activity range selection bounds the heatmap window", () => {
    const usage = read("gui/src/pages/Usage.tsx");

    expect(usage).toContain("function buildHeatmap(days: UsageDay[], monthNames: string[], range: Range)");
    expect(usage).toContain('if (range === "all" && days.length > 0)');
    expect(usage).toContain('const spanDays = range === "7d" ? 6 : 29');
    expect(usage).toContain("buildHeatmap(data?.days ?? []");
    expect(usage).toContain(", range), [data?.days, range, t]");
  });

  test("Logs empty state has actions and can navigate from Details", () => {
    const logs = read("gui/src/pages/Logs.tsx");
    const details = read("gui/src/pages/DeveloperDetails.tsx");
    const app = read("gui/src/App.tsx");
    const en = read("gui/src/i18n/en.ts");
    const ko = read("gui/src/i18n/ko.ts");
    const zh = read("gui/src/i18n/zh.ts");

    expect(logs).toContain("logs.emptyTitle");
    expect(logs).toContain("logs.emptyOpenModels");
    expect(logs).toContain("logs.emptyRefresh");
    expect(logs).toContain('navigate("models", "model-refresh")');
    expect(details).toContain("<Logs apiBase={apiBase} embedded navigate={navigate} />");
    expect(app).toContain("<DeveloperDetails apiBase={API_BASE} target={target} navigate={navigate} />");
    for (const source of [en, ko, zh]) {
      expect(source).toContain("logs.emptyTitle");
      expect(source).toContain("logs.emptyOpenModels");
      expect(source).toContain("logs.emptyRefresh");
    }
  });
});
