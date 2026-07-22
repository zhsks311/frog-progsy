import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const boundaryFiles = [
  "src/router.ts",
  "src/model-mixing/loop.ts",
  "src/model-mixing/orchestrate.ts",
  "src/provider-fallback.ts",
  "src/local-access.ts",
];

function readRel(path: string): string | null {
  const full = join(repoRoot, path);
  if (!existsSync(full)) return null;
  return readFileSync(full, "utf8");
}

describe("usage pricing import boundaries", () => {
  test("pricing stays display-only and is not imported by routing, fallback, model mixing, or local access paths", () => {
    for (const file of boundaryFiles) {
      const source = readRel(file);
      if (source === null) continue;
      expect(source, `${file} must not import usage-pricing`).not.toMatch(/(?:from\s+["'][^"']*usage-pricing["']|import\(["'][^"']*usage-pricing["']|require\(["'][^"']*usage-pricing["'])/);
    }
  });

  test("Usage page pricing copy is localized in every GUI locale", () => {
    const usagePage = readRel("gui/src/pages/Usage.tsx") ?? "";
    const requiredKeys = [
      "usage.source.badge.displayOnly",
      "usage.source.cost.displayBody",
      "usage.source.value.displayOnly",
      "usage.pricing.title",
      "usage.pricing.note",
      "usage.pricing.total",
      "usage.pricing.pricedRequests",
      "usage.pricing.unpricedRequests",
      "usage.pricing.excludedRequests",
      "usage.pricing.budgetTitle",
      "usage.pricing.budgetRemaining",
      "usage.pricing.budgetNote",
      "usage.pricing.col.priceKey",
      "usage.pricing.col.input",
      "usage.pricing.col.output",
      "usage.pricing.col.cachedInput",
      "usage.pricing.col.reasoningOutput",
      "usage.pricing.noPriceRows",
      "usage.pricing.unpricedTitle",
      "usage.pricing.unpricedNote",
      "usage.pricing.unpricedValue",
    ];

    for (const key of requiredKeys) expect(usagePage).toContain(key);
    for (const locale of ["en", "ko", "zh"]) {
      const source = readRel(`gui/src/i18n/${locale}.ts`) ?? "";
      for (const key of requiredKeys) expect(source, `${locale} missing ${key}`).toContain(`"${key}":`);
    }
  });
});
