import { defineI18n, type I18nConfig } from "fumadocs-core/i18n";
import { defineI18nUI } from "fumadocs-ui/i18n";

export const languages = ["en", "ko", "zh-cn"] as const;
export type Locale = (typeof languages)[number];

export const i18nConfig = {
  defaultLanguage: "en",
  languages: [...languages],
  parser: "dir",
  hideLocale: "default-locale",
} satisfies I18nConfig<Locale>;

export const i18n = defineI18n(i18nConfig);

export const i18nUI = defineI18nUI(i18nConfig, {
  en: { displayName: "English" },
  ko: { displayName: "한국어" },
  "zh-cn": { displayName: "简体中文" },
});

export const locales = new Set(i18nConfig.languages);

export function parseLocaleSlug(slug: string[] = []) {
  const first = slug[0];
  if (first && locales.has(first as Locale)) {
    return { lang: first, slug: slug.slice(1) };
  }

  return { lang: i18n.defaultLanguage, slug };
}
