/**
 * dom-annotakit — host-side snapshot metadata (COPY-MAP preview row:
 * story-meta.ts REPLACE → this module).
 *
 * Upstream's buildStoryRef fetched SB's index.json to enrich Thread.story with
 * importPath/componentPath/title/name and minted `url` as a `?path=/story/`
 * deep link. Here the manifest entry IS the metadata, and `story.url` is the
 * CAPTURE VIEW URL (the host app's `?capture=` deep link) — so the
 * `?path=/story/` fallbacks (routes.ts:670, ghsync.ts:244, ghClient.ts:627)
 * never fire. Precedent: upstream story-meta.ts:79.
 *
 * D7 (2026-10-23): `title` AND `name` are the FILENAME, extension-stripped —
 * never the page `<title>`. This is the single choke point every NEW thread's
 * story name flows through (panel headers, digests/exports, mirror items).
 * Already-seeded threads keep their old names (documented — the board derives
 * display names from the MANIFEST, not from story.name; audit P2-7).
 *
 * getSnapshotMeta runs in the HOST window; injectLayer hands the result to the
 * iframe as `window.__DOM_AK_SNAPSHOT_META__`, and the layer's local
 * buildStoryRef (layer.tsx EDIT (iii)) consumes it.
 */

import { captureName } from './capture-id';

export interface SnapshotMeta {
  storyId: string;
  title?: string;
  name?: string;
  /** The capture view URL — `?capture=<captureId>` on the current app URL. */
  url?: string;
}

/** Manifest entry fields the meta derives from. */
export interface CaptureLike {
  title?: string;
  relpath: string;
}

export function getSnapshotMeta(captureId: string, capture: CaptureLike): SnapshotMeta {
  const displayName = captureName(capture.relpath);
  const meta: SnapshotMeta = {
    storyId: captureId,
    title: displayName,
    name: displayName,
  };
  try {
    const u = new URL(location.href);
    u.searchParams.set('capture', captureId);
    u.hash = '';
    meta.url = u.href;
  } catch {
    /* location unavailable — threads keep a bare storyId */
  }
  return meta;
}
