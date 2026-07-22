import type { ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import { source } from "@/lib/source";
import { baseOptions } from "@/lib/layout.shared";
import { StaticSearchDialog } from "@/components/search";
import { parseLocaleSlug } from "@/lib/i18n";
import { i18nUI } from "@/lib/i18n";

type LayoutProps = {
  children: ReactNode;
  params: Promise<{
    slug?: string[];
  }>;
};

export default async function Layout({ children, params }: LayoutProps) {
  const { slug } = await params;
  const { lang } = parseLocaleSlug(slug ?? []);

  return (
    <RootProvider i18n={i18nUI.provider(lang)} search={{ SearchDialog: StaticSearchDialog }} theme={{ enabled: false }}>
      <DocsLayout tree={source.getPageTree(lang)} {...baseOptions}>
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
