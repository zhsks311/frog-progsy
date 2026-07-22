import { useT, type TKey } from "../i18n";

const PIPE_KEYS: TKey[] = ["mix.infoPipe1", "mix.infoPipe2", "mix.infoPipe3", "mix.infoPipe4"];
const COST_KEYS: TKey[] = ["mix.infoCost1", "mix.infoCost2", "mix.infoCost3"];
const BOUNDARY_KEYS: TKey[] = ["mix.infoBoundary1", "mix.infoBoundary2", "mix.infoBoundary3"];

export function ModelMixingInfo() {
  const t = useT();
  return (
    <>
      <p className="muted" style={{ fontSize: 13 }}>{t("mix.infoDesc")}</p>
      <details className="setup-guide">
        <summary>{t("mix.infoHow")}</summary>
        <div style={{ marginTop: 8, color: "var(--muted)", fontSize: 12.5, lineHeight: 1.7 }}>
          <div style={{ fontWeight: 650 }}>{t("mix.infoPipeTitle")}</div>
          <ol style={{ margin: "4px 0 10px", paddingLeft: 18 }}>
            {PIPE_KEYS.map(k => <li key={k}>{t(k)}</li>)}
          </ol>
          <div style={{ fontWeight: 650 }}>{t("mix.infoCostTitle")}</div>
          <ul style={{ margin: "4px 0 10px", paddingLeft: 18 }}>
            {COST_KEYS.map(k => <li key={k}>{t(k)}</li>)}
          </ul>
          <div style={{ fontWeight: 650 }}>{t("mix.infoBoundaryTitle")}</div>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {BOUNDARY_KEYS.map(k => <li key={k}>{t(k)}</li>)}
          </ul>
        </div>
      </details>
    </>
  );
}
