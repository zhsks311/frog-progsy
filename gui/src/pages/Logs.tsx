import { Fragment, useEffect, useMemo, useState } from "react";
import { useI18n, LOCALES } from "../i18n";
import { DASH, primitiveDiagnosticText as primitiveText, safeDiagnosticLabel } from "../diagnostic-labels";
import type { Navigate } from "../navigation";

type LogRecord = Record<string, unknown>;
type StatusFilter = "all" | "ok" | "error" | "pending" | "other";

interface LogEntry extends LogRecord {
  id?: unknown;
  startedAt?: string | number;
  finalizedAt?: string | number;
  timestamp?: string | number;
  model?: unknown;
  provider?: unknown;
  route?: unknown;
  routeModel?: unknown;
  routeProvider?: unknown;
  lifecycle?: unknown;
  lifecycleStatus?: unknown;
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  endpoint?: unknown;
  method?: unknown;
  durationMs?: unknown;
  duration?: unknown;
  request?: unknown;
  upstream?: unknown;
  structuredError?: unknown;
  error?: unknown;
  errorSummary?: unknown;
  phases?: unknown;
  phaseSummary?: unknown;
  phaseCounts?: unknown;
  fallbacks?: unknown;
}

const ENDPOINT_LABELS = new Map([
  ["/v1/messages", "messages"],
  ["/v1/messages/count_tokens", "count tokens"],
  ["/messages/count_tokens", "count tokens"],
  ["/v1/responses", "responses"],
  ["/v1/chat/completions", "chat completions"],
  ["/chat/completions", "chat completions"],
  ["/messages", "messages"],
  ["/responses", "responses"],
]);

function asRecord(value: unknown): LogRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as LogRecord : undefined;
}

function safeLabel(value: unknown, options: { allowSlash?: boolean; max?: number } = {}): string | undefined {
  return safeDiagnosticLabel(value, options);
}

function formatTimestamp(log: LogEntry, localeTag?: string): string {
  const value = log.startedAt ?? log.timestamp;
  const date = typeof value === "number"
    ? new Date(value)
    : typeof value === "string"
      ? new Date(value)
      : undefined;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString(localeTag) : DASH;
}

function statusValue(log: LogEntry): unknown {
  const lifecycle = asRecord(log.lifecycle);
  const lifecycleStatus = lifecycle?.statusCode ?? lifecycle?.status ?? lifecycle?.code ?? primitiveText(log.lifecycle);
  return log.statusCode ?? lifecycleStatus ?? log.lifecycleStatus ?? log.status ?? log.code;
}

function numericStatus(log: LogEntry): number | undefined {
  const value = statusValue(log);
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatStatus(log: LogEntry): string {
  return safeLabel(statusValue(log), { allowSlash: false, max: 32 }) ?? DASH;
}

function statusKind(log: LogEntry): StatusFilter {
  const lifecycle = safeLabel(log.lifecycle, { allowSlash: false, max: 40 })?.toLowerCase() ?? "";
  if (lifecycle === "in_progress") return "pending";
  const status = numericStatus(log);
  if (status !== undefined) {
    if (status >= 200 && status < 300) return "ok";
    if (status >= 400) return "error";
    return "other";
  }
  if (formatStructuredError(log) !== DASH || /error|abort|timeout|cancel/.test(lifecycle)) return "error";
  if (lifecycle === "completed") return "ok";
  return "other";
}

function endpointLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const endpoint = value.trim().split(/[?#]/, 1)[0];
  if (!endpoint) return undefined;
  const known = ENDPOINT_LABELS.get(endpoint);
  if (known) return known;
  if (endpoint.startsWith("/")) return undefined;
  return safeLabel(endpoint, { allowSlash: false, max: 60 });
}

function formatEndpoint(log: LogEntry): string {
  const method = safeLabel(log.method, { allowSlash: false, max: 12 });
  const endpoint = endpointLabel(log.endpoint);
  return [method, endpoint].filter(Boolean).join(" ") || DASH;
}

function formatProvider(log: LogEntry): string {
  const route = asRecord(log.route);
  return safeLabel(route?.providerLabel ?? route?.provider ?? log.routeProvider ?? log.provider, { allowSlash: true }) ?? DASH;
}

function formatModel(log: LogEntry): string {
  const route = asRecord(log.route);
  const requested = safeLabel(route?.requestedModelLabel ?? log.routeModel ?? log.model, { allowSlash: true, max: 120 });
  const routed = safeLabel(route?.routedModelLabel ?? route?.modelLabel ?? route?.model, { allowSlash: true, max: 120 });
  return requested && routed && requested !== routed ? `${requested} → ${routed}` : routed ?? requested ?? DASH;
}

function formatDuration(log: LogEntry): string {
  const duration = asRecord(log.duration);
  const value = log.durationMs ?? duration?.ms ?? log.duration;
  if (typeof value === "number" && Number.isFinite(value)) return `${Math.round(value)}ms`;
  const safe = safeLabel(value, { allowSlash: false, max: 24 });
  return safe ? (/\d$/.test(safe) ? `${safe}ms` : safe) : DASH;
}

function formatStructuredError(log: LogEntry): string {
  const structured = asRecord(log.structuredError) ?? asRecord(log.errorSummary) ?? asRecord(log.error);
  const kind = safeLabel(structured?.kind ?? log.errorKind, { allowSlash: false, max: 48 });
  const code = safeLabel(structured?.code ?? log.errorCode, { allowSlash: false, max: 48 });
  const upstreamStatus = safeLabel(structured?.upstreamStatus ?? structured?.status, { allowSlash: false, max: 16 });
  const parts = [
    kind ? `kind:${kind}` : undefined,
    code ? `code:${code}` : undefined,
    upstreamStatus ? `upstream:${upstreamStatus}` : undefined,
  ].filter(Boolean);
  return parts.join(" · ") || DASH;
}

function phaseItem(label: unknown, value: unknown): string | undefined {
  const safeName = safeLabel(label, { allowSlash: false, max: 40 });
  if (!safeName) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return `${safeName}:${value}`;
  const record = asRecord(value);
  if (!record) {
    const safeValue = safeLabel(value, { allowSlash: false, max: 32 });
    return safeValue ? `${safeName}:${safeValue}` : undefined;
  }
  const status = safeLabel(record.status ?? record.code, { allowSlash: false, max: 32 });
  const count = typeof record.count === "number" && Number.isFinite(record.count) ? `×${record.count}` : undefined;
  return [safeName, status, count].filter(Boolean).join(" ");
}

function formatPhaseSummary(log: LogEntry): string {
  const source = log.phaseSummary ?? log.phaseCounts ?? log.phases;
  if (Array.isArray(source)) {
    const parts = source.slice(0, 6).map((phase, index) => {
      const record = asRecord(phase);
      return record
        ? phaseItem(record.phase ?? record.name ?? `phase${index + 1}`, record)
        : undefined;
    }).filter(Boolean);
    return parts.join(" · ") || DASH;
  }

  const record = asRecord(source);
  if (!record) return DASH;
  const parts = Object.entries(record).slice(0, 6).map(([key, value]) => phaseItem(key, value)).filter(Boolean);
  return parts.join(" · ") || DASH;
}

function optionValues(logs: LogEntry[], format: (log: LogEntry) => string): string[] {
  return [...new Set(logs.map(format).filter(value => value && value !== DASH))].sort((a, b) => a.localeCompare(b));
}

function rowKey(log: LogEntry, index: number): string {
  return safeLabel(log.id, { allowSlash: true, max: 120 }) ?? `${String(log.startedAt ?? log.timestamp ?? "log")}-${index}`;
}

function detailJson(log: LogEntry): string {
  const route = asRecord(log.route);
  const upstream = asRecord(log.upstream);
  return JSON.stringify({
    time: {
      startedAt: log.startedAt ?? log.timestamp ?? null,
      finalizedAt: log.finalizedAt ?? null,
      durationMs: log.durationMs ?? asRecord(log.duration)?.ms ?? null,
    },
    request: {
      method: safeLabel(log.method, { allowSlash: false, max: 12 }) ?? null,
      endpoint: safeLabel(log.endpoint, { allowSlash: true, max: 80 }) ?? null,
      bytes: asRecord(log.request)?.requestBytes ?? null,
    },
    route: route ? {
      provider: route.provider ?? route.providerLabel ?? null,
      requestedModel: route.requestedModelLabel ?? log.model ?? null,
      routedModel: route.routedModelLabel ?? route.modelLabel ?? route.model ?? null,
      adapter: route.adapter ?? null,
      routeKind: route.routeKind ?? null,
      ambiguousCandidates: Array.isArray(route.ambiguousCandidates) ? route.ambiguousCandidates : undefined,
    } : null,
    lifecycle: log.lifecycle ?? null,
    status: log.status ?? log.statusCode ?? null,
    upstream: upstream ? {
      status: upstream.status ?? null,
      contentTypeFamily: upstream.contentTypeFamily ?? null,
      requestBytes: upstream.requestBytes ?? null,
      responseBytes: upstream.responseBytes ?? null,
      usage: upstream.usage ?? null,
    } : null,
    error: asRecord(log.error) ?? asRecord(log.structuredError) ?? null,
    fallbacks: asRecord(log.fallbacks) ?? null,
    phases: Array.isArray(log.phases) ? log.phases : null,
  }, null, 2);
}

export default function Logs({ apiBase, embedded = false, navigate }: { apiBase: string; embedded?: boolean; navigate?: Navigate }) {
  const { t, locale } = useI18n();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [providerFilter, setProviderFilter] = useState("");
  const [errorFilter, setErrorFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;

  const fetchLogs = async () => {
    try {
      const res = await fetch(`${apiBase}/api/logs`);
      const data = await res.json();
      setLogs(Array.isArray(data) ? data : []);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    fetchLogs();
    if (!autoRefresh) return;
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, [apiBase, autoRefresh]);

  const orderedLogs = useMemo(() => [...logs].reverse(), [logs]);
  const providerOptions = useMemo(() => optionValues(orderedLogs, formatProvider), [orderedLogs]);
  const errorOptions = useMemo(() => optionValues(orderedLogs, formatStructuredError), [orderedLogs]);
  const visibleLogs = useMemo(() => orderedLogs.filter(log => {
    if (statusFilter !== "all" && statusKind(log) !== statusFilter) return false;
    if (providerFilter && formatProvider(log) !== providerFilter) return false;
    if (errorFilter && formatStructuredError(log) !== errorFilter) return false;
    return true;
  }), [orderedLogs, statusFilter, providerFilter, errorFilter]);

  const statusColor = (log: LogEntry) => {
    const kind = statusKind(log);
    if (kind === "ok") return "var(--green)";
    if (kind === "error") return "var(--red)";
    if (kind === "pending") return "var(--amber)";
    return "var(--text)";
  };

  return (
    <>
      {!embedded && (
        <>
          <div className="page-head">
            <h2>{t("logs.title")}</h2>
            <label className="muted" style={{ fontSize: 13, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
              {t("logs.autoRefresh")}
            </label>
          </div>
          <p className="page-sub">{t("logs.subtitle")}</p>
        </>
      )}
      {embedded && (
        <div className="page-head">
          <h3 className="panel-title">{t("logs.title")}</h3>
          <label className="muted" style={{ fontSize: 13, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
            {t("logs.autoRefresh")}
          </label>
        </div>
      )}

      {logs.length === 0 ? (
        <div className="empty logs-empty">
          <div className="title">{t("logs.emptyTitle")}</div>
          <div>{t("logs.emptyBody")}</div>
          <div className="action-row" style={{ justifyContent: "center", marginTop: 12 }}>
            {navigate && <button className="btn btn-primary" type="button" onClick={() => navigate("models", "model-refresh")}>{t("logs.emptyOpenModels")}</button>}
            <button className="btn btn-ghost" type="button" onClick={fetchLogs}>{t("logs.emptyRefresh")}</button>
          </div>
        </div>
      ) : (
        <>
          <div className="log-filter-bar">
            <label className="field-label">
              {t("logs.filter.status")}
              <select className="select-sm" value={statusFilter} onChange={e => setStatusFilter(e.target.value as StatusFilter)}>
                <option value="all">{t("logs.filter.allStatuses")}</option>
                <option value="ok">{t("logs.filter.ok")}</option>
                <option value="error">{t("logs.filter.error")}</option>
                <option value="pending">{t("logs.filter.pending")}</option>
                <option value="other">{t("logs.filter.other")}</option>
              </select>
            </label>
            <label className="field-label">
              {t("logs.filter.provider")}
              <select className="select-sm" value={providerFilter} onChange={e => setProviderFilter(e.target.value)}>
                <option value="">{t("logs.filter.allProviders")}</option>
                {providerOptions.map(provider => <option key={provider} value={provider}>{provider}</option>)}
              </select>
            </label>
            <label className="field-label">
              {t("logs.filter.errorCode")}
              <select className="select-sm" value={errorFilter} onChange={e => setErrorFilter(e.target.value)}>
                <option value="">{t("logs.filter.allErrors")}</option>
                {errorOptions.map(error => <option key={error} value={error}>{error}</option>)}
              </select>
            </label>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => { setStatusFilter("all"); setProviderFilter(""); setErrorFilter(""); }}>{t("logs.filter.clear")}</button>
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("logs.col.time")}</th>
                  <th>{t("logs.col.model")}</th>
                  <th>{t("logs.col.provider")}</th>
                  <th>{t("logs.col.status")}</th>
                  <th>{t("logs.col.endpoint")}</th>
                  <th className="num">{t("logs.col.duration")}</th>
                  <th>{t("logs.col.errorCodes")}</th>
                  <th>{t("logs.col.phases")}</th>
                  <th>{t("logs.col.details")}</th>
                </tr>
              </thead>
              <tbody>
                {visibleLogs.length === 0 ? (
                  <tr><td colSpan={9} className="muted">{t("logs.noFilterMatches")}</td></tr>
                ) : visibleLogs.map((log, i) => {
                  const key = rowKey(log, i);
                  const isExpanded = expanded === key;
                  return (
                    <Fragment key={key}>
                      <tr>
                        <td className="muted mono">{formatTimestamp(log, localeTag)}</td>
                        <td className="mono">{formatModel(log)}</td>
                        <td className="muted">{formatProvider(log)}</td>
                        <td>
                          <span className="mono" style={{ color: statusColor(log), fontWeight: 600 }}>{formatStatus(log)}</span>
                        </td>
                        <td className="muted mono">{formatEndpoint(log)}</td>
                        <td className="num">{formatDuration(log)}</td>
                        <td className="muted mono">{formatStructuredError(log)}</td>
                        <td className="muted mono">{formatPhaseSummary(log)}</td>
                        <td><button className="btn btn-ghost btn-sm" type="button" aria-expanded={isExpanded} onClick={() => setExpanded(isExpanded ? null : key)}>{isExpanded ? t("logs.hideDetails") : t("logs.showDetails")}</button></td>
                      </tr>
                      {isExpanded && (
                        <tr className="log-detail-row">
                          <td colSpan={9}>
                            <pre className="log-detail-json">{detailJson(log)}</pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
