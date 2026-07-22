import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { i18nConfig } from "@/lib/i18n";
import { DocsThemeSwitch } from "@/components/theme-switch";

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <span className="inline-flex items-center gap-2 font-semibold">
        <img
          src="/frog-progsy/favicon.png"
          alt=""
          aria-hidden="true"
          className="size-7 rounded-md"
        />
        <span>FrogProgsy</span>
      </span>
    ),
  },
  slots: {
    themeSwitch: DocsThemeSwitch,
  },
  githubUrl: "https://github.com/zhsks311/frog-progsy",
  i18n: i18nConfig,
};
