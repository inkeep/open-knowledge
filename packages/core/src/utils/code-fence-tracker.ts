/**
 * Stateful tracker for CommonMark fenced code blocks while iterating over
 * markdown lines. Returns a predicate that, for each successive line, answers
 * "is this line inside (or an opening/closing marker of) a fenced code block?".
 *
 * Used by line-scanning consumers (outline heading extraction on server, source-mode
 * outline navigation on client) to ignore `# …` lines inside code fences — without
 * pulling in a full markdown parser.
 *
 * Follows CommonMark §4.5:
 *   - Opening fence: 0-3 leading spaces, then 3+ backticks or tildes, optional info string.
 *   - Closing fence: same char as opening, at least as long, no info string (only whitespace).
 *   - Inside a backtick fence, a tilde sequence doesn't close (and vice versa).
 *
 * Tabs-as-indent and 4+ space indented code blocks are intentionally out of scope —
 * our ATX heading detection anchors on `^#` so those cases can't produce false positives.
 */
export function createCodeFenceTracker(): (line: string) => boolean {
  let inFence = false;
  let openChar = '';
  let openLen = 0;

  return (line: string): boolean => {
    const fence = parseCodeFenceLine(line);
    if (inFence) {
      if (fence && fence.char === openChar && fence.len >= openLen && !fence.hasInfo) {
        inFence = false;
        openChar = '';
        openLen = 0;
      }
      return true;
    }
    if (fence) {
      inFence = true;
      openChar = fence.char;
      openLen = fence.len;
      return true;
    }
    return false;
  };
}

function parseCodeFenceLine(line: string): { char: string; len: number; hasInfo: boolean } | null {
  // Tolerate Windows-style CR at line ends — consumers typically split on '\n'
  // only, so a CRLF file leaves a trailing '\r' on each line that would otherwise
  // defeat the regex's `$` anchor (since JS `.` does not match `\r`).
  const stripped = line.endsWith('\r') ? line.slice(0, -1) : line;
  // ^ {0,3} — up to 3 leading spaces (CommonMark §4.5)
  // ([`~])  — fence character
  // \1{2,}  — 2 more of the same char (3+ total)
  // (.*)$   — optional info string
  const m = stripped.match(/^ {0,3}([`~])(\1{2,})(.*)$/);
  if (!m) return null;
  return {
    char: m[1] as string,
    len: 1 + (m[2] as string).length,
    hasInfo: (m[3] as string).trim() !== '',
  };
}
