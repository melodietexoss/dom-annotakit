#!/usr/bin/env node
/**
 * dom-annotakit — release readiness gate.
 *
 * Vendored from storybook-annotakit's scripts/release-check.mjs @2853e32 and
 * re-targeted to THIS repo's layout (COPY-MAP scripts/ row). The vendored
 * discipline is kept: one function per gate, every gate PROVEN to bite by
 * the --selftest (plants + finally-restore), notes on the happy path.
 *
 * Gates (any failure → exit 1):
 *   1. dist chunk drift — untracked/ignored ghosts in dist/ (tsup emits
 *      content-hashed chunk names; a rebuild renames chunks while tracked
 *      dist stays clean, leaving ghosts behind)
 *   2. version agreement — package.json ↔ src/server/routes.ts VERSION
 *      (the /health identity; dom-annotakit is its own tool, NOT the
 *      vendored engine's 0.6.16)
 *   3. dist FRESHNESS — (i) dist is git-tracked (this repo's convention:
 *      fresh clone works unbuilt; git is the disk); (ii) no src input is
 *      NEWER than the newest dist artifact (mtime — "edit src, forget the
 *      rebuild"); (iii) dist/server.cjs + dist/standalone.cjs EMBED the
 *      current version (the bump-without-rebuild class: every gate that
 *      reads SRC stays green while /health reports the old version)
 *   4. dist EXACT-SET — the tracked dist file set must equal a fresh build's
 *      output set, byte-identical on every shared name (layer.mjs +
 *      server.cjs + standalone.cjs + the battery .mjs entries + chunks —
 *      no strays, no stale fixed-name bundles)
 *   5. dist-app present + index.html relative-refs-only (Vite base './' —
 *      the standalone server serves it at the origin root AND the static
 *      bake copies it to any subpath; a root-absolute ref breaks both)
 *      + every referenced asset exists
 *   6. sensitive-pattern sweep over TRACKED files — live PAT shapes
 *      (ghp_… GitHub, glpat-… GitLab) must never ride a commit. .env is
 *      EXCLUDED BY DESIGN (see SWEEP_EXCLUDES below for the rationale).
 *
 * Self-test: `node scripts/release-check.mjs --selftest` plants a ghost
 * chunk, a version drift, a stale-by-content dist file, a stale-by-mtime
 * dist artifact, a scratch-dir fake PAT (the sweep must flag it), a PAT
 * planted in a TRACKED file (the real sweep must flag it), a PAT in .env
 * (the real sweep must IGNORE it — the exclusion is load-bearing), and a
 * root-absolute dist-app index (the gate must bite) — expects ALL to be
 * caught, restoring state in finally.
 *
 * Exit codes: 0 = clean, 1 = release-dirty, 2 = selftest failure.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const problems = [];
const notes = [];

const run = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', timeout: 120_000, ...opts });
  } catch {
    return null;
  }
};

/* 1 — dist chunk drift (vendored gate 1, unchanged in spirit) */
function chunkDriftLines() {
  const out = run('git', ['status', '--porcelain', '--ignored', '--', 'dist/']) ?? '';
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => /dist\//.test(l) && (l.startsWith('??') || l.startsWith('!!')));
}
function chunkDriftProblems() {
  const ghosts = chunkDriftLines();
  if (ghosts.length) problems.push(`dist chunk drift (${ghosts.length} untracked/ignored entries): ${ghosts.slice(0, 5).join(' | ')}`);
  else notes.push('dist: no untracked/ignored ghost chunks');
  return [];
}

/* 2 — version agreement (package.json ↔ routes.ts VERSION) */
function versionProblems() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const routes = fs.readFileSync(path.join(root, 'src/server/routes.ts'), 'utf8');
  const m = routes.match(/VERSION = '([^']+)'/);
  const routesV = m ? m[1] : '(not found)';
  if (pkg.version !== routesV) {
    return [`version disagreement: package.json=${pkg.version} routes.ts=${routesV} — /health must report THIS tool's version`];
  }
  notes.push(`version agreement: ${pkg.version} (package.json + routes.ts VERSION)`);
  return [];
}

/* 3 — dist FRESHNESS (tracked convention + src-vs-dist mtimes + embedded version) */
function distFreshnessProblems() {
  const out = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const tracked = (run('git', ['ls-files', '--', 'dist/']) ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (tracked.length === 0) {
    return ['dist is not git-tracked — this repo ships the committed-dist convention (.gitignore documents it; a fresh clone must work unbuilt)'];
  }
  // (ii) mtime: the newest built SOURCE newer than the newest dist artifact
  // means a src edit landed without `bun run build` — every byte below could
  // still be stale. (Vite's dist-app is gate 5's business; dist/ is tsup's.)
  const newestSrc = newestMtime(path.join(root, 'src'), /\.(ts|tsx)$/);
  const newestDist = tracked
    .map((f) => {
      try {
        return fs.statSync(path.join(root, f)).mtimeMs;
      } catch {
        return 0;
      }
    })
    .reduce((a, b) => Math.max(a, b), 0);
  if (newestSrc > newestDist) {
    out.push(`dist is STALE by mtime: a src input is newer than every dist artifact (src ${new Date(newestSrc).toISOString()} > dist ${new Date(newestDist).toISOString()}) — run \`bun run build\` before tagging`);
  }
  // (iii) the built bundles EMBED the current version (routes.ts VERSION is
  // compile-time-embedded into both server bundles)
  for (const bundle of ['dist/server.cjs', 'dist/standalone.cjs']) {
    const abs = path.join(root, bundle);
    if (!fs.existsSync(abs)) return [...out, `${bundle} missing — run \`bun run build\` before tagging`];
    const bundled = fs.readFileSync(abs, 'utf8').match(/VERSION = "([^"]+)"/);
    const distV = bundled ? bundled[1] : null;
    if (distV !== pkg.version) {
      out.push(`dist is STALE: ${bundle} embeds VERSION=${distV ?? '(none)'} while package.json=${pkg.version} — run \`bun run build\` and re-commit dist`);
    }
  }
  if (!out.length) notes.push(`dist freshness: tracked (${tracked.length} files), src not newer than dist, bundles embed ${pkg.version}`);
  return out;
}

function newestMtime(dir, filter, acc = { t: 0 }) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc.t;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) newestMtime(abs, filter, acc);
    else if (e.isFile() && filter.test(e.name)) {
      try {
        const t = fs.statSync(abs).mtimeMs;
        if (t > acc.t) acc.t = t;
      } catch {
        /* vanished — skip */
      }
    }
  }
  return acc.t;
}

/* 4 — dist EXACT-SET (vendored gate 5, re-targeted): the tracked dist set ==
 *      a fresh build's set, byte-identical on shared names. Runs the repo's
 *      own tsup into a TEMP dir (never touches dist/). */
function distSetProblems() {
  const tracked = new Set(
    (run('git', ['ls-files', '--', 'dist/']) ?? '')
      .split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => l.replace(/^dist\//, '')),
  );
  if (tracked.size === 0) return ['dist is not git-tracked — the exact-set gate assumes the committed-dist convention'];
  const tsupBin = path.join(root, 'node_modules', '.bin', 'tsup');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dom-annotakit-dist-'));
  try {
    let built = null;
    if (fs.existsSync(tsupBin)) built = run(tsupBin, ['--out-dir', tmp]);
    else built = run('bunx', ['tsup', '--out-dir', tmp]) ?? run('npx', ['tsup', '--out-dir', tmp]);
    if (built === null) {
      // vendored (audit 24-e P2): a FAILED build must FAIL the gate, not
      // silently skip it. Only a missing toolchain skips.
      const anyTool = fs.existsSync(tsupBin) || run('which', ['bunx']) !== null || run('which', ['npx']) !== null;
      if (anyTool) return ['dist exact-set: the fresh tsup build FAILED — the gate cannot verify (fix the build before tagging)'];
      notes.push('tsup unavailable — skipped exact-set compare (run where deps are installed)');
      return [];
    }
    const fresh = new Set(fs.readdirSync(tmp).filter((f) => fs.statSync(path.join(tmp, f)).isFile()));
    const orphans = [...tracked].filter((f) => !fresh.has(f));
    const missing = [...fresh].filter((f) => !tracked.has(f));
    if (orphans.length || missing.length) {
      const fmt = (a) => `${a.length} [${a.slice(0, 4).join(', ')}${a.length > 4 ? ', …' : ''}]`;
      return [
        `dist file-set drift vs fresh build: ${fmt(orphans)} tracked ORPHAN(S) + ${fmt(missing)} missing — ` +
          'rebuild via `bun run build` (its rm -rf dist wipes orphans) and re-commit the whole dist',
      ];
    }
    // byte-compare every shared name — the fixed-name entry bundles
    // (server.cjs / standalone.cjs / layer.mjs / the battery .mjs entries)
    // never self-report content drift by renaming.
    const stale = [];
    for (const f of fresh) {
      const distFile = path.join(root, 'dist', f);
      if (!fs.existsSync(distFile)) { stale.push(`dist/${f}`); continue; } // tracked in index, gone from worktree
      if (!fs.readFileSync(path.join(tmp, f)).equals(fs.readFileSync(distFile))) stale.push(`dist/${f}`);
    }
    if (stale.length) {
      return stale.map((f) => `${f} is STALE vs src (content differs from fresh build) — run \`bun run build\``);
    }
    notes.push(`dist exact-set: ${tracked.size} files == fresh build (names + bytes)`);
    return [];
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* 5 — dist-app present + relative-refs-only + referenced assets exist */
function distAppProblems(appDir = path.join(root, 'dist-app')) {
  const out = [];
  const indexPath = path.join(appDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return [`dist-app/index.html missing (${indexPath}) — run \`bun run build\` (the Vite host build) before tagging`];
  }
  const html = fs.readFileSync(indexPath, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)=["']([^"']*)["']/gi)].map((m) => m[1]);
  const bad = refs.filter((r) => r && r !== '#' && !/^(data:|https?:|mailto:)/i.test(r) && r.startsWith('/'));
  if (bad.length) {
    out.push(`dist-app/index.html references ROOT-ABSOLUTE asset(s): ${bad.slice(0, 3).join(', ')} — the Vite build must use base './' (vite.config.ts); the standalone server serves dist-app at the origin root and the static bake copies it to arbitrary subpaths`);
  }
  const missingAssets = refs
    .filter((r) => r && r !== '#' && !/^(data:|https?:|mailto:)/i.test(r) && !r.startsWith('/'))
    .filter((r) => !fs.existsSync(path.resolve(path.dirname(indexPath), r)));
  if (missingAssets.length) {
    out.push(`dist-app/index.html references MISSING asset(s): ${missingAssets.slice(0, 3).join(', ')} — a partial/stale copy of the app build`);
  }
  if (!out.length) notes.push('dist-app: present, relative-refs-only, referenced assets exist');
  return out;
}

/* 6 — sensitive-pattern sweep over TRACKED files.
 *
 * EXCLUDED BY DESIGN: `.env`. This repo tracks `.env` DELIBERATELY — the
 * sandbox convention is "git is the disk" (PLAN.md "Known constraints";
 * .gitignore documents it; the upstream env.ts refusal is silenced via
 * ANNOTAKIT_ENV_TRACKED_OK). The tool repo's own .env is the documented
 * home for the dogfood GH mirror PAT; sweeping it would fail every release
 * on a deliberate configuration.
 *
 * ALSO DELIBERATE (D6, 2026-10-23, user-instructed): the BAKED PAT in
 * `src/shared/bakedCreds.ts` (and therefore inside the bundled
 * `dist/server.cjs`). The user explicitly directed that the credential
 * "can be baked in" after the sandbox's constant .env sweeping left every
 * deployed instance tokenless; repos are PRIVATE. This allowlist is
 * EXACT-PATH — not a pattern amnesty: any OTHER tracked file carrying a
 * live PAT shape still fails hard (including dist-app — see the inverse
 * gate below: the BROWSER bundle must contain ZERO ghp_ matches, because
 * browser code must never import bakedCreds.ts).
 * (A public-release transform would scrub + untrack all of these — M8's
 * business.) */
const SWEEP_EXCLUDES = new Set(['.env']);
/* server-side bundles ONLY (bakedCreds is imported by standalone.ts → both
 * node bundles embed it); dist-app has the INVERSE gate below — zero ghp_. */
const SWEEP_ALLOWLIST = new Set(['src/shared/bakedCreds.ts', 'dist/server.cjs', 'dist/standalone.cjs']);
const PAT_RES = [/ghp_[A-Za-z0-9]{16,}/, /glpat-[A-Za-z0-9_-]{10,}/];

function trackedFilePaths() {
  return (run('git', ['ls-files']) ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
}

function sweepFiles(files) {
  const hits = [];
  for (const f of files) {
    if (SWEEP_EXCLUDES.has(f) || SWEEP_ALLOWLIST.has(f)) continue;
    const abs = path.isAbsolute(f) ? f : path.join(root, f);
    let text;
    try {
      text = fs.readFileSync(abs).toString('latin1'); // binary-safe
    } catch {
      continue; // unreadable (submodule/permission) — not a leak vector we can read
    }
    for (const re of PAT_RES) {
      if (re.test(text)) {
        hits.push(`${f} matches ${re.source}`);
        break;
      }
    }
  }
  return hits;
}

function sensitiveSweepProblems() {
  const files = trackedFilePaths();
  if (files.length === 0) return ['git ls-files returned nothing — the sweep cannot run here'];
  const hits = sweepFiles(files);
  if (hits.length) {
    return [`sensitive-pattern sweep over tracked files FAILED: ${hits.slice(0, 5).join('; ')} (live PAT shapes must never ride a commit; deliberate exceptions: .env + the exact-path baked-token allowlist — src/shared/bakedCreds.ts, dist/server.cjs) — rotate the token, scrub the file(s)`];
  }
  /* INVERSE gate (audit P2-5): the exact-path allowlist covers the server
   * bundle; the BROWSER bundle gets a STRONGER rule — zero ghp_ matches,
   * ever. projectClient.ts must read annotakit-gh.json, never import
   * bakedCreds.ts. */
  const distAppHits = [];
  for (const f of files) {
    if (!f.startsWith('dist-app/')) continue;
    try {
      if (/ghp_[A-Za-z0-9]{16,}/.test(fs.readFileSync(path.join(root, f)).toString('latin1'))) {
        distAppHits.push(f);
      }
    } catch {
      /* unreadable — the tracked set is readable by definition */
    }
  }
  if (distAppHits.length) {
    return [`dist-app browser bundle carries a GH PAT shape: ${distAppHits.join(', ')} — browser code must NEVER import bakedCreds.ts (the static path receives the token via annotakit-gh.json only)`];
  }
  notes.push(`sensitive sweep: clean over ${files.length} tracked files (ghp_/glpat-; .env + exact-path baked allowlist excluded; dist-app inverse gate: 0 ghp_)`);
  return [];
}

/* --------------------------------- selftest --------------------------------- */
if (process.argv.includes('--selftest')) {
  let failed = 0;
  const ok = (label, cond, detail = '') => {
    if (cond) console.log(`  ok  ${label}`);
    else {
      failed++;
      console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    }
  };
  const ghost = path.join(root, 'dist', 'chunk-DEADBEEF.mjs');
  const routesPath = path.join(root, 'src/server/routes.ts');
  const layerPath = path.join(root, 'dist', 'layer.mjs');
  const standalonePath = path.join(root, 'dist', 'standalone.cjs');
  const readmePath = path.join(root, 'README.md');
  const envPath = path.join(root, '.env');
  const pkgPath = path.join(root, 'package.json');
  const origPkg = fs.readFileSync(pkgPath, 'utf8');
  const trackedDist = (run('git', ['ls-files', '--', 'dist/']) ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const origDistStats = trackedDist.map((f) => ({ f, st: fs.statSync(path.join(root, f)) }));
  const origRoutes = fs.readFileSync(routesPath, 'utf8');
  const origRoutesStat = fs.statSync(routesPath);
  const origLayer = fs.existsSync(layerPath) ? fs.readFileSync(layerPath) : null;
  const origReadme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : null;
  const origEnv = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : null;
  try {
    // (a) ghost chunk → gate 1 must see it
    fs.writeFileSync(ghost, '// selftest ghost chunk\n');
    ok('ghost chunk detected', chunkDriftLines().some((l) => /DEADBEEF/.test(l)));
    // (b) version drift → the REAL gate 2 must bite
    fs.writeFileSync(routesPath, origRoutes.replace(/VERSION = '[^']+'/, "VERSION = '9.9.9-selftest'"));
    ok('version gate bites on pkg↔routes drift', (() => { problems.length = 0; const vp = versionProblems(); problems.length = 0; return vp.length === 1 && /version disagreement/.test(vp[0]); })());
    fs.writeFileSync(routesPath, origRoutes);
    // (c) stale-by-content dist (fixed-name bundle + marker byte) → the REAL
    //     exact-set byte-compare must bite
    if (origLayer !== null) {
      fs.writeFileSync(layerPath, Buffer.concat([origLayer, Buffer.from('\n// selftest stale-content marker\n')]));
      const sp = distSetProblems();
      ok('exact-set gate bites on stale-by-content dist', sp.length >= 1 && sp.some((p) => /layer\.mjs is STALE vs src/.test(p)), JSON.stringify(sp).slice(0, 160));
      fs.writeFileSync(layerPath, origLayer);
    } else {
      console.log('  note  dist/layer.mjs missing — stale-content plant skipped');
    }
    // (d) stale-by-mtime dist → the REAL freshness gate must bite. The gate
    //     compares NEWEST src vs NEWEST dist artifact, so the plant ages back
    //     EVERY tracked dist artifact (a single one would be masked by the
    //     rest). Restored in finally.
    {
      const past = new Date(Date.now() - 90 * 24 * 3600 * 1000);
      for (const { f } of origDistStats) fs.utimesSync(path.join(root, f), past, past);
      const fp = distFreshnessProblems();
      ok('freshness gate bites on src-newer-than-dist', fp.some((p) => /STALE by mtime/.test(p)), JSON.stringify(fp).slice(0, 160));
    }
    // (e) embedded-version staleness (the bump-without-rebuild class): bump
    //     BOTH package.json and routes.ts, keep dist as-is → gate 3(iii) must
    //     name BOTH bundles (their embedded 0.1.0 no longer matches pkg)
    {
      fs.writeFileSync(pkgPath, origPkg.replace(/"version": "[^"]+"/, '"version": "0.0.0-embedtest"'));
      fs.writeFileSync(routesPath, origRoutes.replace(/VERSION = '[^']+'/, "VERSION = '0.0.0-embedtest'"));
      const fp2 = distFreshnessProblems();
      ok('freshness gate bites on bump-without-rebuild (embedded VERSION)', fp2.filter((p) => /embeds VERSION=/.test(p)).length === 2, JSON.stringify(fp2).slice(0, 240));
    }
    // (f) fake PAT in a SCRATCH file → the sweep must flag it
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'release-check-selftest-'));
    const patFile = path.join(scratch, 'notes.md');
    // Deliberate selftest vectors are ASSEMBLED at runtime ([…].join('')) so
    // the committed SOURCE never matches this script's own sweep — a REAL
    // pasted token always will (it is contiguous in the file).
    const FAKE_GHP = ['ghp_', 'selftestFake', 'Token123456789'].join('');
    const FAKE_GLPAT = ['glpat-', 'selftestFake', 'Token12345678'].join('');
    fs.writeFileSync(patFile, `# scratch\n gh Token: ${FAKE_GHP} end\n`);
    const scratchHits = sweepFiles([patFile]);
    ok('sweep flags a PAT in a given file', scratchHits.length === 1 && /ghp_/.test(scratchHits[0] ?? ''), `sweep did not flag the scratch PAT (${JSON.stringify(scratchHits)})`);
    // (g) PAT planted in a TRACKED file (README.md) → the REAL tracked sweep
    //     must flag it
    if (origReadme !== null) {
      fs.writeFileSync(readmePath, `${origReadme}\n<!-- selftest --> ${FAKE_GLPAT}\n`);
      ok('real sweep flags a PAT in a tracked file', (() => { const hits = sweepFiles(trackedFilePaths()); return hits.some((h) => /README\.md/.test(h)) && hits.some((h) => /glpat-/.test(h)); })());
      fs.writeFileSync(readmePath, origReadme);
    }
    // (h) PAT in .env → the REAL tracked sweep must IGNORE it (the exclusion
    //     is load-bearing — see SWEEP_EXCLUDES)
    fs.writeFileSync(envPath, `${origEnv ?? ''}\nANNOTAKIT_GH_TOKEN=${FAKE_GHP}\n`);
    ok('sweep EXCLUDES .env by design (PAT there does not fail the gate)', (() => { const hits = sweepFiles(trackedFilePaths()); return !hits.some((h) => /\.env/.test(h)); })());
    // (h2) the EXACT-PATH baked allowlist is honored (bakedCreds.ts is the
    //      deliberate server-side home — D6) but stays surgical: the SAME
    //      content under ANY other name still flags.
    const otherCreds = path.join(root, 'src', 'shared', 'selftest-other-creds.ts');
    fs.writeFileSync(otherCreds, `export const T = '${FAKE_GHP}';\n`);
    ok('sweep allowlist honors the exact bakedCreds path only', (() => {
      const allowOk = sweepFiles(['src/shared/bakedCreds.ts']).length === 0;
      const copyFlags = sweepFiles(['src/shared/selftest-other-creds.ts']).length === 1;
      return allowOk && copyFlags;
    })());
    fs.rmSync(otherCreds, { force: true });
    // (i) dist-app gate: a scratch app with a root-absolute ref must bite;
    //     the REAL dist-app must pass (if built)
    const badApp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-check-badapp-'));
    fs.writeFileSync(path.join(badApp, 'index.html'), '<!doctype html><html><head></head><body><script src="/assets/app.js"></script></body></html>');
    ok('dist-app gate bites on root-absolute refs', distAppProblems(badApp).some((p) => /ROOT-ABSOLUTE/.test(p)));
    if (fs.existsSync(path.join(root, 'dist-app', 'index.html'))) {
      ok('dist-app gate passes on the real build', distAppProblems().length === 0);
    } else {
      console.log('  note  dist-app not built — real-app probe skipped');
    }
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(badApp, { recursive: true, force: true });
  } finally {
    fs.rmSync(ghost, { force: true });
    fs.writeFileSync(routesPath, origRoutes);
    fs.writeFileSync(pkgPath, origPkg);
    // mtime restore: the selftest REWRITES routes.ts + ages back dist mtimes —
    // without this, the NEXT real run's freshness gate would fail on our plant
    fs.utimesSync(routesPath, origRoutesStat.atime, origRoutesStat.mtime);
    for (const { f, st } of origDistStats) {
      try {
        fs.utimesSync(path.join(root, f), st.atime, st.mtime);
      } catch {
        /* vanished — nothing to restore */
      }
    }
    if (origLayer !== null) fs.writeFileSync(layerPath, origLayer);
    if (origReadme !== null) fs.writeFileSync(readmePath, origReadme);
    if (origEnv !== null) fs.writeFileSync(envPath, origEnv);
    else if (fs.existsSync(envPath)) fs.rmSync(envPath); // we created it — remove
  }
  console.log(failed === 0 ? 'release-check selftest: PASS (ghost chunk + version drift + stale content + stale mtime + bump-without-rebuild + scratch PAT + tracked PAT + .env exclusion + dist-app gate all proven)' : 'release-check selftest: FAIL');
  process.exit(failed === 0 ? 0 : 2);
}

/* --------------------------------- verdict ---------------------------------- */
chunkDriftProblems();
problems.push(...versionProblems(), ...distFreshnessProblems(), ...distSetProblems(), ...distAppProblems(), ...sensitiveSweepProblems());
for (const n of notes) console.log(`  ok  ${n}`);
if (problems.length) {
  for (const p of problems) console.error(`  FAIL  ${p}`);
  console.error('\nrelease-check: NOT CLEAN — fix the above before tagging');
  process.exit(1);
}
console.log('release-check: CLEAN');
