import { describe, expect, test } from "bun:test";
import { findSharedAssetMismatches, SHARED_ASSET_COPIES } from "../scripts/sync-brand-assets";

describe("shared brand assets", () => {
  test("consumer copies stay synchronized with canonical assets", async () => {
    const mismatches = await findSharedAssetMismatches();

    expect(mismatches.map(item => ({
      source: item.source,
      target: item.target,
      reason: item.reason,
    }))).toEqual([]);
  });

  test("the sync map covers every intentional shared copy", () => {
    expect(SHARED_ASSET_COPIES).toEqual([
      {
        source: "assets/dashboard.png",
        target: "docs-site/src/assets/dashboard.png",
        reason: "docs-site home page dashboard image",
      },
      {
        source: "assets/claude-app-picker.png",
        target: "docs-site/src/assets/claude-app-picker.png",
        reason: "docs-site model picker image",
      },
      {
        source: "assets/logo-light.png",
        target: "docs-site/src/assets/logo-light.png",
        reason: "docs-site light theme logo",
      },
      {
        source: "assets/logo-dark.png",
        target: "docs-site/src/assets/logo-dark.png",
        reason: "docs-site dark theme logo",
      },
      {
        source: "assets/logo-light.png",
        target: "gui/public/logo.png",
        reason: "GUI public logo; GUI currently uses one neutral logo file",
      },
    ]);
  });
});
