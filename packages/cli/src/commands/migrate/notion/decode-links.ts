/**
 * Normalize internal markdown link targets so they both RENDER and RESOLVE
 * in Open Knowledge.
 *
 * Notion percent-encodes link targets (`[x](Foo%20Bar%20<id>.md)`) and its
 * targets frequently contain literal parentheses (`(EnterpriseDB)`) and, once
 * decoded, spaces. Two OK constraints drive the transform:
 *
 *  1. OK's doc-link resolver does not decode `%20`, so an encoded target never
 *     matches the file on disk — we must decode it.
 *  2. CommonMark (OK's parser) only allows spaces in a link destination when it
 *     is wrapped in angle brackets. `[x](Foo Bar.md)` renders as plain TEXT, not
 *     a link — so a decoded target containing a space must be emitted as
 *     `[x](<Foo Bar.md>)`, which both renders and resolves (OK strips the `<>`).
 *
 * Targets are extracted with paren-depth awareness (so `(EnterpriseDB)` inside a
 * target is included, not truncated at the first `)`). External URLs, bare
 * anchors, and anything inside code are left untouched. Idempotent: an already
 * angle-wrapped, decoded target is returned unchanged.
 */

const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;
// Fenced-code opener/closer, capturing the fence character so a backtick block
// containing a `~~~` line (or vice versa) does not mis-toggle fence state
// (CommonMark §4.5 — a closing fence must match the opener's type).
const FENCE = /^\s*(`{3,}|~{3,})/;
// An internal link target pointing at a database `_all.csv`. Redirected to the
// generated `.md` table page so links open the readable table (and don't dangle
// after `--remove-csv` deletes the CSV).
const CSV_TABLE_TARGET = /_all\.csv(?=$|[#?])/i;

/** Decode the path portion of a target, preserving any #anchor / ?query suffix. */
function decodePath(url: string): string {
  const cut = Math.min(
    ...[url.indexOf('#'), url.indexOf('?')].filter((i) => i >= 0).concat(url.length),
  );
  const path = url.slice(0, cut);
  const suffix = url.slice(cut);
  try {
    return decodeURIComponent(path) + suffix;
  } catch {
    return url;
  }
}

/**
 * Rewrite a single extracted link target (the text between `](` and its closing
 * `)`, or an angle-bracket `<...>` form). Notion never emits link titles, so the
 * whole target is treated as the destination — no title splitting (which would
 * wrongly break a spaced target).
 */
function rewriteTarget(raw: string, redirectCsv: boolean): string {
  // Already angle-wrapped: decode inside, keep wrapped.
  if (raw.startsWith('<') && raw.endsWith('>')) {
    const inner = raw.slice(1, -1);
    if (EXTERNAL.test(inner) || inner.startsWith('//') || inner.startsWith('#')) return raw;
    let decoded = decodePath(inner);
    if (redirectCsv) decoded = decoded.replace(CSV_TABLE_TARGET, '.md');
    return `<${decoded}>`;
  }
  if (EXTERNAL.test(raw) || raw.startsWith('//') || raw.startsWith('#')) return raw;

  let decoded = decodePath(raw);
  if (redirectCsv) decoded = decoded.replace(CSV_TABLE_TARGET, '.md');
  // A destination with whitespace must be angle-wrapped to render as a link.
  return /\s/.test(decoded) ? `<${decoded}>` : decoded;
}

/**
 * Rewrite every markdown link target in a code-free text segment. Finds each
 * `](` and extracts the destination — an angle form `<...>` or a paren-balanced
 * run ending at the `)` that closes the link.
 */
function rewriteTargets(text: string, redirectCsv: boolean): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('](', i);
    if (open === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open + 2); // include `](`
    const j = open + 2;

    if (text[j] === '<') {
      const close = text.indexOf('>', j);
      if (close === -1 || text[close + 1] !== ')') {
        // Malformed or titled angle link — leave from here untouched.
        i = j;
        continue;
      }
      out += `${rewriteTarget(text.slice(j, close + 1), redirectCsv)})`;
      i = close + 2;
      continue;
    }

    // Paren-depth scan: the `(` of `](` opened depth 1; the link's `)` closes it.
    let depth = 1;
    let k = j;
    for (; k < text.length; k++) {
      const c = text[k];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (k >= text.length) {
      // Unbalanced — not a well-formed link; leave the rest as-is.
      out += text.slice(j);
      break;
    }
    out += `${rewriteTarget(text.slice(j, k), redirectCsv)})`;
    i = k + 1;
  }
  return out;
}

/** Rewrite markdown links on a single line's non-code segments. */
function rewriteLineOutsideCode(line: string, redirectCsv: boolean): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] === '`') {
      let ticks = 0;
      while (line[i + ticks] === '`') ticks++;
      const open = line.slice(i, i + ticks);
      const closeIdx = line.indexOf(open, i + ticks);
      if (closeIdx >= 0) {
        out += line.slice(i, closeIdx + ticks);
        i = closeIdx + ticks;
        continue;
      }
      out += line.slice(i);
      break;
    }
    const next = line.indexOf('`', i);
    const end = next === -1 ? line.length : next;
    out += rewriteTargets(line.slice(i, end), redirectCsv);
    i = end;
  }
  return out;
}

export interface DecodeLinksOptions {
  /** Redirect internal `_all.csv` link targets to the `.md` table page. */
  redirectCsv?: boolean;
}

/** Decode + angle-wrap internal link targets across a markdown document. */
export function decodeLinks(markdown: string, opts: DecodeLinksOptions = {}): string {
  const redirectCsv = opts.redirectCsv ?? false;
  const lines = markdown.split('\n');
  let fenceChar: '`' | '~' | null = null;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] as string;
    const match = line.match(FENCE);
    if (match) {
      const ch = (match[1] as string)[0] as '`' | '~';
      if (fenceChar === null) fenceChar = ch;
      else if (ch === fenceChar) fenceChar = null;
      continue;
    }
    if (fenceChar !== null) continue;
    lines[n] = rewriteLineOutsideCode(line, redirectCsv);
  }
  return lines.join('\n');
}
