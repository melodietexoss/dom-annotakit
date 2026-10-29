// src/shared/specDirectives.ts
var DIRECTIVE_LINE_RE = /^[ \t]*@?(epic|story)[ \t]*:[ \t]*(\S.*)$/i;
var MAX_VALUE_LEN = 60;
function cleanValue(raw) {
  const v = raw.trim().replace(/\s+/g, " ");
  if (!v) return null;
  return v.length > MAX_VALUE_LEN ? v.slice(0, MAX_VALUE_LEN) : v;
}
function parseSpecDirectives(body) {
  const lines = body.split(/\r?\n/);
  const kept = [];
  const directives = {};
  for (const line of lines) {
    const m = DIRECTIVE_LINE_RE.exec(line);
    if (m) {
      const v = cleanValue(m[2] ?? "");
      if (v) directives[m[1].toLowerCase()] = v;
    } else {
      kept.push(line);
    }
  }
  return { directives, cleaned: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}
function threadSpecDirectives(bodies) {
  const out = {};
  for (const b of bodies) {
    const { directives } = parseSpecDirectives(b);
    if (directives.epic) out.epic = directives.epic;
    if (directives.story) out.story = directives.story;
  }
  return out;
}
function specTitleExcerpt(body, fallback, maxLen = 80) {
  const { cleaned } = parseSpecDirectives(body);
  const flat = cleaned.replace(/\s+/g, " ").trim();
  const base = flat || fallback;
  return base.length > maxLen ? `${base.slice(0, maxLen - 1).trimEnd()}\u2026` : base;
}

export {
  parseSpecDirectives,
  threadSpecDirectives,
  specTitleExcerpt
};
