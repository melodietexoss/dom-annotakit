# kb: the SingleFile annotation format + our parse/import contract

Verified 2026-10-22 against real captures (GenEditor-ui corpus + live iframe
DOM). Reference implementation: `src/singlefile/parse.ts` +
`src/host/import.ts`; tests: `scripts/singlefile-import-test.mjs` (fragment
shape) + the browser E2Es (shadowRoot shape).

## The format (as stored in a saved page)

1. **Note cards** — `<single-file-note data-note-id=N data-note-offset-x=X
   data-note-offset-y=Y>` custom elements in the LIGHT DOM, **as siblings
   immediately after their target elements** (not inside them, not
   body-appended). Each wraps `<template shadowrootmode=open>` containing a
   self-styled sticky card (`.note` … z-index 2147483646) whose payload is:

   ```
   <blockquote cite='https://www.w3.org/TR/annotation-model/#selector(type=CssSelector,value=[data-single-file-note-refs~="N"])'>
     <textarea dir=auto>NOTE TEXT</textarea>
   </blockquote>
   <div class=note-resize></div>
   ```

2. **Targets** — arbitrary page elements carrying
   `data-single-file-note-refs="N M …"` (space-separated; multi-membership is
   real: one element with refs="1 2 3 4" and four notes pointing at it — one
   thread per note). The cite's CssSelector is exactly
   `[data-single-file-note-refs~="N"]` (the `~=` word-match).
3. **Highlights** — a separate system: `.single-file-highlight-yellow|pink|…`
   classes on arbitrary elements + `<style class=single-file-highlights-
   stylesheet>`. We leave them rendered; NOT converted to threads (v0.1 —
   PLAN).
4. **Serialization quirks** — SingleFile writes unquoted, sometimes
   lowercase attributes (`http-equiv=content-security-policy`): a
   case-SENSITIVE or quote-assuming grep over raw bytes misses real
   attributes. ALWAYS verify format claims against the LIVE PARSED DOM.
5. **Provenance** — every capture opens with `<!-- Page saved with SingleFile
   / url: … / saved date: … -->` (right after `<html>`) — manifest/bake
   head-scan this (first 64KB is enough).
6. **The freeze-CSP** — every observed capture carries
   `<meta http-equiv=content-security-policy content="default-src 'none';
   font-src 'self' data:; img-src 'self' data:; style-src 'unsafe-inline';
   media-src 'self' data:; script-src 'unsafe-inline' data:; object-src
   'self' data:; frame-src 'self' data:; form-action 'none'; base-uri
   'none';">` — blocks the injected layer module SILENTLY. Stripped at serve
   time (server) / bake time (static); never on disk; note cards never
   stripped.

## The dual-shape reader (the P1 that ships dead if wrong)

Declarative shadow DOM: on LIVE parse the browser creates the shadow root and
ADOPTS the template's children into it — `note.shadowRoot` holds the card and
`template.content` is EMPTY. In Node/jsdom fixtures (no declarative-shadow
support) it's the INVERSE: `template.content` holds the card, `shadowRoot` is
null. Therefore:

- Reader: `contentOf(note) = note.shadowRoot ?? note.querySelector('template')
  ?.content ?? null` — NEVER one shape only.
- Text: live textareas carry `.value`; fragment textareas (never rendered)
  have EMPTY `.value` — read `(ta.value || '').trim() || (ta.textContent || '').trim()`.
- The test matrix MUST pin BOTH halves: Node suite (fragment) + a browser E2E
  on a real annotated capture (shadowRoot). A Node-only suite stays green
  while the browser path is dead.

## The import contract (design REV 3 §D2c, all amendments folded)

- Order: parse (read all notes to plain data) → strip cards → capture anchors
  → create threads. **Strip-first invariant**: cards are layout-inert
  siblings, but finder selectors are :nth-child-based — anchors captured with
  cards present break their css rung when a later strip runs.
- Deterministic thread id: `singlefile-<captureId>-<noteId>-<sha1(noteText)
  [0:8]>` — idempotent across sessions, survives note-id recycling on re-save
  (text hash folds in), and replays at BOTH store doors. Delete-wins
  respected: a replay hitting a tombstone (server 409 `{deletedId:true}` /
  staticStore THROW on tombstone) = already-imported-and-deleted → skip,
  never resurrect, batch proceeds per-note.
- Dangling refs (target absent from the saved DOM — real corpus cases) and
  page-level targets (html/body/root): panel-only threads
  (`TargetContext.singleFileDangling = true`; note offsets stored as
  provenance bbox) — the layer's pin-render filter skips them; NEVER
  fabricate positional evidence.
- The auto-strip flag `dom-annotakit:stripped:<captureId>` is host-side UX
  state; the STORE is the correctness layer (idempotency + delete-wins). A
  fresh browser re-offers the import bar — clicking it is harmless.
- Comment source `'singlefile'` (additive types field); author = settings
  override → else `singlefile-import`.

## Corpus evidence

- `fixtures/magnific-folder-new-asset-flow-annotated.html` — 4 notes (one
  multi-line + entity-rich), all targets resolvable.
- `fixtures/synthetic-annotated.html` — 6 authored notes: normal, dangling,
  multi-ref pair (refs="3 4"), page-level (body target), empty-text.
- GenEditor-ui `docs/analysis/annotations.txt` — 6 dangling-ref cases across
  the older corpus (the python extractor's regex approach needed fallbacks;
  our DOM-parse approach doesn't).
