import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { pageToHash, parsePageHash, shouldPushPageHash } from "../gui/src/hash-routing";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("GUI interaction stability", () => {
  test("hash routing helpers cover the page union and safe fallbacks", () => {
    expect(pageToHash("home")).toBe("#/home");
    expect(pageToHash("accounts")).toBe("#/accounts");
    expect(pageToHash("models")).toBe("#/models");
    expect(pageToHash("modelMixing")).toBe("#/model-mixing");
    expect(pageToHash("activity")).toBe("#/activity");
    expect(pageToHash("developerDetails")).toBe("#/developer-details");

    expect(parsePageHash("")).toBe("home");
    expect(parsePageHash("#/model-mixing")).toBe("modelMixing");
    expect(parsePageHash("#/developer-details")).toBe("developerDetails");
    expect(parsePageHash("#/unknown")).toBe("home");
    expect(parsePageHash("#/models?ignored=true")).toBe("models");

    expect(shouldPushPageHash("#/models", "models")).toBe(false);
    expect(shouldPushPageHash("#/home", "models")).toBe(true);
  });

  test("App wires hash initial load, navigation push, hashchange, and duplicate-history guard", () => {
    const app = read("gui/src/App.tsx");

    expect(app).toContain("useState<Page>(() => parsePageHash(currentHash()))");
    expect(app).toContain('window.addEventListener("hashchange", onHashChange)');
    expect(app).toContain("setPage(parsePageHash(window.location.hash))");
    expect(app).toContain("const nextHash = pageToHash(nextPage)");
    expect(app).toContain("shouldPushPageHash(window.location.hash, nextPage)");
    expect(app).toContain('window.history.pushState(null, "", nextHash)');
  });

  test("Model Mixing numeric fields commit only on blur or Enter", () => {
    const mixing = read("gui/src/pages/ModelMixing.tsx");
    const numberInputs = mixing.match(/<CommitNumberInput/g) ?? [];

    expect(numberInputs).toHaveLength(7);
    expect(mixing).toContain("onBlur={commit}");
    expect(mixing).toContain('e.key === "Enter"');
    expect(mixing).toContain("e.currentTarget.blur()");
    expect(mixing).not.toContain("onChange={e => void saveFusionPatch({ panelWebSearch");
    expect(mixing).not.toContain("onChange={e => void savePatch({ stageTimeoutMs");
  });

  test("provider modal guards dirty close and traps focus", () => {
    const modal = read("gui/src/components/AddProviderModal.tsx");
    const en = read("gui/src/i18n/en.ts");
    const ko = read("gui/src/i18n/ko.ts");
    const zh = read("gui/src/i18n/zh.ts");

    expect(modal).toContain("modal.discardConfirm");
    expect(modal).toContain("const isDirty = form !== null");
    expect(modal).toContain("querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)");
    expect(modal).toContain('e.key !== "Tab"');
    expect(modal).toContain("document.activeElement === first");
    expect(modal).toContain("!cardRef.current.contains(document.activeElement)");
    expect(en).toContain("modal.discardConfirm");
    expect(ko).toContain("modal.discardConfirm");
    expect(zh).toContain("modal.discardConfirm");
  });

  test("Models clarifies save semantics and reduces repeated n/5 counters", () => {
    const models = read("gui/src/pages/Models.tsx");
    const en = read("gui/src/i18n/en.ts");
    const ko = read("gui/src/i18n/ko.ts");
    const zh = read("gui/src/i18n/zh.ts");

    expect(models).toContain("models.visibilityAutoSave");
    expect(models).toContain("models.priorityManualSave");
    expect(models).toContain("models.priorityNoChanges");
    expect(models).toContain("disabled={featuredSaving || !featuredDirty}");
    expect(models).toContain("featuredAfterVisibilityChange");
    expect(models).toContain("apply(next, featuredAfterVisibilityChange(next))");
    expect(models).not.toContain("{featuredChosen.length}/5</div>");
    expect(models).not.toContain("selected-order-count");
    for (const source of [en, ko, zh]) {
      expect(source).toContain("models.visibilityAutoSave");
      expect(source).toContain("models.priorityManualSave");
      expect(source).toContain("models.priorityNoChanges");
    }
  });
});
