/**
 * Convert Notion `<aside>` callouts to Open Knowledge `> [!note]` callouts.
 *
 * Notion exports callouts as raw `<aside>...</aside>` HTML (often led by an emoji
 * icon). OK does not style raw `<aside>`, so we rewrite each block to a native
 * note callout, blockquote-prefixing every content line. v1 always emits
 * `[!note]` (no emoji-to-type mapping) and drops a leading emoji. Idempotent:
 * once converted, no `<aside>` remains for a second pass to match.
 */

const ASIDE = /<aside>\s*([\s\S]*?)\s*<\/aside>/g;
// One or more leading emoji (with optional variation selector) plus trailing space.
const LEADING_EMOJI = /^(?:\p{Extended_Pictographic}️?\s*)+/u;

export function asideToCallout(markdown: string): string {
  return markdown.replace(ASIDE, (_match, rawInner: string) => {
    const lines = rawInner.replace(/\r\n/g, '\n').split('\n');
    while (lines.length > 0 && (lines[0] as string).trim() === '') lines.shift();
    while (lines.length > 0 && (lines[lines.length - 1] as string).trim() === '') lines.pop();
    if (lines.length > 0) {
      lines[0] = (lines[0] as string).replace(LEADING_EMOJI, '');
      // If the first line was only an emoji, it is now blank — re-trim so the
      // callout does not open with empty `>` lines.
      while (lines.length > 0 && (lines[0] as string).trim() === '') lines.shift();
    }
    const body = lines.map((line) => (line.trim() === '' ? '>' : `> ${line}`)).join('\n');
    return body ? `> [!note]\n${body}` : '> [!note]';
  });
}
