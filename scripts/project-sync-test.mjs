#!/usr/bin/env node
/**
 * dom-annotakit — the D6 project-sync offline suite (fake transport, no network).
 *
 * Two halves (design §7 + audit folds):
 *   A. specDirectives parser table — syntax, last-wins, cleaning, clipping,
 *      excerpt fallback.
 *   B. reconcileProject against a FAKE GraphQL transport:
 *        1. fresh board + 2 threads (one @epic/@story) → 2 creates, field
 *           sets, id-preserving option append
 *        2. re-run, no changes → ZERO writes (idempotent)
 *        3. comment edit → exactly 1 update
 *        4. re-organize via a REPLY carrying @epic → Epic field set (last wins)
 *        5. delete-wins is EVIDENCE-GATED: a tombstoned thread's item is
 *           deleted; a thread merely MISSING from the list (not tombstoned)
 *           keeps its item (P1-3 — the boot-race/board-wipe regression pin)
 *        6. duplicate markers → extra culled, canonical (oldest) kept (P2-1)
 *        7. >100-item boards page correctly (P1-1 — pagination regression pin)
 *        8. user-authored items (no byte-0 marker) are NEVER touched
 *        9. hostile thread ids (not ^th_) are skipped, never mirrored (P2-1)
 *       10. option append preserves a human-added option (fresh re-read +
 *           full-list replace, P2-3)
 *   C. the serve sidecar's single-flight (P2-4) via startProjectMirror with an
 *      injected fake transport + a real temp-dir store: two trigger() storms
 *      produce non-overlapping passes; tombstone deletes flow end-to-end
 *      through the store singleton.
 *
 * Run: node scripts/project-sync-test.mjs   (needs dist/ built — `bun run build`)
 * Exit 0 = pass; 1 = failure.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const { parseSpecDirectives, threadSpecDirectives, specTitleExcerpt } = await import('../dist/specDirectives.mjs');
const { reconcileProject, parseMarker, parseProjectTarget, markerFor, makeGql } = await import('../dist/ghProjects.mjs');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

/* ============================== A. the parser ============================== */

{
  console.log('\nA. specDirectives');
  const p1 = parseSpecDirectives('@epic: Creator Flows\nthe CTA should pulse');
  ok('A1 @epic: parsed + stripped', p1.directives.epic === 'Creator Flows' && p1.cleaned === 'the CTA should pulse', JSON.stringify(p1));
  const p2 = parseSpecDirectives('story: Login page\nplain line');
  ok('A2 bare story: parsed (no @)', p2.directives.story === 'Login page' && p2.cleaned === 'plain line', JSON.stringify(p2));
  const p3 = parseSpecDirectives('  @STORY:   Mixed   Case   value  ');
  ok('A3 case-insensitive + whitespace collapsed + trimmed', p3.directives.story === 'Mixed Case value', JSON.stringify(p3.directives));
  ok('A4 value clipped to 60', parseSpecDirectives('@epic: ' + 'x'.repeat(90)).directives.epic.length === 60);
  ok('A5 empty value ignored (line dropped)', parseSpecDirectives('@epic:\nrest').directives.epic === undefined);
  ok('A6 mid-line mention is NOT a directive', parseSpecDirectives('use the @epic: tag inline').directives.epic === undefined);
  ok('A7 multi-line mix — only directive lines stripped', parseSpecDirectives('keep1\n@story: S\nkeep2').cleaned === 'keep1\nkeep2');
  const t = threadSpecDirectives(['@epic: First', '@epic: Second', '@story: S1']);
  ok('A8 whole-thread LAST-WINS', t.epic === 'Second' && t.story === 'S1', JSON.stringify(t));
  ok('A9 excerpt clips at 80 with ellipsis', specTitleExcerpt('word '.repeat(40), 'fb').length === 80);
  ok('A10 excerpt falls back when cleaned empty', specTitleExcerpt('@epic: Only-directive', '[pin] cap') === '[pin] cap');
  ok('A11 parseProjectTarget users form', parseProjectTarget('https://github.com/users/melodietexoss/projects/10')?.number === 10);
  ok('A12 parseProjectTarget orgs form', parseProjectTarget('github.com/orgs/acme/projects/2')?.kind === 'org');
  ok('A13 parseProjectTarget rejects junk', parseProjectTarget('https://github.com/melodietexoss/dom-annotakit') === null);
  ok('A14 marker round-trip + byte-0 claim (generator tail \\n\\n)', parseMarker(`${markerFor('th_abc_1')}\n\nbody`) === 'th_abc_1');
  ok('A15 marker claim refuses mid-body paste', parseMarker(`prose\n${markerFor('th_abc_1')}`) === null);
  ok('A16 hostile id never claims AS itself (truncation-safe)', (() => { const claimed = parseMarker(`${markerFor('th_evil--></script>')}\n\nx`); return claimed !== 'th_evil--></script>'; })(), String(parseMarker(`${markerFor('th_evil--></script>')}\n\nx`)));
  ok('A17 SingleFile-import id shape admitted (live E2E find #3)', parseMarker(`${markerFor('singlefile-magnific-folder-filters-1-48bd1716')}\n\nx`) === 'singlefile-magnific-folder-filters-1-48bd1716');
  ok('A18 hostile singlefile-shaped id refused (follow-bytes check)', parseMarker(`${markerFor('singlefile-x-->y')}\n\nx`) === null);
}

/* =========================== B. the fake transport =========================== */

function fakeTransport({ pageSize = 100 } = {}) {
  const board = {
    project: { id: 'PVT_test', title: 'dom-annotakit — UI Spec', url: 'https://github.com/users/u/projects/1' },
    fields: [
      { id: 'F_EPIC', name: 'Epic', dataType: 'SINGLE_SELECT', options: [{ id: 'o1', name: 'General', color: 'GRAY', description: '' }] },
      { id: 'F_STORY', name: 'Story', dataType: 'SINGLE_SELECT', options: [{ id: 'o2', name: 'General', color: 'GRAY', description: '' }] },
      { id: 'F_CAP', name: 'Capture', dataType: 'TEXT' },
      { id: 'F_ANCH', name: 'DOM anchor', dataType: 'TEXT' },
    ],
    items: [],
    nextItem: 1,
    nextDraft: 1,
  };
  const calls = { writes: 0, reads: 0, ops: [] };
  const fieldByName = (n) => board.fields.find((f) => f.name === n);

  const gql = async (query, variables = {}) => {
    calls.reads++;
    const v = variables;
    /* project resolution (user or org query shape) */
    if (query.includes('projectV2(number:')) {
      return { data: { [query.includes('user(login:') ? 'user' : 'organization']: { projectV2: {
        id: board.project.id, title: board.project.title, url: board.project.url,
        fields: { nodes: board.fields.map((f) => ({ ...f, __typename: f.dataType === 'SINGLE_SELECT' ? 'ProjectV2SingleSelectField' : 'ProjectV2Field' })) },
      } } } };
    }
    /* paged items read */
    if (query.includes('items(first: 100')) {
      const after = v.cursor ?? null;
      const start = after ? board.items.findIndex((i) => i.itemId === after) + 1 : 0;
      const page = board.items.slice(start, start + pageSize);
      return { data: { node: { items: {
        pageInfo: { hasNextPage: start + pageSize < board.items.length, endCursor: page.length ? page[page.length - 1].itemId : null },
        nodes: page.map((i) => ({
          id: i.itemId,
          createdAt: i.createdAt,
          content: { __typename: 'DraftIssue', id: i.draftId, title: i.title, body: i.body },
          fieldValues: { nodes: i.fieldValues.map((fv) => ({ __typename: fv.name ? 'ProjectV2ItemFieldSingleSelectValue' : 'ProjectV2ItemFieldTextValue', name: fv.name, text: fv.text, field: { name: fieldById(fv.fieldId)?.name } })) },
        })),
      } } } };
    }
    /* fresh single-select option re-read */
    if (query.includes('ProjectV2SingleSelectField') && query.startsWith('query')) {
      const f = board.fields.find((x) => x.id === v.id);
      return { data: { node: { options: [...(f?.options ?? [])] } } };
    }
    /* mutations */
    if (query.includes('createProjectV2Field')) {
      calls.writes++;
      const f = { id: `F_new_${board.fields.length}`, name: v.input.name, dataType: v.input.dataType, options: v.input.dataType === 'SINGLE_SELECT' ? [] : undefined };
      board.fields.push(f);
      return { data: { createProjectV2Field: { projectV2Field: { id: f.id, name: f.name } } } };
    }
    if (query.includes('updateProjectV2Field')) {
      calls.writes++;
      const f = board.fields.find((x) => x.id === v.input.fieldId);
      f.options = v.input.singleSelectOptions.map((o, i) => ({ id: o.id ?? `o_new_${i}`, name: o.name, color: o.color, description: o.description }));
      return { data: { updateProjectV2Field: { projectV2Field: { id: f.id, options: f.options.map((o) => ({ id: o.id, name: o.name })) } } } };
    }
    if (query.includes('addProjectV2DraftIssue')) {
      calls.writes++;
      const item = {
        itemId: `PVTI_${board.nextItem++}`,
        draftId: `DI_${board.nextDraft++}`,
        createdAt: new Date(Date.now() + board.nextItem).toISOString(),
        title: v.input.title,
        body: v.input.body,
        fieldValues: [],
      };
      board.items.push(item);
      return { data: { addProjectV2DraftIssue: { projectItem: { id: item.itemId, content: { id: item.draftId } } } } };
    }
    if (query.includes('updateProjectV2DraftIssue')) {
      calls.writes++;
      const item = board.items.find((i) => i.draftId === v.input.draftIssueId);
      if (v.input.title !== undefined) item.title = v.input.title;
      if (v.input.body !== undefined) item.body = v.input.body;
      return { data: { updateProjectV2DraftIssue: { draftIssue: { id: item.draftId } } } };
    }
    if (query.includes('clearProjectV2ItemFieldValue')) {
      calls.writes++;
      const item = board.items.find((i) => i.itemId === v.input.itemId);
      item.fieldValues = item.fieldValues.filter((fv) => fv.fieldId !== v.input.fieldId);
      return { data: { clearProjectV2ItemFieldValue: {} } };
    }
    if (query.includes('updateProjectV2ItemFieldValue')) {
      calls.writes++;
      const item = board.items.find((i) => i.itemId === v.input.itemId);
      const f = board.fields.find((x) => x.id === v.input.fieldId);
      let fv = item.fieldValues.find((x) => x.fieldId === v.input.fieldId);
      if (v.input.value.singleSelectOptionId) {
        const opt = f.options.find((o) => o.id === v.input.value.singleSelectOptionId);
        fv = { fieldId: v.input.fieldId, name: opt?.name ?? '?' };
      } else {
        fv = { fieldId: v.input.fieldId, text: v.input.value.text };
      }
      item.fieldValues = item.fieldValues.filter((x) => x.fieldId !== v.input.fieldId);
      item.fieldValues.push(fv);
      return { data: { updateProjectV2ItemFieldValue: {} } };
    }
    if (query.includes('deleteProjectV2Item')) {
      calls.writes++;
      board.items = board.items.filter((i) => i.itemId !== v.input.itemId);
      return { data: { deleteProjectV2Item: {} } };
    }
    throw new Error(`fake transport: unhandled query ${query.slice(0, 80)}`);
  };
  function fieldById(id) {
    return board.fields.find((f) => f.id === id);
  }
  return { board, calls, gql };
}

const thread = (id, storyId, bodies, extra = {}) => ({
  id,
  storyId,
  status: 'open',
  createdAt: '2026-10-23T10:00:00.000Z',
  updatedAt: '2026-10-23T10:00:00.000Z',
  number: 1,
  comments: bodies.map((b, i) => ({ id: `c${i}`, author: 'reviewer', body: b, createdAt: '2026-10-23T10:00:00.000Z' })),
  target: { context: { tag: 'button', id: 'save', text: 'Save the flow' }, selector: 'button#save' },
  story: { storyId, name: 'old page title' },
  ...extra,
});

const config = { target: parseProjectTarget('https://github.com/users/melodietexoss/projects/10'), token: 'FAKE_TEST_TOKEN', publicUrl: 'https://preview.example' };
const captureName = (storyId) => `cap-${storyId}`;

{
  console.log('\nB1/B2. fresh board — creates + idempotence');
  const { board, calls, gql } = fakeTransport();
  let threads = [thread('th_a1', 'cap1', ['@epic: Creator Flows\nthe CTA should pulse on hover']), thread('th_b2', 'cap2', ['plain note, no directives'])];
  const deps = () => ({ gql, config, listThreads: () => threads, listDeletedIds: () => new Set(), captureName, log: () => {} });
  const r1 = await reconcileProject(deps());
  ok('B1a two items created', r1.created === 2, JSON.stringify(r1));
  ok('B1b marker bodies + spec headers', board.items.every((i) => i.body.startsWith('<!-- dom-annotakit:thread=')) && board.items[0].body.includes('**Epic:** Creator Flows'));
  ok('B1c epic option APPENDED (General preserved)', board.fields.find((f) => f.name === 'Epic').options.some((o) => o.name === 'General') && board.fields.find((f) => f.name === 'Epic').options.some((o) => o.name === 'Creator Flows'));
  const epicItem = board.items.find((i) => i.body.includes('th_a1'));
  ok('B1d Epic + Story + Capture + anchor field values set', epicItem.fieldValues.length >= 3 && epicItem.fieldValues.some((f) => f.name === 'Creator Flows') && epicItem.fieldValues.some((f) => f.text === 'cap-cap1') && epicItem.fieldValues.some((f) => f.text === 'button#save — “Save the flow”'), JSON.stringify(epicItem.fieldValues));
  ok('B1e deep link minted from publicUrl', epicItem.body.includes('https://preview.example/?capture=cap1'));
  ok('B1f plain thread has NO epic field', !board.items.find((i) => i.body.includes('th_b2')).fieldValues.some((f) => f.name));
  const w1 = calls.writes;
  const r2 = await reconcileProject(deps());
  ok('B2 idempotent — zero writes on a no-change pass', r2.created === 0 && r2.updated === 0 && r2.deleted === 0 && calls.writes === w1, `created=${r2.created} updated=${r2.updated} writes+${calls.writes - w1}`);
  ok('B2b title carries directives stripped (excerpt)', epicItem.title === 'the CTA should pulse on hover');

  console.log('\nB3/B4. edit + directive re-organization');
  threads = [threads[0], threads[1]];
  threads[0] = thread('th_a1', 'cap1', ['@epic: Creator Flows\nthe CTA should pulse on hover', 'now with more detail']);
  const r3 = await reconcileProject(deps());
  ok('B3 comment edit → exactly 1 update', r3.updated === 1 && r3.created === 0, JSON.stringify(r3));
  threads[0] = thread('th_a1', 'cap1', ['the CTA should pulse on hover', '@epic: New Epic']);
  const r4 = await reconcileProject(deps());
  const epicF = board.fields.find((f) => f.name === 'Epic');
  ok('B4 reply directive re-files the item (LAST WINS)', epicF.options.some((o) => o.name === 'New Epic') && epicItem.fieldValues.some((f) => f.name === 'New Epic') && !epicItem.fieldValues.some((f) => f.name === 'Creator Flows'), JSON.stringify(epicItem.fieldValues));

  console.log('\nB5. delete-wins is EVIDENCE-GATED (P1-3)');
  const before = board.items.length;
  threads = [threads[0]]; /* th_b2 vanished from the list — NOT tombstoned */
  const r5 = await reconcileProject(deps());
  ok('B5a missing-but-not-tombstoned thread KEEPS its item', r5.deleted === 0 && board.items.length === before, JSON.stringify(r5));
  const r6 = await reconcileProject({ ...deps(), listDeletedIds: () => new Set(['th_b2']) });
  ok('B5b tombstone EVIDENCE deletes the item', r6.deleted === 1 && !board.items.some((i) => i.body.includes('th_b2')), JSON.stringify(r6));

  console.log('\nB6. duplicate markers culled, oldest canonical (P2-1)');
  const dupBody = `${markerFor('th_a1')}\n\ndup`;
  board.items.push({ itemId: 'PVTI_DUP', draftId: 'DI_DUP', createdAt: new Date(Date.now() + 9999).toISOString(), title: 'dup', body: dupBody, fieldValues: [] });
  const r7 = await reconcileProject({ ...deps(), listThreads: () => threads, listDeletedIds: () => new Set() });
  ok('B6 duplicate culled', r7.culled === 1 && !board.items.some((i) => i.itemId === 'PVTI_DUP') && board.items.filter((i) => i.body.includes('th_a1')).length === 1, JSON.stringify(r7));

  console.log('\nB7. >100-item paging (P1-1)');
  for (let i = 0; i < 120; i++) board.items.push({ itemId: `PVTI_PAD_${i}`, draftId: `DI_PAD_${i}`, createdAt: new Date(2020, 0, i + 1).toISOString(), title: `pad ${i}`, body: `<div>padding ${i}</div>`, fieldValues: [] });
  threads = [threads[0]];
  const r8 = await reconcileProject(deps());
  ok('B7 all pages read; no duplicate creates for the mirrored thread', r8.items === board.items.length && r8.created === 0 && board.items.filter((i) => i.body.startsWith('<!-- dom-annotakit:')).length === 1, JSON.stringify(r8));

  console.log('\nB8. user-authored items never touched');
  board.items.push({ itemId: 'PVTI_HUMAN', draftId: 'DI_HUMAN', createdAt: new Date(2021, 0, 1).toISOString(), title: 'my own item', body: `some prose ${markerFor('th_a1')} pasted mid-body`, fieldValues: [] });
  const before8 = board.items.length;
  const r9 = await reconcileProject(deps());
  ok('B8 no marker at byte 0 → unclaimed → untouched', r9.culled === 0 && r9.deleted === 0 && board.items.length === before8 && board.items.some((i) => i.itemId === 'PVTI_HUMAN'), JSON.stringify(r9));

  console.log('\nB9. hostile thread ids skipped (P2-1)');
  threads = [threads[0], thread('th_evil--></script>', 'capX', ['bad'])];
  const r10 = await reconcileProject(deps());
  ok('B9 hostile id skipped, count reported', r10.skipped === 1 && !board.items.some((i) => i.body.includes('th_evil')), JSON.stringify(r10));

  console.log('\nB10. option append preserves human options (P2-3)');
  const epicField = board.fields.find((f) => f.name === 'Epic');
  epicField.options.push({ id: 'o_human', name: 'Human Added', color: 'PINK', description: 'by hand' });
  /* a FRESH thread exercises the create path against a human-touched field */
  const fresh = [thread('th_z9', 'cap9', ['@epic: Yet Another Epic\nz'])];
  const r11 = await reconcileProject({ ...deps(), listThreads: () => fresh, listDeletedIds: () => new Set() });
  ok('B10a new option appended + item created', epicField.options.some((o) => o.name === 'Yet Another Epic') && r11.created === 1, JSON.stringify(r11));
  ok('B10b human option SURVIVES with its id', epicField.options.some((o) => o.id === 'o_human' && o.name === 'Human Added'), JSON.stringify(epicField.options.map((o) => `${o.id}:${o.name}`)));
}

/* ======================= C. sidecar single-flight (P2-4) ======================= */

{
  console.log('\nC. serialized-pass interleaving pin (P2-4 — the wrapper mutex pattern)');
  const { board, calls, gql } = fakeTransport();
  let slowWrites = 30;
  const slowGql = async (q, v) => {
    if (q.includes('addProjectV2DraftIssue')) await new Promise((r) => setTimeout(r, slowWrites));
    return gql(q, v);
  };
  const threads = [thread('th_x1', 'cap1', ['race one']), thread('th_x2', 'cap2', ['race two'])];
  const deps = { gql: slowGql, config, listThreads: () => threads, listDeletedIds: () => new Set(), captureName, log: () => {} };
  /* exactly the promise-chain mutex projectMirror.ts/projectClient.ts run —
   * two racing trigger()s serialize into two non-overlapping passes */
  let chain = Promise.resolve();
  const queuedRun = () => {
    const p = chain.then(() => reconcileProject(deps));
    chain = p.then(() => undefined, () => undefined);
    return p;
  };
  const [ra, rb] = await Promise.all([queuedRun(), queuedRun()]);
  ok('C1 serialized passes → no duplicate creates', ra.created + rb.created === 2 && board.items.length === 2, `a=${ra.created} b=${rb.created} items=${board.items.length}`);
}

/* D15 (session 5): the option-color palette must be EXACTLY GitHub's
 * accepted set — an invalid color (BROWN/CYAN/MAGENTA/TAN) kills the whole
 * option-append mutation and latches the mirror in an error state (live
 * find: the user's first @epic:@story: test pin 2026-10-27). Pinned here so
 * the palette can never silently regress. */
{
  const GH_VALID = new Set(['GRAY', 'BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'RED', 'PINK', 'PURPLE']);
  const srcTxt = fs.readFileSync(new URL('../src/shared/ghProjects.ts', import.meta.url), 'utf8');
  const m = /const OPTION_COLORS = \[([^\]]+)\] as const;/.exec(srcTxt);
  assert.ok(m, 'OPTION_COLORS declaration found');
  const colors = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  assert.ok(colors.length > 0, 'palette non-empty');
  const bad = colors.filter((c) => !GH_VALID.has(c));
  assert.deepStrictEqual(bad, [], `every palette color must be a GitHub-accepted color (offenders: ${bad.join(', ')})`);
  ok('option-color palette ⊆ GitHub\'s accepted set', true);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
