/**
 * dom-annotakit — SingleFile native-annotation reader (design D2c-1; M4;
 * D13/§9 P1-A reframe 2026-10-26).
 *
 * DOM-GENERIC: every function takes a `Document`/`Element` and nothing else —
 * the SAME module runs in the HOST window against the capture iframe's
 * document (same-origin object access) and inside Node tests against a
 * hand-rolled fake DOM (scripts/singlefile-import-test.mjs). No window, no
 * fetch, no React.
 *
 * THE DISPLAY INVARIANT (D13 — replaces the old strip-first invariant):
 * note cards are ALWAYS in the DOM tree, in every session and every shape
 * (serve live, baked static — the bake PRESERVES cards too). Display flips
 * via a single injected <style> (hidden by default post-import; the toolbar
 * SF toggle flips it live). WHY: `:nth-child` counts TREE position, so
 * hidden and visible cards are anchor-identical; a STRIPPED DOM is the only
 * third shape, and mixing it in (the old import path) made every later
 * cards-present session resolve those anchors against shifted sibling
 * positions (live audit P1-1). The import flow therefore captures anchors
 * on the HIDDEN-cards DOM — consistent with every later load. Nothing ever
 * removes card elements; the capture file on disk is never modified.
 *
 * The format (decoded from real captures —
 * fixtures/magnific-folder-new-asset-flow-annotated.html, verified 2026-10-22):
 *
 *   <single-file-note data-note-id=N data-note-offset-x=X data-note-offset-y=Y>
 *     <template shadowrootmode=open>            ← the sticky card
 *       <style>.note { … z-index: 2147483646 }</style>
 *       <div class="note …" style="left: Xpx; top: Ypx; position: absolute;">
 *         <header>…</header>
 *         <blockquote cite='https://www.w3.org/TR/annotation-model/
 *           #selector(type=CssSelector,value=[data-single-file-note-refs~="N"])'>
 *           <textarea dir=auto>NOTE TEXT — newlines + entities</textarea>
 *         </blockquote>
 *         <div class=note-resize></div>
 *       </div>
 *     </template>
 *   </single-file-note>
 *
 * …as a light-DOM SIBLING of its target; the target element carries
 * `data-single-file-note-refs="N …"` (space-separated multi-membership is
 * real — one element can serve several notes, and `~=` matches any member).
 *
 * THE DUAL-SHAPE CONTRACT (crit-1a P1 — the most dangerous hole of the
 * design): declarative shadow DOM MOVES the template's children into the
 * shadow root on live parse, so in a BROWSER `note.shadowRoot` holds the card
 * and `template.content` is EMPTY; in Node/jsdom-style fixtures (no
 * declarative-shadow attach) the inverse holds — `shadowRoot` is null and
 * `template.content` still carries the card. The reader must accept BOTH:
 *
 *   contentOf(note) = note.shadowRoot ?? note.querySelector('template')?.content ?? null
 *
 * Both shapes are pinned by tests: the Node suite (fragment shape) +
 * the agent-browser E2E on the real capture (shadowRoot shape). jsdom masks
 * the live-parse behavior — a green Node suite alone proves nothing.
 */

/** One embedded SingleFile note, flattened to plain data. */
export interface NoteInfo {
  /** `data-note-id` attribute (raw string — usually numeric). May be '' when
   * the capture carries a malformed note; the IMPORT flow treats that as an
   * invalid note (skipped, counted), never a crash. */
  noteId: string;
  /** The note body, trimmed. Newlines INSIDE survive (only the edges are
   * trimmed); entities are decoded by the DOM parser before we read them.
   * EMPTY string = empty note: returned for counting, skipped by import. */
  text: string;
  /** `data-note-offset-x` (the card's viewport-ish x — provenance only). */
  offsetX?: number;
  /** `data-note-offset-y`. */
  offsetY?: number;
  /** The CssSelector from the blockquote's cite — URL-decoded; falls back to
   * `[data-single-file-note-refs~="<id>"]` when the cite is missing or
   * unparseable. `~=` semantics cover multi-membership targets for free. */
  selector: string;
}

/** THE dual-shape content reader (see header). Shadow root first (live
 * browser parse), template fragment second (Node fixtures + legacy engines
 * without declarative-shadow support). */
export function contentOf(note: Element): DocumentFragment | ShadowRoot | null {
  const sr = (note as HTMLElement).shadowRoot;
  if (sr) return sr;
  return note.querySelector('template')?.content ?? null;
}

/** `https://…/#selector(type=CssSelector,value=<SEL>)` → `<SEL>`,
 * URL-decoded. Greedy to the LAST `)` so selectors that themselves end with
 * `)` (e.g. `:not(.x)`) survive. null when the cite is missing/malformed. */
export function selectorFromCite(cite: string | null): string | null {
  if (!cite) return null;
  const m = /[#&]selector\(\s*type=CssSelector\s*,\s*value=([\s\S]*)\)\s*$/.exec(cite);
  if (!m) return null;
  const raw = m[1];
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // malformed percent-escapes: keep the raw selector, never crash the batch
  }
}

function offsetOf(attr: string | null): number | undefined {
  if (attr == null) return undefined;
  const n = Number.parseFloat(attr);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read EVERY `<single-file-note>` in the document into plain data.
 *
 * Notes with EMPTY text are RETURNED (text: '') so callers can count them for
 * the loud "N skipped (empty)" import notice — the import flow skips them.
 * The card content is reached through the dual-shape contract; the textarea
 * is read live-`.value`-first (`(ta.value || '').trim() || (ta.textContent ||
 * '').trim()`): a LIVE textarea carries .value, but a fragment textarea
 * (template.content shape, never rendered) has EMPTY .value — its text lives
 * in .textContent. Newlines and entities must survive both paths.
 */
export function parseSingleFileNotes(doc: Document): NoteInfo[] {
  const notes = doc.querySelectorAll('single-file-note');
  const out: NoteInfo[] = [];
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    const noteId = note.getAttribute('data-note-id') ?? '';
    const content = contentOf(note);
    let text = '';
    let selector: string | null = null;
    if (content) {
      const ta = content.querySelector('textarea');
      // duck-typed .value: a live browser textarea has it, a fake-DOM/
      // fragment textarea does not — neither instanceof nor absence may
      // throw in either world.
      const value = ta && typeof (ta as { value?: unknown }).value === 'string' ? (ta as { value: string }).value : '';
      text = (value || '').trim() || (ta?.textContent || '').trim();
      const cite = content.querySelector('blockquote')?.getAttribute('cite') ?? null;
      selector = selectorFromCite(cite);
    }
    const offX = offsetOf(note.getAttribute('data-note-offset-x'));
    const offY = offsetOf(note.getAttribute('data-note-offset-y'));
    out.push({
      noteId,
      text,
      ...(offX !== undefined ? { offsetX: offX } : {}),
      ...(offY !== undefined ? { offsetY: offY } : {}),
      // fallback selector: the refs-membership form (also covers multi-ref)
      selector: selector ?? `[data-single-file-note-refs~="${noteId}"]`,
    });
  }
  return out;
}

/**
 * Remove all `<single-file-note>` ELEMENTS from the document — their sticky
 * shadow cards die with them. Returns the count removed. Highlights
 * (`.single-file-highlight-*`), `data-single-file-note-refs` target attrs and
 * everything else in the capture STAY (targets keep their identity; the
 * highlight system is a separate v0.1-kept surface).
 *
 * LEGACY (D13): no production caller since the display-invariant reframe —
 * anchor capture NEVER runs against a card-removed DOM anymore (hidden is
 * the display answer; see the header). Kept for the bake's raw-shape
 * documentation + the offline suite, which pins the removal semantics.
 */
export function stripSingleFileNoteCards(doc: Document): number {
  const notes = doc.querySelectorAll('single-file-note');
  let removed = 0;
  for (let i = 0; i < notes.length; i++) {
    const el = notes[i];
    const parent = el.parentNode;
    if (parent) parent.removeChild(el);
    removed++;
  }
  return removed;
}

/* ------------------- D13: the hide/unhide display helpers ------------------- */

/** The injected hide-stylesheet's marker attribute (one per document). */
export const SF_HIDE_STYLE_ATTR = 'data-dom-ak-sf-hide';
const SF_HIDE_CSS = 'single-file-note{display:none !important}';

function ensureHideStyle(doc: Document): HTMLStyleElement | null {
  const existing = doc.querySelector(`style[${SF_HIDE_STYLE_ATTR}]`) as HTMLStyleElement | null;
  if (existing) return existing;
  try {
    const style = doc.createElement('style');
    style.setAttribute(SF_HIDE_STYLE_ATTR, 'sf');
    style.textContent = SF_HIDE_CSS;
    // hidden by default: the sheet applies until setSingleFileNoteCardsVisible
    // flips its media to 'not all' (a disabled stylesheet — reversible, live)
    style.media = 'all';
    /* CASCADE ORDER IS LOAD-BEARING (live E2E find, D13): SingleFile saves
     * its OWN `single-file-note{display:contents!important}` rule (plus the
     * per-property all:initial set) in a capture <style>. Two author-origin
     * !important rules: the LATER one in document order wins — a head-
     * appended hide sheet LOSES to SingleFile's rule (live-verified: cards
     * stayed visible). Appending at the DOCUMENT END puts this sheet last,
     * so display:none wins while media='all', and 'not all' (the visible
     * toggle) cleanly restores SingleFile's display:contents. */
    const host = doc.body ?? doc.head ?? doc.documentElement;
    host?.appendChild?.(style);
    return style;
  } catch {
    return null; // hostile/edge DOM: hiding degrades to no-op, never crashes
  }
}

/** Hide the SingleFile note CARDS via the style (elements STAY in the tree
 *  — see the header invariant). Idempotent per document. Returns the note
 *  count (or -1 when the style could not be injected). */
export function hideSingleFileNoteCards(doc: Document): number {
  const style = ensureHideStyle(doc);
  if (!style) return -1;
  style.media = 'all';
  return doc.querySelectorAll('single-file-note').length;
}

/** Flip the cards' VISIBILITY live (the toolbar SF toggle). */
export function setSingleFileNoteCardsVisible(doc: Document, visible: boolean): void {
  const style = ensureHideStyle(doc);
  if (style) style.media = visible ? 'not all' : 'all';
}

/** Current visibility state — `false` when hidden (or when no cards/style exist). */
export function singleFileNoteCardsVisible(doc: Document): boolean {
  const style = doc.querySelector(`style[${SF_HIDE_STYLE_ATTR}]`) as HTMLStyleElement | null;
  if (!style) return true; // nothing hidden
  return style.media === 'not all';
}
