import { useEffect, useState } from "react";
import Home from "./pages/Home";
import Accounts from "./pages/Providers";
import Models from "./pages/Models";
import ClaudeProfiles from "./pages/ClaudeProfiles";
import ModelMixing from "./pages/ModelMixing";
import Activity from "./pages/Activity";
import DeveloperDetails from "./pages/DeveloperDetails";
import { IconGrid, IconServer, IconBoxes, IconGithub, IconSun, IconMoon, IconMonitor, IconGlobe, IconBarChart, IconList, IconBot } from "./icons";
import { useI18n, useT, LOCALES, type TKey } from "./i18n";
import { Notice } from "./ui";
import { detectGuiBuildSkewNotice, type GuiBuildSkewNotice } from "./build-skew";
import type { DeepLinkTarget, Navigate, Page } from "./navigation";
import { pageToHash, parsePageHash, shouldPushPageHash } from "./hash-routing";

type Theme = "light" | "dark" | "system";

const API_BASE = import.meta.env.VITE_API_BASE || "";
const THEME_KEY = "frogp-theme";

const NAV: { id: Page; tkey: TKey; Icon: typeof IconGrid }[] = [
  { id: "home", tkey: "nav.dashboard", Icon: IconGrid },
  { id: "accounts", tkey: "nav.providers", Icon: IconServer },
  { id: "models", tkey: "nav.models", Icon: IconBoxes },
  { id: "claudeProfiles", tkey: "nav.claudeProfiles", Icon: IconBot },
  { id: "modelMixing", tkey: "nav.modelMixing", Icon: IconList },
  { id: "activity", tkey: "nav.activity", Icon: IconBarChart },
  { id: "developerDetails", tkey: "nav.developerDetails", Icon: IconList },
];

const THEME_ICON = { light: IconSun, dark: IconMoon, system: IconMonitor } as const;
const THEME_TKEY: Record<Theme, TKey> = { light: "theme.light", dark: "theme.dark", system: "theme.system" };

function readRuntimeVersion(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("version" in data)) return null;
  const version = (data as { version?: unknown }).version;
  return typeof version === "string" && version.length > 0 ? version : null;
}

function buildSkewDetail(notice: GuiBuildSkewNotice): string {
  const parts = [`status=${notice.status}`];
  if (notice.servedBuildId) parts.push(`served=${notice.servedBuildId}`);
  parts.push(`bundle=${notice.expectedBuildId}`);
  return parts.join(" · ");
}

function readStoredTheme(): Theme {
  const t = localStorage.getItem(THEME_KEY);
  return t === "light" || t === "dark" ? t : "system";
}

function currentHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

export default function App() {
  const [page, setPage] = useState<Page>(() => parsePageHash(currentHash()));
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [target, setTarget] = useState<DeepLinkTarget | null>(null);
  const [runtimeVersion, setRuntimeVersion] = useState<string | null>(null);
  const [buildSkewNotice, setBuildSkewNotice] = useState<GuiBuildSkewNotice | null>(null);
  const { locale, setLocale } = useI18n();
  const t = useT();

  useEffect(() => {
    const el = document.documentElement;
    if (theme === "system") { el.removeAttribute("data-theme"); localStorage.removeItem(THEME_KEY); }
    else { el.setAttribute("data-theme", theme); localStorage.setItem(THEME_KEY, theme); }
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    const fetchRuntimeVersion = async () => {
      try {
        const res = await fetch(`${API_BASE}/healthz`);
        if (!res.ok) return;
        const data = await res.json();
        const version = readRuntimeVersion(data);
        const skew = detectGuiBuildSkewNotice(data, __APP_BUILD_ID__);
        if (!cancelled) {
          if (version) setRuntimeVersion(version);
          setBuildSkewNotice(skew);
        }
      } catch {
        // Keep the build-time fallback when the proxy is unavailable.
      }
    };
    fetchRuntimeVersion();
    const interval = setInterval(fetchRuntimeVersion, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      setPage(parsePageHash(window.location.hash));
      setTarget(null);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const cycleTheme = () => setTheme(t => (t === "light" ? "dark" : t === "dark" ? "system" : "light"));
  const ThemeIcon = THEME_ICON[theme];
  const displayedVersion = runtimeVersion ?? __APP_VERSION__;

  const langName = LOCALES.find(l => l.code === locale)?.name ?? "English";
  const cycleLang = () => {
    const order = LOCALES.map(l => l.code);
    setLocale(order[(order.indexOf(locale) + 1) % order.length]);
  };

  const navigate: Navigate = (nextPage, nextTarget) => {
    const nextHash = pageToHash(nextPage);
    if (shouldPushPageHash(window.location.hash, nextPage)) {
      window.history.pushState(null, "", nextHash);
    }
    setPage(nextPage);
    setTarget(nextTarget ?? null);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-logo" role="img" aria-label="frogprogsy logo" />
          <span className="name">frogprogsy</span>
          <span className="ver">v{displayedVersion}</span>
        </div>
        <nav>
          {NAV.map(({ id, tkey, Icon }) => (
            <button key={id} className={`nav-item${page === id ? " active" : ""}`} onClick={() => navigate(id)}
              aria-current={page === id ? "page" : undefined}>
              <Icon /> {t(tkey)}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button type="button" className="theme-toggle" onClick={cycleLang}
            aria-label={`${t("lang.label")}: ${langName}`} title={`${t("lang.label")}: ${langName}`}>
            <IconGlobe /> <span className="mode">{langName}</span>
          </button>
          <button type="button" className="theme-toggle" onClick={cycleTheme}
            aria-label={`${t("theme.label")}: ${t(THEME_TKEY[theme])}`} title={`${t("theme.label")}: ${t(THEME_TKEY[theme])}`}>
            <ThemeIcon /> <span className="mode">{t(THEME_TKEY[theme])}</span>
          </button>
          <a className="sidebar-link" href="https://github.com/zhsks311/frog-progsy" target="_blank" rel="noreferrer">
            <IconGithub /> {t("common.github")}
          </a>
        </div>
      </aside>

      <main className="main">
        <div className="main-inner">
          {buildSkewNotice && (
            <Notice tone="err">
              <strong>{t("app.buildSkewTitle")}</strong>{" "}
              {t("app.buildSkewBody", { detail: buildSkewDetail(buildSkewNotice), cmd: "frogp refresh" })}
            </Notice>
          )}
          {page === "home" && <Home apiBase={API_BASE} navigate={navigate} />}
          {page === "accounts" && <Accounts apiBase={API_BASE} target={target} />}
          {page === "models" && <Models apiBase={API_BASE} target={target} />}
          {page === "claudeProfiles" && <ClaudeProfiles apiBase={API_BASE} navigate={navigate} />}
          {page === "modelMixing" && <ModelMixing apiBase={API_BASE} navigate={navigate} />}
          {page === "activity" && <Activity apiBase={API_BASE} target={target} />}
          {page === "developerDetails" && <DeveloperDetails apiBase={API_BASE} target={target} navigate={navigate} />}
        </div>
      </main>
    </div>
  );
}
