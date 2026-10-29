/**
 * dom-annotakit — comment spec directives (@epic: / @story:).
 *
 * A comment may carry line-start directives that organize the thread when it
 * mirrors to the GH Projects board (D6): the annotation then files under an
 * epic/story instead of the ungrouped tail. Syntax, per LINE (case-insensitive,
 * the @ is optional):
 *
 *     @epic: Creator flows
 *     story: Login page
 *
 * Rules (design §2.4 + audit P2-1):
 *   - value = trimmed, inner whitespace collapsed, clipped to 60 chars;
 *     empty values are ignored (a bare `@epic:` line organizes nothing).
 *   - scans comments in order across the WHOLE thread, LAST WINS — replying
 *     `@epic: New epic` re-files the thread.
 *   - directive lines are stripped from the CLEANED text (used for the item
 *     title); the board body shows full originals (the directives ARE the
 *     record).
 *
 * Isomorphic + pure: no DOM, no fetch — testable from Node and the browser.
 */

const DIRECTIVE_LINE_RE = /^[ \t]*@?(epic|story)[ \t]*:[ \t]*(\S.*)$/i;
const MAX_VALUE_LEN = 60;

export interface SpecDirectives {
  epic?: string;
  story?: string;
}

function cleanValue(raw: string): string | null {
  const v = raw.trim().replace(/\s+/g, ' ');
  if (!v) return null;
  return v.length > MAX_VALUE_LEN ? v.slice(0, MAX_VALUE_LEN) : v;
}

/** Parse ONE comment body → its directives + the body minus directive lines. */
export function parseSpecDirectives(body: string): { directives: SpecDirectives; cleaned: string } {
  const lines = body.split(/\r?\n/);
  const kept: string[] = [];
  const directives: SpecDirectives = {};
  for (const line of lines) {
    const m = DIRECTIVE_LINE_RE.exec(line);
    if (m) {
      const v = cleanValue(m[2] ?? '');
      if (v) directives[m[1]!.toLowerCase() as 'epic' | 'story'] = v;
      // an empty/unparseable directive line is dropped either way — it
      // organized nothing and the line itself is pure noise
    } else {
      kept.push(line);
    }
  }
  return { directives, cleaned: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

/** Whole-thread directive resolution (comments in order, LAST WINS). */
export function threadSpecDirectives(bodies: string[]): SpecDirectives {
  const out: SpecDirectives = {};
  for (const b of bodies) {
    const { directives } = parseSpecDirectives(b);
    if (directives.epic) out.epic = directives.epic;
    if (directives.story) out.story = directives.story;
  }
  return out;
}

/** First-comment excerpt for the board item title (directives stripped). */
export function specTitleExcerpt(body: string, fallback: string, maxLen = 80): string {
  const { cleaned } = parseSpecDirectives(body);
  const flat = cleaned.replace(/\s+/g, ' ').trim();
  const base = flat || fallback;
  return base.length > maxLen ? `${base.slice(0, maxLen - 1).trimEnd()}…` : base;
}
