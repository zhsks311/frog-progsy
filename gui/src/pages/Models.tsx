import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { Switch, Notice } from "../ui";
import { IconArrowDown, IconArrowUp, IconCheck, IconChevron, IconSearch } from "../icons";
import { useT, Trans } from "../i18n";
import type { DeepLinkTarget } from "../navigation";

interface ModelRow { provider: string; id: string; namespaced: string; disabled: boolean; authReady: boolean }
interface FeaturedModelsResponse { available?: string[]; chosen?: string[] }
interface ModelControlRow { provider: string | null; id: string; namespaced: string; disabled: boolean; canHide: boolean; authReady: boolean }
interface ProviderVisibilitySummary { provider: string; visible: number; hidden: number }

function parseModelRows(value: unknown): ModelRow[] {
  if (!Array.isArray(value)) throw new Error("models response must be an array");
  return value.map(item => {
    if (!item || typeof item !== "object") throw new Error("invalid model row");
    const row = item as Partial<ModelRow>;
    if (typeof row.provider !== "string" || typeof row.id !== "string" || typeof row.namespaced !== "string") {
      throw new Error("invalid model row");
    }
    return {
      provider: row.provider,
      id: row.id,
      namespaced: row.namespaced,
      disabled: row.disabled === true,
      authReady: row.authReady !== false,
    };
  });
}

function parseFeaturedModels(value: unknown): Required<FeaturedModelsResponse> {
  if (!value || typeof value !== "object") throw new Error("featured models response must be an object");
  const data = value as FeaturedModelsResponse;
  if (!Array.isArray(data.available) || !data.available.every(item => typeof item === "string")) {
    throw new Error("invalid featured available models");
  }
  if (!Array.isArray(data.chosen) || !data.chosen.every(item => typeof item === "string")) {
    throw new Error("invalid featured chosen models");
  }
  return { available: data.available, chosen: data.chosen };
}

function splitModelName(model: string): { provider: string | null; id: string } {
  const slash = model.indexOf("/");
  if (slash <= 0) return { provider: null, id: model };
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

export default function Models({ apiBase, target }: { apiBase: string; target?: DeepLinkTarget | null }) {
  const t = useT();
  const [models, setModels] = useState<ModelRow[]>([]);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const [featuredAvailable, setFeaturedAvailable] = useState<string[]>([]);
  const [featuredChosen, setFeaturedChosen] = useState<string[]>([]);
  const [featuredQuery, setFeaturedQuery] = useState("");
  const [featuredStatus, setFeaturedStatus] = useState("");
  const [featuredOk, setFeaturedOk] = useState(false);
  const [featuredLoading, setFeaturedLoading] = useState(true);
  const [featuredSaving, setFeaturedSaving] = useState(false);
  const [featuredDirty, setFeaturedDirty] = useState(false);
  const [draggedFeatured, setDraggedFeatured] = useState<string | null>(null);
  const [dragOverFeatured, setDragOverFeatured] = useState<string | null>(null);
  const featuredDirtyRef = useRef(false);
  const featuredSavingRef = useRef(false);
  const featuredLoadSeqRef = useRef(0);
  const modelControlsRef = useRef<HTMLElement | null>(null);

  const loadFeatured = async (force = false) => {
    if (!force && (featuredDirtyRef.current || featuredSavingRef.current)) return;
    const requestId = ++featuredLoadSeqRef.current;
    try {
      const res = await fetch(`${apiBase}/api/subagent-models`);
      if (!res.ok) throw new Error("featured load failed");
      const data = parseFeaturedModels(await res.json());
      if (requestId !== featuredLoadSeqRef.current) return;
      if (!force && (featuredDirtyRef.current || featuredSavingRef.current)) return;
      setFeaturedAvailable(data.available);
      setFeaturedChosen(data.chosen.filter(model => data.available.includes(model)));
      featuredDirtyRef.current = false;
      setFeaturedDirty(false);
    } catch {
      setFeaturedOk(false);
      setFeaturedStatus(t("models.featuredLoadFail"));
    } finally {
      setFeaturedLoading(false);
    }
  };

  const load = async () => {
    try {
      const res = await fetch(`${apiBase}/api/models`);
      if (!res.ok) throw new Error("models load failed");
      const data = parseModelRows(await res.json());
      setModels(data);
      setDisabled(new Set(data.filter(m => m.disabled).map(m => m.namespaced)));
    } catch {
      setOk(false); setStatus(t("models.loadFail"));
    } finally {
      setLoading(false);
    }
  };

  const refreshAll = () => {
    setLoading(true);
    load();
    loadFeatured(true);
  };

  useEffect(() => {
    load();
    loadFeatured(true);
    // Provider models resolve lazily (live /models + OAuth tokens), so a provider that wasn't ready
    // on first load would otherwise stay missing until a manual remove/re-add.
    // Re-poll to pick it up; skip while a toggle PUT is in flight to avoid clobbering.
    const timer = setInterval(() => { if (!busyRef.current) { load(); loadFeatured(); } }, 10000);
    return () => clearInterval(timer);
  }, [apiBase]);

  useEffect(() => {
    if (target === "model-visibility-row") modelControlsRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    if (target === "model-refresh") {
      modelControlsRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
      refreshAll();
    }
  }, [target]);

  const activeCount = models.filter(model => !disabled.has(model.namespaced) && model.authReady).length;
  const providerHiddenSummaries = useMemo<ProviderVisibilitySummary[]>(() => {
    const summaries = new Map<string, ProviderVisibilitySummary>();
    for (const model of models) {
      const summary = summaries.get(model.provider) ?? { provider: model.provider, visible: 0, hidden: 0 };
      if (disabled.has(model.namespaced)) summary.hidden += 1;
      else if (model.authReady) summary.visible += 1;
      summaries.set(model.provider, summary);
    }
    return [...summaries.values()]
      .filter(summary => summary.hidden > 0)
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }, [models, disabled]);

  const providerHiddenSummaryText = providerHiddenSummaries
    .map(summary => t("models.providerHiddenSummaryItem", {
      provider: summary.provider,
      visible: summary.visible,
      hidden: summary.hidden,
    }))
    .join("; ");
  const hiddenCount = disabled.size;
  const authUnavailableCount = models.filter(model => !disabled.has(model.namespaced) && !model.authReady).length;
  const requiresAttention = hiddenCount > 0 || authUnavailableCount > 0;
  const featuredSelected = useMemo(() => new Set(featuredChosen), [featuredChosen]);

  const controlRows = useMemo<ModelControlRow[]>(() => {
    const rows: ModelControlRow[] = [];
    const seen = new Set<string>();
    for (const model of models) {
      seen.add(model.namespaced);
      rows.push({
        provider: model.provider,
        id: model.id,
        namespaced: model.namespaced,
        disabled: disabled.has(model.namespaced),
        canHide: true,
        authReady: model.authReady,
      });
    }
    for (const model of featuredAvailable) {
      if (seen.has(model)) continue;
      const parts = splitModelName(model);
      rows.push({
        provider: parts.provider,
        id: parts.id,
        namespaced: model,
        disabled: false,
        canHide: false,
        authReady: true,
      });
    }
    return rows;
  }, [models, disabled, featuredAvailable]);

  const featuredRows = useMemo<ModelControlRow[]>(() => {
    const byName = new Map(controlRows.map(row => [row.namespaced, row]));
    return featuredChosen.map(model => {
      const row = byName.get(model);
      if (row) return row;
      const parts = splitModelName(model);
      return {
        provider: parts.provider,
        id: parts.id,
        namespaced: model,
        disabled: false,
        canHide: false,
        authReady: true,
      };
    });
  }, [controlRows, featuredChosen]);

  const filteredRows = useMemo(() => {
    const q = featuredQuery.trim().toLowerCase();
    return controlRows.filter(row => !q || row.namespaced.toLowerCase().includes(q));
  }, [controlRows, featuredQuery]);

  const groupedRows = useMemo(() => {
    const groups = new Map<string, ModelControlRow[]>();
    for (const row of filteredRows) {
      const key = row.provider ?? "__claude_code__";
      const bucket = groups.get(key) ?? [];
      bucket.push(row);
      groups.set(key, bucket);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filteredRows]);


  const apply = async (next: Set<string>, nextFeatured?: string[]) => {
    setBusy(true);
    busyRef.current = true;
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/disabled-models`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: [...next] }),
      });
      if (r.ok) {
        setDisabled(next);
        setOk(true);
        setStatus(t("models.applied"));
        if (nextFeatured) {
          setFeaturedChosen(nextFeatured);
          void saveFeatured(nextFeatured);
        } else {
          loadFeatured();
        }
      }
      else { setOk(false); setStatus(t("models.saveFailed")); }
    } catch {
      setOk(false); setStatus(t("models.networkError"));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };

  const saveFeatured = async (modelsToSave = featuredChosen) => {
    if (modelsToSave === featuredChosen && !featuredDirtyRef.current) {
      setFeaturedOk(true);
      setFeaturedStatus(t("models.priorityNoChanges"));
      return;
    }
    const visibleModels = modelsToSave.filter(model => !disabled.has(model));
    setFeaturedStatus("");
    setFeaturedSaving(true);
    featuredSavingRef.current = true;
    try {
      const res = await fetch(`${apiBase}/api/subagent-models`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: visibleModels }),
      });
      const data = await res.json().catch(() => ({})) as { applied?: unknown; error?: string };
      const applied = Array.isArray(data.applied)
        ? data.applied.filter((model): model is string => typeof model === "string")
        : visibleModels;
      setFeaturedOk(res.ok);
      if (res.ok) {
        setFeaturedChosen(applied);
        featuredDirtyRef.current = false;
        setFeaturedDirty(false);
      }
      setFeaturedStatus(res.ok
        ? t("models.featuredSaved", { n: applied.length, cmd: "frogp refresh" })
        : (data.error || t("models.featuredSaveFailed")));
    } catch {
      setFeaturedOk(false);
      setFeaturedStatus(t("models.featuredNetworkError"));
    } finally {
      setFeaturedSaving(false);
      featuredSavingRef.current = false;
    }
  };

  const saveFeaturedChanges = () => {
    void saveFeatured();
  };

  const featuredAfterVisibilityChange = (nextDisabled: Set<string>): string[] | undefined => {
    const nextFeatured = featuredChosen.filter(model => !nextDisabled.has(model));
    return nextFeatured.length === featuredChosen.length ? undefined : nextFeatured;
  };

  const toggle = (row: ModelControlRow) => {
    if (!row.canHide) return;
    const next = new Set(disabled);
    if (next.has(row.namespaced)) next.delete(row.namespaced); else next.add(row.namespaced);
    apply(next, featuredAfterVisibilityChange(next));
  };

  const toggleProvider = (rows: ModelControlRow[], enable: boolean) => {
    const next = new Set(disabled);
    for (const row of rows) {
      if (!row.canHide) continue;
      if (enable) next.delete(row.namespaced); else next.add(row.namespaced);
    }
    apply(next, featuredAfterVisibilityChange(next));
  };

  const toggleCollapse = (p: string) => {
    setCollapsed(prev => { const n = new Set(prev); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  };

  const toggleFeatured = (row: ModelControlRow) => {
    if (row.disabled) return;
    if (!row.authReady && !featuredChosen.includes(row.namespaced)) return;
    setFeaturedStatus("");
    setFeaturedChosen(prev => {
      if (prev.includes(row.namespaced)) {
        setFeaturedDirty(true);
        featuredDirtyRef.current = true;
        return prev.filter(item => item !== row.namespaced);
      }
      featuredDirtyRef.current = true;
      setFeaturedDirty(true);
      return [...prev, row.namespaced];
    });
  };

  const reorderFeatured = (from: string, to: string) => {
    if (!from || from === to) return;
    setFeaturedChosen(prev => {
      const fromIndex = prev.indexOf(from);
      const toIndex = prev.indexOf(to);
      if (fromIndex < 0 || toIndex < 0) return prev;
      const next = [...prev];
      const [item] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, item);
      featuredDirtyRef.current = true;
      setFeaturedDirty(true);
      return next;
    });
  };

  const handleFeaturedDragStart = (event: DragEvent<HTMLDivElement>, model: string) => {
    if (featuredSaving) {
      event.preventDefault();
      return;
    }
    setDraggedFeatured(model);
    setDragOverFeatured(model);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", model);
  };

  const handleFeaturedDragOver = (event: DragEvent<HTMLDivElement>, model: string) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverFeatured(model);
  };

  const handleFeaturedDrop = (event: DragEvent<HTMLDivElement>, model: string) => {
    event.preventDefault();
    const source = draggedFeatured || event.dataTransfer.getData("text/plain");
    reorderFeatured(source, model);
    setDraggedFeatured(null);
    setDragOverFeatured(null);
  };

  const handleFeaturedDragEnd = () => {
    setDraggedFeatured(null);
    setDragOverFeatured(null);
  };

  const moveFeatured = (index: number, dir: -1 | 1) => {
    setFeaturedChosen(prev => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      setFeaturedDirty(true);
      featuredDirtyRef.current = true;
      return next;
    });
  };

  if (loading) return <div className="row muted"><span className="spin" /> {t("models.loading")}</div>;

  return (
    <div className="models-page">
      <div className="models-hero">
        <div className="models-hero-copy">
          <h2>{t("models.controlTitle")}</h2>
          <p>{t("models.subtitle")}</p>
        </div>
        <div className={`models-status-card${requiresAttention ? " warn" : ""}`}>
          <div className="models-status-label">{requiresAttention ? t("models.statusReview") : t("models.statusOk")}</div>
          <p>{requiresAttention
            ? t("models.statusAttention", { visible: activeCount, hidden: hiddenCount, unavailable: authUnavailableCount })
            : t("models.statusReady", { n: activeCount })}</p>
          <button className="btn btn-ghost btn-sm" type="button" onClick={refreshAll}>{t("models.refreshDashboard")}</button>
        </div>
      </div>

      {status && <Notice tone={ok ? "ok" : "err"}>{status}</Notice>}

      <section ref={modelControlsRef} className="panel model-control-panel">
        <div className="model-summary-grid model-summary-strip">
          <div className="stat"><div className="muted">{t("models.summary.visible")}</div><div className="stat-value">{activeCount}</div><div className="muted stat-caption">{t("models.summary.visibleHint")}</div></div>
          <div className="stat"><div className="muted">{t("models.summary.authUnavailable")}</div><div className="stat-value">{authUnavailableCount}</div><div className="muted stat-caption">{t("models.summary.authUnavailableHint")}</div></div>
          <div className="stat"><div className="muted">{t("models.summary.hidden")}</div><div className="stat-value">{hiddenCount}</div><div className="muted stat-caption">{hiddenCount > 0 ? t("models.visibilityHiddenCount", { n: hiddenCount }) : t("models.visibilityAllShown")}</div></div>
          <div className="stat"><div className="muted">{t("models.summary.featured")}</div><div className="stat-value accent-value">{featuredChosen.length}</div><div className="muted stat-caption">{t("models.summary.featuredHint")}</div></div>
        </div>

        {providerHiddenSummaries.length > 0 && (
          <Notice tone="err">
            {t("models.providerHiddenNotice", { providers: providerHiddenSummaryText, cmd: "frogp doctor claude" })}
          </Notice>
        )}

        <div className="model-control-head">
          <div>
            <h3 className="panel-title model-control-title">{t("models.controlListTitle")}</h3>
            <p className="page-sub model-control-copy">{t("models.controlHint")} {t("models.visibilityAutoSave")} {t("models.priorityManualSave")} {t("models.pickerRecoveryHint")}</p>
          </div>
          <div className="featured-meter" aria-label={t("models.featuredCount", { n: featuredChosen.length })}>
            <div className="featured-meter-count">{t("models.featuredCount", { n: featuredChosen.length })}</div>
          </div>
        </div>

        {featuredStatus && <Notice tone={featuredOk ? "ok" : "err"}>{featuredStatus}</Notice>}

        {!featuredLoading && (
          <div className="selected-order-card">
            <div className="selected-order-head">
              <div>
                <h4>{t("models.orderTitle")}</h4>
                <p>{t("models.orderHint")}</p>
              </div>
            </div>
            {featuredRows.length === 0 ? (
              <div className="selected-order-empty">{t("models.orderEmpty")}</div>
            ) : (
              <div className="selected-order-list">
                {featuredRows.map((row, index) => (
                  <div
                    key={row.namespaced}
                    className={`selected-order-item${draggedFeatured === row.namespaced ? " dragging" : ""}${dragOverFeatured === row.namespaced && draggedFeatured !== row.namespaced ? " drop-target" : ""}`}
                    draggable={!featuredSaving}
                    onDragStart={event => handleFeaturedDragStart(event, row.namespaced)}
                    onDragOver={event => handleFeaturedDragOver(event, row.namespaced)}
                    onDrop={event => handleFeaturedDrop(event, row.namespaced)}
                    onDragEnd={handleFeaturedDragEnd}
                    aria-label={t("models.orderItemAria", { n: index + 1, model: row.namespaced })}
                  >
                    <div className="drag-handle" aria-hidden="true">⋮⋮</div>
                    <div className="selected-order-rank">{index + 1}</div>
                    <div className="selected-order-main">
                      <div className="model-control-name">
                        <code className="mono text-anywhere">{row.id}</code>
                        {row.provider && <span className="model-provider-tag">{row.provider}</span>}
                        {!row.authReady && <span className="badge badge-amber">{t("models.authLoginRequired")}</span>}
                      </div>
                      <div className="model-control-meta">
                        {row.authReady
                          ? t("models.orderDragHint")
                          : <Trans k="models.authNotReadyMeta" cmd={row.provider ? `frogp login ${row.provider}` : "frogp login"} />}
                      </div>
                    </div>
                    <div className="selected-order-actions">
                      <button className="btn btn-ghost btn-icon btn-sm" onClick={() => moveFeatured(index, -1)} disabled={index === 0 || featuredSaving} aria-label={t("models.featuredMoveUp", { m: row.namespaced })}>
                        <IconArrowUp />
                      </button>
                      <button className="btn btn-ghost btn-icon btn-sm" onClick={() => moveFeatured(index, 1)} disabled={index === featuredRows.length - 1 || featuredSaving} aria-label={t("models.featuredMoveDown", { m: row.namespaced })}>
                        <IconArrowDown />
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => toggleFeatured(row)} disabled={featuredSaving}>
                        {t("models.orderRemove")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="model-control-toolbar">
          <div className="featured-search">
            <IconSearch />
            <input
              className="input"
              value={featuredQuery}
              onChange={e => setFeaturedQuery(e.target.value)}
              placeholder={t("models.controlSearch")}
            />
          </div>
          <div className="model-save-group">
            {featuredDirty && <span className="model-save-note">{t("models.priorityDirty")}</span>}
            <button className="btn btn-primary" onClick={saveFeaturedChanges} disabled={featuredSaving || !featuredDirty}>
              {featuredSaving ? t("prov.savingDefault") : t("models.prioritySave")}
            </button>
          </div>
        </div>

        {featuredLoading ? (
          <div className="row muted"><span className="spin" /> {t("models.featuredLoading")}</div>
        ) : groupedRows.length === 0 ? (
          <div className="empty">{t("models.controlNoModels")}</div>
        ) : (
          <div className="model-control-groups">
            {groupedRows.map(([providerKey, rows]) => {
              const isCollapsed = collapsed.has(providerKey);
              const hideableRows = rows.filter(row => row.canHide);
              const groupActiveCount = rows.filter(row => !row.disabled && row.authReady).length;
              const percent = rows.length === 0 ? "0%" : `${Math.round((groupActiveCount / rows.length) * 100)}%`;
              const providerLabel = providerKey === "__claude_code__" ? t("models.providerClaudeCode") : providerKey;
              return (
                <section key={providerKey} className="model-provider-card">
                  <div
                    onClick={() => toggleCollapse(providerKey)}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCollapse(providerKey); } }}
                    role="button"
                    tabIndex={0}
                    className="model-provider-head"
                  >
                    <IconChevron className="model-provider-chevron" style={{ transform: isCollapsed ? "none" : "rotate(90deg)" }} />
                    <div className="model-provider-title">
                      <span>{providerLabel}</span>
                      <span className="model-account-badge">{t("models.accountBadge")}</span>
                      <span className="muted mono">{t("models.active", { active: groupActiveCount, total: rows.length })}</span>
                    </div>
                    <div className="provider-meter" aria-hidden="true"><span style={{ width: percent }} /></div>
                    {hideableRows.length > 0 && (
                      <div className="model-provider-actions">
                        <button onClick={e => { e.stopPropagation(); toggleProvider(rows, true); }} disabled={busy} className="btn btn-ghost btn-sm">{t("models.allOn")}</button>
                        <button onClick={e => { e.stopPropagation(); toggleProvider(rows, false); }} disabled={busy} className="btn btn-ghost btn-sm">{t("models.allOff")}</button>
                      </div>
                    )}
                  </div>
                  {!isCollapsed && (
                    <div className="model-list model-control-list">
                      {rows.map(row => {
                        const selected = featuredSelected.has(row.namespaced);
                        const rank = featuredChosen.indexOf(row.namespaced);
                        const priorityDisabled = featuredSaving || row.disabled || (!row.authReady && !selected);
                        const loginCmd = row.provider ? `frogp login ${row.provider}` : "frogp login";
                        const priorityLabel = row.disabled
                          ? t("models.priorityHidden")
                          : selected
                            ? t("models.prioritySelected", { n: rank + 1 })
                            : !row.authReady
                              ? t("models.authLoginRequired")
                              : t("models.priorityAdd");
                        return (
                          <div key={row.namespaced} className={`visibility-model-row model-control-row${row.disabled ? " disabled" : ""}${selected ? " prioritized" : ""}`}>
                            <Switch on={!row.disabled} onClick={() => toggle(row)} disabled={busy || !row.canHide} label={t("models.visibilityToggle", { model: row.namespaced })} />
                            <div className="model-control-main">
                              <div className="model-control-name">
                                <code className="mono text-anywhere">{row.id}</code>
                                {row.provider && <span className="model-provider-tag">{row.provider}</span>}
                                {!row.canHide && <span className="badge badge-muted">{t("models.builtinBadge")}</span>}
                                {!row.authReady && <span className="badge badge-amber">{t("models.authLoginRequired")}</span>}
                              </div>
                              <div className="model-control-meta">
                                {!row.authReady
                                  ? <Trans k="models.authNotReadyMeta" cmd={loginCmd} />
                                  : row.disabled ? t("models.rowHidden") : t("models.rowVisible")}
                              </div>
                            </div>
                            <div className="model-row-actions">
                              <button
                                className={`btn btn-sm ${selected ? "btn-ghost" : "btn-primary"}`}
                                onClick={() => toggleFeatured(row)}
                                disabled={priorityDisabled}
                              >
                                {selected && <IconCheck />}
                                {priorityLabel}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </section>

      {controlRows.length === 0 && (
        <div className="empty">
          <div className="title">{t("models.noRouted")}</div>
          <div style={{ fontSize: 13 }}>{t("models.noRoutedHint")}</div>
        </div>
      )}
    </div>
  );
}
