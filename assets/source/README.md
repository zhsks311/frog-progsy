# FrogProgsy brand source assets

This directory is the editable source area for FrogProgsy brand artwork.

- `mascot.png` is the icon/logo master.
- `wordmark.png`, `wordmark-light.png`, and `wordmark-dark.png` are the banner/OG wordmark masters.
- `frogprogsy-mark.svg` is the retired neutral placeholder.
- `brand-manifest.json` maps source intent to checked-in output files and expected dimensions.

Checked-in outputs are split by consumer:

- `assets/` is the canonical README/package asset set.
- `docs-site/src/assets/` and `docs-site/public/` are docs-site build/public assets.
- `gui/public/` is the GUI public asset set.

Do not hand-edit duplicated consumer copies. For shared copies that must remain byte-identical, edit the canonical file under `assets/`, then run `bun run sync:assets`. `bun run sync:assets:check` fails when those copies drift.
