// src/singlefile/parse.ts
function contentOf(note) {
  const sr = note.shadowRoot;
  if (sr) return sr;
  return note.querySelector("template")?.content ?? null;
}
function selectorFromCite(cite) {
  if (!cite) return null;
  const m = /[#&]selector\(\s*type=CssSelector\s*,\s*value=([\s\S]*)\)\s*$/.exec(cite);
  if (!m) return null;
  const raw = m[1];
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
function offsetOf(attr) {
  if (attr == null) return void 0;
  const n = Number.parseFloat(attr);
  return Number.isFinite(n) ? n : void 0;
}
function parseSingleFileNotes(doc) {
  const notes = doc.querySelectorAll("single-file-note");
  const out = [];
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    const noteId = note.getAttribute("data-note-id") ?? "";
    const content = contentOf(note);
    let text = "";
    let selector = null;
    if (content) {
      const ta = content.querySelector("textarea");
      const value = ta && typeof ta.value === "string" ? ta.value : "";
      text = (value || "").trim() || (ta?.textContent || "").trim();
      const cite = content.querySelector("blockquote")?.getAttribute("cite") ?? null;
      selector = selectorFromCite(cite);
    }
    const offX = offsetOf(note.getAttribute("data-note-offset-x"));
    const offY = offsetOf(note.getAttribute("data-note-offset-y"));
    out.push({
      noteId,
      text,
      ...offX !== void 0 ? { offsetX: offX } : {},
      ...offY !== void 0 ? { offsetY: offY } : {},
      // fallback selector: the refs-membership form (also covers multi-ref)
      selector: selector ?? `[data-single-file-note-refs~="${noteId}"]`
    });
  }
  return out;
}
function stripSingleFileNoteCards(doc) {
  const notes = doc.querySelectorAll("single-file-note");
  let removed = 0;
  for (let i = 0; i < notes.length; i++) {
    const el = notes[i];
    const parent = el.parentNode;
    if (parent) parent.removeChild(el);
    removed++;
  }
  return removed;
}
var SF_HIDE_STYLE_ATTR = "data-dom-ak-sf-hide";
var SF_HIDE_CSS = "single-file-note{display:none !important}";
function ensureHideStyle(doc) {
  const existing = doc.querySelector(`style[${SF_HIDE_STYLE_ATTR}]`);
  if (existing) return existing;
  try {
    const style = doc.createElement("style");
    style.setAttribute(SF_HIDE_STYLE_ATTR, "sf");
    style.textContent = SF_HIDE_CSS;
    style.media = "all";
    const host = doc.body ?? doc.head ?? doc.documentElement;
    host?.appendChild?.(style);
    return style;
  } catch {
    return null;
  }
}
function hideSingleFileNoteCards(doc) {
  const style = ensureHideStyle(doc);
  if (!style) return -1;
  style.media = "all";
  return doc.querySelectorAll("single-file-note").length;
}
function setSingleFileNoteCardsVisible(doc, visible) {
  const style = ensureHideStyle(doc);
  if (style) style.media = visible ? "not all" : "all";
}
function singleFileNoteCardsVisible(doc) {
  const style = doc.querySelector(`style[${SF_HIDE_STYLE_ATTR}]`);
  if (!style) return true;
  return style.media === "not all";
}

export {
  contentOf,
  selectorFromCite,
  parseSingleFileNotes,
  stripSingleFileNoteCards,
  SF_HIDE_STYLE_ATTR,
  hideSingleFileNoteCards,
  setSingleFileNoteCardsVisible,
  singleFileNoteCardsVisible
};
