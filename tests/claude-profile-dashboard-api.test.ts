import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { __requestLogTest } from "../src/server";
import type { FrogConfig } from "../src/types";

let previousNoClaudeWrites: string | undefined;
let originalFetch: typeof fetch;

function config(): FrogConfig {
  return {
    port: 10100,
    defaultProvider: "test",
    providers: {
      anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "forward", defaultModel: "claude-sonnet-4-6" },
      test: { adapter: "openai-chat", baseUrl: "https://models.test/v1", apiKey: "sk-test", defaultModel: "alpha", models: ["alpha", "beta"], liveModels: false },
    },
    disabledModels: ["test/beta"],
    subagentModels: ["test/beta"],
    claudeProfiles: {
      schemaVersion: 1,
      defaultProfileId: "cp_default",
      profiles: [
        { id: "cp_default", name: "Default", claudeHome: "/tmp/.claude", authState: "not_seen" },
        { id: "cp_work", name: "업무", claudeHome: "/tmp/.claude-work", authState: "not_seen" },
      ],
    },
  };
}

function configWithProject(projectRoot: string): FrogConfig {
  const cfg = config();
  cfg.claudeProjects = {
    schemaVersion: 1,
    projects: [{ id: "cproj_work", name: "project", projectPath: projectRoot, routingProfileId: "cp_work", enrolled: true }],
  };
  return cfg;
}

async function json(res: Response): Promise<any> {
  return await res.json();
}

beforeEach(() => {
  previousNoClaudeWrites = process.env.FROGPROGSY_NO_CLAUDE_WRITES;
  process.env.FROGPROGSY_NO_CLAUDE_WRITES = "1";
  originalFetch = globalThis.fetch;
  __requestLogTest.clear();
});

afterEach(() => {
  if (previousNoClaudeWrites === undefined) delete process.env.FROGPROGSY_NO_CLAUDE_WRITES;
  else process.env.FROGPROGSY_NO_CLAUDE_WRITES = previousNoClaudeWrites;
  globalThis.fetch = originalFetch;
  __requestLogTest.clear();
});

describe("Claude Code home management API", () => {
  test("PATCH is local-origin guarded and renames homes", async () => {
    const cfg = config();
    let saves = 0;

    const blocked = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/claude-profiles/cp_work", {
        method: "PATCH",
        headers: { Origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ name: "evil" }),
      }),
      new URL("http://localhost/api/claude-profiles/cp_work"),
      cfg,
      { saveConfig: () => { saves++; } },
    );
    expect(blocked?.status).toBe(403);
    expect(cfg.claudeProfiles?.profiles.find(profile => profile.id === "cp_work")?.name).toBe("업무");

    const patched = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/claude-profiles/cp_work", {
        method: "PATCH",
        headers: { Origin: "http://localhost:10100", "content-type": "application/json" },
        body: JSON.stringify({ name: "컬리 업무용" }),
      }),
      new URL("http://localhost/api/claude-profiles/cp_work"),
      cfg,
      { saveConfig: () => { saves++; } },
    );
    expect(patched?.status).toBe(200);
    const profile = cfg.claudeProfiles?.profiles.find(item => item.id === "cp_work");
    expect(profile?.name).toBe("컬리 업무용");

    expect(cfg.disabledModels).toEqual(["test/beta"]);
    expect(saves).toBeGreaterThanOrEqual(1);
  });

  test("originless mutations must still target a loopback URL", async () => {
    const cfg = config();
    const blocked = await __requestLogTest.handleManagementAPI(
      new Request("http://evil.example/api/claude-profiles/cp_work", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "evil" }),
      }),
      new URL("http://evil.example/api/claude-profiles/cp_work"),
      cfg,
    );
    expect(blocked?.status).toBe(403);
  });

  test("unknown profile headers fail closed instead of falling back to global settings", () => {
    const cfg = config();
    expect(() => __requestLogTest.requestClaudeProfileId(
      new Request("http://localhost/v1/messages", { headers: { "x-frogp-claude-profile": "cp_missing" } }),
      cfg,
    )).toThrow("Unknown Claude Code home: cp_missing");
  });

  test("native Claude Code catalog slugs honor global hidden models", () => {
    const cfg = config();
    cfg.disabledModels = ["gpt-5.5", "openai/gpt-5.4"];

    expect(__requestLogTest.isNativeSlugHidden(cfg, "gpt-5.5")).toBe(true);
    expect(__requestLogTest.isNativeSlugHidden(cfg, "gpt-5.4")).toBe(true);
    expect(__requestLogTest.isNativeSlugHidden(cfg, "gpt-5.3-claude-spark")).toBe(false);
  });

  test("gateway-applied profiles cannot be removed while restore writes are blocked", async () => {
    const cfg = config();
    const profile = cfg.claudeProfiles!.profiles.find(item => item.id === "cp_work")!;
    const home = mkdtempSync(join(tmpdir(), "frog-profile-delete-"));
    profile.claudeHome = home;
    profile.injected = false;
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "http://localhost:10100",
        ANTHROPIC_AUTH_TOKEN: "local-frogprogsy",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        ANTHROPIC_CUSTOM_HEADERS: "X-Frogp-Claude-Profile: cp_work",
      },
    }, null, 2));

    try {
      const res = await __requestLogTest.handleManagementAPI(
        new Request("http://localhost/api/claude-profiles/cp_work", {
          method: "DELETE",
          headers: { Origin: "http://localhost:10100" },
        }),
        new URL("http://localhost/api/claude-profiles/cp_work"),
        cfg,
        { saveConfig: () => {} },
      );
      expect(res?.status).toBe(409);
      expect(cfg.claudeProfiles!.profiles.some(item => item.id === "cp_work")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("profile list distinguishes token-free and sentinel settings carriers", async () => {
    const cfg = config();
    const defaultProfile = cfg.claudeProfiles!.profiles.find(item => item.id === "cp_default")!;
    const profile = cfg.claudeProfiles!.profiles.find(item => item.id === "cp_work")!;
    const defaultHome = mkdtempSync(join(tmpdir(), "frog-profile-gateway-default-"));
    const home = mkdtempSync(join(tmpdir(), "frog-profile-gateway-"));
    defaultProfile.claudeHome = defaultHome;
    profile.claudeHome = home;
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "http://localhost:10100",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        ANTHROPIC_CUSTOM_HEADERS: "X-Frogp-Claude-Profile: cp_work",
      },
    }, null, 2));

    try {
      const res = await __requestLogTest.handleManagementAPI(
        new Request("http://localhost/api/claude-profiles"),
        new URL("http://localhost/api/claude-profiles"),
        cfg,
        { saveConfig: () => {} },
      );
      expect(res?.status).toBe(200);
      const body = await json(res!);
      const work = body.profiles.find((item: any) => item.id === "cp_work");
      expect(work.injected).toBe(true);
      expect(work.gateway).toMatchObject({
        injected: true,
        carrier: "token-free",
        modelDiscoveryReady: true,
        discoveryAuth: "settings",
      });

      writeFileSync(join(home, "settings.json"), JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://localhost:10100",
          ANTHROPIC_AUTH_TOKEN: "local-frogprogsy",
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
          ANTHROPIC_CUSTOM_HEADERS: "X-Frogp-Claude-Profile: cp_work",
        },
      }, null, 2));
      const globalRes = await __requestLogTest.handleManagementAPI(
        new Request("http://localhost/api/claude-profiles"),
        new URL("http://localhost/api/claude-profiles"),
        cfg,
        { saveConfig: () => {} },
      );
      const globalBody = await json(globalRes!);
      expect(globalBody.profiles.find((item: any) => item.id === "cp_work").gateway).toMatchObject({
        carrier: "sentinel",
        modelDiscoveryReady: true,
        discoveryAuth: "settings",
      });
    } finally {
      rmSync(defaultHome, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("project API enrolls, reports, restores, and is local-origin guarded", async () => {
    const cfg = config();
    const projectRoot = mkdtempSync(join(tmpdir(), "frog-project-api-"));
    const frogHome = mkdtempSync(join(tmpdir(), "frog-project-api-home-"));
    const previousHome = process.env.FROGPROGSY_HOME;
    process.env.FROGPROGSY_HOME = frogHome;
    let saves = 0;

    try {
      const blocked = await __requestLogTest.handleManagementAPI(
        new Request("http://localhost/api/claude-projects", {
          method: "POST",
          headers: { Origin: "https://evil.example", "content-type": "application/json" },
          body: JSON.stringify({ root: projectRoot }),
        }),
        new URL("http://localhost/api/claude-projects"),
        cfg,
        { saveConfig: () => { saves++; } },
      );
      expect(blocked?.status).toBe(403);

      const preEnrollStatus = await __requestLogTest.handleManagementAPI(
        new Request(`http://localhost/api/claude-projects?root=${encodeURIComponent(projectRoot)}`, { headers: { Origin: "http://localhost:10100" } }),
        new URL(`http://localhost/api/claude-projects?root=${encodeURIComponent(projectRoot)}`),
        cfg,
        { saveConfig: () => { saves++; } },
      );
      expect(preEnrollStatus?.status).toBe(200);
      const preEnrollBody = await json(preEnrollStatus!);
      expect(preEnrollBody.projects).toEqual([]);
      expect(preEnrollBody.current).toMatchObject({
        root: projectRoot,
        gitProtection: "not_git",
        modelDiscoveryReady: false,
      });
      expect(preEnrollBody.current.gateway).toMatchObject({
        modelDiscoveryReady: false,
        tokenScope: "none",
      });

      const enrolled = await __requestLogTest.handleManagementAPI(
        new Request("http://localhost/api/claude-projects", {
          method: "POST",
          headers: { Origin: "http://localhost:10100", "content-type": "application/json" },
          body: JSON.stringify({ root: projectRoot, routingProfileId: "cp_work" }),
        }),
        new URL("http://localhost/api/claude-projects"),
        cfg,
        { saveConfig: () => { saves++; } },
      );
      expect(enrolled?.status).toBe(201);
      const enrollBody = await json(enrolled!);
      expect(enrollBody.project.gateway).toMatchObject({
        enrolled: true,
        applied: true,
        modelDiscoveryReady: true,
        carrier: "token-free",
        tokenScope: "none",
      });
      const settings = JSON.parse(readFileSync(join(projectRoot, ".claude", "settings.local.json"), "utf8"));
      expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://localhost:10100");
      expect(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
      expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toContain("X-Frogp-Claude-Profile: cp_work");

      const listed = await __requestLogTest.handleManagementAPI(
        new Request(`http://localhost/api/claude-projects?root=${encodeURIComponent(projectRoot)}`, { headers: { Origin: "http://localhost:10100" } }),
        new URL(`http://localhost/api/claude-projects?root=${encodeURIComponent(projectRoot)}`),
        cfg,
        { saveConfig: () => { saves++; } },
      );
      expect(listed?.status).toBe(200);
      const listBody = await json(listed!);
      expect(listBody.projects[0].note).toContain("does not choose");
      expect(listBody.projects[0].settingsPath).toBe(join(realpathSync.native(projectRoot), ".claude", "settings.local.json"));
      expect(listBody.projects[0].gitProtection).toBe("not_git");
      expect(listBody.projects[0].gateway.effectiveSource).toBe("project.local.settings");
      expect(listBody.projects[0].gateway.carrier).toBe("token-free");

      const restored = await __requestLogTest.handleManagementAPI(
        new Request(`http://localhost/api/claude-projects/${enrollBody.project.id}/restore`, { method: "POST", headers: { Origin: "http://localhost:10100" } }),
        new URL(`http://localhost/api/claude-projects/${enrollBody.project.id}/restore`),
        cfg,
        { saveConfig: () => { saves++; } },
      );
      expect(restored?.status).toBe(200);
      expect(cfg.claudeProjects?.projects[0]?.enrolled).toBe(false);
      const restoredSettings = JSON.parse(readFileSync(join(projectRoot, ".claude", "settings.local.json"), "utf8"));
      expect(restoredSettings.env).toBeUndefined();

      cfg.gatewayAuthCarrier = "sentinel";
      const sentinelEnroll = await __requestLogTest.handleManagementAPI(
        new Request("http://localhost/api/claude-projects", {
          method: "POST",
          headers: { Origin: "http://localhost:10100", "content-type": "application/json" },
          body: JSON.stringify({ root: projectRoot, routingProfileId: "cp_work" }),
        }),
        new URL("http://localhost/api/claude-projects"),
        cfg,
        { saveConfig: () => { saves++; } },
      );
      expect(sentinelEnroll?.status).toBe(201);
      const sentinelBody = await json(sentinelEnroll!);
      expect(sentinelBody.project.gateway).toMatchObject({ carrier: "sentinel", tokenScope: "project" });
      const sentinelSettings = JSON.parse(readFileSync(join(projectRoot, ".claude", "settings.local.json"), "utf8"));
      expect(sentinelSettings.env.ANTHROPIC_AUTH_TOKEN).toBe("local-frogprogsy");
      expect(saves).toBeGreaterThanOrEqual(2);
    } finally {
      if (previousHome === undefined) delete process.env.FROGPROGSY_HOME;
      else process.env.FROGPROGSY_HOME = previousHome;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(frogHome, { recursive: true, force: true });
    }
  });

  test("profile deletion clears referencing project metadata and project profile header", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "frog-project-profile-delete-"));
    mkdirSync(join(projectRoot, ".claude"), { recursive: true });
    writeFileSync(join(projectRoot, ".claude", "settings.local.json"), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "http://localhost:10100",
        ANTHROPIC_AUTH_TOKEN: "local-frogprogsy",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        ANTHROPIC_CUSTOM_HEADERS: "X-Other: keep\nX-Frogp-Claude-Profile: cp_work",
      },
    }, null, 2));
    const cfg = configWithProject(projectRoot);
    const defaultHome = mkdtempSync(join(tmpdir(), "frog-project-profile-default-home-"));
    const workHome = mkdtempSync(join(tmpdir(), "frog-project-profile-work-home-"));
    const frogHome = mkdtempSync(join(tmpdir(), "frog-project-profile-frog-home-"));
    const previousFrogHome = process.env.FROGPROGSY_HOME;
    cfg.claudeProfiles!.profiles.find(profile => profile.id === "cp_default")!.claudeHome = defaultHome;
    cfg.claudeProfiles!.profiles.find(profile => profile.id === "cp_work")!.claudeHome = workHome;
    process.env.FROGPROGSY_HOME = frogHome;

    try {
      const res = await __requestLogTest.handleManagementAPI(
        new Request("http://localhost/api/claude-profiles/cp_work", {
          method: "DELETE",
          headers: { Origin: "http://localhost:10100" },
        }),
        new URL("http://localhost/api/claude-profiles/cp_work"),
        cfg,
        { saveConfig: () => {} },
      );

      expect(res?.status).toBe(200);
      const body = await json(res!);
      expect(body.launcherSync).toMatchObject({ success: true });
      expect(cfg.claudeProjects?.projects[0]?.routingProfileId).toBeUndefined();
      const settings = JSON.parse(readFileSync(join(projectRoot, ".claude", "settings.local.json"), "utf8"));
      expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe("X-Other: keep");
    } finally {
      if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
      else process.env.FROGPROGSY_HOME = previousFrogHome;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(defaultHome, { recursive: true, force: true });
      rmSync(workHome, { recursive: true, force: true });
      rmSync(frogHome, { recursive: true, force: true });
    }
  });

  test("profile deletion validates removability before project cleanup side effects", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "frog-project-only-profile-delete-"));
    mkdirSync(join(projectRoot, ".claude"), { recursive: true });
    writeFileSync(join(projectRoot, ".claude", "settings.local.json"), JSON.stringify({
      env: {
        ANTHROPIC_CUSTOM_HEADERS: "X-Frogp-Claude-Profile: cp_default",
      },
    }, null, 2));
    const cfg = configWithProject(projectRoot);
    cfg.claudeProjects!.projects[0]!.routingProfileId = "cp_default";
    cfg.claudeProfiles!.profiles = [cfg.claudeProfiles!.profiles[0]!];

    try {
      const res = await __requestLogTest.handleManagementAPI(
        new Request("http://localhost/api/claude-profiles/cp_default", {
          method: "DELETE",
          headers: { Origin: "http://localhost:10100" },
        }),
        new URL("http://localhost/api/claude-profiles/cp_default"),
        cfg,
        { saveConfig: () => {} },
      );

      expect(res?.status).toBe(409);
      expect(cfg.claudeProjects?.projects[0]?.routingProfileId).toBe("cp_default");
      const settings = JSON.parse(readFileSync(join(projectRoot, ".claude", "settings.local.json"), "utf8"));
      expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe("X-Frogp-Claude-Profile: cp_default");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });


  test("refresh returns success-compatible skipped model reload metadata when Claude writes are blocked", async () => {
    const cfg = config();
    const res = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/claude-profiles/cp_work/refresh", {
        method: "POST",
        headers: { Origin: "http://localhost:10100" },
      }),
      new URL("http://localhost/api/claude-profiles/cp_work/refresh"),
      cfg,
      { saveConfig: () => {} },
    );

    expect(res?.status).toBe(200);
    const body = await json(res!);
    expect(body.success).toBe(true);
    expect(body.message).toContain("skipped");
    expect(body.profile.id).toBe("cp_work");
    expect(body.modelReload).toMatchObject({
      schemaVersion: 1,
      action: "claude-model-reload",
      profileId: "cp_work",
      command: "frogp claude reload-models cp_work",
      attempted: false,
      writeBlocked: true,
      status: "skipped",
      gatewayCache: { status: "skipped" },
      proxy: {
        checked: false,
        running: null,
        guidance: "Run frogp refresh if the proxy is not answering.",
      },
      nextStep: {
        requiresClaudeCodeStartOrResume: true,
        hotReloadSupported: false,
      },
    });
    expect(body.modelReload.warnings.length).toBeGreaterThan(0);
    expect(body.modelReload.nextStep.guidance).toContain("refetches /v1/models");
  });

  test("refresh body can opt into global discovery auth for dashboard control", async () => {
    const cfg = config();
    const profile = cfg.claudeProfiles!.profiles.find(item => item.id === "cp_work")!;
    const home = mkdtempSync(join(tmpdir(), "frog-profile-global-auth-"));
    const frogHome = mkdtempSync(join(tmpdir(), "frog-profile-global-auth-config-"));
    profile.claudeHome = home;
    const previous = process.env.FROGPROGSY_NO_CLAUDE_WRITES;
    const previousFrogHome = process.env.FROGPROGSY_HOME;
    process.env.FROGPROGSY_HOME = frogHome;
    delete process.env.FROGPROGSY_NO_CLAUDE_WRITES;
    try {
      const res = await __requestLogTest.handleManagementAPI(
        new Request("http://localhost/api/claude-profiles/cp_work/refresh", {
          method: "POST",
          headers: { Origin: "http://localhost:10100", "content-type": "application/json" },
          body: JSON.stringify({ globalDiscoveryAuth: true }),
        }),
        new URL("http://localhost/api/claude-profiles/cp_work/refresh"),
        cfg,
        { saveConfig: () => {} },
      );
      expect(res?.status).toBe(200);
      const body = await json(res!);
      expect(body.message).toContain("Local gateway auth token injected into settings");
      const settings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
      expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe("local-frogprogsy");

      const scopedRes = await __requestLogTest.handleManagementAPI(
        new Request("http://localhost/api/claude-profiles/cp_work/refresh", {
          method: "POST",
          headers: { Origin: "http://localhost:10100" },
        }),
        new URL("http://localhost/api/claude-profiles/cp_work/refresh"),
        cfg,
        { saveConfig: () => {} },
      );
      expect(scopedRes?.status).toBe(200);
      const scopedSettings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
      expect(scopedSettings.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.FROGPROGSY_NO_CLAUDE_WRITES;
      else process.env.FROGPROGSY_NO_CLAUDE_WRITES = previous;
      if (previousFrogHome === undefined) delete process.env.FROGPROGSY_HOME;
      else process.env.FROGPROGSY_HOME = previousFrogHome;
      rmSync(frogHome, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("model and subagent APIs use global hidden and featured settings for profiles", async () => {
    const cfg = config();
    let saves = 0;

    const modelsRes = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/models?profileId=cp_work"),
      new URL("http://localhost/api/models?profileId=cp_work"),
      cfg,
      { saveConfig: () => { saves++; } },
    );
    expect(modelsRes?.status).toBe(200);
    const models = await json(modelsRes!);
    expect(models.find((model: any) => model.namespaced === "test/alpha")?.disabled).toBe(false);
    expect(models.find((model: any) => model.namespaced === "test/beta")?.disabled).toBe(true);
    expect(models.find((model: any) => model.namespaced === "anthropic/claude-sonnet-4-6")?.disabled).toBe(false);

    const subagentRes = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/subagent-models?profileId=cp_work"),
      new URL("http://localhost/api/subagent-models?profileId=cp_work"),
      cfg,
      { saveConfig: () => { saves++; } },
    );
    const subagent = await json(subagentRes!);
    expect(subagent.chosen).toEqual(["test/beta"]);
    expect(subagent.available).toContain("test/alpha");
    expect(subagent.available).not.toContain("test/beta");
    expect(subagent.available).toContain("anthropic/claude-sonnet-4-6");

    const updateDisabled = await __requestLogTest.handleManagementAPI(
      new Request("http://localhost/api/disabled-models", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ models: ["test/alpha"] }),
      }),
      new URL("http://localhost/api/disabled-models"),
      cfg,
      { saveConfig: () => { saves++; } },
    );
    expect(updateDisabled?.status).toBe(200);
    expect(cfg.disabledModels).toEqual(["test/alpha"]);
  });

  test("data-plane routing rejects a globally hidden model for the selected profile", async () => {
    const cfg = config();
    cfg.disabledModels = ["test/alpha"];
    const ctx = __requestLogTest.createRequestLog("/v1/messages", "POST", new Headers());
    const res = await __requestLogTest.handleMessages(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-frogp-claude-profile": "cp_work" },
        body: JSON.stringify({ model: "test/alpha", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
      }),
      cfg,
      ctx,
      { profileId: "cp_work" },
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("is disabled");
  });

  test("pass-through Anthropic model cache is scoped by profile and forwards only safe auth headers", async () => {
    const cfg = config();
    const seen: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      const headers = new Headers(init?.headers);
      seen.push(`${headers.get("authorization") ?? ""}|${headers.get("x-api-key") ?? ""}|${headers.get("anthropic-beta") ?? ""}`);
      return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-6" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    __requestLogTest.noteClaudeProfileRequest(cfg, "cp_work", new Headers({ authorization: "Bearer subscription-token" }));
    const work = await __requestLogTest.effectiveModelView(cfg, { profileId: "cp_work", headers: new Headers({ authorization: "Bearer subscription-token", "anthropic-beta": "oauth-2025-04-20" }) });
    expect(work.models.map((model: any) => `${model.provider}/${model.id}`)).toContain("anthropic/claude-sonnet-4-6");
    expect(seen).toEqual(["Bearer subscription-token||oauth-2025-04-20"]);
    expect(cfg.claudeProfiles?.profiles.find(profile => profile.id === "cp_work")?.authState).toBe("oauth_ok");
    expect(JSON.stringify(cfg)).not.toContain("subscription-token");

    const personal = await __requestLogTest.effectiveModelView(cfg, { profileId: "cp_default", headers: new Headers() });
    expect(personal.models.map((model: any) => `${model.provider}/${model.id}`)).not.toContain("anthropic/claude-sonnet-4-6");
  });
});

describe("claude-grant provider binding (hard validation on create/update)", () => {
  let prevHome: string | undefined;
  let bindHome = "";

  beforeEach(() => {
    prevHome = process.env.FROGPROGSY_HOME;
    bindHome = mkdtempSync(join(tmpdir(), "frog-grant-bind-"));
    process.env.FROGPROGSY_HOME = bindHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FROGPROGSY_HOME;
    else process.env.FROGPROGSY_HOME = prevHome;
    if (bindHome) rmSync(bindHome, { recursive: true, force: true });
    bindHome = "";
  });

  function grantConfig(): FrogConfig {
    const cfg = config();
    cfg.claudeGrants = {
      schemaVersion: 1,
      grants: [{ id: "cg_bound01", label: "Bound", configDir: join(bindHome, "claude-grants", "cg_bound01"), createdAt: new Date().toISOString() }],
    };
    return cfg;
  }

  async function postProvider(cfg: FrogConfig, provider: Record<string, unknown>, name = "anthropic-work"): Promise<Response> {
    const url = "http://localhost/api/providers";
    const res = await __requestLogTest.handleManagementAPI(
      new Request(url, {
        method: "POST",
        headers: { Origin: "http://localhost:10100", "content-type": "application/json" },
        body: JSON.stringify({ name, provider }),
      }),
      new URL(url),
      cfg,
      { saveConfig: () => {} },
    );
    expect(res).not.toBeNull();
    return res!;
  }

  test("accepts a claude-grant provider bound to an existing grant + anthropic adapter", async () => {
    const cfg = grantConfig();
    const res = await postProvider(cfg, { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "claude-grant", claudeGrantId: "cg_bound01", defaultModel: "claude-sonnet-4-6" });
    expect(res.status).toBe(200);
    expect(cfg.providers["anthropic-work"]?.authMode).toBe("claude-grant");
    expect(cfg.providers["anthropic-work"]?.claudeGrantId).toBe("cg_bound01");
  });

  test("rejects an unknown grant id with a hard 400", async () => {
    const cfg = grantConfig();
    const res = await postProvider(cfg, { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "claude-grant", claudeGrantId: "cg_missing99" });
    expect(res.status).toBe(400);
    expect(cfg.providers["anthropic-work"]).toBeUndefined();
  });

  test("rejects a missing grant id with a hard 400", async () => {
    const cfg = grantConfig();
    const res = await postProvider(cfg, { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "claude-grant" });
    expect(res.status).toBe(400);
    expect(cfg.providers["anthropic-work"]).toBeUndefined();
  });

  test("rejects grant mode on a non-anthropic adapter with a hard 400", async () => {
    const cfg = grantConfig();
    const res = await postProvider(cfg, { adapter: "openai-chat", baseUrl: "https://models.test/v1", authMode: "claude-grant", claudeGrantId: "cg_bound01" });
    expect(res.status).toBe(400);
    expect(cfg.providers["anthropic-work"]).toBeUndefined();
  });

  test("does not disturb an ordinary key provider create (oauth/key/forward path unchanged)", async () => {
    const cfg = grantConfig();
    const res = await postProvider(cfg, { adapter: "openai-chat", baseUrl: "https://models.test/v1", apiKey: "sk-plain-key", defaultModel: "alpha" }, "plainkey");
    expect(res.status).toBe(200);
    expect(cfg.providers["plainkey"]?.apiKey).toBe("sk-plain-key");
  });

  test("GET /api/providers shows grant id + auth mode but no secret or absolute path", async () => {
    const cfg = grantConfig();
    await postProvider(cfg, { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "claude-grant", claudeGrantId: "cg_bound01", defaultModel: "claude-sonnet-4-6" });
    const url = "http://localhost/api/providers";
    const res = await __requestLogTest.handleManagementAPI(new Request(url), new URL(url), cfg, { saveConfig: () => {} });
    const providers = await res!.json();
    const bound = providers.find((p: any) => p.name === "anthropic-work");
    expect(bound.authMode).toBe("claude-grant");
    expect(bound.claudeGrantId).toBe("cg_bound01");
    const serialized = JSON.stringify(providers);
    expect(serialized).not.toContain(bindHome);
    expect(serialized).not.toContain("/claude-grants/cg_bound01");
  });
});

describe("GET /api/claude-grants re-auth command (server-built; non-default FROGPROGSY_HOME; no leaks)", () => {
  let prevHome: string | undefined;
  let prevRealClaude: string | undefined;
  let homeBase = "";
  let frogHome = "";
  let exeDir = "";
  let fakeClaude = "";

  beforeEach(() => {
    prevHome = process.env.FROGPROGSY_HOME;
    prevRealClaude = process.env.FROGP_REAL_CLAUDE;
    delete process.env.FROGP_REAL_CLAUDE;
    // A NON-default FROGPROGSY_HOME nested under the real $HOME so the server-built command is
    // $HOME-tokenized and its config dir carries the custom home segment (never the default path).
    // The dir is never created — the redacted GET performs no filesystem writes — so the real home
    // is left untouched.
    homeBase = (process.env.HOME?.trim() || homedir()).replace(/[/\\]+$/, "");
    frogHome = join(homeBase, `.frogprogsy-nondefault-${process.pid}-${Date.now()}`);
    process.env.FROGPROGSY_HOME = frogHome;
    // Real executable stand-in for the resolved Claude binary. This remains portable when a Windows
    // runner places tmpdir under $HOME; the dedicated grant API test positively exercises tokenization.
    exeDir = mkdtempSync(join(tmpdir(), "frog-grant-exe-"));
    fakeClaude = join(exeDir, process.platform === "win32" ? "claude.cmd" : "claude");
    writeFileSync(
      fakeClaude,
      process.platform === "win32" ? "@echo off\r\necho fake-claude\r\n" : "#!/bin/sh\necho fake-claude\n",
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FROGPROGSY_HOME;
    else process.env.FROGPROGSY_HOME = prevHome;
    if (prevRealClaude === undefined) delete process.env.FROGP_REAL_CLAUDE;
    else process.env.FROGP_REAL_CLAUDE = prevRealClaude;
    if (exeDir) rmSync(exeDir, { recursive: true, force: true });
    homeBase = ""; frogHome = ""; exeDir = ""; fakeClaude = "";
  });

  function grantCfg(): FrogConfig {
    const cfg = config();
    cfg.claudeGrants = {
      schemaVersion: 1,
      grants: [{ id: "cg_reauth01", label: "Work", configDir: join(frogHome, "claude-grants", "cg_reauth01"), createdAt: new Date().toISOString() }],
    };
    return cfg;
  }

  async function getGrants(cfg: FrogConfig, grantDeps: Record<string, unknown>): Promise<any> {
    const url = "http://localhost/api/claude-grants";
    const res = await __requestLogTest.handleManagementAPI(
      new Request(url, { headers: { Origin: "http://localhost:10100" } }),
      new URL(url),
      cfg,
      { saveConfig: () => {}, claudeGrants: grantDeps },
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    return await res!.json();
  }

  test("exposes a server-built, $HOME-tokenized re-auth command that reflects the real config dir", async () => {
    const body = await getGrants(grantCfg(), { realClaude: fakeClaude, inspectStatus: () => ({ state: "reauth_required" }) });
    const grant = body.grants.find((g: any) => g.id === "cg_reauth01");
    // "/.frogprogsy-nondefault-XXXX/claude-grants/cg_reauth01"
    const homeSegment = join(frogHome, "claude-grants", "cg_reauth01").slice(homeBase.length);

    // The command is built by the authoritative server builder (grantSetup), $HOME-tokenized, and
    // reflects the grant's ACTUAL (non-default) config dir — proving FROGPROGSY_HOME independence.
    expect(typeof grant.reauthCommand).toBe("string");
    const shellEscapedHomeSegment = process.platform === "win32"
      ? homeSegment
      : homeSegment.replace(/(["\\$`])/g, "\\$1");
    const envPrefix = process.platform === "win32" ? "$env:CLAUDE_CONFIG_DIR=" : "CLAUDE_CONFIG_DIR=";
    expect(grant.reauthCommand).toContain(`${envPrefix}"$HOME${shellEscapedHomeSegment}"`);
    expect(grant.reauthCommand).toContain("auth login --claudeai");
    // Never the hardcoded default path the old client fabricated, and never a raw absolute home.
    expect(grant.reauthCommand).not.toContain(".frogprogsy/claude-grants/cg_reauth01");
    expect(grant.reauthCommand).not.toContain(homeBase);

    // The API exposes only the safe command string plus existing non-secret fields.
    expect(grant).toMatchObject({ id: "cg_reauth01", label: "Work", state: "reauth_required", boundProviders: [], realClaudeReady: true });
    expect(grant.configDir).toBeUndefined();
    expect(grant.executable).toBeUndefined();
    expect(grant.service).toBeUndefined();

    // No raw config dir, keychain service, home path, token, or credential material anywhere.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(homeBase);
    expect(serialized).not.toContain("Claude Code-credentials");
    expect(serialized).not.toContain("claudeAiOauth");
    expect(serialized).not.toContain("refreshToken");
    expect(serialized).not.toContain("accessToken");
    // realClaude readiness is reported without leaking a raw home path.
    expect(body.realClaude.ready).toBe(true);
    expect(body.realClaude.name).not.toContain(homeBase);
  });

  test("omits the re-auth command (fail-closed) when no real executable resolves", async () => {
    const body = await getGrants(grantCfg(), { resolveRealClaude: () => "claude", inspectStatus: () => ({ state: "reauth_required" }) });
    const grant = body.grants.find((g: any) => g.id === "cg_reauth01");
    expect(grant.reauthCommand).toBeUndefined();
    expect(grant.realClaudeReady).toBe(false);
    expect(body.realClaude.ready).toBe(false);
  });
});
