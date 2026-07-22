import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("GUI management parity", () => {
  test("provider management uses narrow APIs and never exposes stored secrets", () => {
    const providers = read("gui/src/pages/Providers.tsx");
    const addProvider = read("gui/src/components/AddProviderModal.tsx");
    const server = read("src/server.ts");

    expect(server).toContain('url.pathname === "/api/default-provider"');
    expect(server).toContain('url.pathname === "/api/provider-state"');
    expect(server).toContain("cannot remove the default provider");
    expect(server).toContain("providers: Object.fromEntries(providerSummaries()");
    expect(server).not.toContain("JSON.parse(JSON.stringify(config))");
    expect(server).not.toContain("prov.apiKey = prov.apiKey.slice");
    expect(providers).toContain("/api/default-provider");
    expect(providers).toContain("/api/provider-state");
    expect(providers).not.toContain("/api/config`, {");
    expect(providers).not.toContain("/api/config");
    expect(providers).not.toContain("setEditing");
    expect(providers).not.toContain("setDraft");
    expect(providers).not.toContain("prov.apiKey");
    expect(providers).toContain("prov.defaultBadge");
    expect(providers).toContain('{!isDefault && <button className="btn btn-danger');
    expect(providers).toContain("oauthDisplayState");
    expect(providers).toContain("accountProviderIds");
    expect(providers).toContain("displayState.connected");
    expect(providers).toContain("JSON.stringify({ provider, restart: true })");

    expect(addProvider).toContain("setDefault: boolean");
    expect(addProvider).toContain("setDefault: form.setDefault");
    expect(addProvider).toContain("modal.defaultProviderCheckbox");
  });

  test("provider modal, usage heatmap, and review terminology stay localized", () => {
    const addProvider = read("gui/src/components/AddProviderModal.tsx");
    const usage = read("gui/src/pages/Usage.tsx");
    const en = read("gui/src/i18n/en.ts");
    const ko = read("gui/src/i18n/ko.ts");
    const zh = read("gui/src/i18n/zh.ts");

    for (const literal of [
      "Connect AI account",
      "Search accounts or APIs…",
      "No matching account or API.",
      "Provider name is required",
      "Advanced forward auth only",
      "Make this the default provider",
      "Adding…",
    ]) {
      expect(addProvider).not.toContain(literal);
    }
    expect(addProvider).toContain('t("modal.title")');
    expect(addProvider).toContain('t("modal.forwardNotice")');
    expect(addProvider).not.toContain("return p.note");
    expect(addProvider).not.toContain("{preset.note");
    expect(addProvider).toContain("PRESET_NOTE_KEYS");
    expect(addProvider).toContain("modal.note.localKeyBlank");
    expect(addProvider).not.toContain("d.error");
    expect(addProvider).not.toContain("data.instructions");
    expect(addProvider).not.toContain("String(s.error)");
    expect(addProvider).toContain("selectedPresetNote && preset.dashboardUrl");

    expect(usage).not.toContain("<span>Mon</span>");
    expect(usage).not.toContain("req ·");
    expect(usage).toContain('t("usage.weekday.mon")');
    expect(usage).toContain('t("usage.heatmap.tooltip"');

    expect(en).toContain('"mix.boundaryTitle": "Separate from command approval"');
    // Auto-approval review keys keep the plain "심사/审查" naming (mixing's judge is the
    // separate "분류기/分类器" concept and may use those words in mix.* keys only).
    expect(ko).toContain('"dash.classifierTitle": "자동 승인 심사 모델"');
    expect(zh).toContain('"dash.classifierTitle": "自动批准审查模型"');
    const dashSectionKo = ko.slice(ko.indexOf('"dash.classifierTitle"'), ko.indexOf('"dash.classifierPolicyTitle"'));
    expect(dashSectionKo).not.toContain("분류기");
  });

  test("model registry keeps auth-not-ready rows with redacted login guidance", () => {
    const models = read("gui/src/pages/Models.tsx");
    const en = read("gui/src/i18n/en.ts");
    const ko = read("gui/src/i18n/ko.ts");
    const zh = read("gui/src/i18n/zh.ts");

    expect(models).toContain("authReady: row.authReady !== false");
    expect(models).toContain("!row.authReady && !featuredChosen.includes(row.namespaced)");
    expect(models).toContain("`frogp login ${row.provider}`");
    expect(models).toContain('t("models.authLoginRequired")');
    expect(models).toContain('<Trans k="models.authNotReadyMeta"');
    for (const translations of [en, ko, zh]) {
      expect(translations).toContain('"models.authLoginRequired"');
      expect(translations).toContain('"models.authNotReadyMeta"');
    }
    expect(models).toContain("else if (model.authReady) summary.visible += 1");
    expect(en).toContain("Only authentication-ready enabled models are visible");
    expect(en).toContain("authentication-required models stay excluded");
    expect(ko).toContain("인증이 준비된 켜진 모델만 Claude Code에 보이고");
    expect(ko).toContain("인증 필요 모델은 로그인할 때까지 제외됩니다");
    expect(zh).toContain("只有认证就绪的启用模型才会显示在 Claude Code 中");
    expect(zh).toContain("需要认证的模型在登录前始终被排除");
  });
  test("details fallback models come from registered fallback providers or typed value and dead dashboard stays removed", () => {
    const developer = read("gui/src/pages/DeveloperDetails.tsx");

    expect(existsSync("gui/src/pages/Dashboard.tsx")).toBe(false);
    expect(developer).not.toContain("const SIDECAR_MODELS");
    expect(developer).toContain("fallbackModelOptions");
    expect(developer).toContain("fallback.providers");
    expect(developer).toContain("<datalist id=\"fallback-model-options\">");
    expect(developer).toContain("setWebSearchModelDraft");
    expect(developer).toContain("setImageModelDraft");
    expect(developer).toContain("selectWebSearchProvider");
    expect(developer).toContain("selectImageProvider");
    expect(developer).toContain("providerList.find(provider => provider.name === providerName)?.models ?? []");
    expect(developer).not.toContain("if (currentModel) values.add(currentModel)");
    expect(developer).not.toContain("modelsForFallbackProvider(webSearchFallbackProviders, provider, fallback.webSearch.model)");
    expect(developer).not.toContain("modelsForFallbackProvider(imageFallbackProviders, provider, fallback.image.model)");
  });

  test("release metadata uses current frogprogsy surfaces", () => {
    const pkg = JSON.parse(read("package.json"));

    expect(pkg.scripts["generate:model-metadata"]).toBe("bun scripts/generate-model-metadata.ts");
    expect(pkg.scripts["generate:jawcode-metadata"]).toBeUndefined();
    expect(pkg.keywords).toContain("claude-code");
    expect(pkg.keywords).toContain("anthropic-messages");
    expect(pkg.keywords).not.toContain("responses-api");
  });

  test("public GUI docs match current management surfaces", () => {
    const webDashboardDocs = [
      read("docs-site/content/docs/en/guides/web-dashboard.md"),
      read("docs-site/content/docs/ko/guides/web-dashboard.md"),
      read("docs-site/content/docs/zh-cn/guides/web-dashboard.md"),
    ].join("\n");
    const cliDocs = [
      read("docs-site/content/docs/en/reference/cli.md"),
      read("docs-site/content/docs/ko/reference/cli.md"),
      read("docs-site/content/docs/zh-cn/reference/cli.md"),
    ].join("\n");

    expect(webDashboardDocs).toContain("/api/provider-state");
    expect(webDashboardDocs).toContain("/api/default-provider");
    expect(webDashboardDocs).not.toMatch(/PID|edit, enable\/disable|편집, 활성화\/비활성화|编辑、启用\/禁用/);
    expect(cliDocs).not.toMatch(/omitted from the short `frogp help`|생략되어|未包含在简短/);
  });

  test("configuration docs avoid stale/internal type names", () => {
    const configDocs = [
      read("docs-site/content/docs/en/reference/configuration.md"),
      read("docs-site/content/docs/ko/reference/configuration.md"),
      read("docs-site/content/docs/zh-cn/reference/configuration.md"),
    ].join("\n");

    expect(configDocs).toContain("ProviderConfig");
    expect(configDocs).toContain("WebSearchFallbackConfig");
    expect(configDocs).not.toMatch(/FrogConfig|FrogProviderConfig|FrogWebSearchFallbackConfig|FrogVisionFallbackConfig|GatewayWebSearchFallbackConfig|GatewayVisionFallbackConfig|Every field|모든 필드|每一个字段/);
  });
});
