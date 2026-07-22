# Docs And Release SOT

## Public docs

The public documentation site lives in `docs-site/` and is built with Next.js + fumadocs
(`docs-site/next.config.mjs`, `docs-site/source.config.ts`). English is served at the site root,
Korean under `/ko`, and Simplified Chinese under `/zh-cn`; content trees live at
`docs-site/content/docs/{en,ko,zh-cn}/`.

Navigation is defined per directory in `meta.json` files inside the content trees. When adding a
public page, add it to all three locale trees and the relevant `meta.json` — partial-locale pages
are rejected by the parity guard below.

### Docs i18n parity policy

Documentation follows the same localization policy as the dashboard i18n (`gui/src/i18n`: `en` is
the source of truth; ko/zh are compile-checked against its keys). For docs, English is the source
of truth and `tests/docs-i18n-parity.test.ts` enforces, for every page across `en`/`ko`/`zh-cn`
and for the README triple (`README.md`/`README.ko.md`/`README.zh-CN.md`):

- identical file sets (no missing or extra pages per locale),
- identical frontmatter keys,
- identical heading-depth sequences (titles translate, structure does not),
- identical fence count + info-string sequence,
- byte-identical fence bodies for machine-content fences (`json`/`jsonc`/`ts`/`tsx`/`js`) —
  prose-ish fences (`text`/`txt`/`bash` diagrams and commented commands) may localize,
- identical multisets of high-precision decimal tokens, so numeric claims (eval deltas, CI bounds)
  cannot drift between locales.

Editing docs in one language only will fail `bun test`; translate (or structurally mirror) all
three locales in the same change.

## GitHub Pages

`.github/workflows/deploy-docs.yml` publishes the docs to:

```text
https://zhsks311.github.io/frog-progsy/
```

The workflow runs on `main` pushes touching `docs-site/**` or the workflow itself, builds
`docs-site`, uploads the artifact, and deploys with GitHub Pages.

Local validation:

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

## GitHub workflow map

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `.github/workflows/ci.yml` | `pull_request`, `push` to `main` or `dev`, or manual dispatch when runtime/package paths change | Linux, Windows, and macOS quality gate. Every test process uses a temporary `FROGPROGSY_HOME`; tests run with Bun isolation. The GitHub-hosted macOS lane also runs the opt-in scoped Keychain grant lifecycle smoke. |
| `.github/workflows/package-lifecycle.yml` | `pull_request`, `push` to `main` or `dev`, or manual dispatch when package/lifecycle paths change | Build one Bun tarball, then install and exercise those exact bytes on Linux, Windows, and macOS through start, explicit restore, stop, restart, final restore, and package-only removal. |
| `.github/workflows/release.yml` | Manual dispatch only | Bun validation/dry-run plus final Trusted Publishing workflow. It requires the exact `GITHUB_SHA` to have successful Cross-platform CI and Package lifecycle runs before publish or dry-run. |
| `.github/workflows/deploy-docs.yml` | `push` to `main` touching `docs-site/**` or the workflow, or manual dispatch | Build and publish the Next.js/Fumadocs site to GitHub Pages. |


Docs-only changes intentionally route through the docs workflow instead of the runtime gates. If a
docs change also edits runtime/package/release files, run the relevant local checks before push and
let `ci.yml` plus `package-lifecycle.yml` provide the three-platform confirmation.

## Root README

The root READMEs are the concise product entrypoint. They should explain what frogprogsy does, how to
install/start it, where Claude Code state is touched, and where the full docs live. Deep implementation
invariants belong in `structure/`, not the README.

## Local investigations and artifacts

`docs/` and `artifacts/` are gitignored, local-only investigation and verification output. Never
commit either directory. When an investigation becomes a maintained invariant, record it under
`structure/`; publish user-facing guidance through `docs-site/` and the localized root READMEs.

## Bun development package cycle

Development dependency installation, testing, GUI builds, tarball creation, global installation, updates,
and package-only removal use Bun. `package.json` pins the expected Bun toolchain through `packageManager`
and exposes `bun run dev:package`.

`dev:package build` runs the full local gates by default and writes an immutable tarball plus SHA-256
manifest under the repository Git common directory. All linked worktrees share that directory. A build id
contains package version, commit, completion timestamp, and tarball hash; `latest` means the most recently
completed successful build, with a deterministic build-id tie break. Updating `latest.json` is serialized by
an owner-token lock and an atomic rename, so concurrent worktrees cannot silently select an older build.

`dev:package install --yes` installs either the shared latest manifest or an explicit `--build <id>` only
after size/hash verification. The installed package receives a local build receipt, and
`dev:package status` reports `current`, `outdated`, `untracked`, or `not-installed`. `reinstall --yes`
always installs the tarball produced by that invocation rather than re-resolving latest after the build.

The development script manages only Bun's global package/link state. It never invokes the product-level
uninstall command and never removes frogprogsy config, Claude homes, Keychain entries, grants, or other
credentials. Public registry publishing is a separate release concern.

## Release strategy

This file is the single maintainer source of truth for release policy. `CLAUDE.md` and `AGENTS.md`
carry only the non-negotiable summary, `.github/workflows/release.yml` is the executable enforcement
layer, and the localized READMEs contain only consumer installation and update instructions. Do not
duplicate the full strategy across those surfaces.

### Version and channel policy

frogprogsy uses SemVer release versions and two registry channels:

| Channel | Version form | Purpose |
| --- | --- | --- |
| `preview` | prerelease version such as `0.2.0-preview.1` | Validate a candidate without moving the stable install channel. |
| `latest` | stable version such as `0.2.0` | Supported public release installed by default. |

A published preview is immutable and is not republished as stable. After preview validation, publish
the corresponding stable version as a new release. Every changed package version is consumed even if
a later metadata step fails; recovery uses a new patch or prerelease number.

### Release sequence

1. Land the release contents on `main` through the normal branch/worktree path.
2. Choose an unused version and update `package.json` in a dedicated release commit.
3. Require successful Cross-platform CI and Package lifecycle runs for that exact commit SHA.
4. Run the release workflow as a dry-run for that SHA and verify the exact Bun-built tarball.
5. Dispatch a real publish for the same SHA with `preview` for a prerelease version or `latest` for a
   stable version. If `main` moved after the dry-run, repeat the dry-run on the new release SHA.
6. Require the registry smoke, immutable `v<version>` tag, and matching GitHub Release to succeed.
7. Verify the published version and dist-tags with `bun pm view`; retain the workflow URL as the
   release receipt.

`scripts/release.ts` automates the version commit, push, exact-SHA gate wait, workflow dispatch, and
watch steps. Direct local registry publishing is not a supported shortcut.
Manual dispatch must set `expected-sha` to the full 40-character release commit. The workflow compares
it with `GITHUB_SHA` before any registry work; `scripts/release.ts` supplies it automatically.

### First-package bootstrap

Trusted Publisher configuration is attached to an existing npm package, so the first package version
is a separate, one-time bootstrap. It must still run in the real-publish GitHub Actions lane using a
short-lived npm credential; local `npm publish` is not permitted.

1. Create a granular npm token with the shortest available expiry, read/write access to **All
   Packages** (the package does not exist yet), and 2FA bypass only for this CI publish. Store it as
   the `NPM_BOOTSTRAP_TOKEN` GitHub Actions secret.
2. Run `bun run release <version> --publish --bootstrap`. Bootstrap is stable/`latest` only; the helper
   and workflow still require the exact-SHA CI gates and exact Bun-built tarball.
3. On npmjs.com, configure the package Trusted Publisher with owner `zhsks311`, repository
   `Frogprogsy`, workflow filename `release.yml`, and the `npm publish` action.
4. Revoke the granular token on npmjs.com, delete the `NPM_BOOTSTRAP_TOKEN` Actions secret, verify a
   normal OIDC release, and configure npm publishing access to disallow token publishing.

After the first normal OIDC release, confirm that npm shows provenance for the published tarball before
treating the Trusted Publisher migration as complete.

The workflow rejects bootstrap during dry-runs, after the package exists, or when the scoped secret is
missing. Normal releases receive no registry token and must fail closed rather than fall back from OIDC.

### Recovery policy

Do not unpublish, overwrite tarballs, force-move public tags, or reuse a consumed version. For a bad
stable release, fix forward with the next patch and publish it to `latest`. For a bad preview, publish
the next prerelease number. Metadata disagreement between the registry, Git tag, and GitHub Release
blocks automation until maintainers either repair the missing metadata at the same immutable commit
or choose a new version. The normal release workflow does not perform ad-hoc dist-tag rollback.

## Release workflow

Package development and release preparation are Bun-first. `package.json` defines the `frogprogsy` package
and the `frogp`/`claude` bins; `prepublishOnly` runs typecheck and GUI build; and `scripts/release.ts` uses
Bun for registry preflight, version updates, and release orchestration. The workflow then creates one
allowlisted, hash-recorded tarball through `scripts/dev-package.ts`. Each workflow run verifies the exact
tarball it produced: dry-run validates it with Bun, while a real run passes that same run's verified path
to the final `npm publish`. npm is otherwise confined to the real-publish lane, where it first updates
itself to the OIDC-capable version and then performs Trusted Publishing. The one-time bootstrap uses
the same lane and exact tarball with an explicitly selected short-lived secret; no normal release
receives that credential. This exception remains because tokenless OIDC authentication and provenance
are not currently documented for `bun publish`. Docs publishing is separate from package registry
publishing.

## Release metadata invariants

Every package release version must map cleanly across four surfaces:

| Surface | Required state |
| --- | --- |
| `package.json` | `version` equals the release workflow `version` input. |
| Package registry | `frogprogsy@<version>` does not exist before publish, then exists after publish with the requested dist-tag. |
| Git tag | `v<version>` does not exist before publish, then points at the exact release commit. |
| GitHub Release | `v<version>` does not exist before publish, then is created from the exact release commit. |

The release must fail before the final publish if the package registry, Git tag, or GitHub Release already
has the requested version. This prevents partial releases where a package is published but GitHub Release
creation fails afterward.

Do not force-move public version tags by default. If release metadata is already inconsistent, treat
the version as consumed and publish the next unused patch version instead. Only rewrite a public tag
after an explicit human decision that the public history rewrite is acceptable.

Manual preflight checks when debugging a release:

```bash
bun pm view frogprogsy@<version> version
git ls-remote origin refs/tags/v<version>
gh release view v<version>
```

If any of these commands reports an existing artifact for the requested version, stop before
publishing. For a non-destructive recovery, choose the next unused patch version and release that
version through `scripts/release.ts`.

## Cross-platform CI

`.github/workflows/ci.yml` is the ordinary quality gate for runtime/package changes. It pins the Bun
version declared by `packageManager` and runs on Linux, Windows, and macOS:

```bash
bun install --frozen-lockfile
bun x tsc --noEmit
bun test --isolate ./tests
bun build scripts/release.ts --target=bun --outdir=.tmp/ci-release-script-check
bun run src/cli.ts help
cd gui && bun install --frozen-lockfile && bun run build
```

`bunfig.toml` limits discovery to `tests/` and preloads a process-wide temporary
`FROGPROGSY_HOME`. The preload overrides inherited values and reasserts the temporary home plus
`NODE_ENV=test` before every test, so a developer's live config, PID, active port, and watchdog files
cannot affect the suite. `--isolate` additionally gives each test file a fresh global object, but
`process.env` remains process-wide; tests that mutate other environment variables still own their
explicit save/restore.

The GitHub-hosted macOS lane runs a separately opted-in, bounded Keychain smoke. It creates one
unique grant-scoped item, verifies product read/status/delete behavior including idempotent deletion,
and records only the scoped service/account needed by an `always()` cleanup step. It never targets
the native `Claude Code-credentials` service.

`.github/workflows/package-lifecycle.yml` builds one GUI-bearing tarball on Linux with gates skipped
because `ci.yml` owns those gates, uploads that immutable artifact, and downloads the same bytes in
all three OS jobs. Each job installs into an isolated Bun global root and uses temporary frogprogsy
and Claude homes to verify start, health, explicit restore, stop, restart, final byte-equivalent
restore, watchdog/proxy cleanup, and package-only removal.

The Release workflow remains manual and publish-focused. Before any dry-run or publish step, it
checks that the exact release commit (`GITHUB_SHA`) already has successful Cross-platform CI and
Package lifecycle runs. Missing runs fail closed. This makes release a deployment of a verified
commit rather than a second CI pipeline.
