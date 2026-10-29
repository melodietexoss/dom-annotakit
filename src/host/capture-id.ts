/**
 * dom-annotakit — captureId (design D2b): the relative path from the captures
 * root, extension-stripped, sanitized `[^a-zA-Z0-9-]` → `-`. This is the
 * thread's `storyId` — the join key between the manifest, the store, and the
 * layer.
 *
 * The MANIFEST carries BOTH `id` and `relpath` (preferred — no reverse
 * mapping exists); captureIdOf runs only at build/listing time (bake +
 * the server manifest route). Rename = new identity (documented; threads stay
 * keyed to the old id). Basename collisions (a/b.html vs a-b.html) are a
 * LOUD failure at the manifest doors, never a silent merge.
 *
 * D7 (2026-10-23): the DISPLAY identity is `captureName` — the FILENAME,
 * extension-stripped, NEVER the page `<title>` ("users organize those
 * captures" by renaming files; mixing the two was the complaint). The id
 * stays a full-relpath sanitize (subdirs collapse into dashes); the name
 * keeps the basename verbatim.
 */

export function captureIdOf(relpath: string): string {
  const noExt = relpath.replace(/\.[^./\\]+$/, '');
  return noExt.replace(/[^a-zA-Z0-9-]/g, '-');
}

/** D7: the DISPLAY name — basename minus the extension, unsanitized. */
export function captureName(relpath: string): string {
  const base = relpath.replace(/^.*[/\\]/, '');
  return base.replace(/\.(html?|htm)$/i, '');
}
