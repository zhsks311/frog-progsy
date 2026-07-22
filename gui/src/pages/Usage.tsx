import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import type { DeepLinkTarget } from "../navigation";

type Range = "all" | "30d" | "7d";

interface UsageSummaryTotals {
  requests: number;
  reportedRequests: number;
  unreportedRequests: number;
  unsupportedRequests: number;
  estimatedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  coverageRatio: number;
}

interface UsageDay {
  date: string;
  requests: number;
  reportedRequests: number;
  totalTokens: number;
}

interface UsageModel {
  provider: string;
  model: string;
  resolvedModel?: string;
  requests: number;
  reportedRequests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  shareRatio: number;
}

interface UsageProvider {
  provider: string;
  requests: number;
  reportedRequests: number;
  totalTokens: number;
  shareRatio: number;
}

interface UsageSourceState {
  observedUsage: {
    available: true;
    source: "local_request_log";
    authoritative: false;
    reason: null;
  };
  sessionLimits: {
    available: false;
    source: null;
    reason: "no_authoritative_source";
  };
  cost: {
    available: false;
    source: null;
    reason: "no_authoritative_source";
  } | {
    available: true;
    source: "local_price_table";
    authoritative: false;
    reason: "display_only_not_billing";
  };
}

interface UsageConfiguredPrice {
  key: string;
  inputPerMTok?: number;
  outputPerMTok?: number;
  cachedInputPerMTok?: number;
  reasoningOutputPerMTok?: number;
}

interface UsagePricingUnpriced {
  provider: string;
  model: string;
  resolvedModel?: string;
  requests: number;
  totalTokens: number;
  priceKeyCandidates: string[];
  reason: "price_missing";
}

interface UsagePricingBudget {
  amount: number;
  used: number;
  remaining: number;
  ratio: number;
  displayOnly: true;
}

interface UsagePricing {
  available: boolean;
  source: "local_price_table" | null;
  reason: "disabled" | "display_only_not_billing";
  currency: string;
  totalCost: number;
  inputCost: number;
  outputCost: number;
  cachedInputCost: number;
  reasoningOutputCost: number;
  pricedRequests: number;
  pricedTokens: number;
  unpricedRequests: number;
  unpricedTokens: number;
  excludedRequests: number;
  excludedByReason: Record<string, number>;
  configuredPrices: UsageConfiguredPrice[];
  unpriced: UsagePricingUnpriced[];
  budget?: UsagePricingBudget;
}

interface UsageResponse {
  range: Range;
  since: number | null;
  generatedAt: number;
  summary: UsageSummaryTotals;
  days: UsageDay[];
  models: UsageModel[];
  providers: UsageProvider[];
  sourceState: UsageSourceState;
  pricing?: UsagePricing;
  error?: string;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: Math.abs(amount) < 1 ? 4 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(Math.abs(amount) < 1 ? 4 : 2)}`;
  }
}

function formatRate(value: number | undefined, currency: string): string {
  if (typeof value !== "number") return "—";
  return `${formatMoney(value, currency)} / MTok`;
}

function quantileBuckets(values: number[]): number[] {
  const positive = values.filter(v => v > 0).sort((a, b) => a - b);
  if (positive.length === 0) return [0, 0, 0, 0];
  const q = (p: number) => positive[Math.min(positive.length - 1, Math.floor(p * positive.length))];
  return [q(0.25), q(0.5), q(0.75), q(0.95)];
}

function bucketLevel(value: number, buckets: number[]): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0;
  if (value <= buckets[0]) return 1;
  if (value <= buckets[1]) return 2;
  if (value <= buckets[2]) return 3;
  return 4;
}

interface HeatmapCell {
  date: string;
  requests: number;
  totalTokens: number;
  level: 0 | 1 | 2 | 3 | 4;
  dayOfWeek: number;
}

function buildHeatmap(days: UsageDay[], monthNames: string[], range: Range): { weeks: HeatmapCell[][]; months: { label: string; col: number }[]; buckets: number[] } {
  const buckets = quantileBuckets(days.map(d => d.requests));
  const dayMap = new Map(days.map(d => [d.date, d]));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  if (range === "all" && days.length > 0) {
    const first = days
      .map(day => new Date(`${day.date}T00:00:00`))
      .filter(day => !Number.isNaN(day.getTime()))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (first) start.setTime(first.getTime());
    else start.setDate(start.getDate() - 364);
  } else {
    const spanDays = range === "7d" ? 6 : 29;
    start.setDate(start.getDate() - spanDays);
  }
  start.setDate(start.getDate() - start.getDay());

  const weeks: HeatmapCell[][] = [];
  const months: { label: string; col: number }[] = [];
  const fallbackMonthNames = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
  let lastMonthCol = -4;
  let prevMonthIdx = -1;
  let week: HeatmapCell[] = [];
  const cursor = new Date(start);

  while (cursor <= today) {
    const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
    const m = cursor.getMonth();
    if (cursor.getDay() === 0 && m !== prevMonthIdx && weeks.length - lastMonthCol >= 4) {
      months.push({ label: monthNames[m] ?? fallbackMonthNames[m] ?? String(m + 1), col: weeks.length });
      lastMonthCol = weeks.length;
      prevMonthIdx = m;
    }
    const d = dayMap.get(iso);
    week.push({
      date: iso,
      requests: d?.requests ?? 0,
      totalTokens: d?.totalTokens ?? 0,
      level: d ? bucketLevel(d.requests, buckets) : 0,
      dayOfWeek: cursor.getDay(),
    });
    if (cursor.getDay() === 6) {
      weeks.push(week);
      week = [];
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  if (week.length > 0) {
    while (week.length < 7) {
      week.push({ date: "", requests: 0, totalTokens: 0, level: 0, dayOfWeek: week.length });
    }
    weeks.push(week);
  }
  return { weeks, months, buckets };
}
function isUsageSourceState(value: unknown): value is UsageSourceState {
  if (!value || typeof value !== "object") return false;
  const state = value as UsageSourceState;
  const hasObservedUsage = state.observedUsage?.available === true &&
    state.observedUsage.source === "local_request_log" &&
    state.observedUsage.authoritative === false &&
    state.observedUsage.reason === null;
  const hasMissingLimits = state.sessionLimits?.available === false &&
    state.sessionLimits.source === null &&
    state.sessionLimits.reason === "no_authoritative_source";
  const hasCostState =
    (state.cost?.available === false &&
      state.cost.source === null &&
      state.cost.reason === "no_authoritative_source") ||
    (state.cost?.available === true &&
      state.cost.source === "local_price_table" &&
      state.cost.authoritative === false &&
      state.cost.reason === "display_only_not_billing");
  return hasObservedUsage && hasMissingLimits && hasCostState;
}


export default function Usage({ apiBase, embedded = false, target }: { apiBase: string; embedded?: boolean; target?: DeepLinkTarget | null }) {
  const { t } = useI18n();
  const [range, setRange] = useState<Range>("30d");
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const sourceStateRef = useRef<HTMLElement | null>(null);
  const anomalyRef = useRef<HTMLElement | null>(null);


  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    setLoadError(false);
    const fetchUsage = async () => {
      try {
        const res = await fetch(`${apiBase}/api/usage?range=${range}`);
        if (!res.ok) throw new Error("fetch failed");
        const json = await res.json() as UsageResponse;
        if (!cancelled) {
          if (json.range === range) {
            setData(json);
          } else {
            setLoadError(true);
          }
        }
      } catch {
        if (!cancelled) {
          setData(null);
          setLoadError(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchUsage();
    return () => { cancelled = true; };
  }, [apiBase, range]);
  useEffect(() => {
    if (target === "usage-source-state") sourceStateRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    if (target === "usage-anomaly") anomalyRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [target, data]);


  const heatmap = useMemo(() => buildHeatmap(data?.days ?? [], [t("usage.month.jan"), t("usage.month.feb"), t("usage.month.mar"), t("usage.month.apr"), t("usage.month.may"), t("usage.month.jun"), t("usage.month.jul"), t("usage.month.aug"), t("usage.month.sep"), t("usage.month.oct"), t("usage.month.nov"), t("usage.month.dec")], range), [data?.days, range, t]);
  const activeDays = useMemo(() => (data?.days ?? []).filter(d => d.requests > 0).length, [data?.days]);
  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    const models = data?.models ?? [];
    if (!q) return models.slice(0, 100);
    return models.filter(m =>
      m.model.toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q) ||
      (m.resolvedModel ?? "").toLowerCase().includes(q),
    ).slice(0, 100);
  }, [data?.models, modelQuery]);
  const sourceState = isUsageSourceState(data?.sourceState) ? data.sourceState : null;
  const hasUsage = Boolean(data && data.summary.requests > 0);
  const pricing = data?.pricing?.available ? data.pricing : null;

  return (
    <>
      {!embedded && (
        <>
          <div className="page-head">
            <h2>{t("usage.title")}</h2>
            <div className="usage-range" role="group" aria-label={t("usage.title")}>
              {(["all", "30d", "7d"] as Range[]).map(r => (
                <button key={r} type="button"
                  className={`usage-range-btn${range === r ? " active" : ""}`}
                  aria-pressed={range === r}
                  onClick={() => setRange(r)}>
                  {t(`usage.range.${r}`)}
                </button>
              ))}
            </div>
          </div>
          <p className="page-sub">{t("usage.subtitle")}</p>
        </>
      )}
      {embedded && (
        <div className="page-head">
          <h3 className="panel-title">{t("usage.title")}</h3>
          <div className="usage-range" role="group" aria-label={t("usage.title")}>
            {(["all", "30d", "7d"] as Range[]).map(r => (
              <button key={r} type="button"
                className={`usage-range-btn${range === r ? " active" : ""}`}
                aria-pressed={range === r}
                onClick={() => setRange(r)}>
                {t(`usage.range.${r}`)}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading && !data ? (
        <div className="empty">{t("usage.loading")}</div>
      ) : loadError ? (
        <div className="empty">
          <div className="title">{t("usage.error.title")}</div>
          <div>{t("usage.error.body")}</div>
        </div>
      ) : data ? (
        <>
          <section ref={sourceStateRef} className="panel usage-source-panel">
            <div className="panel-head">
              <div>
                <h3 className="panel-title">{t("usage.source.title")}</h3>
                <p className="muted usage-source-note">{t("usage.source.note")}</p>
              </div>
              <span className={`badge ${sourceState ? "badge-amber" : "badge-muted"}`}>{sourceState ? t("usage.source.badge.notAuthoritative") : t("usage.source.badge.missing")}</span>
            </div>
            <div className="usage-source-summary">
              <div><strong>{t("usage.source.summary.observed")}</strong><span>{t("usage.source.summary.observedBody")}</span></div>
              <div><strong>{t("usage.source.summary.unavailable")}</strong><span>{t("usage.source.summary.unavailableBody")}</span></div>
            </div>
            {sourceState ? (
              <div className="usage-source-grid">
                <div className="source-card">
                  <div className="spread">
                    <h4>{t("usage.source.observed.title")}</h4>
                    <span className="badge badge-green">{t("usage.source.badge.available")}</span>
                  </div>
                  <p className="muted">{t("usage.source.observed.body")}</p>
                  <div className="mini-list">
                    <div><span>{t("usage.source.field.source")}</span><code>{sourceState.observedUsage.source}</code></div>
                    <div><span>{t("usage.source.field.authority")}</span><code>{t("usage.source.value.observedOnly")}</code></div>
                  </div>
                </div>
                <div className="source-card source-card-unavailable">
                  <div className="spread">
                    <h4>{t("usage.source.limits.title")}</h4>
                    <span className="badge badge-amber">{t("usage.source.badge.unavailable")}</span>
                  </div>
                  <p className="muted">{t("usage.source.limits.body")}</p>
                  <div className="mini-list">
                    <div><span>{t("usage.source.field.source")}</span><code>{sourceState.sessionLimits.source ?? "—"}</code></div>
                    <div><span>{t("usage.source.field.reason")}</span><code>{sourceState.sessionLimits.reason}</code></div>
                  </div>
                </div>
                <div className={`source-card${pricing ? "" : " source-card-unavailable"}`}>
                  <div className="spread">
                    <h4>{t("usage.source.cost.title")}</h4>
                    <span className={`badge ${pricing ? "badge-green" : "badge-amber"}`}>{pricing ? t("usage.source.badge.displayOnly") : t("usage.source.badge.unavailable")}</span>
                  </div>
                  <p className="muted">{pricing ? t("usage.source.cost.displayBody") : t("usage.source.cost.body")}</p>
                  <div className="mini-list">
                    <div><span>{t("usage.source.field.source")}</span><code>{sourceState.cost.source ?? "—"}</code></div>
                    <div><span>{pricing ? t("usage.source.field.authority") : t("usage.source.field.reason")}</span><code>{pricing ? t("usage.source.value.displayOnly") : sourceState.cost.reason}</code></div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="notice notice-err">{t("usage.source.contractMissing")}</div>
            )}
          </section>
          {pricing && (
            <section className="panel" style={{ marginTop: 16 }}>
              <div className="panel-head">
                <div>
                  <h3 className="panel-title">{t("usage.pricing.title")}</h3>
                  <p className="muted">{t("usage.pricing.note")}</p>
                </div>
                <span className="badge badge-amber">{t("usage.source.badge.displayOnly")}</span>
              </div>
              <div className="usage-cards">
                <div className="stat"><div className="muted">{t("usage.pricing.total")}</div><div className="stat-value">{formatMoney(pricing.totalCost, pricing.currency)}</div></div>
                <div className="stat"><div className="muted">{t("usage.pricing.pricedRequests")}</div><div className="stat-value">{pricing.pricedRequests}</div></div>
                <div className="stat"><div className="muted">{t("usage.pricing.unpricedRequests")}</div><div className="stat-value">{pricing.unpricedRequests}</div></div>
                <div className="stat"><div className="muted">{t("usage.pricing.excludedRequests")}</div><div className="stat-value">{pricing.excludedRequests}</div></div>
              </div>
              {pricing.budget && (
                <div style={{ marginTop: 14 }}>
                  <div className="spread">
                    <strong>{t("usage.pricing.budgetTitle")}</strong>
                    <span className="muted">{t("usage.pricing.budgetRemaining", { remaining: formatMoney(pricing.budget.remaining, pricing.currency), amount: formatMoney(pricing.budget.amount, pricing.currency) })}</span>
                  </div>
                  <div className="usage-bar" aria-label={t("usage.pricing.budgetTitle")}>
                    <div className="usage-bar-fill" style={{ width: `${Math.round(pricing.budget.ratio * 100)}%` }} />
                  </div>
                  <p className="muted" style={{ marginTop: 8, fontSize: 13 }}>{t("usage.pricing.budgetNote")}</p>
                </div>
              )}
              <div className="tbl-wrap" style={{ marginTop: 16 }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{t("usage.pricing.col.priceKey")}</th>
                      <th className="num">{t("usage.pricing.col.input")}</th>
                      <th className="num">{t("usage.pricing.col.output")}</th>
                      <th className="num">{t("usage.pricing.col.cachedInput")}</th>
                      <th className="num">{t("usage.pricing.col.reasoningOutput")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pricing.configuredPrices.length === 0 ? (
                      <tr><td colSpan={5} className="muted">{t("usage.pricing.noPriceRows")}</td></tr>
                    ) : pricing.configuredPrices.map(row => (
                      <tr key={row.key}>
                        <td className="mono text-anywhere">{row.key}</td>
                        <td className="num mono">{formatRate(row.inputPerMTok, pricing.currency)}</td>
                        <td className="num mono">{formatRate(row.outputPerMTok, pricing.currency)}</td>
                        <td className="num mono">{formatRate(row.cachedInputPerMTok, pricing.currency)}</td>
                        <td className="num mono">{formatRate(row.reasoningOutputPerMTok, pricing.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {pricing.unpriced.length > 0 && (
                <div className="notice notice-warn" style={{ marginTop: 16 }}>
                  <strong>{t("usage.pricing.unpricedTitle")}</strong>
                  <div className="muted" style={{ marginTop: 4 }}>{t("usage.pricing.unpricedNote")}</div>
                  <div className="mini-list" style={{ marginTop: 8 }}>
                    {pricing.unpriced.map(item => (
                      <div key={`${item.provider}/${item.model}/${item.resolvedModel ?? ""}`}>
                        <span>{item.provider}/{item.resolvedModel ?? item.model}</span>
                        <code>{t("usage.pricing.unpricedValue", { requests: item.requests, tokens: formatTokens(item.totalTokens) })}</code>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="mini-list" style={{ marginTop: 16 }}>
                {Object.entries(pricing.excludedByReason).filter(([, count]) => count > 0).map(([reason, count]) => (
                  <div key={reason}><span>{reason}</span><code>{count}</code></div>
                ))}
              </div>
            </section>
          )}

          {!hasUsage ? (
            <div className="empty usage-empty">{t("usage.empty")}</div>
          ) : (
            <>
              <div className="usage-cards">
                <div className="stat"><div className="muted">{t("usage.card.requests")}</div><div className="stat-value">{data.summary.requests}</div></div>
                <div className="stat"><div className="muted">{t("usage.card.reported")}</div><div className="stat-value">{data.summary.reportedRequests}</div></div>
                <div className="stat"><div className="muted">{t("usage.card.totalTokens")}</div><div className="stat-value">{formatTokens(data.summary.totalTokens)}</div></div>
                <div className="stat"><div className="muted">{t("usage.card.coverage")}</div><div className="stat-value">{formatPct(data.summary.coverageRatio)}</div></div>
                <div className="stat"><div className="muted">{t("usage.card.activeDays")}</div><div className="stat-value">{activeDays}</div></div>
              </div>

              <section className="panel" style={{ marginTop: 16 }}>
                <h3 className="panel-title">{t("usage.section.heatmap")}</h3>
                <div className="heatmap">
                  <div className="heatmap-months" style={{ gridTemplateColumns: `28px repeat(${heatmap.weeks.length}, 1fr)` }}>
                    <span className="heatmap-day-spacer" />
                    {heatmap.months.map((m, i) => (
                      <span key={i} className="heatmap-month" style={{ gridColumn: m.col + 2 }}>{m.label}</span>
                    ))}
                  </div>
                  <div className="heatmap-body">
                    <div className="heatmap-days">
                      <span /><span>{t("usage.weekday.mon")}</span><span /><span>{t("usage.weekday.wed")}</span><span /><span>{t("usage.weekday.fri")}</span><span />
                    </div>
                    <div className="heatmap-grid" style={{ gridTemplateColumns: `repeat(${heatmap.weeks.length}, 1fr)` }}>
                      {heatmap.weeks.map((week, wi) => (
                        <div key={wi} className="heatmap-week">
                          {week.map((cell, di) => (
                            <div key={`${wi}-${di}`}
                              className={`heatmap-cell heatmap-cell-${cell.level}`}
                              title={cell.date ? t("usage.heatmap.tooltip", { date: cell.date, requests: cell.requests, tokens: formatTokens(cell.totalTokens) }) : ""} />
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="heatmap-legend muted">
                    <span>{t("usage.heatmap.less")}</span>
                    {[0, 1, 2, 3, 4].map(l => <span key={l} className={`heatmap-cell heatmap-cell-${l}`} />)}
                    <span>{t("usage.heatmap.more")}</span>
                  </div>
                </div>
              </section>

              <section ref={anomalyRef} className="panel" style={{ marginTop: 16 }}>
                <div className="panel-head">
                  <h3 className="panel-title">{t("usage.section.models")}</h3>
                  <input className="input" placeholder={t("usage.search.models")}
                    value={modelQuery} onChange={e => setModelQuery(e.target.value)} />
                </div>
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>{t("logs.col.model")}</th>
                        <th>{t("logs.col.provider")}</th>
                        <th className="num">{t("usage.col.requests")}</th>
                        <th className="num">{t("usage.col.reported")}</th>
                        <th className="num">{t("usage.col.tokens")}</th>
                        <th>{t("usage.col.share")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredModels.map(m => (
                        <tr key={`${m.provider}/${m.model}/${m.resolvedModel ?? ""}`}>
                          <td className="mono text-anywhere">{m.resolvedModel ?? m.model}</td>
                          <td className="muted text-anywhere">{m.provider}</td>
                          <td className="num">{m.requests}</td>
                          <td className="num">{m.reportedRequests}</td>
                          <td className="num mono">{formatTokens(m.totalTokens)}</td>
                          <td><div className="usage-bar"><div className="usage-bar-fill" style={{ width: `${Math.round(m.shareRatio * 100)}%` }} /></div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="panel" style={{ marginTop: 16 }}>
                <h3 className="panel-title">{t("usage.section.providers")}</h3>
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>{t("logs.col.provider")}</th>
                        <th className="num">{t("usage.col.requests")}</th>
                        <th className="num">{t("usage.col.reported")}</th>
                        <th className="num">{t("usage.col.tokens")}</th>
                        <th>{t("usage.col.share")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.providers.map(p => (
                        <tr key={p.provider}>
                          <td className="mono text-anywhere">{p.provider}</td>
                          <td className="num">{p.requests}</td>
                          <td className="num">{p.reportedRequests}</td>
                          <td className="num mono">{formatTokens(p.totalTokens)}</td>
                          <td><div className="usage-bar"><div className="usage-bar-fill" style={{ width: `${Math.round(p.shareRatio * 100)}%` }} /></div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="panel" style={{ marginTop: 16 }}>
                <h3 className="panel-title">{t("usage.section.coverage")}</h3>
                <div className="usage-cards" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
                  <div className="stat"><div className="muted">{t("logs.tokens.reported")}</div><div className="stat-value">{data.summary.reportedRequests}</div></div>
                  <div className="stat"><div className="muted">{t("logs.tokens.unreported")}</div><div className="stat-value">{data.summary.unreportedRequests}</div></div>
                  <div className="stat"><div className="muted">{t("logs.tokens.unsupported")}</div><div className="stat-value">{data.summary.unsupportedRequests}</div></div>
                </div>
                <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>{t("usage.coverage.note")}</p>
              </section>
            </>
          )}
        </>
      ) : (
        <div className="empty">{t("usage.empty")}</div>
      )}
    </>
  );
}
