// Shared explainer for the "Auto-approval review model" card (Dashboard + Developer details).
// Explains what the auto-mode permission classifier is, the routing pipeline, what each
// control changes, and how the model choice relates to Claude Code's built-in policy.
import { useT, type TKey } from "../i18n";

const PIPE_KEYS: TKey[] = ["dash.classifierPipe1", "dash.classifierPipe2", "dash.classifierPipe3", "dash.classifierPipe4"];
const BEHAVIOR_KEYS: TKey[] = ["dash.classifierBehavior1", "dash.classifierBehavior2", "dash.classifierBehavior3"];
const POLICY_KEYS: TKey[] = ["dash.classifierPolicy1", "dash.classifierPolicy2", "dash.classifierPolicy3"];

export function ClassifierInfo() {
  const t = useT();
  return (
    <>
      <p className="muted" style={{ fontSize: 13 }}>{t("dash.classifierDesc")}</p>
      <details className="setup-guide">
        <summary>{t("dash.classifierHow")}</summary>
        <div style={{ marginTop: 8, color: "var(--muted)", fontSize: 12.5, lineHeight: 1.7 }}>
          <div style={{ fontWeight: 650 }}>{t("dash.classifierPipeTitle")}</div>
          <ol style={{ margin: "4px 0 10px", paddingLeft: 18 }}>
            {PIPE_KEYS.map(k => <li key={k}>{t(k)}</li>)}
          </ol>
          <div style={{ fontWeight: 650 }}>{t("dash.classifierBehaviorTitle")}</div>
          <ul style={{ margin: "4px 0 10px", paddingLeft: 18 }}>
            {BEHAVIOR_KEYS.map(k => <li key={k}>{t(k)}</li>)}
          </ul>
          <div style={{ fontWeight: 650 }}>{t("dash.classifierPolicyTitle")}</div>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {POLICY_KEYS.map(k => <li key={k}>{t(k)}</li>)}
          </ul>
        </div>
      </details>
    </>
  );
}
