import { defineConfig } from 'tsup';

// dom-annotakit build — adapted from upstream storybook-annotakit @2853e32
// (COPY-MAP build row). TWO bundles:
//   1. browser ESM standalone entries — the node test battery imports these
//      (upstream's standalone-export pattern, same entry map MINUS
//      manager/preview/layer: those carry SB imports until the surface port
//      replaces them).
//   2. the node CJS server bundle — dist/server.cjs is the ONE self-contained
//      vendoring unit (store + ghsync + sync + merge + digest + env + gh +
//      the shared modules they pull in) mounted by src/server/standalone.ts.
export default [
  defineConfig({
    entry: {
      // standalone export so node tests can exercise the static-mode store
      // (any embedding bundle embeds its own copy — state is per-document
      // by design; cross-doc sync rides storage events).
      staticStore: 'src/shared/staticStore.ts',
      // v0.5.3: client-side GitHub publisher — same standalone-export pattern
      // (tests drive it with an injected transport + localStorage shims).
      ghClient: 'src/shared/ghClient.ts',
      // v0.6.10 (S6): the hotkey kernel + pin-mode hit-tester — standalone
      // exports so node tests exercise them directly (injectable
      // elementsFromPoint/rect getters — jsdom-free).
      hotkeys: 'src/shared/hotkeys.ts',
      hittest: 'src/preview/hittest.ts',
      // v0.6.16 (wave-6, 57-a P3): the pin cascade — pure math, standalone
      // export (the s6 suite pins the corner/edge/ladder shapes).
      cascade: 'src/shared/cascade.ts',
      // v0.6.12 (S7-AUDIT-C7): the panel-toggle helper — same pattern (the
      // host panel bundle is not node-importable; the truth table is
      // unit-pinned).
      panelToggle: 'src/shared/panelToggle.ts',
      // v0.6.13 (S9/DD-3, DD-18): the recall guard, the recall sanitizer,
      // and the anchor gate — same pattern (the s6 suite pins
      // shouldApplyRecall, sanitizeMountedView's frame neutralization,
      // isPinnableTarget, and textQuoteGate through these standalone
      // exports).
      recall: 'src/shared/recall.ts',
      snapshot: 'src/preview/snapshot.ts',
      anchor: 'src/preview/anchor.ts',
      // dom-annotakit M4 (design D2c): the SingleFile note reader + the import
      // flow — same standalone-export pattern. The Node fixture suite
      // (singlefile-import-test.mjs) drives the template.content (fragment)
      // shape through these; the shadowRoot (live-parse) half of the
      // dual-shape contract is pinned by the agent-browser E2E on the real
      // annotated capture — jsdom-free means jsdom-blind, BOTH are
      // mandatory.
      singlefileParse: 'src/singlefile/parse.ts',
      singlefileSha1: 'src/singlefile/sha1.ts',
      sfImport: 'src/host/import.ts',
      // D6 (2026-10-23): the spec-board mirror — standalone exports so
      // scripts/project-sync-test.mjs drives reconcileProject through a FAKE
      // transport (directive parser table + create/update/delete/option-append
      // convergence, >100-item paging, evidence-gated deletes — no network).
      specDirectives: 'src/shared/specDirectives.ts',
      ghProjects: 'src/shared/ghProjects.ts',
      // D10/D11 (2026-10-26): the spec catalog — combobox reducer + rollups +
      // the context text transform; pure, so scripts/spec-catalog-test.mjs
      // pins the whole matrix jsdom-free.
      specCatalog: 'src/shared/specCatalog.ts',
      // NOTE: dist/layer.mjs is NOT in this shared config on purpose — code
      // splitting would factor shared modules into sibling chunk-*.mjs files,
      // and the server serves ONLY /layer.mjs verbatim (a chunk import would
      // 404). The dedicated self-contained config below builds it.
    },
    format: ['esm'],
    platform: 'browser',
    clean: false,
    noExternal: ['@medv/finder'],
    outExtension: () => ({ js: '.mjs' }),
  }),
  // The iframe pin-layer bundle (COPY-MAP build row): SELF-CONTAINED — the
  // capture iframe has no module map, no React, no @medv/finder. React 19 +
  // react-dom + @medv/finder + every shared module bundle INTO layer.mjs;
  // splitting:false keeps it ONE file (a sibling chunk import would 404 —
  // the server maps only /layer.mjs). Loaded via
  // `<script type="module" src="…/layer.mjs">` (src/host/inject.ts mints the
  // src from the HOST page's baseURI, never a hard-coded absolute path).
  defineConfig({
    entry: { layer: 'src/preview/bootstrap.ts' },
    format: ['esm'],
    platform: 'browser',
    target: 'es2022',
    external: [],
    noExternal: [/.*/],
    splitting: false,
    clean: false,
    dts: false,
    treeshake: true,
    outExtension: () => ({ js: '.mjs' }),
    esbuildOptions(options) {
      // Classic JSX transform (React.createElement — layer.tsx imports
      // React), the upstream preview-bundle discipline; no jsx-runtime import.
      options.jsx = 'transform';
    },
  }),
  // Node bundle: the REST middleware + sqlite store + digest + gh publisher.
  defineConfig({
    entry: {
      server: 'src/server/routes.ts',
      // the standalone bin (design D3a): node:http entry mounting the
      // middleware + serving the review app/captures/layer — splitting:false
      // keeps it fully self-contained like server.cjs.
      standalone: 'src/server/standalone.ts',
      // D12-D14 (2026-10-26): the host REST seam (captures manager + spec
      // endpoints + the annotation rewrite wrapper) — standalone so
      // scripts/host-routes-test.mjs drives the upload/delete/gate/rewrite
      // matrix against temp dirs + fake requests, no server needed.
      hostRoutes: 'src/server/hostRoutes.ts',
    },
    format: ['cjs'],
    platform: 'node',
    target: 'node20',
    // BOTH configs share dist/ and tsup runs them in parallel — a clean:true
    // on either can wipe the other's output mid-build depending on execution
    // order (an intermittent, order-dependent failure). Keep clean:false
    // here; the build script rm -rf's dist exactly once, BEFORE tsup.
    clean: false,
    outExtension: () => ({ js: '.cjs' }),
    dts: false,
    splitting: false,
    treeshake: true,
  }),
];
