import { flexsearchFromSource } from "fumadocs-core/search/flexsearch";
import { source } from "@/lib/source";

export const dynamic = "force-static";

export const { staticGET: GET } = flexsearchFromSource(source, {
  localeMap: {
    ko: "cjk",
    "zh-cn": "cjk",
  },
});
