"use client";

import { useEffect, useState, type ComponentProps } from "react";

const STORAGE_KEY = "frogprogsy-docs-theme";
type ThemeChoice = "light" | "dark" | "system";

function systemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(choice: ThemeChoice): void {
  const resolved = choice === "system" ? systemTheme() : choice;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.classList.toggle("light", resolved === "light");
  document.documentElement.style.colorScheme = resolved;
}

function readStoredTheme(): ThemeChoice {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

type ThemeSwitchProps = ComponentProps<"div"> & {
  mode?: "light-dark" | "light-dark-system";
};

export function DocsThemeSwitch({ className, mode: _mode, ...props }: ThemeSwitchProps) {
  const [theme, setTheme] = useState<ThemeChoice>("system");

  useEffect(() => {
    const stored = readStoredTheme();
    setTheme(stored);
    applyTheme(stored);

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (readStoredTheme() === "system") applyTheme("system");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const choose = (next: ThemeChoice) => {
    setTheme(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  };

  return (
    <div
      {...props}
      className={[
        "inline-flex items-center gap-1 rounded-full border p-1 text-xs",
        className,
      ].filter(Boolean).join(" ")}
      data-theme-toggle=""
    >
      <button
        type="button"
        aria-label="Light theme"
        aria-pressed={theme === "light"}
        className={theme === "light" ? "rounded-full bg-fd-accent px-2 py-1 text-fd-accent-foreground" : "rounded-full px-2 py-1 text-fd-muted-foreground"}
        onClick={() => choose("light")}
      >
        ☀︎
      </button>
      <button
        type="button"
        aria-label="Dark theme"
        aria-pressed={theme === "dark"}
        className={theme === "dark" ? "rounded-full bg-fd-accent px-2 py-1 text-fd-accent-foreground" : "rounded-full px-2 py-1 text-fd-muted-foreground"}
        onClick={() => choose("dark")}
      >
        ☾
      </button>
      <button
        type="button"
        aria-label="System theme"
        aria-pressed={theme === "system"}
        className={theme === "system" ? "rounded-full bg-fd-accent px-2 py-1 text-fd-accent-foreground" : "rounded-full px-2 py-1 text-fd-muted-foreground"}
        onClick={() => choose("system")}
      >
        ◐
      </button>
    </div>
  );
}
