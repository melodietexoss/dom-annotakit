#!/usr/bin/env node
/**
 * scripts/drift-check.mjs — COPY-MAP enforcement (COPY-MAP scripts row: NEW).
 *
 * Re-diffs every VENDORED file against the UPSTREAM pin (the `UPSTREAM` file:
 * repo URL + commit) and fails on any delta beyond the edits COPY-MAP lists.
 *
 *  - AS-IS files must be BYTE-IDENTICAL to the pin (no import-path rewrites
 *    exist: vendor.sh copied verbatim, directory shape preserved).
 *  - EDIT files: every changed line (added or removed) must be in the file's
 *    `allow` list below — EXACT line-content fingerprints, one group per
 *    COPY-MAP'd edit site, reviewed hunk-by-hunk against COPY-MAP at M6
 *    (Task 10, audit round). The lists are intentionally exact-line: a future
 *    edit that touches ANY other line (incl. rewording an allowed one) fails
 *    here — re-review it against COPY-MAP, then re-apply the row. The site
 *    comment above each list cites the COPY-MAP justification.
 *  - REPLACE / REWRITTEN / NEW files have no hunk-checked upstream twin —
 *    they are listed in OUT_OF_SCOPE and reported as out of drift scope.
 *
 * Usage: npm run test:drift   (or: node scripts/drift-check.mjs)
 * Upstream clone override: $DOM_AK_UPSTREAM_CLONE
 * (default: /home/z/ak/sb-annotakit-dev — must contain the UPSTREAM pin).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------- upstream pin ------------------------------- */

const UPSTREAM_TXT = readFileSync(path.join(REPO_ROOT, 'UPSTREAM'), 'utf8');
const UPSTREAM_URL = UPSTREAM_TXT.match(/https?:\/\/\S+/)?.[0];
const UPSTREAM_SHA =
  UPSTREAM_TXT.trim().split(/\s+/).find((t) => /^[0-9a-f]{40,}$/.test(t)) ??
  UPSTREAM_TXT.trim().split(/\s+/).filter(Boolean).pop();
const UPSTREAM_CLONE = process.env.DOM_AK_UPSTREAM_CLONE || '/home/z/ak/sb-annotakit-dev';

if (!UPSTREAM_URL || !UPSTREAM_SHA) {
  console.error('drift-check: UPSTREAM file malformed (need repo URL + pin commit)');
  process.exit(1);
}

let pinnedOk = false;
try {
  execFileSync('git', ['-C', UPSTREAM_CLONE, 'cat-file', '-e', `${UPSTREAM_SHA}^{commit}`], { stdio: 'pipe' });
  pinnedOk = true;
} catch {
  /* loud error below */
}
if (!pinnedOk) {
  console.error(
    `drift-check: upstream clone ${UPSTREAM_CLONE} does not contain pin ${UPSTREAM_SHA} (from the UPSTREAM file).` +
      ` Clone ${UPSTREAM_URL} (or point $DOM_AK_UPSTREAM_CLONE at an existing clone).`,
  );
  process.exit(1);
}

function upstreamBlob(file) {
  return execFileSync('git', ['-C', UPSTREAM_CLONE, 'show', `${UPSTREAM_SHA}:${file}`], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
}

/* ------------------------------ file spec table ----------------------------- */

/* AS-IS: byte-identical to the pin. (preview/api.ts is listed as EDIT in
 * COPY-MAP but its listed edits changed nothing — "API base unchanged; static
 * branch unchanged; envelope code unchanged" — it is byte-identical today.) */
const AS_IS = [
  'src/shared/metaline.ts',
  'src/shared/describe.ts',
  'src/shared/cascade.ts',
  'src/shared/hotkeys.ts',
  'src/shared/recall.ts',
  'src/shared/events.ts',
  'src/shared/panelToggle.ts',
  'src/shared/legacyMirror.ts',
  'src/preview/api.ts',
  'src/preview/hittest.ts',
  'src/server/store.ts',
  'src/server/merge.ts',
  'src/server/gh.ts',
  'scripts/s6-unit-test.mjs',
  'scripts/static-store-test.mjs',
  'scripts/lattice-test.mjs',
  'scripts/store-robust-server.mjs',
  'scripts/serve-static.py',
  'scripts/detach-run.py',
];

/* EDIT: every changed line must be in the file's allow list (exact content). */
const EDIT_FILES = [
  {
    // COPY-MAP shared/types: Comment.source + 'singlefile'; TargetContext.singleFileNoteRef/.singleFileDangling (3 additive lines, L233/L154-179)
    file: "src/shared/types.ts",
    allow: [
    "  /** dom-annotakit: the SingleFile note id this thread was imported from",
    "   *  (singlefile-import provenance — additive, merge-safe). */",
    "  singleFileNoteRef?: string;",
    "  /** dom-annotakit: true when the note's target is NOT in the capture DOM",
    "   *  (or is page-level) — panel-only thread, no canvas pin. */",
    "  singleFileDangling?: boolean;",
    "  /** 'github' = imported from a GitHub issue comment by pull-sync. */",
    "  source?: 'local' | 'github';",
    "  /** 'github' = imported from a GitHub issue comment by pull-sync;",
    "   *  'singlefile' = imported from an embedded SingleFile note (dom-annotakit). */",
    "  source?: 'local' | 'github' | 'singlefile';",
    ],
  },
  {
    // COPY-MAP shared/staticStore: label strings story->capture (L720, 817-820)
    file: "src/shared/staticStore.ts",
    allow: [
    "    if (t.story.importPath) out.push(`- story: ${metaLine(`${t.story.title ?? ''}/${t.story.name ?? ''} (${t.story.importPath})`)}`);",
    "    if (t.story.importPath) out.push(`- capture: ${metaLine(`${t.story.title ?? ''}/${t.story.name ?? ''} (${t.story.importPath})`)}`);",
    "    out.push(`story id: \\`${metaLine(st.storyId, 200)}\\``);",
    "    if (st.importPath) out.push(`story file: ${metaLine(st.importPath)}`);",
    "    out.push(`capture id: \\`${metaLine(st.storyId, 200)}\\``);",
    "    if (st.importPath) out.push(`capture file: ${metaLine(st.importPath)}`);",
    ],
  },
  {
    // COPY-MAP shared/mode: window.__DOM_AK_APP_BASE__ FIRST health candidate (crit-1a P2-9)
    file: "src/shared/mode.ts",
    allow: [
    "declare global {",
    "  interface Window {",
    "    /** dom-annotakit: host-injected build constant — the review app's base",
    "     *  URL. First health candidate (see healthOk): a server/subpath",
    "     *  deployment defeats both ladder rungs inside the capture iframe",
    "     *  (critique-1a P2-9). */",
    "    __DOM_AK_APP_BASE__?: string;",
    "  }",
    "}",
    "",
    "  const candidates = [",
    "    new URL('annotakit/api/health', document.baseURI).href,",
    "    new URL('/annotakit/api/health', window.location.origin).href,",
    "  ];",
    "  const candidates: string[] = [];",
    "  // dom-annotakit: `window.__DOM_AK_APP_BASE__` (host-injected) is the FIRST",
    "  // candidate — a subpath/proxied deployment keeps the API under the review",
    "  // app's base, which neither of the two ladder rungs below can see from",
    "  // inside the capture iframe (baseURI-relative points at the capture",
    "  // document, origin-root only covers dev-at-root).",
    "  if (typeof window.__DOM_AK_APP_BASE__ === 'string' && window.__DOM_AK_APP_BASE__) {",
    "    try {",
    "      candidates.push(new URL('annotakit/api/health', window.__DOM_AK_APP_BASE__).href);",
    "    } catch {",
    "      /* malformed injected base — fall through to the ladder */",
    "    }",
    "  candidates.push(new URL('annotakit/api/health', document.baseURI).href);",
    "  candidates.push(new URL('/annotakit/api/health', window.location.origin).href);",
    ],
  },
  {
    // COPY-MAP shared/ghClient: DEFAULT_LABEL dom-annotakit; ?capture= deep-link; SB notices -> host wording; footer reworded (L54/627/212/631/652/707/711/1173/1307/640)
    file: "src/shared/ghClient.ts",
    allow: [
    "const DEFAULT_LABEL = 'annotakit';",
    "const DEFAULT_LABEL = 'dom-annotakit';",
    "        `GitHub rejected the token (401: ${text.slice(0, 160)}). Open the annotakit panel → static GitHub settings and paste a fresh PAT (github.com/settings/tokens, classic: repo scope). Feedback stays queued until then.`,",
    "        `GitHub rejected the token (401: ${text.slice(0, 160)}). Open the review app drawer → GitHub settings and paste a fresh PAT (github.com/settings/tokens, classic: repo scope). Feedback stays queued until then.`,",
    "  const storyUrl = t.story?.url ?? `${origin}?path=/story/${t.storyId}`;",
    "  const storyUrl = t.story?.url ?? `${origin}?capture=${t.storyId}`;",
    "  out.push(`storybook (static deployment): ${origin}`);",
    "  out.push(`review app (static deployment): ${origin}`);",
    "    'Agent loop: fix the code at the `jsx:`/`component file:` paths, comment with fix evidence, then mark the thread FIXED — do NOT close this issue: on this mirror, closing = the reviewer CONFIRMED your fix (they close it, or confirm in the panel). A `rejected — the fix was not accepted` notice means re-work is expected (the thread stays in the re-work queue until you re-address it and they confirm). ' +",
    "      'Note: `jsx: file:line` points at the component definition (may be a few lines off); the `element:`/`selector:` lines pinpoint the exact pinned node.',",
    "    'Agent loop: open the capture (the `open:` link above) — the `element:`/`selector:` rows locate the pinned target in the capture; comment with fix evidence, then mark the thread FIXED — do NOT close this issue: on this mirror, closing = the reviewer CONFIRMED your fix (they close it, or confirm in the review app drawer). A `rejected — the fix was not accepted` notice means re-work is expected (the thread stays in the re-work queue until you re-address it and they confirm).',",
    "      'full thread: the Storybook annotakit panel export (threads → Download JSON))'",
    "      'full thread: the review app drawer export (threads → Download JSON))'",
    "  return `${GH_SENTINEL}\\nresolved in Storybook — thread #${t.number}${t.resolvedAt ? `, ${t.resolvedAt.slice(0, 16).replace('T', ' ')}` : ''}. Fix evidence is in the replies above.`;",
    "  return `${GH_SENTINEL}\\nresolved in the review app — thread #${t.number}${t.resolvedAt ? `, ${t.resolvedAt.slice(0, 16).replace('T', ' ')}` : ''}. Fix evidence is in the replies above.`;",
    "  return `${GH_SENTINEL}\\nreopened in Storybook — thread #${t.number}.`;",
    "  return `${GH_SENTINEL}\\nreopened in the review app — thread #${t.number}.`;",
    "      await addIssueCommentRemote(cfg, created.number, `${GH_SENTINEL}\\nthread deleted in Storybook (static) — closing.`);",
    "      await addIssueCommentRemote(cfg, created.number, `${GH_SENTINEL}\\nthread deleted in the review app (static) — closing.`);",
    "  await addIssueCommentRemote(cfg, op.issue, `${GH_SENTINEL}\\nthread deleted in Storybook (static) — closing.`);",
    "  await addIssueCommentRemote(cfg, op.issue, `${GH_SENTINEL}\\nthread deleted in the review app (static) — closing.`);",
    ],
  },
  {
    // COPY-MAP preview/anchor: className exclusion += /^single-file-/ (D2b EDIT 1, L116)
    file: "src/preview/anchor.ts",
    allow: [
    "      // dom-annotakit (D2b EDIT 1): `single-file-*` classes (highlight yellow/",
    "      // red, …) are RE-REVIEW STATE, not page identity — a captured selector",
    "      // embedding them breaks the css rung the moment the capture is re-saved",
    "      // without the highlight.",
    "        name.length > 3 && !name.startsWith('_') && !/(?:^|[-_])(?:css|scss|module)/.test(name),",
    "        name.length > 3 && !name.startsWith('_') && !/(?:^|[-_])(?:css|scss|module)/.test(name) && !/^single-file-/.test(name),",
    ],
  },
  {
    // COPY-MAP preview/styles: .annota-root z-index -> 2147483647 (D2a z-war)
    file: "src/preview/styles.ts",
    allow: [
    "  z-index: 2147483000;",
    "  /* dom-annotakit (D2a z-war): SingleFile note cards paint at 2147483646 —",
    "     the review surface must win; max-z + DOM order (we inject after the",
    "     capture content) beats same-z cards. */",
    "  z-index: 2147483647;",
    ],
  },
  {
    // COPY-MAP preview/snapshot: SB portal-sweep selectors dropped; body-root contains() skip; frozen-veil z -> 2147483646 (L204 cssText)
    file: "src/preview/snapshot.ts",
    allow: [
    "  container.style.cssText = `position:fixed;inset:0;z-index:2147482000;pointer-events:auto;overflow:auto;background:${frozenBackground(liveRoot)};`;",
    "  // dom-annotakit (D2a z-war, COPY-MAP snapshot.ts (2)): SingleFile note cards",
    "  // style themselves at 2147483646 — the frozen view must paint above them",
    "  // (later DOM order wins same-z ties) while staying BELOW .annota-root",
    "  // (2147483647, styles.ts) so pins/cards/composer keep painting over it.",
    "  container.style.cssText = `position:fixed;inset:0;z-index:2147483646;pointer-events:auto;overflow:auto;background:${frozenBackground(liveRoot)};`;",
    "  // 2. portal sweep — the PRIMARY use case (context menus, tooltips, toasts",
    "  //    living at body level via the radix/floating-ui pattern). Skips:",
    "  //    non-elements, the live root, head-ish tags, our own surfaces, SB chrome",
    "  //    (the sb-* namespace + SB's own body-level roots) and zero-area children",
    "  //    (display:none SB wrappers, closed-but-mounted portals — hidden surfaces",
    "  // 2. portal sweep — body-level content OUTSIDE the live root (the radix/",
    "  //    floating-ui portal pattern). Skips: non-elements, anything the live root",
    "  //    already contains (dom-annotakit: the capture root IS document.body, so",
    "  //    every body child is capture content and the story clone itself carries",
    "  //    it — the SB shape skipped only `child === liveRoot`, which in the",
    "  //    body-rooted capture shape duplicated EVERY body child below the",
    "  //    clone), head-ish tags, our own surfaces and zero-area children",
    "  //    (display:none wrappers, closed-but-mounted portals — hidden surfaces",
    "  //    dom-annotakit (COPY-MAP snapshot.ts (1)): the SB chrome exclusions",
    "  //    (`sb-*` classes, #storybook-docs, #storybook-highlights-root,",
    "  //    data-sb-error) are DROPPED — no such namespace exists in a SingleFile",
    "  //    capture; the generic aria-live skip stays.",
    "    if (child === liveRoot) continue;",
    "    if (liveRoot.contains(child)) continue; // inside the live root (or the root itself)",
    "    if (child.hasAttribute('aria-live') || child.hasAttribute('data-sb-error')) continue; // SB chrome / a11y announcements",
    "    if (child.id === 'storybook-docs' || child.id === 'storybook-highlights-root') continue; // SB's own body-level roots",
    "    if ([...child.classList].some((c) => c.startsWith('sb-'))) continue; // the SB namespace (wrappers, errordisplay)",
    "    if (child.hasAttribute('aria-live')) continue; // a11y announcements (visually hidden by convention)",
    ],
  },
  {
    // COPY-MAP preview/layer: the SEVEN surgical points — (i) injected channel (L19/74), (iii) getSnapshotMeta/buildStoryRef (L23/1412), (v) singleFileDangling pin-render filter (skips PINS only), (vi) freezeEnabled honored at ALL entries (hotkey+UI_COMMAND+UI_STATE frozenViewEnabled), (vii) per-pin capture OFF (snap=null) + the import-line fallout of (i)/(iii)/(vii)
    file: "src/preview/layer.tsx",
    allow: [
    "import { addons } from 'storybook/preview-api';",
    "import { buildStoryRef } from './story-meta';",
    "import { captureFrozenSnapshot, captureFrozenView, captureSnapshot, mountRecalledView, type FrozenMount } from './snapshot';",
    "import { captureFrozenView, mountRecalledView, type FrozenMount } from './snapshot';",
    "import type { Comment, ComponentRef, TargetContext, Thread, ThreadTarget } from '../shared/types';",
    "import type { Comment, ComponentRef, StoryRef, TargetContext, Thread, ThreadTarget } from '../shared/types';",
    "/** dom-annotakit: the channel used when no host injected one (the capture",
    " *  iframe opened standalone) — every call site keeps its try/catch contract;",
    " *  pinning still works, only the toolbar/panel go deaf. */",
    "const noopChannel: ChannelLike = {",
    "  on: () => undefined,",
    "  removeListener: () => undefined,",
    "  emit: () => undefined,",
    "};",
    "",
    "/** dom-annotakit (COPY-MAP layer EDIT (i)): SB's `addons.getChannel()` is",
    " *  replaced by the HOST-injected channel object — `window.__DOM_AK_CHANNEL__`,",
    " *  set on the capture iframe BEFORE layer.mjs loads (a same-origin object",
    " *  reference; the host's channel pair fans every emit out to BOTH heaps —",
    " *  host panel/toolbar + this layer). The name stays `sbChannel()` so every",
    " *  call site is byte-identical. */",
    "function sbChannel(): ChannelLike {",
    "  try {",
    "    return ((window as any).__DOM_AK_CHANNEL__ as ChannelLike | undefined) ?? noopChannel;",
    "  } catch {",
    "    return noopChannel;",
    "  }",
    "}",
    "/** dom-annotakit (COPY-MAP layer EDIT (iii)): replaces ./story-meta's SB",
    " *  index.json lookup — the host injects the capture's metadata pre-script:",
    " *  `window.__DOM_AK_SNAPSHOT_META__` = { storyId, name, url }. `story.url` is",
    " *  minted as the CAPTURE VIEW URL (the host's `?capture=` deep link), so the",
    " *  `?path=/story/` fallbacks (routes.ts:670, ghsync.ts:244, ghClient.ts:627)",
    " *  never fire. All StoryRef fields except storyId are optional — an absent",
    " *  injection degrades to the props-passed title/name, never breaks pinning. */",
    "function injectedSnapshotMeta(): { storyId?: string; title?: string; name?: string; url?: string } {",
    "    return (window as any).__DOM_AK_SNAPSHOT_META__ ?? {};",
    "    return {};",
    "async function buildStoryRef(storyId: string, context: { title?: string; name?: string } = {}): Promise<StoryRef> {",
    "  const meta = injectedSnapshotMeta();",
    "  return {",
    "    storyId,",
    "    title: meta.title ?? context.title,",
    "    name: meta.name ?? context.name,",
    "    ...(meta.url ? { url: meta.url } : {}),",
    "  };",
    "/** dom-annotakit (COPY-MAP layer EDIT (vi), design D2a freeze gate): the",
    " *  manifest-derived freeze option, injected as",
    " *  `window.__DOM_AK_OPTIONS__ = { freezeEnabled: boolean }` (default true;",
    " *  false when the capture exceeds the host's 20MB clone threshold — freeze",
    " *  deep-clones the WHOLE captured DOM). toggleFreeze is the single funnel",
    " *  for the ⌥I hotkey, the UI_COMMAND 'freeze' handler, and any internal",
    " *  trigger, so gating it here covers EVERY entry (upstream refused only when",
    " *  frozenView === false — a story parameter, not a per-capture size gate). */",
    "function freezeEnabledOption(): boolean {",
    "    return (window as any).__DOM_AK_OPTIONS__?.freezeEnabled !== false;",
    "    return true;",
    "  return (addons as any).getChannel() as ChannelLike;",
    "      frozenViewEnabled: frozenView,",
    "      // dom-annotakit (freeze gate): the toolbar's freeze affordance",
    "      // reflects the per-capture option too — the host disables + hints its",
    "      // freeze button off this field.",
    "      frozenViewEnabled: frozenView && freezeEnabledOption(),",
    "    // dom-annotakit (COPY-MAP layer EDIT (vi), the freeze gate): per-capture",
    "    // size refusal — cloned-DOM freeze over the manifest threshold would",
    "    // jank the session. Dead entries SPEAK (button, ⌥I, UI_COMMAND — all",
    "    // funnel through here), never silently disable.",
    "    if (!freezeEnabledOption()) {",
    "      showHint('Frozen views are disabled for this capture — it is too large to clone safely');",
    "      return;",
    "    }",
    "        // plan-b evidence: the frozen view serializes ITSELF (container +",
    "        // story clone + portals — subtree-aware budget ladder, snapshot.ts);",
    "        // a live pin keeps the existing story-root capture. Captured at",
    "        // submit time, BEFORE the composer closes.",
    "        const snap = staticMode ? null : (",
    "          frozenPin && fm",
    "            ? captureFrozenSnapshot(fm, composer.target.kind === 'pin' ? (composer.element ?? null) : null)",
    "            : captureSnapshot(",
    "                storyRoot(),",
    "                composer.target.kind === 'pin' ? (composer.element ?? null) : null,",
    "              )",
    "        );",
    "        // dom-annotakit (design D3d; COPY-MAP snapshot.ts row (4) — the edit",
    "        // lives at its only call site, layer.tsx submitThread): per-pin DOM",
    "        // snapshots are OFF in v0.1. The capture file IS the evidence (`view`",
    "        // recall = open the capture + focus the pin); the SB-shaped 32KB body",
    "        // clone would only be recall-rejected noise, and cloning a multi-MB",
    "        // capture at every submit janks the exact case the freeze gate exists",
    "        // for. The recall path itself stays (mountRecalledView + the honest",
    "        // live-flash fallback) for lineage threads that DO carry snapshots.",
    "        const snap: DomSnapshot | null = null;",
    "      // dom-annotakit (COPY-MAP layer EDIT (v), design D2c-3): dangling /",
    "      // page-level SingleFile imports render NO canvas pin — no fabricated",
    "      // bbox evidence for a target that is not in the capture. They STAY in",
    "      // `threads` (the UI_STATE counts + the panel's own fetch see them);",
    "      // only the pin render path skips them.",
    "      if (t.target.context.singleFileDangling) continue;",
    // M6 audit (Task 10): the 4 apiOk no-store hints (upstream L896/1118/1419/1424
    // instruct `storybook dev`) — COPY-MAP layer row edit site (viii).
    "      showHint('AnnotaKit has no store \u2014 run `storybook dev`, or bake the static build (see the Annotakit panel)');",
    "      showHint('AnnotaKit has no store \u2014 run `npm run serve` (the standalone review server), or bake the static build (`npm run bake <outDir>` \u2014 see the threads panel)');",
    "          showHint('AnnotaKit has no store \u2014 run `storybook dev`, or bake the static build (see the Annotakit panel)');",
    "          showHint('AnnotaKit has no store \u2014 run `npm run serve` (the standalone review server), or bake the static build (`npm run bake <outDir>` \u2014 see the threads panel)');",
    "        if (apiOk === false) showHint('AnnotaKit has no store \u2014 run `storybook dev`, or bake the static build (see the Annotakit panel)');",
    "        if (apiOk === false) showHint('AnnotaKit has no store \u2014 run `npm run serve` (the standalone review server), or bake the static build (`npm run bake <outDir>` \u2014 see the threads panel)');",
    ],
  },
  {
    // COPY-MAP server/routes (4 edits): VERSION 0.1.0; GH_LABEL dom-annotakit; /schema example+notes story->capture (component:null shape comment); groupByStory ?capture= deep-link
    file: "src/server/routes.ts",
    allow: [
    "const VERSION = '0.6.16';",
    "const VERSION = '0.1.0';",
    "const GH_LABEL = 'annotakit';",
    "const GH_LABEL = 'dom-annotakit';",
    "  storyId: 'nimbus-components--kpi-card-story',",
    "  story: { title: 'Nimbus Components', name: 'KPI Card', importPath: 'src/components/nimbus/KpiCard.stories.tsx' },",
    "  component: {",
    "    name: 'KpiCard',",
    "    chain: ['Dashboard', 'KpiCard'],",
    "    source: { file: 'src/components/nimbus/KpiCard.tsx', line: 12, column: 8 },",
    "    props: { label: '\"Revenue\"', trend: '\"up\"' },",
    "  },",
    "  // storyId = the CAPTURE id (manifest id: relative path from the captures",
    "  // root, extension-stripped, `[^a-zA-Z0-9-]` → `-`); `story` mirrors the",
    "  // capture metadata: importPath = the capture file's path.",
    "  storyId: 'reports-kpi-page',",
    "  story: { title: 'Reports', name: 'KPI page', importPath: 'captures/reports/kpi-page.html' },",
    "  // captures have no live component tree — component stays null/omitted",
    "  // (the field remains in the schema for lineage rows; renderers guard `if (comp)`).",
    "  component: null,",
    "      const storyUrl = `${origin}/?path=/story/${t.storyId}`;",
    "      const storyUrl = `${origin}/?capture=${t.storyId}`;",
    "        note: 'body.id is the IDEMPOTENCY KEY: a replayed POST with the same id returns 200 (existing thread, flagged replayed:true — your new body does NOT land; amend via PATCH), a fresh id (or none) returns 201 — send a stable id (e.g. \"fix-header-overflow\") whenever a retry might replay the POST, or you mint duplicate threads. FINALITY: an id that was DELETEd stays deleted — POSTing it again 409s {deletedId:true}; a correction after a delete needs a NEW id. Server assigns per-story numbers; comment ids are deterministically re-hashed server-side (your comment id may come back different — key by thread id). Threads without story.importPath render as bare digest sections (pass story metadata when you have it).',",
    "        note: 'body.id is the IDEMPOTENCY KEY: a replayed POST with the same id returns 200 (existing thread, flagged replayed:true — your new body does NOT land; amend via PATCH), a fresh id (or none) returns 201 — send a stable id (e.g. \"fix-header-overflow\") whenever a retry might replay the POST, or you mint duplicate threads. FINALITY: an id that was DELETEd stays deleted — POSTing it again 409s {deletedId:true}; a correction after a delete needs a NEW id. Server assigns per-capture numbers; comment ids are deterministically re-hashed server-side (your comment id may come back different — key by thread id). Threads without story.importPath render as bare digest sections (pass capture metadata — title/name + the capture file path — when you have it).',",
    "        note: 'GET → JSON { html, clipped, capturedAt, width, height } (plan-b evidence: story DOM at pin time, pinned element carries data-annota-snap=\"1\"); GET ?format=html → human-viewable inert render (CSP script-src none; unknown format values → 400); PUT/POST replaces (idempotent, 96KB cap measured in UTF-8 bytes)',",
    "        note: 'GET → JSON { html, clipped, capturedAt, width, height } (plan-b evidence: capture DOM at pin time, pinned element carries data-annota-snap=\"1\"); GET ?format=html → human-viewable inert render (CSP script-src none; unknown format values → 400); PUT/POST replaces (idempotent, 96KB cap measured in UTF-8 bytes)',",
    ],
  },
  {
    // COPY-MAP server/ghsync: labelsOf fallback -> dom-annotakit (L121)
    file: "src/server/ghsync.ts",
    allow: [
    "  const labelsOf = opts.labels ?? (() => ['annotakit']);",
    "  const labelsOf = opts.labels ?? (() => ['dom-annotakit']);",
    ],
  },
  {
    // COPY-MAP server/sync site-a: BRANCH_PRIMARY annotakit-dom / FALLBACK annotakit-dom-store (L106-107, dual-kit isolation)
    // COPY-MAP server/sync site-b (s6): fetchRemote returns {sha, ref} — the A14 gates classify the ref that SUPPLIED the head
    //   (offline fallback = origin tracking ref; old shape nulled the parent in the private-repo no-token case → root snapshots → non-FF forever)
    file: "src/server/sync.ts",
    allow: [
    "const BRANCH_PRIMARY = 'annotakit';",
    "const BRANCH_FALLBACK = 'annotakit-store';",
    "const BRANCH_PRIMARY = 'annotakit-dom';",
    "const BRANCH_FALLBACK = 'annotakit-dom-store';",
        "  /** A4.1: fetch the remote store branch into our cache ref. Returns the",
    "   *  remote head sha — the FETCHED one, or the cached/tracking one when the",
    "   *  fetch itself fails (offline: parent on what we know, push fails later,",
    "   *  never an unrelated root commit). Null when no head is known at all. */",
    "  const fetchRemote = async (timeoutMs: number, targetBranch?: string): Promise<string | null> => {",
    "  /** A4.1/s6: returns the head SHA *AND THE REF THAT SUPPLIED IT* — the",
    " *  A14 classification gates must read the kind off the SAME ref the head",
    " *  came from. Fresh fetch → REMOTE_CACHE_REF; offline fallback → the cached",
    " *  remote head's ref (cache ref or origin tracking ref). The old string-only",
    " *  return made the offline shape (private repo + no token: fetch fails,",
    " *  head from refs/remotes/origin/<branch>) classify against the hard-coded",
    " *  cache ref, which is absent there → 'no-readme' → parent nulled → every",
    " *  snapshot a parentless root → non-FF pushes forever. */",
    "  const fetchRemote = async (timeoutMs: number, targetBranch?: string): Promise<{ sha: string; ref: string } | null> => {",
    "    if (head.ok && SHA_RE.test(head.out.trim())) return head.out.trim();",
    "    if (head.ok && SHA_RE.test(head.out.trim())) return { sha: head.out.trim(), ref: REMOTE_CACHE_REF };",
    "      if (cached) return cached.sha;",
    "      if (cached) return cached;",
    "        trace(`restore: fetched=${fetched ? fetched.slice(0, 8) : 'none'}`);",
    "        if (fetched) remote = { sha: fetched, ref: REMOTE_CACHE_REF };",
    "        trace(`restore: fetched=${fetched ? fetched.sha.slice(0, 8) : 'none'}`);",
    "        if (fetched) remote = fetched;",
    "            if (fb && (await refHasOurReadme(REMOTE_CACHE_REF))) {",
    "            if (fb && (await refHasOurReadme(fb.ref))) {",
    "              remote = { sha: fb, ref: REMOTE_CACHE_REF };",
    "              kind = await refReadmeKind(REMOTE_CACHE_REF);",
    "              remote = fb;",
    "              kind = await refReadmeKind(fb.ref);",
    "      trace(`syncOnce(${reason}): remoteHead=${remoteHead ? remoteHead.slice(0, 8) : 'none'}`);",
    "      let parent = remoteHead;",
    "      if (parent) {",
    "        const kind = await refReadmeKind(REMOTE_CACHE_REF);",
    "      trace(`syncOnce(${reason}): remoteHead=${remoteHead ? remoteHead.sha.slice(0, 8) : 'none'}`);",
    "      let parent = remoteHead ? remoteHead.sha : null;",
    "      if (parent && remoteHead) {",
    "        // s6 fix (PLAN backlog): classify THE REF THAT SUPPLIED THE HEAD —",
    "        // in the offline fallback shape the head comes from the origin",
    "        // tracking ref while the cache ref is absent; reading the kind off",
    "        // the hard-coded cache ref nulled the parent here and minted a",
    "        // parentless root snapshot on EVERY sync (non-FF pushes forever —",
    "        // the store-push.sh priming ritual was the interim workaround).",
    "        const kind = await refReadmeKind(remoteHead.ref);",
    "        if (freshHead && (await refHasOurReadme(REMOTE_CACHE_REF))) {",
    "          const freshRead = await readRemoteDoc(freshHead);",
    "        if (freshHead && (await refHasOurReadme(freshHead.ref))) {",
    "          const freshRead = await readRemoteDoc(freshHead.sha);",
    "            const commit2 = tree2 ? await commitTree(tree2, freshHead, `annotakit store merge (${reason})`, timeoutMs) : null;",
    "            const commit2 = tree2 ? await commitTree(tree2, freshHead.sha, `annotakit store merge (${reason})`, timeoutMs) : null;",
    "              pushedParent = freshHead;",
    "              pushedParent = freshHead.sha;",
],
  },
  {
    // COPY-MAP server/digest: group labels story->capture (L84/168/173/183/186-187) + footer agent-instructions reworded (L233-237)
    file: "src/server/digest.ts",
    allow: [
    "    if (t.story.importPath) out.push(`- story: ${metaLine(`${t.story.title ?? ''}/${t.story.name ?? ''} (${ip})`)}`);",
    "    if (t.story.importPath) out.push(`- capture: ${metaLine(`${t.story.title ?? ''}/${t.story.name ?? ''} (${ip})`)}`);",
    "      : `UI review — ${stories.length} stories`;",
    "      : `UI review — ${stories.length} captures`;",
    "  if (opts?.origin) out.push(`storybook: ${opts.origin}`);",
    "  if (opts?.origin) out.push(`review app: ${opts.origin}`);",
    "    out.push(`story id: \\`${metaLine(st.storyId, 200)}\\``);",
    "    out.push(`capture id: \\`${metaLine(st.storyId, 200)}\\``);",
    "    if (st.importPath) out.push(`story file: ${metaLine(repoRelPath(st.importPath) ?? st.importPath)}`);",
    "    if (st.componentPath) out.push(`component file: ${metaLine(repoRelPath(st.componentPath) ?? st.componentPath)}`);",
    "    if (st.importPath) out.push(`capture file: ${metaLine(repoRelPath(st.importPath) ?? st.importPath)}`);",
    "    if (st.componentPath) out.push(`component file (SB lineage): ${metaLine(repoRelPath(st.componentPath) ?? st.componentPath)}`);",
    "    ? 'Agent loop: fix the code at the `jsx:`/`component file:` paths, comment with fix evidence, then mark the thread FIXED — do NOT close this issue: on this mirror, closing = the reviewer CONFIRMED your fix (they close it, or confirm in the panel). A REJECTED thread means the fix was not accepted: re-work it and comment evidence again, then mark it FIXED again for re-verification. ' +",
    "      'Note: `jsx: file:line` points at the component definition (may be a few lines off); the `element:`/`selector:` lines pinpoint the exact pinned node.'",
    "    : 'Agent loop: fix the code at the `jsx:`/`component file:` paths, then PATCH ' +",
    "      `${opts?.origin ?? ''}/annotakit/api/threads/<id> with {\"status\":\"fixed\"} (addressed, awaiting the reviewer\\'s verification — {\"status\":\"resolved\"} is the reviewer\\'s confirmation, not yours; a REJECTED thread needs re-work: fix again, then PATCH {\"status\":\"fixed\"} to re-enter review). ` +",
    "      'Note: `jsx: file:line` points at the component definition (may be a few lines off); the `element:`/`selector:` lines pinpoint the exact pinned node.';",
    "    ? 'Agent loop: open the capture (the `open:` link) — the `element:`/`selector:` rows locate the pinned target in the capture; comment with fix evidence, then mark the thread FIXED — do NOT close this issue: on this mirror, closing = the reviewer CONFIRMED your fix (they close it, or confirm in the review app drawer). A REJECTED thread means the fix was not accepted: re-work it and comment evidence again, then mark it FIXED again for re-verification.'",
    "    : 'Agent loop: open the capture (the `open:` link) — the `element:`/`selector:` rows locate the pinned target in the capture; comment with fix evidence, then PATCH ' +",
    "      `${opts?.origin ?? ''}/annotakit/api/threads/<id> with {\"status\":\"fixed\"} (addressed, awaiting the reviewer\\'s verification — {\"status\":\"resolved\"} is the reviewer\\'s confirmation, not yours; a REJECTED thread needs re-work: fix again, then PATCH {\"status\":\"fixed\"} to re-enter review).`;",
    ],
  },
  {
    // COPY-MAP server/env: storeLocation git-dir join -> annotakit-dom (L373, dual-kit isolation)
    file: "src/server/env.ts",
    allow: [
    "  if (gitDir) return { dir: path.join(gitDir, 'annotakit'), mode: 'git', gitDir };",
    "  if (gitDir) return { dir: path.join(gitDir, 'annotakit-dom'), mode: 'git', gitDir };",
    ],
  },
  {
    // COPY-MAP scripts: expectation renames for the reworded ghClient notices ("in Storybook" -> "in the review app")
    file: "scripts/ghclient-test.mjs",
    allow: [
    "  ok('close notice comment', issue?.comments.some((c) => c.body.includes('resolved in Storybook')));",
    "  ok('close notice comment', issue?.comments.some((c) => c.body.includes('resolved in the review app')));",
    "  ok('reopen notice comment', issue?.comments.some((c) => c.body.includes('reopened in Storybook')));",
    "  ok('reopen notice comment', issue?.comments.some((c) => c.body.includes('reopened in the review app')));",
    "  ok('delete notice comment', issue?.comments.some((c) => c.body.includes('thread deleted in Storybook')));",
    "  ok('delete notice comment', issue?.comments.some((c) => c.body.includes('thread deleted in the review app')));",
    ],
  },
  {
    // COPY-MAP scripts: F13 expectation rename for the reworded digest origin line ("storybook:" -> "review app:"; the legacy-candidate assertion keeps the LEGACY format by design)
    file: "scripts/ghsync-fake.mjs",
    allow: [
    "    check('F13: dev digest storybook line is BARE (no trailing slash)', /^storybook: http:\\/\\/localhost:6006$/m.test(digest), digest.split('\\n').find((l) => l.startsWith('storybook:')));",
    "    check('F13: dev digest review-app line is BARE (no trailing slash)', /^review app: http:\\/\\/localhost:6006$/m.test(digest), digest.split('\\n').find((l) => l.startsWith('review app:')));",
    ],
  },
  {
    // COPY-MAP scripts/heal-mirrors: default --labels -> dom-annotakit (L66) + its usage-doc line (doc truth)
    file: "scripts/heal-mirrors.mjs",
    allow: [
    " *   --labels  which issues belong to this kit (default: annotakit)",
    " *   --labels  which issues belong to this kit (default: dom-annotakit)",
    "const labels = (arg('labels') ?? 'annotakit').split(',').map((l) => l.trim()).filter(Boolean);",
    "const labels = (arg('labels') ?? 'dom-annotakit').split(',').map((l) => l.trim()).filter(Boolean);",
    ],
  },
  {
    // COPY-MAP scripts/store-robust: branch-name expectation renames (annotakit -> annotakit-dom, fallback annotakit-dom-store, store dir); marker/legacy/migration/REMOTE_CACHE strings unchanged BY DESIGN
    file: "scripts/store-robust.mjs",
    allow: [
    " *   2. push      — mutations land on refs/heads/annotakit only (orphan,",
    " *   2. push      — mutations land on refs/heads/annotakit-dom only (orphan,",
    " *   6. adoption  — foreign `annotakit` branch → fallback name, never touched (A14)",
    " *   6. adoption  — foreign `annotakit-dom` branch → fallback name, never touched (A14)",
    "  return { base, work, remote, gitDir, configDir, gitDataDir: path.join(gitDir, 'annotakit') };",
    "  return { base, work, remote, gitDir, configDir, gitDataDir: path.join(gitDir, 'annotakit-dom') };",
    "    ctx.check('storePath inside common git dir', h.storePath.startsWith(path.join(repo.gitDir, 'annotakit')));",
    "    ctx.check('store branch reported', h.storeBranch === 'annotakit');",
    "    ctx.check('storePath inside common git dir', h.storePath.startsWith(path.join(repo.gitDir, 'annotakit-dom')));",
    "    ctx.check('store branch reported', h.storeBranch === 'annotakit-dom');",
    "    await waitFor(() => sh(repo.work, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit']).ok, 15_000);",
    "    await waitFor(() => sh(repo.work, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit-dom']).ok, 15_000);",
    "    const tree = sh(repo.work, ['ls-tree', 'refs/heads/annotakit']);",
    "    const tree = sh(repo.work, ['ls-tree', 'refs/heads/annotakit-dom']);",
    "    const ok = await waitFor(() => sh(repo.remote, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit']).ok, 20_000);",
    "    ctx.check('refs/heads/annotakit created on remote', ok);",
    "    const ok = await waitFor(() => sh(repo.remote, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit-dom']).ok, 20_000);",
    "    ctx.check('refs/heads/annotakit-dom created on remote', ok);",
    "    await waitFor(() => sh(repo.remote, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit']).ok, 20_000);",
    "    await waitFor(() => sh(repo.remote, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit-dom']).ok, 20_000);",
    "      sh(repo.work, ['fetch', '-q', repo.remote, '+refs/heads/annotakit:refs/annotakit/remote']);",
    "      sh(repo.work, ['fetch', '-q', repo.remote, '+refs/heads/annotakit-dom:refs/annotakit/remote']);",
    "    sh(repo.work, ['push', '-q', repo.remote, `${head}:refs/heads/annotakit`]);",
    "    ctx.check('corrupt remote head planted (4 deep)', sh(repo.remote, ['rev-parse', 'refs/heads/annotakit']).out === head);",
    "    sh(repo.work, ['push', '-q', repo.remote, `${head}:refs/heads/annotakit-dom`]);",
    "    ctx.check('corrupt remote head planted (4 deep)', sh(repo.remote, ['rev-parse', 'refs/heads/annotakit-dom']).out === head);",
    "    ctx.check('remote head NOT advanced (uncomputed union never pushed)', sh(repo.remote, ['rev-parse', 'refs/heads/annotakit']).out === head);",
    "    ctx.check('remote head NOT advanced (uncomputed union never pushed)', sh(repo.remote, ['rev-parse', 'refs/heads/annotakit-dom']).out === head);",
    "    const ref = sh(repo.work, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit']);",
    "    const ref = sh(repo.work, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit-dom']);",
    "    const ref2 = sh(repo.work, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit']);",
    "    const ref2 = sh(repo.work, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit-dom']);",
    "    // local-refs comparison (refs/annotakit/remote === refs/heads/annotakit)",
    "    // local-refs comparison (refs/annotakit/remote === refs/heads/annotakit-dom)",
    "    sh(repo.work, ['branch', 'annotakit']);",
    "    sh(repo.work, ['push', '-q', 'origin', 'annotakit']);",
    "    const foreignHead = sh(repo.remote, ['rev-parse', 'refs/heads/annotakit']).out;",
    "    sh(repo.work, ['branch', 'annotakit-dom']);",
    "    sh(repo.work, ['push', '-q', 'origin', 'annotakit-dom']);",
    "    const foreignHead = sh(repo.remote, ['rev-parse', 'refs/heads/annotakit-dom']).out;",
    "      return /annotakit-store|not an annotakit store branch/.test(srv.logs.join(''));",
    "      return /annotakit-dom-store|not an annotakit store branch/.test(srv.logs.join(''));",
    "    ctx.check('A14: falls back to annotakit-store', (resolved && h.storeBranch === 'annotakit-store') || h2b.storeBranch === 'annotakit-store', `branch=${h.storeBranch} later=${h2b.storeBranch}`);",
    "    ctx.check('A14: falls back to annotakit-dom-store', (resolved && h.storeBranch === 'annotakit-dom-store') || h2b.storeBranch === 'annotakit-dom-store', `branch=${h.storeBranch} later=${h2b.storeBranch}`);",
    "    const ok = await waitFor(() => sh(repo.remote, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit-store']).ok, 20_000);",
    "    const ok = await waitFor(() => sh(repo.remote, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit-dom-store']).ok, 20_000);",
    "    ctx.check('foreign branch untouched', sh(repo.remote, ['rev-parse', 'refs/heads/annotakit']).out === foreignHead);",
    "    ctx.check('foreign branch untouched', sh(repo.remote, ['rev-parse', 'refs/heads/annotakit-dom']).out === foreignHead);",
    "    const seeded = await waitFor(() => sh(repo.remote, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit']).ok, 20_000);",
    "    const seeded = await waitFor(() => sh(repo.remote, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit-dom']).ok, 20_000);",
    "    // restart from the subdir: the local refs/heads/annotakit (created by the",
    "    // restart from the subdir: the local refs/heads/annotakit-dom (created by the",
    "    ctx.check('subdir: branch stays primary after restart (no A14 false flip)', h2.storeBranch === 'annotakit', `branch=${h2.storeBranch}`);",
    "    ctx.check('subdir: branch stays primary after restart (no A14 false flip)', h2.storeBranch === 'annotakit-dom', `branch=${h2.storeBranch}`);",
    "    ctx.check('no local orphan branch from empty store', !sh(repo.work, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit']).ok);",
    "    ctx.check('no remote orphan branch from empty store', !sh(repo.remote, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit']).ok);",
    "    ctx.check('no local orphan branch from empty store', !sh(repo.work, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit-dom']).ok);",
    "    ctx.check('no remote orphan branch from empty store', !sh(repo.remote, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit-dom']).ok);",
    "    sh(repo.work, ['fetch', '-q', repo.remote, '+refs/heads/annotakit:refs/annotakit/remote']);",
    "    sh(repo.work, ['fetch', '-q', repo.remote, '+refs/heads/annotakit-dom:refs/annotakit/remote']);",
    "      const p = sh(repo.work, ['push', '-q', 'origin', `+${commit.out}:refs/heads/annotakit`]);",
    "      const p = sh(repo.work, ['push', '-q', 'origin', `+${commit.out}:refs/heads/annotakit-dom`]);",
    "      const remoteBranch = sh(repo.remote, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit']).ok;",
    "      const remoteBranch = sh(repo.remote, ['rev-parse', '--verify', '--quiet', 'refs/heads/annotakit-dom']).ok;",
    ],
  },
  {
    // COPY-MAP scripts/bake-static-threads: default label dom-annotakit (L327); REQUIRE --store (cwd-git/configDir discovery ladder dropped, loud exit-1)
    file: "scripts/bake-static-threads.mjs",
    allow: [
    " * Store resolution (mirrors src/server/env.ts location logic):",
    " *   1. --store <path> (explicit)",
    " * Store resolution (dom-annotakit: the store is REQUIRED — the cwd git-dir",
    " *   / config-dir discovery ladder is GONE; a consumer repo's cwd must never",
    " *   be walked for a store it does not own):",
    " *   1. --store <path>              (threads.db, or its threads.json sibling)",
    " *   3. <git-common-dir>/annotakit/threads.db   (v0.5 gitdir store — run from",
    " *      anywhere inside the project repo)",
    " *   4. <configDir>/annotakit/threads.db        (classic: --config-dir, or",
    " *      ./ .storybook fallback)",
    " *   JSON fallback: threads.json sibling of either location.",
    " *   The documented default to point these at: the TOOL repo's own store",
    " *   (the standalone server's — configDir <repoRoot>/.dom-annotakit; the db",
    " *   resolves per env.ts storeLocation to <repoRoot>/.git/annotakit-dom/ or",
    " *   <repoRoot>/.dom-annotakit/annotakit/).",
    " *   Unconfigured → exit 1 LOUDLY before any file is written (an empty seed",
    " *   is no longer a silent fallback).",
    "import { fileURLToPath } from 'node:url';",
    "    labels: labelList.length ? labelList : ['annotakit'],",
    "    labels: labelList.length ? labelList : ['dom-annotakit'],",
    "  const configDir = optValue('config-dir') ?? path.resolve('.storybook');",
    "  const gcd = sh('git rev-parse --git-common-dir', '.');",
    "  const candidates = [];",
    "  if (explicit) candidates.push({ db: explicit, json: explicit.replace(/threads\\.db$/, 'threads.json') });",
    "  if (gcd) {",
    "    const base = path.isAbsolute(gcd) ? gcd : path.resolve(gcd);",
    "    candidates.push({ db: path.join(base, 'annotakit', 'threads.db'), json: path.join(base, 'annotakit', 'threads.json') });",
    "  // dom-annotakit (crit-1b Area D): the store is REQUIRED. The cwd git-dir /",
    "  // config-dir discovery ladder is GONE — a discovery walk from a CONSUMER",
    "  // repo could read the WRONG store (its own annotakit dir, or the SB kit's",
    "  // db on a dual-kit machine) while the tool repo owns the threads, and an",
    "  // unconfigured bake used to fall back to an EMPTY seed (a static build",
    "  // that silently looks thread-less while the real store was never read).",
    "  // Honest exit 1, before any file is written.",
    "  if (!explicit) {",
    "    const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');",
    "    console.error(",
    "      `[bake-static] FATAL: no store configured — the bake requires it explicitly: --store <threads.db (or its threads.json sibling)> or $ANNOTAKIT_STORE_PATH.\\n` +",
    "        `  The documented tool-repo store (the standalone server's): ${path.join(toolRoot, '.git', 'annotakit-dom', 'threads.db')} (git mode) or ${path.join(toolRoot, '.dom-annotakit', 'annotakit', 'threads.db')} (classic configDir mode).\\n` +",
    "        `  The old silent EMPTY-seed fallback is gone — point at the real store.`,",
    "    );",
    "    process.exit(1);",
    "  candidates.push({ db: path.join(configDir, 'annotakit', 'threads.db'), json: path.join(configDir, 'annotakit', 'threads.json') });",
    "  candidates.push({ db: explicit, json: explicit.replace(/threads\\.db$/, 'threads.json') });",
    ],
  },
  {
    // COPY-MAP scripts/api-test: re-targeted to the standalone server — :4310 default, capture-manifest metadata source, ?capture= deep-links (expectation updates only, never test logic)
    file: "scripts/api-test.mjs",
    allow: [
    " * API contract test for storybook-annotakit — run against the demo storybook",
    " * dev server (default http://localhost:6006). Node stdlib only.",
    " * API contract test for dom-annotakit — run against the standalone review",
    " * server (default http://127.0.0.1:4310; `npm run serve`). Node stdlib only.",
    " * Usage: node scripts/api-test.mjs [baseUrl]",
    " * Vendored from storybook-annotakit's scripts/api-test.mjs @2853e32 and",
    " * re-targeted (COPY-MAP scripts/ row): same REST engine, same cases — only",
    " * the host/port default, the metadata source (capture manifest instead of",
    " * SB index.json) and the deep-link convention (?capture= instead of",
    " * ?path=/story/) moved. Expectation updates only, never test logic.",
    " *",
    " * Usage: node scripts/api-test.mjs [baseUrl]   (expects npm run serve on :4310)",
    "const BASE = process.argv[2] ?? 'http://localhost:6006';",
    "const BASE = process.argv[2] ?? 'http://127.0.0.1:4310';",
    "  console.log(`annotakit api-test against ${BASE}\\n`);",
    "  console.log(`dom-annotakit api-test against ${BASE}\\n`);",
    "  /* 2. index.json reachable (story metadata source) */",
    "  const index = await j('GET', `${BASE}/index.json`);",
    "  const entries = index.json?.entries ?? {};",
    "  const storyIds = Object.keys(entries).filter((k) => entries[k].type === 'story');",
    "  check('index.json has stories', storyIds.length > 0, `(${storyIds.length})`);",
    "  const leafId = storyIds.find((s) => entries[s].name === 'Status Badge') ?? storyIds[0];",
    "  check('sample entry has importPath', Boolean(entries[leafId]?.importPath), JSON.stringify(entries[leafId] ?? {}));",
    "  /* 2. capture manifest reachable (story metadata source — the SAME JSON the",
    "     static bake writes; here served dynamically by the standalone server) */",
    "  const manifest = await j('GET', `${BASE}/dom-annotakit-manifest.json`);",
    "  const captures = manifest.json?.captures ?? [];",
    "  check('manifest has captures', captures.length > 0, `(${captures.length})`);",
    "  // pick a capture with NO existing threads: the digest assertions below",
    "  // assert on OUR first thread (dogfood threads carry no component metadata —",
    "  // component is null by design for browser-created pins, D3a)",
    "  const listAll0 = await j('GET', `${API}/threads`);",
    "  const busy = new Set((listAll0.json?.threads ?? []).map((t) => t.storyId));",
    "  const leafId = (captures.find((c) => !busy.has(c.id)) ?? captures[0])?.id;",
    "  const leafMeta = captures.find((c) => c.id === leafId) ?? {};",
    "  check('sample entry has relpath', Boolean(leafMeta.relpath), JSON.stringify(leafMeta));",
    "      title: entries[storyId]?.title,",
    "      name: entries[storyId]?.name,",
    "      importPath: entries[storyId]?.importPath,",
    "      componentPath: entries[storyId]?.componentPath,",
    "      url: `${BASE}/?path=/story/${storyId}`,",
    "      // capture metadata in the story slots (D3a): title from the manifest;",
    "      // name/importPath = the capture file's path (digest renders it as",
    "      // \"capture file:\"; componentPath has no capture equivalent — omitted)",
    "      title: leafMeta.title,",
    "      name: leafMeta.relpath,",
    "      importPath: leafMeta.relpath,",
    "      url: `${BASE}/?capture=${storyId}`,",
    "  // v0.6.1 portability (Track B): derive the extension from the ACTUAL story",
    "  // importPath (from index.json) — the hardcoded '.stories.tsx' false-failed",
    "  // 1/67 on JSX-only consumer projects",
    "  const ownImportPath = String(entries[storyId]?.importPath ?? '');",
    "  // v0.6.1 portability (Track B): derive the path from the ACTUAL capture",
    "  // metadata (from the manifest) — the story.importPath we POSTED is what the",
    "  // digest renders as \"capture file:\"",
    "  const ownImportPath = String(leafMeta.relpath ?? '');",
    "      story: { title: entries[storyId]?.title, name: entries[storyId]?.name, importPath: entries[storyId]?.importPath },",
    "      story: { title: leafMeta.title, name: leafMeta.relpath, importPath: leafMeta.relpath },",
    ],
  },
];

/* REPLACE (upstream twin superseded by new host-side code) / REWRITTEN (an
 * upstream file re-targeted wholesale — its "edit" is the whole file) / NEW
 * (no upstream twin). Out of hunk-check scope; listed in the report. */
const OUT_OF_SCOPE = {
  'src/host/** (App/Toolbar/Sidebar/PanelDrawer/ImportBar/main/capture-id/channel/icons/inject/import/projectClient/projectStatus/snapshot-meta/theme + panel/ReviewPanel.tsx)':
    'NEW/REPLACE — the host shell + the manager/index.tsx port (COPY-MAP manager row lists the substitutions)',
  'src/shared/bakedCreds.ts': 'NEW — the user-instructed baked PAT + default project target (D6; server-side + bake-script only — release-check exact-path allowlist + dist-app inverse gate enforce the boundary)',
  'src/shared/specDirectives.ts': 'NEW — @epic:/@story: comment-directive parser (D6; isomorphic, pure)',
  'src/shared/ghProjects.ts': 'NEW — GH Projects v2 GraphQL client + the stateless marker-anchored reconciler (D6; isomorphic — serve sidecar + static client + fake-transport tests share it)',
  'src/server/projectMirror.ts': 'NEW — the serve-mode spec-mirror sidecar (D6; store-singleton reads, evidence-gated deletes)',
  'src/singlefile/parse.ts, src/singlefile/sha1.ts': 'NEW — SingleFile note reader + sync sha1 (M4)',
  'src/preview/bootstrap.ts': 'NEW — the iframe layer entry (upstream index.ts decorator replaced by host/inject.ts)',
  'src/preview/fiber.ts': 'REPLACE — null stub (COPY-MAP preview row)',
  'src/server/standalone.ts': 'NEW — the standalone server (COPY-MAP server row)',
  'scripts/bake-dom-annotakit.mjs': 'NEW — the static bake (COPY-MAP scripts row)',
  'scripts/singlefile-import-test.mjs': 'NEW — the M4 Node suite (COPY-MAP scripts row)',
  'scripts/gh-projects-recon.mjs, scripts/gh-projects-probe.mjs, scripts/gh-projects-bootstrap.mjs, scripts/project-sync-test.mjs': 'NEW — D6 GH Projects API recon/probe/bootstrap + the offline reconcile suite (COPY-MAP scripts rows)',
  'scripts/drift-check.mjs': 'NEW — this file',
  'scripts/release-check.mjs': 'REWRITTEN — re-targeted to this repo (COPY-MAP scripts row; 6 gates + selftest plants + the D6 exact-path baked-token allowlist + dist-app inverse gate)',
  'tsup.config.ts': 'REWRITTEN — build config for the two-bundle + layer.mjs shape (COPY-MAP build row)',
  'package.json, vite.config.ts, index.html': 'NEW — tool repo scaffolding',
};

/* --------------------------------- checker --------------------------------- */

const tmp = mkdtempSync(path.join(tmpdir(), 'drift-'));
const tmpA = path.join(tmp, 'up');
const tmpB = path.join(tmp, 'cur');

function diffFile(file) {
  let up;
  try {
    up = upstreamBlob(file);
  } catch {
    return null; // absent upstream
  }
  writeFileSync(tmpA, up);
  writeFileSync(tmpB, readFileSync(path.join(REPO_ROOT, file)));
  try {
    return execFileSync('git', ['diff', '--no-index', '-U0', '--', tmpA, tmpB], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (e) {
    if (typeof e.stdout === 'string') return e.stdout; // exit 1 = files differ
    throw e;
  }
}

function changedLines(diffOut) {
  const out = [];
  for (const l of diffOut.split('\n')) {
    if ((l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---')) {
      out.push(l.slice(1));
    }
  }
  return out;
}

const verdicts = [];
let dirty = 0;

for (const file of AS_IS) {
  if (!existsSync(path.join(REPO_ROOT, file))) {
    verdicts.push(`DIRTY      ${file} — MISSING LOCALLY (AS-IS file)`);
    dirty++;
    continue;
  }
  const d = diffFile(file);
  const lines = d ? changedLines(d) : [];
  if (lines.length === 0) {
    verdicts.push(`HEALTHY    ${file} — AS-IS, byte-identical`);
  } else {
    verdicts.push(`DIRTY      ${file} — AS-IS but ${lines.length} changed line(s) beyond COPY-MAP (none listed)`);
    for (const l of lines.slice(0, 12)) verdicts.push(`             | ${l.slice(0, 160)}`);
    dirty++;
  }
}

for (const spec of EDIT_FILES) {
  const { file, allow } = spec;
  if (!existsSync(path.join(REPO_ROOT, file))) {
    verdicts.push(`DIRTY      ${file} — MISSING LOCALLY (EDIT file)`);
    dirty++;
    continue;
  }
  const d = diffFile(file);
  if (d === null) {
    verdicts.push(`DIRTY      ${file} — absent in the upstream pin`);
    dirty++;
    continue;
  }
  const lines = d ? changedLines(d) : [];
  const allowSet = new Set(allow);
  const bad = lines.filter((l) => !allowSet.has(l));
  if (bad.length === 0) {
    verdicts.push(`HEALTHY    ${file} — EDIT, ${lines.length} changed line(s), all within COPY-MAP's listed edits`);
  } else {
    verdicts.push(`DIRTY      ${file} — ${bad.length} changed line(s) NOT justified by COPY-MAP's edit list:`);
    for (const l of bad.slice(0, 12)) verdicts.push(`             | ${l.slice(0, 160)}`);
    dirty++;
  }
}

console.log(`drift-check — vendored files vs upstream pin ${UPSTREAM_SHA.slice(0, 7)} (${UPSTREAM_URL})`);
console.log('');
for (const v of verdicts) console.log(v);
console.log('');
console.log('Out of drift scope (REPLACE / REWRITTEN / NEW — no hunk-checked upstream twin):');
for (const [k, v] of Object.entries(OUT_OF_SCOPE)) console.log(`  ${k} — ${v}`);
console.log('');
rmSync(tmp, { recursive: true, force: true });
if (dirty > 0) {
  console.log(`drift-check: DIRTY (${dirty})`);
  process.exit(1);
}
console.log('drift-check: CLEAN');
