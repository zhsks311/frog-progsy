# AGENTS.md — frogprogsy

frogprogsy is a local provider proxy for Claude Code (bin `frogp`, config `~/.frogprogsy/`).

## Working agreements — read first

The working agreements, preferences, and known pitfalls for this repo live in
**[`./CLAUDE.md`](./CLAUDE.md)** (written in Korean). **Read and follow `./CLAUDE.md` before acting.**

Non-negotiable highlights (full detail in `CLAUDE.md`):

- Respond in Korean.
- Do not guess — verify claims by reading source and running tools/tests first.
- Prefer the simplest correct solution; safety-sensitive choices (the auto-mode classifier) must stay
  deterministic, verifiable, and overridable — no route-time model-name guessing, no price-based auto-pick.
- Distinguish "implemented & committed" vs "planned" vs "runtime-only (`.gjc/`, gitignored)". Never
  call transient/runtime state "saved/done".

## Where things live

- Maintainer source of truth: `structure/*.md` (e.g. `structure/07_classifier-routing.md` for classifier routing).
- Release strategy source of truth: [`structure/06_docs-and-release.md`](structure/06_docs-and-release.md); `.github/workflows/release.yml` is its executable enforcement layer.
- Public documentation: `docs-site/` plus the root localized READMEs.
- Local investigations and generated evidence: `docs/` and `artifacts/` — gitignored and never committed.
- Runtime state / workflow artifacts: `.gjc/` — gitignored, runtime-owned. Never hand-edit; use the `gjc` CLI. Durable specifications and maintainer decisions belong in `structure/`.

## Verify before claiming done

`bun run typecheck` + `bun test --isolate ./tests` (full suite) + `bun run build:gui` when the GUI changed.

## Bun development packaging

- Bun owns dependency installation, local checks, GUI builds, package creation, global install/update, and
  package-only removal. Use `bun run dev:package`; do not add a parallel npm-based local workflow.
- Main commands: `build`, `install --yes`, `reinstall --yes`, `status`, and `uninstall --yes`.
- Dev builds are immutable, hash-recorded artifacts shared through the Git common directory. Check
  `bun run dev:package status` rather than guessing which worktree produced the installed `frogp`.
- Dev-package `uninstall` removes only the Bun global package/link and must preserve `~/.frogprogsy`,
  Claude homes, Keychain entries, grants, and credentials. Do not substitute the destructive product-level
  `frogp uninstall`.
- npm is permitted only in the real-publish GitHub Actions lane. Normal releases use OIDC Trusted
  Publishing for the exact Bun-built tarball; only the explicit first-package bootstrap may use its
  short-lived scoped secret. The maintained contract is
  [`structure/06_docs-and-release.md`](structure/06_docs-and-release.md).
- Do not reintroduce retired product or worktree names into active source, scripts, tests, or user docs.

## Git

Land work via a branch + worktree → commit → merge to `main`. Do NOT push to a remote without an explicit
request. Never resolve/commit/revert the user's in-progress merge or conflicts unless explicitly asked.
