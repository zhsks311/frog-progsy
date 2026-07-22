# Classifier Routing SOT

Auto-mode classifier model selection for Claude Code. Claude Code runs its auto-mode permission
classifier as a separate small/fast (Haiku-class) model call. When the default provider is
non-Anthropic, frogprogsy would otherwise redirect every unqualified `claude-*` id — including the
classifier's Haiku — to the default provider's heavyweight `defaultModel`, so a frontier model
becomes the permission judge and over-blocks auto-mode actions. Classifier routing sends Haiku-class
ids to a configured lightweight model instead.

## Config shape

| Field | Location | Purpose |
| --- | --- | --- |
| `FrogProviderConfig.classifierModel?` | per provider | Lightweight model for this provider's classifier side-queries. |
| `FrogConfig.classifierFallback?` `{ provider?, model? }` | top level | Cross-provider override (e.g. main = codex, classifier = anthropic haiku). |

Both are optional and additive; existing configs without them route exactly as before.

## Router precedence (`src/router.ts` `resolveClassifierRoute`)

Haiku-class id = `claude-haiku-*` or legacy `claude-3-5-haiku*` (`isHaikuClassModelId`). For a
Haiku-class id when `defaultProvider` is non-Anthropic, resolution is:

1. `classifierFallback` `{provider, model}` — top-level cross-provider pin.
2. default provider's `classifierModel` — per-provider pin.
3. `defaultModel` + a `warning` carrier — loud fallback, never silent.

- Non-Haiku `claude-*` keep the existing client-default redirect to `defaultModel` (unchanged).
- Alias resolution (s1) and `provider/model` namespace (s2) resolve before this stage.
- An Anthropic (or `anthropic-*`) default provider skips this stage entirely and uses native haiku.
- `RouteResult` carries `classifierRoute?` and `warning?`; no new `routeKind` value is introduced —
  a configured classifier route keeps `routeKind: "client-default"` plus the `classifierRoute` flag.

## Seeding and startup back-fill

- Registry (`src/providers/registry.ts`): `ProviderRegistryEntry.classifierModel` field, part of the
  `ProviderConfigSeed` pick; the `codex` entry is seeded `"gpt-5.4-mini"`. Threaded through
  `providerConfigSeed` (`src/providers/derive.ts`) so `deriveOAuthProviderConfig('codex')` yields it.
- Startup back-fill (`src/server.ts` `startServer`, after `reconcileOAuthProviders`): set-if-absent for
  registered providers only, `saveConfig` once, one-time startup notification. It never overwrites a
  user value, never runs inside `loadConfig` (a pure reader), and never appends to
  `OAUTH_RECONCILE_FIELDS` (which force-overwrites).

## Management API and GUI

- `src/classifier-settings.ts`: `providerKnownModels`, `validateClassifierModel` (warn-only),
  `classifierSettingsSnapshot` (broad `Object.keys(config.providers)` enumeration — deliberately NOT
  the `openai-responses`+`forward` fallback filter, which would exclude codex/anthropic).
- `GET`/`PUT /api/classifier-settings` (verb is `PUT`): edit per-provider `classifierModel` and the
  top-level `classifierFallback`. Validation is warn-only — an unknown model returns `200` with a
  `warnings` array and still persists; only malformed JSON returns `400`.
- GUI: the dashboard "Classifier model (auto-mode)" card (`gui/src/pages/Dashboard.tsx`, also rendered
  on `gui/src/pages/DeveloperDetails.tsx`) with i18n keys in `gui/src/i18n/{en,ko,zh}.ts`. The card
  includes a shared explainer (`gui/src/components/ClassifierInfo.tsx`): what the classifier is, the
  4-step pipeline (action → Haiku-class side-query → routing precedence → allow/block), what each
  control changes (blank = defaultModel fallback + warning; fallback overrides per-provider; Anthropic
  default = native haiku), and the policy-vs-model note (model changes interpretation strictness of the
  built-in allow/soft_deny/hard_deny policy; the policy itself is tuned in Claude Code via
  `claude auto-mode defaults`/`config`; hard_deny always blocks). The same pipeline + policy note is in
  `docs-site/content/docs/{en,ko,zh-cn}/reference/configuration.md` "Classifier routing fields".

## Invariants

- The classifier is a permission/safety judge. Never silently install a heavy or wrong model as the
  judge: an unconfigured Haiku-class request falls back to `defaultModel` with a loud `warning`.
- Selection is deterministic and config-driven. No route-time auto-guessing by model-name shape, and
  no live pricing/`:floor` selection (rejected: non-deterministic and unsafe for a safety judge).
- Explicit config (`classifierFallback`, then per-provider `classifierModel`) always overrides.
- Save-time validation is warn-only; never `400` on an unknown model against a partial `models[]`.

## Tests

- `tests/router.test.ts`, `tests/router-classifier.adversarial.test.ts` — precedence, Haiku-class
  detection, negatives (sonnet/opus/default), `classifierFallback` precedence, warning carrier.
- `tests/classifier-settings.test.ts`, `tests/classifier-settings.adversarial.test.ts` — broad
  enumeration, warn-only, delete semantics, `classifierFallback` lifecycle, malformed-JSON `400`.
- `tests/provider-registry-parity.test.ts` — `deriveOAuthProviderConfig('codex')` yields
  `classifierModel`.

## Not automated

The auto-mode deny behavior (a hard-deny action such as data exfiltration and a soft-deny action such
as `curl | bash` staying blocked under a `gpt-5.4-mini` classifier) is a documented MANUAL gate; no
auto-mode e2e harness exists.
