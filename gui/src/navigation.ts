export type Page = "home" | "accounts" | "models" | "claudeProfiles" | "modelMixing" | "activity" | "developerDetails";

export type DeepLinkTarget =
  | "account-login"
  | "account-api-key"
  | "account-add-provider"
  | "account-default-model"
  | "model-visibility-row"
  | "model-refresh"
  | "usage-source-state"
  | "usage-anomaly"
  | "debugging-logs"
  | "recovery-controls";

export type Navigate = (page: Page, target?: DeepLinkTarget) => void;
