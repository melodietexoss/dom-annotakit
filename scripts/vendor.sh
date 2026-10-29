#!/usr/bin/env bash
# vendor.sh — verbatim copy of all COPY-MAP files from the upstream SB kit
# clone into this repo. AS-IS + EDIT files start byte-identical; edits are
# applied afterwards with reviewable diffs. REPLACE files are NOT copied.
# Re-runnable: idempotent (overwrites). Source pinned by UPSTREAM.
set -euo pipefail

UP=/home/z/ak/sb-annotakit-dev
HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "Upstream: $UP ($(git -C "$UP" rev-parse --short HEAD))"
[ "$(git -C "$UP" rev-parse --short HEAD)" = "2853e32" ] || { echo "UPSTREAM PIN MISMATCH (expected 2853e32) — update UPSTREAM + COPY-MAP first or re-clone."; exit 1; }

# --- src/shared (11 files; REPLACE: none. legacyMirror + events = AS-IS per crit-1b) ---
for f in types.ts metaline.ts describe.ts cascade.ts hotkeys.ts recall.ts events.ts staticStore.ts ghClient.ts mode.ts panelToggle.ts legacyMirror.ts; do
  cp "$UP/src/shared/$f" "$HERE/src/shared/$f"
done

# --- src/preview (EDIT: anchor, hittest, styles, snapshot, layer, api — copied verbatim;
#     REPLACE: story-meta.ts, fiber.ts, index.ts — NOT copied) ---
for f in anchor.ts hittest.ts styles.ts snapshot.ts layer.tsx api.ts; do
  cp "$UP/src/preview/$f" "$HERE/src/preview/$f"
done

# --- src/server (8 files — wholesale; standalone.ts is NEW, not copied) ---
for f in routes.ts store.ts ghsync.ts sync.ts merge.ts digest.ts env.ts gh.ts; do
  cp "$UP/src/server/$f" "$HERE/src/server/$f"
done

# --- src/manager → vendored to src/host/panel/ (EDIT; copied verbatim as the base) ---
mkdir -p "$HERE/src/host/panel"
cp "$UP/src/manager/index.tsx" "$HERE/src/host/panel/ReviewPanel.tsx"

# --- scripts (10 copied; singlefile-import-test/manifest-test/drift-check are NEW) ---
for f in s6-unit-test.mjs ghclient-test.mjs static-store-test.mjs lattice-test.mjs \
         ghsync-fake.mjs store-robust.mjs heal-mirrors.mjs bake-static-threads.mjs \
         release-check.mjs api-test.mjs serve-static.py detach-run.py; do
  cp "$UP/scripts/$f" "$HERE/scripts/$f"
done

echo "Vendored:"
git -C "$HERE" status --short | head -40
