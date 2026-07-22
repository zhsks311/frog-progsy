import Usage from "./Usage";
import { useT } from "../i18n";
import type { DeepLinkTarget } from "../navigation";

export default function Activity({ apiBase, target }: { apiBase: string; target?: DeepLinkTarget | null }) {
  const t = useT();

  return (
    <>
      <div className="page-head">
        <h2>{t("activity.title")}</h2>
      </div>
      <p className="page-sub">{t("activity.subtitle")}</p>
      <Usage apiBase={apiBase} embedded target={target} />
    </>
  );
}
