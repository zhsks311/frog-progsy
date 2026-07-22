"use client";

import { flexsearchStaticClient } from "fumadocs-core/search/client/flexsearch-static";
import { useMemo } from "react";
import { useDocsSearch } from "fumadocs-core/search/client";
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from "fumadocs-ui/components/dialog/search";
import { useI18n } from "fumadocs-ui/contexts/i18n";

export function StaticSearchDialog(props: SharedProps) {
  const { locale } = useI18n();
  const client = useMemo(
    () =>
      flexsearchStaticClient({
        from: "/frog-progsy/api/search",
        locale: locale ?? "",
      }),
    [locale],
  );
  const { search, setSearch, query } = useDocsSearch({ client });

  return (
    <SearchDialog
      search={search}
      onSearchChange={setSearch}
      isLoading={query.isLoading}
      {...props}
    >
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList items={query.data !== "empty" ? query.data : null} />
      </SearchDialogContent>
    </SearchDialog>
  );
}
