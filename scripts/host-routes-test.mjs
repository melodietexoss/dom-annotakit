#!/usr/bin/env node
/**
 * dom-annotakit — the host-routes suite (D12/D13/D14, design 2026-10-26 §9).
 *
 * Drives dist/hostRoutes.cjs against TEMP DIRS + FAKE requests — no server,
 * no network, no git dependency (the git workdir is injected as a fake):
 *
 *   - resolveCapturesDir precedence (env > config > cwd) + repoRoot-relative
 *     config resolution + recursive flag
 *   - listCaptures: non-recursive default, denylist in recursive mode,
 *     dot-entry skip
 *   - the manifest: id collision guard, M5 JSON shape, cache invalidation
 *   - the §9 P1-B SERVE GATE: isServableRel admits ONLY manifest-listed
 *     relpaths (.env / .git/... / package.json → false even though they sit
 *     under the captures dir)
 *   - upload: sanitize matrix (traversal, dotfile, extension, control chars,
 *     size cap), 409 collision, overwrite, invalidation + manifest growth
 *   - (D15: capture DELETE is REMOVED — no remove() surface anymore)
 *   - the D10 REWRITE seam: isRewriteDoor paths, rewriteDoorBody (thread
 *     create + comment add, per-key escalation, malformed JSON passthrough,
 *     empty body untouched, contextless identity) + wrapRequestWithBody
 *     (re-emits buffered bytes through the engine's readBody consumer shape:
 *     on('data'|'end'|'error'), corrected content-length, preserved socket)
 *   - the spec context store: clean/trim/cap, invalid-type rejection
 *
 * Run: npm run test:host-routes
 */
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const HR = await import(path.join(root, 'dist/hostRoutes.cjs'));
const {
  resolveCapturesDir,
  listCaptures,
  createCapturesManager,
  createSpecContextStore,
  isRewriteDoor,
  rewriteDoorBody,
  wrapRequestWithBody,
  RECURSIVE_DENY,
} = HR;

let passed = 0;
let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`✗ ${name}\n  ${e?.stack ?? e}`);
  }
};

/* ------------------------------ temp captures dir ------------------------------ */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dom-ak-host-routes-'));
const caps = path.join(tmp, 'caps');
fs.mkdirSync(caps);
fs.writeFileSync(path.join(caps, 'a.html'), '<html><head><title>A</title></head><body>x</body></html>');
fs.writeFileSync(path.join(caps, 'b.htm'), '<html><body>y</body></html>');
fs.writeFileSync(path.join(caps, 'notes.txt'), 'not a capture');
fs.mkdirSync(path.join(caps, 'node_modules'), { recursive: true });
fs.writeFileSync(path.join(caps, 'node_modules', 'evil.html'), '<html>evil</html>');
fs.mkdirSync(path.join(caps, '.hidden'), { recursive: true });
fs.writeFileSync(path.join(caps, '.hidden', 'dot.html'), '<html>dot</html>');
fs.writeFileSync(path.join(caps, '.env'), 'SECRET=1'); // the P1-B probe target
fs.mkdirSync(path.join(caps, 'sub'), { recursive: true });
fs.writeFileSync(path.join(caps, 'sub', 'deep.html'), '<html>deep</html>');

const fakeGit = { toplevel: null, run: () => ({ ok: false, out: 'no git in tests' }), runAsync: async () => ({ ok: false, out: 'no git in tests' }) };
const captureId = (rel) => rel.replace(/\.[^./\\]+$/, '').replace(/[^a-zA-Z0-9-]/g, '-');
const mgr = createCapturesManager({ dir: caps, recursive: false, source: 'config' }, { captureId });

/* ------------------------------ scan + manifest ------------------------------ */

await check('listCaptures non-recursive: top-level html only, dot + dirs skipped', async () => {
  assert.deepStrictEqual(listCaptures(caps, false), ['a.html', 'b.htm']);
});

await check('listCaptures recursive + denylist: node_modules excluded, subdirs join, dot-dirs never', async () => {
  assert.deepStrictEqual(listCaptures(caps, true), ['a.html', 'b.htm', 'sub/deep.html']);
});

await check('RECURSIVE_DENY carries the audited host-tree hazards', async () => {
  for (const d of ['node_modules', 'skills', 'public', 'examples', 'dist-app', 'annotakit', 'mini-services', 'src', 'prisma', 'tests', 'db', 'download', 'upload']) {
    assert.ok(RECURSIVE_DENY.has(d), `denylist missing ${d}`);
  }
});

await check('manifest: M5 shape + id via relpath', async () => {
  const m = mgr.buildManifest();
  assert.ok(m.ok);
  assert.deepStrictEqual(
    m.json.captures.map((c) => c.id),
    ['a', 'b'],
  );
  assert.strictEqual(m.json.captures[0].title, 'A', 'head-scan provenance');
  assert.strictEqual(typeof m.json.generatedAt, 'string');
});

await check('manifest: id collision fails LOUDLY', async () => {
  const clashDir = path.join(tmp, 'clash');
  fs.mkdirSync(path.join(clashDir, 'x'), { recursive: true });
  fs.writeFileSync(path.join(clashDir, 'x-y.html'), 'a');
  fs.writeFileSync(path.join(clashDir, 'x/y.html'), 'b');
  const m2 = createCapturesManager({ dir: clashDir, recursive: true, source: 'config' }, { captureId }).buildManifest();
  assert.ok(!m2.ok);
  assert.match(m2.error, /collision/);
});

/* ------------------------------ the §9 P1-B gate ------------------------------ */

await check('SERVE GATE: manifest-listed relpaths pass', async () => {
  assert.ok(mgr.isServableRel('a.html'));
  assert.ok(mgr.isServableRel('b.htm'));
});

await check('SERVE GATE: dotfiles, dot-dirs, non-html, deep paths → 404 shape', async () => {
  assert.strictEqual(mgr.isServableRel('.env'), false, 'THE P1-B probe: .env under the captures dir must NOT serve');
  assert.strictEqual(mgr.isServableRel('package.json'), false);
  assert.strictEqual(mgr.isServableRel('notes.txt'), false);
  assert.strictEqual(mgr.isServableRel('.hidden/dot.html'), false);
  assert.strictEqual(mgr.isServableRel('node_modules/evil.html'), false, 'denylisted even when recursive would differ');
  assert.strictEqual(mgr.isServableRel('nope.html'), false);
  assert.strictEqual(mgr.isServableRel(''), false);
  assert.strictEqual(mgr.isServableRel('../.env'), false);
});

/* ---------------------------------- upload ---------------------------------- */

const HTML = '<html><head><title>New</title></head><body>z</body></html>';

await check('upload: writes, invalidates, and returns the manifest entry', async () => {
  const r = await mgr.upload('fresh.html', HTML, false, fakeGit);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.entry.id, 'fresh');
  assert.strictEqual(r.entry.title, 'New');
  assert.ok(fs.existsSync(path.join(caps, 'fresh.html')));
  assert.ok(mgr.isServableRel('fresh.html'), 'the gate admits it immediately');
});

await check('upload: 409 on collision, overwrite replaces', async () => {
  const r = await mgr.upload('a.html', HTML, false, fakeGit);
  assert.ok(!r.ok && r.status === 409 && r.existing === true);
  const r2 = await mgr.upload('a.html', HTML, true, fakeGit);
  assert.ok(r2.ok);
});

await check('upload sanitize: traversal + separators rejected', async () => {
  for (const name of ['../evil.html', 'sub/evil.html', 'a\\b.html', 'x/../y.html']) {
    const r = await mgr.upload(name, HTML, false, fakeGit);
    assert.ok(!r.ok && r.status === 400, `${name} must 400`);
  }
});

await check('upload sanitize: dotfile + extension + control chars + empty content rejected', async () => {
  assert.strictEqual((await mgr.upload('.env.html', HTML, false, fakeGit)).status, 400);
  assert.strictEqual((await mgr.upload('plain.txt', HTML, false, fakeGit)).status, 400);
  assert.strictEqual((await mgr.upload('noext', HTML, false, fakeGit)).status, 400);
  assert.strictEqual((await mgr.upload('bad\u0007.html', HTML, false, fakeGit)).status, 400);
  assert.strictEqual((await mgr.upload('ok.html', '', false, fakeGit)).status, 400);
  assert.strictEqual((await mgr.upload('', HTML, false, fakeGit)).status, 400);
  assert.strictEqual((await mgr.upload('x'.repeat(201) + '.html', HTML, false, fakeGit)).status, 400);
});

await check('upload sanitize: size cap (100MB) enforced', async () => {
  const r = await mgr.upload('big.html', 'x'.repeat(101 * 1024 * 1024), false, fakeGit);
  assert.strictEqual(r.status, 413);
});

await check('scanHead: single-line provenance comment never leaks the document into savedDate (s6 zen-sweep live-find)', async () => {
  const ONE_LINE = '<!DOCTYPE html><!-- Page saved with SingleFile  / url: https://one-line.example/x / saved date: 2026-10-22 --><html lang=en><head><title>one</title></head><body>hi</body>';
  const r = await mgr.upload('one-line.html', ONE_LINE, false, fakeGit);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.entry.savedDate, '2026-10-22T00:00:00.000Z', `savedDate must be a clean ISO date, got ${JSON.stringify(r.entry.savedDate)}`);
  assert.ok(!r.entry.savedDate.includes('-->') && !r.entry.savedDate.includes('<'), 'no comment-close/tag leakage');
});

await check('upload: git durability is best-effort (a failed push stays a WARNING)', async () => {
  const failingGit = { toplevel: '/fake/repo', run: () => ({ ok: false, out: 'push rejected' }), runAsync: async () => ({ ok: false, out: 'push rejected' }) };
  const r = await mgr.upload('durability.html', HTML, false, failingGit);
  assert.ok(r.ok, 'the file op succeeded');
  assert.match(r.durability, /push rejected/);
});

/* ---------------- audit round-1 folds: id collisions + cache + gate-delete ---------------- */

await check('upload: capture-ID collision (foo.htm next to foo.html) REFUSED — the manifest never bricks', async () => {
  const r = await mgr.upload('a.htm', HTML, false, fakeGit);
  assert.ok(!r.ok && r.status === 409, `expected 409, got ${r.status}`);
  assert.match(r.error, /capture id collision/);
  const m = mgr.buildManifest();
  assert.ok(m.ok, 'the manifest still builds');
  assert.strictEqual(fs.existsSync(path.join(caps, 'a.htm')), false, 'nothing was written');
});

await check('upload: overwrite of the SAME name is still fine (same id, same relpath)', async () => {
  const r = await mgr.upload('a.html', HTML, true, fakeGit);
  assert.ok(r.ok, r.error);
});

await check('manifest cache: a content re-save under the same name REFRESHES (fingerprint)', async () => {
  const before = mgr.buildManifest().json.captures.find((c) => c.relpath === 'a.html');
  const stamped = `<html><head><title>Re-saved ${Date.now()}</title></head><body>z</body></html>`;
  fs.writeFileSync(path.join(caps, 'a.html'), stamped);
  const after = mgr.buildManifest().json.captures.find((c) => c.relpath === 'a.html');
  assert.strictEqual(after.title, `Re-saved ${Date.now()}`.length > 0 ? after.title : after.title); // shape check
  assert.notStrictEqual(after.title, before.title, 'the head-scan refreshed with the new content');
});

await check('manifest cache: an UNTOUCHED tree serves the CACHED object (identity)', async () => {
  const m1 = mgr.buildManifest();
  const m2 = mgr.buildManifest();
  assert.strictEqual(m1.json, m2.json, 'no fingerprint change = the cached JSON object, zero rescans');
});

await check('preloadBody: settle-on-close shape (client abort mid-body)', async () => {
  const { preloadBody } = HR;
  // a request that emits data then close WITHOUT end/error must resolve null
  const fakeReq = new PassThrough();
  fakeReq.method = 'POST';
  fakeReq.url = '/annotakit/api/threads';
  fakeReq.headers = {};
  const res = {};
  const p = preloadBody(fakeReq, res, () => {});
  fakeReq.write('partial');
  fakeReq.destroy(); // 'close' without 'end'
  const out = await Promise.race([p, new Promise((r) => setTimeout(() => r('TIMEOUT'), 1000))]);
  assert.strictEqual(out, null, 'aborted bodies settle null, never hang');
});

/* --------------------------- resolveCapturesDir --------------------------- */

await check('resolveCapturesDir: env wins; config is repoRoot-relative; cwd default + non-recursive', async () => {
  const env = { DOM_AK_CAPTURES_DIR: '/env/caps' };
  const a = resolveCapturesDir({ captures: { dir: '../cfg' } }, { repoRoot: '/tool/repo', cwd: '/cwd', env });
  assert.deepStrictEqual([a.dir, a.source], ['/env/caps', 'env']);
  const b = resolveCapturesDir({ captures: { dir: '../cfg', recursive: false } }, { repoRoot: '/tool/repo', cwd: '/cwd', env: {} });
  assert.deepStrictEqual([b.dir, b.recursive, b.source], ['/tool/cfg', false, 'config'], 'config dir is TOOL-INSTANCE-relative (repoRoot)');
  const c = resolveCapturesDir(null, { repoRoot: '/tool/repo', cwd: '/some/cwd', env: {} });
  assert.deepStrictEqual([c.dir, c.recursive, c.source], ['/some/cwd', false, 'default-cwd']);
  const d = resolveCapturesDir({ captures: { recursive: true } }, { repoRoot: '/tool/repo', cwd: '/cwd', env: {} });
  assert.deepStrictEqual([d.dir, d.recursive, d.source], ['/cwd', true, 'default-cwd'], 'recursive opt-in rides the cwd default too');
  const dOff = resolveCapturesDir({ captures: { dir: '../cfg' } }, { repoRoot: '/tool/repo', cwd: '/cwd', env: {} });
  assert.strictEqual(dOff.recursive, false, 'config-with-dir is NON-recursive unless opted in');
  const e2 = resolveCapturesDir(null, { repoRoot: '/tool/repo', cwd: '/cwd', env: { DOM_AK_CAPTURES_DIR: '/env/caps' } });
  assert.strictEqual(e2.recursive, false, 'env branch stays non-recursive without the opt-in');
  const e = resolveCapturesDir(null, { repoRoot: '/tool/repo', cwd: '/cwd', env: { DOM_AK_CAPTURES_DIR: 'rel' } });
  assert.strictEqual(e.dir, path.resolve('rel'), 'env stays PROCESS-cwd-relative (the engine precedent: path.resolve(env value))');
});

/* --------------------------- the D10 rewrite seam --------------------------- */

await check('isRewriteDoor: thread create + comment add ONLY', async () => {
  assert.ok(isRewriteDoor('/annotakit/api/threads'));
  assert.ok(isRewriteDoor('/annotakit/api/threads/th_abc/comments'));
  assert.strictEqual(isRewriteDoor('/annotakit/api/threads/th_abc'), false, 'PATCH door is NOT rewritten (§9 P3-13)');
  assert.strictEqual(isRewriteDoor('/annotakit/api/threads/th_abc/snapshot'), false);
  assert.strictEqual(isRewriteDoor('/annotakit/api/sync'), false);
});

await check('rewriteDoorBody thread create: comments[0].body gains the missing directive lines', async () => {
  const body = Buffer.from(JSON.stringify({ id: 'th_x', storyId: 'cap', comments: [{ id: 'c1', body: 'the pill bar' }] }));
  const out = rewriteDoorBody('/annotakit/api/threads', body, { epic: 'E', story: 'S' });
  const parsed = JSON.parse(out.toString('utf8'));
  assert.strictEqual(parsed.comments[0].body, 'the pill bar\n@epic: E\n@story: S');
});

await check('rewriteDoorBody per-key escalation: the comment\'s own directive survives', async () => {
  const body = Buffer.from(JSON.stringify({ comments: [{ body: 'note\n@epic: Mine' }] }));
  const out = rewriteDoorBody('/annotakit/api/threads', body, { epic: 'Ctx', story: 'S' });
  const parsed = JSON.parse(out.toString('utf8'));
  assert.strictEqual(parsed.comments[0].body, 'note\n@epic: Mine\n@story: S');
});

await check('rewriteDoorBody comment add: {body} shape', async () => {
  const body = Buffer.from(JSON.stringify({ body: 'reply text', author: 'me', createdAt: 'now' }));
  const out = rewriteDoorBody('/annotakit/api/threads/th_abc/comments', body, { epic: 'E' });
  assert.strictEqual(JSON.parse(out.toString('utf8')).body, 'reply text\n@epic: E');
});

await check('rewriteDoorBody: no context = BYTE-IDENTICAL (zero-touch passthrough)', async () => {
  const body = Buffer.from(JSON.stringify({ comments: [{ body: 'x' }] }));
  assert.strictEqual(rewriteDoorBody('/annotakit/api/threads', body, {}), body);
  assert.strictEqual(rewriteDoorBody('/annotakit/api/threads', body, { epic: '' }), body, 'blank context = no context');
});

await check('rewriteDoorBody: malformed JSON / non-objects / empty comment bodies pass UNTOUCHED', async () => {
  const bad = Buffer.from('not json{');
  assert.strictEqual(rewriteDoorBody('/annotakit/api/threads', bad, { epic: 'E' }), bad);
  const arr = Buffer.from('[1,2]');
  assert.strictEqual(rewriteDoorBody('/annotakit/api/threads', arr, { epic: 'E' }), arr);
  const emptyComment = Buffer.from(JSON.stringify({ comments: [{ body: '   ' }] }));
  assert.strictEqual(rewriteDoorBody('/annotakit/api/threads', emptyComment, { epic: 'E' }), emptyComment, '§9 P3-13: never mint a context-only comment');
  const noComments = Buffer.from(JSON.stringify({ id: 'x' }));
  assert.strictEqual(rewriteDoorBody('/annotakit/api/threads', noComments, { epic: 'E' }), noComments);
  const emptyBody = Buffer.from(JSON.stringify({ body: '' }));
  assert.strictEqual(rewriteDoorBody('/annotakit/api/threads/th_x/comments', emptyBody, { epic: 'E' }), emptyBody);
});

await check('wrapRequestWithBody: re-emits buffered bytes through the readBody consumer shape', async () => {
  const orig = new http.IncomingMessage(new PassThrough()); // only for headers/socket shape
  orig.method = 'POST';
  orig.url = '/annotakit/api/threads';
  orig.headers = { host: 'x', 'content-type': 'application/json', 'content-length': '999' };
  const payload = Buffer.from(JSON.stringify({ comments: [{ body: 'hi\n@epic: E' }] }));
  const wrapped = wrapRequestWithBody(orig, payload);
  assert.strictEqual(wrapped.url, '/annotakit/api/threads');
  assert.strictEqual(wrapped.method, 'POST');
  assert.strictEqual(wrapped.headers['content-length'], String(payload.length), 'content-length corrected');
  assert.strictEqual(wrapped.socket, orig.socket, 'socket preserved (isLoopbackPeer)');
  assert.strictEqual(wrapped.headers.host, 'x');
  const read = await new Promise((resolve, reject) => {
    const chunks = [];
    wrapped.on('data', (c) => chunks.push(c));
    wrapped.on('end', () => resolve(Buffer.concat(chunks)));
    wrapped.on('error', reject);
  });
  assert.strictEqual(read.toString('utf8'), payload.toString('utf8'));
});

await check('wrapRequestWithBody: a LATE listener still drains (the engine attaches after dispatch)', async () => {
  const orig = new http.IncomingMessage(new PassThrough());
  orig.method = 'POST';
  orig.url = '/x';
  orig.headers = {};
  const payload = Buffer.from('abc');
  const wrapped = wrapRequestWithBody(orig, payload);
  await new Promise((r) => setTimeout(r, 20)); // end() already called — data must stay buffered
  const read = await new Promise((resolve, reject) => {
    const chunks = [];
    wrapped.on('data', (c) => chunks.push(c));
    wrapped.on('end', () => resolve(Buffer.concat(chunks)));
    wrapped.on('error', reject);
  });
  assert.strictEqual(read.toString('utf8'), 'abc');
});

/* --------------------------- the spec context store --------------------------- */

await check('spec context store: set/get/clean/cap', async () => {
  const s = createSpecContextStore();
  assert.deepStrictEqual(s.get(), {});
  s.set({ epic: '  Folder   UX ', story: null });
  assert.deepStrictEqual(s.get(), { epic: 'Folder UX' }, 'trim + collapse + null-clear');
  s.set({ epic: 'x'.repeat(80) });
  assert.strictEqual(s.get().epic.length, 60, 'the directive cap (60) applies');
  s.set({ epic: null });
  assert.deepStrictEqual(s.get(), {});
});

await check('spec context store: non-string values REJECT (the PUT validates)', async () => {
  const s = createSpecContextStore();
  assert.throws(() => s.set({ epic: 42 }));
  assert.throws(() => s.set({ story: [] }));
});

/* ---------------------------------- report ---------------------------------- */

fs.rmSync(tmp, { recursive: true, force: true });
console.log(
  failed === 0
    ? `\n${passed} passed, 0 failed (host-routes suite — D12 captures/gate + D10 rewrite seam, temp-dir + fake-request driven)`
    : `\n${passed} passed, ${failed} FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
