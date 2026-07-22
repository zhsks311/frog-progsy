import type { FrogConfig, FrogUsage } from "./types";
import type { PersistedUsageEntry, UsageStatus } from "./usage-log";

export type UsagePriceTable = NonNullable<NonNullable<FrogConfig["usagePricing"]>["prices"]>;
export type UsagePrice = UsagePriceTable[string];
export type UsagePricingConfig = FrogConfig["usagePricing"];

export type UsagePricingExcludedReason =
  | "unreported"
  | "unsupported"
  | "estimated"
  | "failed"
  | "shadow"
  | "missing_usage";

export interface UsagePriceRow extends UsagePrice {
  key: string;
}

export interface UsagePricingUnpricedEntry {
  provider: string;
  model: string;
  resolvedModel?: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  priceKeyCandidates: string[];
  reason: "price_missing";
}

export interface UsagePricingBudget {
  amount: number;
  used: number;
  remaining: number;
  ratio: number;
  displayOnly: true;
}

export interface UsagePricingSummary {
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
  excludedByReason: Record<UsagePricingExcludedReason, number>;
  configuredPrices: UsagePriceRow[];
  unpriced: UsagePricingUnpricedEntry[];
  budget?: UsagePricingBudget;
}

const DEFAULT_CURRENCY = "USD";
const MILLION = 1_000_000;

function currency(config: UsagePricingConfig): string {
  const value = config?.currency?.trim();
  return value || DEFAULT_CURRENCY;
}

function emptyExcluded(): Record<UsagePricingExcludedReason, number> {
  return {
    unreported: 0,
    unsupported: 0,
    estimated: 0,
    failed: 0,
    shadow: 0,
    missing_usage: 0,
  };
}

function configuredPrices(prices: UsagePriceTable | undefined): UsagePriceRow[] {
  return Object.entries(prices ?? {})
    .map(([key, price]) => ({ key, ...price }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function usageTokens(usage: FrogUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

function persistedTokens(entry: PersistedUsageEntry): number {
  if (typeof entry.totalTokens === "number") return entry.totalTokens;
  return entry.usage ? usageTokens(entry.usage) : 0;
}

function isSuccessfulStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

export function isShadowUsageEntry(entry: PersistedUsageEntry): boolean {
  const maybe = entry as PersistedUsageEntry & { usageSource?: unknown; shadow?: unknown };
  return entry.source === "shadow" || maybe.usageSource === "shadow" || maybe.shadow === true;
}

function excludedReason(entry: PersistedUsageEntry): UsagePricingExcludedReason | null {
  if (isShadowUsageEntry(entry)) return "shadow";
  if (entry.usageStatus !== "reported") return entry.usageStatus as Exclude<UsageStatus, "reported">;
  if (!entry.usage) return "missing_usage";
  if (!isSuccessfulStatus(entry.status)) return "failed";
  return null;
}

export function usagePriceKeyCandidates(entry: PersistedUsageEntry): string[] {
  const keys = [
    `${entry.provider}/${entry.model}`,
    entry.resolvedModel ? `${entry.provider}/${entry.resolvedModel}` : "",
    entry.model,
    entry.resolvedModel ?? "",
  ].filter(Boolean);
  return [...new Set(keys)];
}

function priceForEntry(entry: PersistedUsageEntry, prices: UsagePriceTable | undefined): { key: string; price: UsagePrice } | null {
  if (!prices) return null;
  for (const key of usagePriceKeyCandidates(entry)) {
    const price = prices[key];
    if (price) return { key, price };
  }
  return null;
}

function tokenCost(tokens: number, pricePerMTok: number | undefined): number {
  if (typeof pricePerMTok !== "number" || !Number.isFinite(pricePerMTok)) return 0;
  return (Math.max(0, tokens) / MILLION) * pricePerMTok;
}

function costForUsage(usage: FrogUsage, price: UsagePrice): Pick<UsagePricingSummary, "inputCost" | "outputCost" | "cachedInputCost" | "reasoningOutputCost"> {
  const cachedInputTokens = Math.max(0, usage.cachedInputTokens ?? 0);
  const inputTokens = price.cachedInputPerMTok === undefined
    ? usage.inputTokens
    : Math.max(0, usage.inputTokens - cachedInputTokens);
  return {
    inputCost: tokenCost(inputTokens, price.inputPerMTok),
    outputCost: tokenCost(usage.outputTokens, price.outputPerMTok),
    cachedInputCost: tokenCost(cachedInputTokens, price.cachedInputPerMTok),
    reasoningOutputCost: tokenCost(usage.reasoningOutputTokens ?? 0, price.reasoningOutputPerMTok),
  };
}

function unpricedKey(entry: PersistedUsageEntry): string {
  return `${entry.provider}\u0000${entry.model}\u0000${entry.resolvedModel ?? ""}`;
}

function addUnpriced(map: Map<string, UsagePricingUnpricedEntry>, entry: PersistedUsageEntry): void {
  const usage = entry.usage;
  if (!usage) return;
  const key = unpricedKey(entry);
  let item = map.get(key);
  if (!item) {
    item = {
      provider: entry.provider,
      model: entry.model,
      ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {}),
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      priceKeyCandidates: usagePriceKeyCandidates(entry),
      reason: "price_missing",
    };
    map.set(key, item);
  }
  item.requests += 1;
  item.inputTokens += usage.inputTokens;
  item.outputTokens += usage.outputTokens;
  item.cachedInputTokens += usage.cachedInputTokens ?? 0;
  item.reasoningOutputTokens += usage.reasoningOutputTokens ?? 0;
  item.totalTokens += persistedTokens(entry);
}

function buildBudget(config: UsagePricingConfig, totalCost: number): UsagePricingBudget | undefined {
  const amount = config?.monthlyDisplayBudget;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return undefined;
  return {
    amount,
    used: totalCost,
    remaining: roundMoney(amount - totalCost),
    ratio: amount > 0 ? Math.max(0, Math.min(1, totalCost / amount)) : 0,
    displayOnly: true,
  };
}

export function buildUsagePricing(entries: PersistedUsageEntry[], config: UsagePricingConfig): UsagePricingSummary {
  const rows = configuredPrices(config?.prices);
  const base: UsagePricingSummary = {
    available: config?.enabled === true,
    source: config?.enabled === true ? "local_price_table" : null,
    reason: config?.enabled === true ? "display_only_not_billing" : "disabled",
    currency: currency(config),
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cachedInputCost: 0,
    reasoningOutputCost: 0,
    pricedRequests: 0,
    pricedTokens: 0,
    unpricedRequests: 0,
    unpricedTokens: 0,
    excludedRequests: 0,
    excludedByReason: emptyExcluded(),
    configuredPrices: rows,
    unpriced: [],
  };

  if (config?.enabled !== true) return base;

  const unpriced = new Map<string, UsagePricingUnpricedEntry>();
  for (const entry of entries) {
    const reason = excludedReason(entry);
    if (reason) {
      base.excludedRequests += 1;
      base.excludedByReason[reason] += 1;
      continue;
    }

    const usage = entry.usage;
    if (!usage) continue;
    const matched = priceForEntry(entry, config.prices);
    if (!matched) {
      base.unpricedRequests += 1;
      base.unpricedTokens += persistedTokens(entry);
      addUnpriced(unpriced, entry);
      continue;
    }

    const costs = costForUsage(usage, matched.price);
    base.pricedRequests += 1;
    base.pricedTokens += persistedTokens(entry);
    base.inputCost += costs.inputCost;
    base.outputCost += costs.outputCost;
    base.cachedInputCost += costs.cachedInputCost;
    base.reasoningOutputCost += costs.reasoningOutputCost;
  }

  base.inputCost = roundMoney(base.inputCost);
  base.outputCost = roundMoney(base.outputCost);
  base.cachedInputCost = roundMoney(base.cachedInputCost);
  base.reasoningOutputCost = roundMoney(base.reasoningOutputCost);
  base.totalCost = roundMoney(base.inputCost + base.outputCost + base.cachedInputCost + base.reasoningOutputCost);
  base.unpriced = [...unpriced.values()].sort((a, b) => b.requests - a.requests || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  const budget = buildBudget(config, base.totalCost);
  if (budget) base.budget = budget;
  return base;
}
