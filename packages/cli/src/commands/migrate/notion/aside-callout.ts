const ASIDE = /<aside>\s*([\s\S]*?)\s*<\/aside>/g;
const LEADING_EMOJI = /^(?:\p{Extended_Pictographic}️?\s*)+/u;

export function asideToCallout(markdown: string): string {
  return markdown.replace(ASIDE, (_match, rawInner: string) => {
    const lines = rawInner.replace(/\r\n/g, '\n').split('\n');
    while (lines.length > 0 && (lines[0] as string).trim() === '') lines.shift();
    while (lines.length > 0 && (lines[lines.length - 1] as string).trim() === '') lines.pop();
    if (lines.length > 0) {
      lines[0] = (lines[0] as string).replace(LEADING_EMOJI, '');
      while (lines.length > 0 && (lines[0] as string).trim() === '') lines.shift();
    }
    const body = lines.map((line) => (line.trim() === '' ? '>' : `> ${line}`)).join('\n');
    return body ? `> [!note]\n${body}` : '> [!note]';
  });
}
