import { notFound } from "next/navigation";
import { source } from "@/lib/source";
import { getMDXComponents } from "@/components/mdx";
import { parseLocaleSlug } from "@/lib/i18n";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";

type PageProps = {
  params: Promise<{
    slug?: string[];
  }>;
};

export default async function Page(props: PageProps) {
  const params = await props.params;
  const parsed = parseLocaleSlug(params.slug ?? []);
  const page = source.getPage(parsed.slug, parsed.lang);

  if (!page) notFound();

  const MDX = page.data.body;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    slug: page.url === "/" ? [] : page.url.replace(/^\//, "").split("/"),
  }));
}

export async function generateMetadata(props: PageProps) {
  const params = await props.params;
  const parsed = parseLocaleSlug(params.slug ?? []);
  const page = source.getPage(parsed.slug, parsed.lang);

  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
  };
}
