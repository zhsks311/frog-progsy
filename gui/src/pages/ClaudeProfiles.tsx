import { useEffect, useMemo, useState } from "react";
import { IconBot, IconCheck, IconPlus, IconTrash } from "../icons";
import { useT, type TFn, type TKey } from "../i18n";
import type { Navigate } from "../navigation";
import { Notice } from "../ui";

type DiscoveryAuthMode = "direct" | "launcher" | "settings";

interface ClaudeProfileGateway {
  injected?: boolean;
  gatewayDiscovery?: boolean;
  modelDiscoveryReady?: boolean;
  discoveryAuth?: DiscoveryAuthMode;
}

interface ClaudeProfile {
  id: string;
  name: string;
  claudeHome: string;
  injected?: boolean;
  lastInjectedAt?: string;
  lastSeenAt?: string;
  authState?: string;
  gateway?: ClaudeProfileGateway;
  isDefault?: boolean;
}

interface ModelRow { provider: string; id: string; namespaced: string; disabled?: boolean }

type ModelReloadStatus = "synced" | "partial" | "skipped" | "failed" | "unknown" | "proxy_down";
type GitProtectionState = "tracked" | "ignored" | "excluded" | "untracked" | "not_git" | "unwritable" | "unknown";

interface ClaudeProjectEnrollment {
  id?: string;
  root?: string;
  settingsPath?: string;
  gitProtection?: GitProtectionState | string;
  gateway?: { modelDiscoveryReady?: boolean; effectiveSource?: string };
  modelDiscoveryReady?: boolean;
  effectiveSource?: string;
  routingProfileId?: string;
  danglingRoutingProfileId?: string;
}

interface ClaudeProjectsResponse {
  projects?: ClaudeProjectEnrollment[];
  current?: ClaudeProjectEnrollment;
}

interface ModelReloadMetadata {
  profileId?: string;
  command?: string;
  attempted?: boolean;
  writeBlocked?: boolean;
  status?: string;
  catalog?: { added?: number; exists?: boolean | null; cacheSynced?: boolean };
  gatewayCache?: { status?: string };
  warnings?: string[];
}

const ACTION_DONE_KEY: Record<"inject" | "restore" | "refresh", TKey> = {
  inject: "claudeProfiles.injectDone",
  restore: "claudeProfiles.restoreDone",
  refresh: "claudeProfiles.refreshDone",
};

const MODEL_RELOAD_KEY: Record<ModelReloadStatus, TKey> = {
  synced: "claudeProfiles.reloadSynced",
  partial: "claudeProfiles.reloadPartial",
  skipped: "claudeProfiles.reloadSkipped",
  failed: "claudeProfiles.reloadFailed",
  unknown: "claudeProfiles.reloadUnknown",
  proxy_down: "claudeProfiles.reloadProxyDown",
};

function normalizeModelReloadStatus(status: unknown): ModelReloadStatus | undefined {
  if (status === "proxy-down" || status === "proxy_down") return "proxy_down";
  return typeof status === "string" && status in MODEL_RELOAD_KEY ? status as ModelReloadStatus : undefined;
}


function parseModelReload(value: unknown): ModelReloadMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as ModelReloadMetadata;
  const status = normalizeModelReloadStatus(data.status);
  if (!status) return undefined;
  return { ...data, status };
}

function authStateKey(state: string | undefined): TKey {
  switch (state) {
    case "seen_no_bearer": return "claudeProfiles.auth.seen_no_bearer";
    case "oauth_ok": return "claudeProfiles.auth.oauth_ok";
    case "oauth_rejected": return "claudeProfiles.auth.oauth_rejected";
    case "cached": return "claudeProfiles.auth.cached";
    case "stale": return "claudeProfiles.auth.stale";
    case "unknown": return "claudeProfiles.auth.unknown";
    default: return "claudeProfiles.auth.not_seen";
  }
}

function discoveryAuthKey(mode: DiscoveryAuthMode | undefined): TKey {
  switch (mode) {
    case "settings": return "claudeProfiles.discoveryAuth.settings";
    case "launcher": return "claudeProfiles.discoveryAuth.launcher";
    default: return "claudeProfiles.discoveryAuth.direct";
  }
}
function parseProfiles(value: unknown): ClaudeProfile[] {
  const profiles = value && typeof value === "object" ? (value as { profiles?: unknown }).profiles : undefined;
  if (!Array.isArray(profiles)) return [];
  return profiles.filter((item): item is ClaudeProfile => {
    const profile = item as Partial<ClaudeProfile>;
    return typeof profile.id === "string" && typeof profile.name === "string" && typeof profile.claudeHome === "string";
  });
}

function parseProjects(value: unknown): ClaudeProjectsResponse {
  if (!value || typeof value !== "object") return {};
  const data = value as ClaudeProjectsResponse;
  const projects = Array.isArray(data.projects) ? data.projects.filter((item): item is ClaudeProjectEnrollment => {
    const project = item as Partial<ClaudeProjectEnrollment>;
    return typeof project.id === "string";
  }) : [];
  const current = data.current && typeof data.current === "object"
    ? data.current as ClaudeProjectEnrollment
    : projects[0];
  return { projects, current };
}

function gitProtectionKey(state: string | undefined): TKey {
  switch (state) {
    case "tracked": return "claudeProjects.git.tracked";
    case "ignored": return "claudeProjects.git.ignored";
    case "excluded": return "claudeProjects.git.excluded";
    case "untracked": return "claudeProjects.git.untracked";
    case "not_git": return "claudeProjects.git.not_git";
    case "unwritable": return "claudeProjects.git.unwritable";
    default: return "claudeProjects.git.unknown";
  }
}

export default function ClaudeProfiles({ apiBase, navigate }: { apiBase: string; navigate: Navigate }) {
  const t = useT();
  const [profiles, setProfiles] = useState<ClaudeProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [newHome, setNewHome] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [projectRoot, setProjectRoot] = useState("");
  const [projectRoutingProfileId, setProjectRoutingProfileId] = useState("");
  const [projects, setProjects] = useState<ClaudeProjectEnrollment[]>([]);
  const [currentProject, setCurrentProject] = useState<ClaudeProjectEnrollment | undefined>();
  const [grants, setGrants] = useState<ClaudeGrantSummary[]>([]);
  const [realClaude, setRealClaude] = useState<RealClaudeInfo | undefined>();
  const [grantsFailed, setGrantsFailed] = useState(false);

  const selected = useMemo(() => profiles.find(profile => profile.id === selectedId) ?? profiles[0], [profiles, selectedId]);
  const runCommand = selected ? `frogp claude run ${JSON.stringify(selected.name)} --` : "frogp claude run <profile> --";
  const reloadCommand = selected ? `frogp claude reload-models ${selected.id}` : "frogp claude reload-models <profile-id>";
  const discoveryAuthMode: DiscoveryAuthMode = selected?.gateway?.discoveryAuth ?? (selected?.gateway?.modelDiscoveryReady ? "settings" : selected?.injected ? "launcher" : "direct");

  const notify = (message: string, success: boolean) => { setStatus(message); setOk(success); };

  const modelReloadMessage = (metadata: ModelReloadMetadata): string => {
    const status = normalizeModelReloadStatus(metadata.status) ?? "unknown";
    const command = typeof metadata.command === "string" && metadata.command.trim() ? metadata.command : reloadCommand;
    return t(MODEL_RELOAD_KEY[status], {
      cmd: command,
      n: metadata.catalog?.added ?? 0,
      warnings: metadata.warnings?.length ?? 0,
    });
  };

  const modelReloadOk = (metadata: ModelReloadMetadata): boolean => metadata.status !== "failed" && metadata.status !== "skipped" && metadata.status !== "proxy_down";

  const loadProfiles = async () => {
    const res = await fetch(`${apiBase}/api/claude-profiles`);
    if (!res.ok) throw new Error("profiles load failed");
    const next = parseProfiles(await res.json());
    setProfiles(next);
    setSelectedId(prev => next.some(profile => profile.id === prev) ? prev : next[0]?.id ?? null);
    return next;
  };

  const loadProfileDetails = async (profile: ClaudeProfile | undefined) => {
    if (!profile) return;
    const modelsRes = await fetch(`${apiBase}/api/models?profileId=${encodeURIComponent(profile.id)}`);
    const modelRows = modelsRes.ok ? await modelsRes.json() as ModelRow[] : [];
    setModels(Array.isArray(modelRows) ? modelRows : []);
    setRenameValue(profile.name);
  };

  const loadProjects = async (root = projectRoot) => {
    const query = root.trim() ? `?root=${encodeURIComponent(root.trim())}` : "";
    const res = await fetch(`${apiBase}/api/claude-projects${query}`);
    if (!res.ok) throw new Error("projects load failed");
    const data = parseProjects(await res.json());
    setProjects(data.projects ?? []);
    setCurrentProject(data.current);
    setProjectRoutingProfileId(data.current?.routingProfileId || "");
    return data;
  };

  // Fail-closed: a grant API failure only disables the grant section, never the whole page.
  const loadGrants = async () => {
    try {
      const res = await fetch(`${apiBase}/api/claude-grants`);
      if (!res.ok) throw new Error("grants load failed");
      const data = parseGrants(await res.json());
      setGrants(data.grants);
      setRealClaude(data.realClaude);
      setGrantsFailed(false);
    } catch {
      setGrants([]);
      setRealClaude(undefined);
      setGrantsFailed(true);
    }
  };

  const reload = async () => {
    setLoading(true);
    try {
      const next = await loadProfiles();
      await Promise.all([
        loadProfileDetails(next.find(profile => profile.id === selectedId) ?? next[0]),
        loadProjects(),
        loadGrants(),
      ]);
    } catch {
      notify(t("claudeProfiles.loadFailed"), false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, [apiBase]);
  useEffect(() => { void loadProfileDetails(selected); }, [selected?.id]);

  const addProfile = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${apiBase}/api/claude-profiles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName, claudeHome: newHome }),
      });
      if (!res.ok) throw new Error("add failed");
      const body = await res.json() as { profile?: ClaudeProfile };
      setNewName(""); setNewHome("");
      const next = await loadProfiles();
      setSelectedId(body.profile?.id ?? next[0]?.id ?? null);
      notify(t("claudeProfiles.added"), true);
    } catch { notify(t("claudeProfiles.addFailed"), false); }
    finally { setBusy(false); }
  };

  const enrollProject = async () => {
    setBusy(true);
    try {
      const root = projectRoot.trim() || ".";
      const res = await fetch(`${apiBase}/api/claude-projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, routingProfileId: projectRoutingProfileId || undefined }),
      });
      if (!res.ok) throw new Error("project enroll failed");
      await loadProjects(root);
      notify(t("claudeProjects.enrolled"), true);
    } catch { notify(t("claudeProjects.enrollFailed"), false); }
    finally { setBusy(false); }
  };

  const runProjectAction = async (action: "restore" | "remove") => {
    const project = currentProject ?? projects[0];
    if (!project?.id) return;
    if (action === "remove" && !window.confirm(t("claudeProjects.removeConfirm", { root: project.root ?? project.id }))) return;
    setBusy(true);
    try {
      const res = await fetch(`${apiBase}/api/claude-projects/${encodeURIComponent(project.id)}${action === "restore" ? "/restore" : ""}`, {
        method: action === "restore" ? "POST" : "DELETE",
      });
      if (!res.ok) throw new Error(`project ${action} failed`);
      await loadProjects(project.root ?? (projectRoot.trim() || "."));
      notify(t(action === "restore" ? "claudeProjects.restored" : "claudeProjects.removed"), true);
    } catch { notify(t(action === "restore" ? "claudeProjects.restoreFailed" : "claudeProjects.removeFailed"), false); }
    finally { setBusy(false); }
  };

  const patchSelected = async (body: Record<string, unknown>, successMessage: string) => {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await fetch(`${apiBase}/api/claude-profiles/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("patch failed");
      await loadProfiles();
      notify(successMessage, true);
    } catch { notify(t("claudeProfiles.saveFailed"), false); }
    finally { setBusy(false); }
  };


  const copyReloadCommand = async () => {
    await navigator.clipboard?.writeText(reloadCommand).catch(() => undefined);
    notify(t("claudeProfiles.reloadCopied"), true);
  };

  const runAction = async (action: "inject" | "restore" | "refresh", options: { globalDiscoveryAuth?: boolean } = {}) => {
    if (!selected) return;
    setBusy(true);
    try {
      const init: RequestInit = { method: "POST" };
      if (options.globalDiscoveryAuth) {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify({ globalDiscoveryAuth: true });
      }
      const res = await fetch(`${apiBase}/api/claude-profiles/${encodeURIComponent(selected.id)}/${action}`, init);
      const body = await res.json().catch(() => ({})) as { message?: string; error?: string; modelReload?: unknown };
      const modelReload = action === "refresh" ? parseModelReload(body.modelReload) : undefined;
      if (!res.ok) {
        if (modelReload) {
          notify(modelReloadMessage(modelReload), false);
          return;
        }
        throw new Error(body.error || action);
      }
      await loadProfiles();
      notify(modelReload ? modelReloadMessage(modelReload) : (body.message || t(ACTION_DONE_KEY[action])), modelReload ? modelReloadOk(modelReload) : true);
    } catch (err) { notify(action === "refresh" ? (err instanceof Error && err.message !== action ? err.message : t("claudeProfiles.refreshProxyDown")) : (err instanceof Error ? err.message : t("claudeProfiles.actionFailed")), false); }
    finally { setBusy(false); }
  };

  const removeSelected = async () => {
    if (!selected || !window.confirm(t("claudeProfiles.removeConfirm", { name: selected.name }))) return;
    setBusy(true);
    try {
      const res = await fetch(`${apiBase}/api/claude-profiles/${encodeURIComponent(selected.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("remove failed");
      const nextProfiles = await loadProfiles();
      await loadProjects(projectRoot.trim() || currentProject?.root || ".");
      setProjectRoutingProfileId(prev => nextProfiles.some(profile => profile.id === prev) ? prev : "");
      notify(t("claudeProfiles.removed"), true);
    } catch { notify(t("claudeProfiles.removeFailed"), false); }
    finally { setBusy(false); }
  };

  const setupGrant = async (label: string): Promise<GrantSetup | null> => {
    setBusy(true);
    try {
      const res = await fetch(`${apiBase}/api/claude-grants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      const body = await res.json().catch(() => ({})) as { grant?: { id?: string; label?: string }; setup?: { command?: string }; error?: unknown };
      if (!res.ok) { notify(grantErrorText(body.error, t("claudeProfiles.grant.createFailed")), false); return null; }
      await loadGrants();
      const command = typeof body.setup?.command === "string" ? body.setup.command.trim() : "";
      if (!command) {
        // Fail-closed: a created grant with no guided-login command is unusable. Never present it as
        // success — the server returns no command when no real Claude executable is available, and
        // nothing was launched.
        notify(t("claudeProfiles.grant.missingCommand"), false);
        return null;
      }
      notify(t("claudeProfiles.grant.createdNotice"), true);
      return {
        command,
        grantId: typeof body.grant?.id === "string" ? body.grant.id : undefined,
        grantLabel: typeof body.grant?.label === "string" ? body.grant.label : undefined,
      };
    } catch {
      notify(t("claudeProfiles.grant.createFailed"), false);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const removeGrant = async (grant: ClaudeGrantSummary) => {
    const bound = grant.boundProviders.length > 0;
    const message = bound
      ? t("claudeProfiles.grant.removeConfirmBound", { label: grant.label, providers: grant.boundProviders.join(", ") })
      : t("claudeProfiles.grant.removeConfirm", { label: grant.label });
    if (!window.confirm(message)) return;
    setBusy(true);
    try {
      // The user already confirmed the dangling consequences above, so a bound grant carries ?confirm=true.
      const url = `${apiBase}/api/claude-grants/${encodeURIComponent(grant.id)}${bound ? "?confirm=true" : ""}`;
      const res = await fetch(url, { method: "DELETE" });
      const body = await res.json().catch(() => ({})) as { warning?: string; error?: unknown; danglingProviders?: unknown };
      if (!res.ok) { notify(grantErrorText(body.error, t("claudeProfiles.grant.removeFailed")), false); return; }
      await loadGrants();
      const dangling = Array.isArray(body.danglingProviders) ? body.danglingProviders.filter((p): p is string => typeof p === "string") : [];
      const base = t("claudeProfiles.grant.removed");
      notify(typeof body.warning === "string" && body.warning ? `${base} ${body.warning}` : base, dangling.length === 0);
    } catch {
      notify(t("claudeProfiles.grant.removeFailed"), false);
    } finally {
      setBusy(false);
    }
  };

  const copyRunCommand = async () => {
    await navigator.clipboard?.writeText(runCommand).catch(() => undefined);
    notify(t("claudeProfiles.copied"), true);
  };

  if (loading) return <div className="row muted"><span className="spin" /> {t("common.loading")}</div>;

  return (
    <div className="models-page">
      <div className="models-hero">
        <div className="models-hero-copy">
          <h2>{t("claudeProfiles.title")}</h2>
          <p>{t("claudeProfiles.subtitle")}</p>
        </div>
        <div className="models-status-card">
          <div className="models-status-label">{t("claudeProfiles.count")}</div>
          <p>{t("claudeProfiles.countValue", { n: profiles.length })}</p>
          <button className="btn btn-ghost btn-sm" type="button" onClick={reload}>{t("models.refreshDashboard")}</button>
        </div>
      </div>

      {status && <Notice tone={ok ? "ok" : "err"}>{status}</Notice>}

      <ClaudeGrantsCard
        t={t}
        grants={grants}
        realClaude={realClaude}
        loadFailed={grantsFailed}
        busy={busy}
        onSetup={setupGrant}
        onRemove={removeGrant}
      />

      <section className="panel" style={{ marginBottom: 18 }}>
        <h3 className="panel-title">{t("claudeProfiles.addTitle")}</h3>
        <div className="settings-grid">
          <label><span>{t("claudeProfiles.name")}</span><input className="input" value={newName} onChange={e => setNewName(e.target.value)} placeholder={t("claudeProfiles.namePlaceholder")} /></label>
          <label><span>{t("claudeProfiles.home")}</span><input className="input" value={newHome} onChange={e => setNewHome(e.target.value)} placeholder="~/.claude-work" /></label>
          <div style={{ alignSelf: "end" }}><button className="btn btn-primary" onClick={addProfile} disabled={busy || !newName.trim() || !newHome.trim()}><IconPlus /> {t("claudeProfiles.add")}</button></div>
        </div>
      </section>

      <div className="model-summary-grid" style={{ marginBottom: 18 }}>
        {profiles.map(profile => (
          <button key={profile.id} type="button" className={`stat profile-card ${selected?.id === profile.id ? "active" : ""}`} onClick={() => setSelectedId(profile.id)} style={{ textAlign: "left" }}>
            <div className="muted">{profile.isDefault ? t("claudeProfiles.defaultBadge") : profile.id}</div>
            <div className="stat-value" style={{ fontSize: 18 }}>{profile.name}</div>
            <div className="muted stat-caption text-anywhere">{profile.claudeHome}</div>
            <div className="muted stat-caption">{profile.injected ? t("claudeProfiles.injected") : t("claudeProfiles.notInjected")} · {t(authStateKey(profile.authState))}</div>
          </button>
        ))}
      </div>

      {selected && (
        <section className="panel model-control-panel">
          <div className="model-control-head">
            <div>
              <h3 className="panel-title model-control-title"><IconBot /> {selected.name}</h3>
              <p className="page-sub model-control-copy">{selected.id} · {selected.claudeHome}</p>
            </div>
            <div className="model-save-group">
              <button className="btn btn-ghost" onClick={() => runAction("inject")} disabled={busy}>{t("claudeProfiles.inject")}</button>
              <button className="btn btn-ghost" onClick={() => runAction("refresh")} disabled={busy}>{t("claudeProfiles.refresh")}</button>
              <button className="btn btn-danger" onClick={() => runAction("refresh", { globalDiscoveryAuth: true })} disabled={busy}>{t("claudeProfiles.globalDiscoveryAuth")}</button>
              <button className="btn btn-ghost" onClick={() => runAction("restore")} disabled={busy}>{t("claudeProfiles.restore")}</button>
            </div>
          </div>

          <div className="model-summary-grid model-summary-strip">
            <div className="stat"><div className="muted">{t("claudeProfiles.lastSeen")}</div><div className="stat-value" style={{ fontSize: 16 }}>{selected.lastSeenAt ?? "—"}</div></div>
            <div className="stat"><div className="muted">{t("claudeProfiles.authState")}</div><div className="stat-value" style={{ fontSize: 16 }}>{t(authStateKey(selected.authState))}</div></div>
            <div className="stat"><div className="muted">{t("claudeProfiles.discoveryAuth")}</div><div className="stat-value" style={{ fontSize: 16 }}>{t(discoveryAuthKey(discoveryAuthMode))}</div><div className="muted stat-caption">{t("claudeProfiles.discoveryAuthHint")}</div></div>
            <div className="stat"><div className="muted">{t("claudeProfiles.preview")}</div><div className="stat-value" style={{ fontSize: 16 }}>{models.filter(m => !m.disabled).length}</div><div className="muted stat-caption">{t("claudeProfiles.previewHint")}</div></div>
          </div>

          <div className="settings-grid" style={{ marginTop: 16 }}>
            <label><span>{t("claudeProfiles.rename")}</span><input className="input" value={renameValue} onChange={e => setRenameValue(e.target.value)} /></label>
            <div style={{ alignSelf: "end" }}><button className="btn btn-primary" onClick={() => patchSelected({ name: renameValue }, t("claudeProfiles.renamed"))} disabled={busy || !renameValue.trim()}>{t("common.save")}</button></div>
          </div>

          <section className="panel-soft" style={{ marginTop: 16 }}>
            <div className="panel-head">
              <div>
                <h3 className="panel-title">{t("claudeProjects.title")}</h3>
                <p className="muted" style={{ fontSize: 13, margin: 0 }}>{t("claudeProjects.subtitle")}</p>
              </div>
              <span className="muted" style={{ fontSize: 12 }}>{t("claudeProjects.safeDefault")}</span>
            </div>
            <div className="settings-grid" style={{ marginTop: 12 }}>
              <label><span>{t("claudeProjects.root")}</span><input className="input" value={projectRoot} onChange={e => setProjectRoot(e.target.value)} onBlur={() => loadProjects().catch(() => undefined)} placeholder={t("claudeProjects.rootPlaceholder")} /></label>
              <label>
                <span>{t("claudeProjects.routingProfile")}</span>
                <select className="input" value={projectRoutingProfileId} onChange={e => setProjectRoutingProfileId(e.target.value)}>
                  <option value="">{t("claudeProjects.routingProfileDefault")}</option>
                  {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select>
              </label>
              <div style={{ alignSelf: "end", display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn btn-primary" type="button" onClick={enrollProject} disabled={busy}>{t("claudeProjects.enroll")}</button>
                <button className="btn btn-ghost" type="button" onClick={() => runProjectAction("restore")} disabled={busy || !currentProject?.id}>{t("claudeProjects.restore")}</button>
                <button className="btn btn-ghost" type="button" onClick={() => runProjectAction("remove")} disabled={busy || !currentProject?.id}>{t("common.remove")}</button>
              </div>
            </div>
            <div className="mini-list" style={{ marginTop: 12 }}>
              <div><span>{t("claudeProjects.settingsPath")}</span><code className="text-anywhere">{currentProject?.settingsPath ?? "—"}</code></div>
              <div><span>{t("claudeProjects.gitProtection")}</span><code>{t(gitProtectionKey(currentProject?.gitProtection))}</code></div>
              <div><span>{t("dev.modelDiscoveryReady")}</span><code>{(currentProject?.gateway?.modelDiscoveryReady ?? currentProject?.modelDiscoveryReady) ? t("common.yes") : t("common.no")}</code></div>
              <div><span>{t("claudeProjects.effectiveSource")}</span><code>{currentProject?.gateway?.effectiveSource ?? currentProject?.effectiveSource ?? "—"}</code></div>
            </div>
            {currentProject?.gitProtection === "tracked" && <Notice tone="err">{t("claudeProjects.trackedBlock")}</Notice>}
            {(currentProject?.danglingRoutingProfileId || (currentProject?.routingProfileId && !profiles.some(profile => profile.id === currentProject.routingProfileId))) && <Notice tone="err">{t("claudeProjects.danglingRoutingHint")}</Notice>}
            <p className="muted" style={{ fontSize: 13 }}>{t("claudeProjects.accountWarning")}</p>
          </section>

          <div className="selected-order-card" style={{ marginTop: 16 }}>
            <div className="selected-order-head">
              <div>
                <h4>{t("claudeProfiles.modelPickerTitle")}</h4>
                <p>{t("claudeProfiles.modelPickerHint", { cmd: reloadCommand })}</p>
              </div>
              <button className="btn btn-primary btn-sm" type="button" onClick={() => navigate("models", "model-visibility-row")}>
                {t("claudeProfiles.openModelPicker")}
              </button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={copyReloadCommand}>
                <IconCheck /> {t("claudeProfiles.copyReload")}
              </button>
            </div>
          </div>


          <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={copyRunCommand}><IconCheck /> {t("claudeProfiles.copyRun")}</button>
            <button className="btn btn-ghost" onClick={removeSelected} disabled={busy || profiles.length <= 1}><IconTrash /> {t("common.remove")}</button>
          </div>
        </section>
      )}
    </div>
  );
}

// ---- Claude grants (Branch B dual-auth) ------------------------------------
// Isolated Claude subscription logins frogprogsy can route through the gateway.
// Readiness and provider bindings lead the UI; scoped credential metadata lives
// behind an Advanced diagnostics disclosure. No token bytes, credential JSON,
// Keychain secrets, emails, or absolute home paths are ever rendered.

export type GrantState = "none" | "ok" | "expiring" | "reauth_required" | "unreadable";

export interface ClaudeGrantSummary {
  id: string;
  label: string;
  state: GrantState;
  expiresAt?: string;
  boundProviders: string[];
  realClaudeReady: boolean;
  statusError?: string;
  reauthCommand?: string;
}

export interface RealClaudeInfo { ready: boolean; name?: string }

export interface ClaudeGrantsPayload { grants: ClaudeGrantSummary[]; realClaude?: RealClaudeInfo }

interface GrantSetup { command: string; grantId?: string; grantLabel?: string }

const GRANT_STATES: GrantState[] = ["none", "ok", "expiring", "reauth_required", "unreadable"];

// A verified real-Claude executable path from the API: $HOME-tokenized or absolute — never a bare
// basename like "claude". A bare basename is treated as not-ready so no guided-login command is built.
export function isVerifiedRealClaudePath(name: string | undefined | null): name is string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed.startsWith("$HOME/") || trimmed.startsWith("/");
}

// Real Claude is usable for guided login only when the API reports ready AND returns a verified
// absolute/$HOME executable path (never a bare "claude").
export function realClaudeReady(realClaude?: RealClaudeInfo): boolean {
  return realClaude?.ready === true && isVerifiedRealClaudePath(realClaude.name);
}

// Safely render a server error that may be a plain string or a { code, message } object, without
// dumping arbitrary object structure (which could carry unexpected fields) into the DOM.
export function grantErrorText(error: unknown, fallback: string): string {
  if (typeof error === "string") return error.trim() || fallback;
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; message?: unknown };
    const message = typeof e.message === "string" ? e.message.trim() : "";
    const code = typeof e.code === "string" ? e.code.trim() : "";
    if (message && code) return `${message} (${code})`;
    return message || code || fallback;
  }
  return fallback;
}

// Accept ISO strings and numeric epochs (seconds or milliseconds) and normalize to a safe ISO display
// string; absurd/unparseable values are dropped rather than rendered raw.
function normalizeGrantExpiresAt(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = Math.abs(value) < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

export function parseGrants(value: unknown): ClaudeGrantsPayload {
  const data = value && typeof value === "object" ? value as { grants?: unknown; realClaude?: unknown } : {};
  const grants = Array.isArray(data.grants) ? data.grants.flatMap((item): ClaudeGrantSummary[] => {
    if (!item || typeof item !== "object") return [];
    const g = item as { id?: unknown; label?: unknown; state?: unknown; expiresAt?: unknown; boundProviders?: unknown; realClaudeReady?: unknown; statusError?: unknown; reauthCommand?: unknown };
    if (typeof g.id !== "string" || typeof g.label !== "string") return [];
    const state: GrantState = GRANT_STATES.includes(g.state as GrantState) ? g.state as GrantState : "unreadable";
    const boundProviders = Array.isArray(g.boundProviders) ? g.boundProviders.filter((p): p is string => typeof p === "string") : [];
    return [{
      id: g.id,
      label: g.label,
      state,
      expiresAt: normalizeGrantExpiresAt(g.expiresAt),
      boundProviders,
      realClaudeReady: g.realClaudeReady === true,
      statusError: typeof g.statusError === "string" ? g.statusError : undefined,
      reauthCommand: typeof g.reauthCommand === "string" && g.reauthCommand.trim() ? g.reauthCommand : undefined,
    }];
  }) : [];
  const rc = data.realClaude && typeof data.realClaude === "object" ? data.realClaude as { ready?: unknown; name?: unknown } : undefined;
  const rcName = rc && typeof rc.name === "string" && isVerifiedRealClaudePath(rc.name) ? rc.name.trim() : undefined;
  const realClaude = rc ? { ready: rc.ready === true, ...(rcName ? { name: rcName } : {}) } : undefined;
  return { grants, realClaude };
}

export function grantStateChip(state: GrantState, t?: TFn): { label: string; cls: string } {
  switch (state) {
    case "ok": return { label: t ? t("claudeProfiles.grant.state.ok") : "Ready", cls: "badge-green" };
    case "expiring": return { label: t ? t("claudeProfiles.grant.state.expiring") : "Expiring soon", cls: "badge-amber" };
    case "reauth_required": return { label: t ? t("claudeProfiles.grant.state.reauthRequired") : "Re-auth required", cls: "badge-amber" };
    case "unreadable": return { label: t ? t("claudeProfiles.grant.state.unreadable") : "Unreadable", cls: "badge-amber" };
    default: return { label: t ? t("claudeProfiles.grant.state.none") : "Not set up", cls: "badge-muted" };
  }
}

export function grantUsable(grant: ClaudeGrantSummary): boolean {
  return grant.realClaudeReady && (grant.state === "ok" || grant.state === "expiring");
}

// The guided re-auth command is built and $HOME-tokenized server-side by the authoritative
// grantSetup() builder and delivered on each grant. The GUI only surfaces that server value
// verbatim and never reconstructs a scoped CLAUDE_CONFIG_DIR path; it returns "" when the server
// withheld the command (no verified real executable), so no re-auth affordance is fabricated.
export function grantReauthCommand(grant: ClaudeGrantSummary): string {
  return typeof grant.reauthCommand === "string" ? grant.reauthCommand : "";
}

export function ClaudeGrantsCard({
  t, grants, realClaude, loadFailed, busy, onSetup, onRemove,
}: {
  t: TFn;
  grants: ClaudeGrantSummary[];
  realClaude?: RealClaudeInfo;
  loadFailed: boolean;
  busy: boolean;
  onSetup: (label: string) => Promise<GrantSetup | null>;
  onRemove: (grant: ClaudeGrantSummary) => void;
}) {
  const [label, setLabel] = useState("");
  const [setup, setSetup] = useState<GrantSetup | null>(null);
  const [openReauthId, setOpenReauthId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const realReady = realClaudeReady(realClaude);

  const copy = (text: string, key: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(key);
  };

  const submitSetup = async () => {
    const trimmed = label.trim();
    if (!trimmed) return;
    const result = await onSetup(trimmed);
    if (result) { setSetup(result); setLabel(""); }
  };

  return (
    <section className="panel" style={{ marginBottom: 18 }} aria-labelledby="claude-grants-title">
      <div className="panel-head">
        <div>
          <h3 className="panel-title" id="claude-grants-title"><IconBot /> {t("claudeProfiles.grants.title")}</h3>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {t("claudeProfiles.grants.subtitle")}
          </p>
        </div>
        <span className={`badge ${realReady ? "badge-green" : "badge-amber"}`}>
          {realReady ? t("claudeProfiles.grants.realReady") : t("claudeProfiles.grants.realMissing")}
        </span>
      </div>

      {loadFailed
        ? <Notice tone="err">{t("claudeProfiles.grants.loadFailed")}</Notice>
        : (
        <>
          {!realReady && (
            <Notice tone="err">
              {isVerifiedRealClaudePath(realClaude?.name)
                ? t("claudeProfiles.grants.executableResolved", { path: realClaude!.name! })
                : t("claudeProfiles.grants.executableHint")}
            </Notice>
          )}

          <div className="stack" style={{ gap: 8, marginTop: 12 }}>
            {grants.length === 0
              ? <div className="empty">{t("claudeProfiles.grants.empty")}</div>
              : grants.map(grant => {
                const chip = grantStateChip(grant.state, t);
                const usable = grantUsable(grant);
                const reauthOpen = openReauthId === grant.id;
                const reauthCmd = grantReauthCommand(grant);
                const canReauth = reauthCmd.length > 0 && realReady;
                return (
                  <div key={grant.id} className="card prov-card">
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, flexWrap: "wrap" }}>
                        <span className="text-anywhere" style={{ fontWeight: 600 }}>{grant.label}</span>
                        <span className={`badge ${chip.cls}`}>{chip.label}</span>
                        <span className={`badge ${usable ? "badge-green" : "badge-muted"}`}>{usable ? t("claudeProfiles.grant.usable") : t("claudeProfiles.grant.blocked")}</span>
                      </div>
                      <div className="muted text-anywhere" style={{ fontSize: 13 }}><code className="chip">{grant.id}</code></div>
                      <div className="mini-list">
                        <div><span>{t("claudeProfiles.grant.boundProviders")}</span><code className="text-anywhere">{grant.boundProviders.length ? grant.boundProviders.join(", ") : t("claudeProfiles.grant.none")}</code></div>
                        <div><span>{t("claudeProfiles.grant.realClaude")}</span><code>{grant.realClaudeReady ? t("claudeProfiles.grant.ready") : t("claudeProfiles.grant.notVerified")}</code></div>
                      </div>
                      {canReauth && reauthOpen && (
                        <div className="panel-soft" style={{ marginTop: 10 }}>
                          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
                            {t("claudeProfiles.grant.reauthHint")}
                          </p>
                          <code className="text-anywhere" style={{ display: "block" }}>{reauthCmd}</code>
                          <button className="btn btn-ghost btn-sm" type="button" style={{ marginTop: 8 }} onClick={() => copy(reauthCmd, `reauth:${grant.id}`)}>
                            <IconCheck /> {copied === `reauth:${grant.id}` ? t("claudeProfiles.grant.copied") : t("claudeProfiles.grant.copyCommand")}
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="row" style={{ gap: 8, flexShrink: 0 }}>
                      {canReauth && (
                        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setOpenReauthId(reauthOpen ? null : grant.id)} aria-expanded={reauthOpen} aria-label={t("claudeProfiles.grant.reauthAria", { label: grant.label })}>
                          {reauthOpen ? t("claudeProfiles.grant.hideGuide") : t("claudeProfiles.grant.reauthGuide")}
                        </button>
                      )}
                      <button className="btn btn-danger btn-sm" type="button" disabled={busy} onClick={() => onRemove(grant)} aria-label={t("claudeProfiles.grant.removeAria", { label: grant.label })}>
                        <IconTrash /> {t("common.remove")}
                      </button>
                    </div>
                  </div>
                );
              })}
          </div>

          <div className="settings-grid" style={{ marginTop: 16 }}>
            <label>
              <span>{t("claudeProfiles.grant.newLabel")}</span>
              <input className="input" value={label} onChange={e => setLabel(e.target.value)} placeholder={t("claudeProfiles.grant.newLabelPlaceholder")} aria-label={t("claudeProfiles.grant.newLabelAria")} />
            </label>
            <div style={{ alignSelf: "end" }}>
              <button className="btn btn-primary" type="button" onClick={() => void submitSetup()} disabled={busy || !label.trim() || !realReady}>
                <IconPlus /> {t("claudeProfiles.grant.setup")}
              </button>
            </div>
          </div>

          {setup && (
            <div className="panel-soft" style={{ marginTop: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                <span style={{ fontWeight: 650 }}>{t("claudeProfiles.grant.createdTitle", { label: setup.grantLabel ? t("claudeProfiles.grant.createdLabelSuffix", { label: setup.grantLabel }) : "" })}</span>
                {setup.grantId && <code className="chip">{setup.grantId}</code>}
              </div>
              <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
                {t("claudeProfiles.grant.setupHint")}
              </p>
              <code className="text-anywhere" style={{ display: "block" }}>{setup.command}</code>
              <button className="btn btn-ghost btn-sm" type="button" style={{ marginTop: 8 }} onClick={() => copy(setup.command, "setup")}>
                <IconCheck /> {copied === "setup" ? t("claudeProfiles.grant.copied") : t("claudeProfiles.grant.copyCommand")}
              </button>
            </div>
          )}

          <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
            {t("claudeProfiles.grant.risk")}
          </p>

          {grants.length > 0 && (
            <details className="setup-guide" style={{ marginTop: 12 }}>
              <summary>{t("claudeProfiles.grant.diagnostics")}</summary>
              <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                {t("claudeProfiles.grant.diagnosticsHint")}
              </p>
              <div className="fallback-grid" style={{ marginTop: 8 }}>
                {grants.map(grant => (
                  <div key={grant.id} className="mini-list">
                    <div><span>{t("claudeProfiles.grant.label")}</span><code className="text-anywhere">{grant.label} · {grant.id}</code></div>
                    <div><span>{t("claudeProfiles.grant.state")}</span><code>{grant.state}</code></div>
                    <div><span>{t("claudeProfiles.grant.expires")}</span><code>{grant.expiresAt ?? "—"}</code></div>
                    <div><span>{t("claudeProfiles.grant.source")}</span><code>{t("claudeProfiles.grant.sourceScoped")}</code></div>
                    {grant.statusError && <div><span>{t("claudeProfiles.grant.statusNote")}</span><code>{grant.statusError}</code></div>}
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
