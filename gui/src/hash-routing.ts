import type { Page } from "./navigation";

const PAGE_HASH_SEGMENTS: Record<Page, string> = {
  home: "home",
  accounts: "accounts",
  models: "models",
  claudeProfiles: "claude-profiles",
  modelMixing: "model-mixing",
  activity: "activity",
  developerDetails: "developer-details",
};

const HASH_SEGMENT_PAGES = new Map<string, Page>(
  Object.entries(PAGE_HASH_SEGMENTS).map(([page, segment]) => [segment, page as Page]),
);

export function pageToHash(page: Page): string {
  return `#/${PAGE_HASH_SEGMENTS[page]}`;
}

export function parsePageHash(hash: string): Page {
  const withoutHash = hash.trim().startsWith("#") ? hash.trim().slice(1) : hash.trim();
  const withoutSlash = withoutHash.startsWith("/") ? withoutHash.slice(1) : withoutHash;
  const [segment] = withoutSlash.split(/[/?#]/, 1);
  return HASH_SEGMENT_PAGES.get(segment) ?? "home";
}

export function shouldPushPageHash(currentHash: string, page: Page): boolean {
  return currentHash !== pageToHash(page);
}
