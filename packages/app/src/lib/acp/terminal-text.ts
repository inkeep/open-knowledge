/**
 * Normalize raw terminal output for the transcript's terminal card: strip
 * ANSI escape sequences (colors, cursor movement) and resolve carriage
 * returns the way a terminal would — a `\r` restarts its line, so progress
 * bars render as their final state instead of hundreds of stacked frames.
 */

// CSI (colors/cursor), OSC (titles/hyperlinks, BEL- or ST-terminated), and
// single-character escapes. Sufficient for display cleanup; not a parser.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC/BEL bytes are exactly what this strips
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export function renderTerminalText(text: string): string {
  const stripped = stripAnsi(text);
  return stripped
    .split('\n')
    .map((line) => {
      // A trailing `\r` is just CRLF line-ending residue — dropping the text
      // before it would blank every line of ordinary Windows output. Only a
      // `\r` FOLLOWED by more characters is a redraw to collapse.
      const trimmed = line.replace(/\r+$/, '');
      const idx = trimmed.lastIndexOf('\r');
      return idx === -1 ? trimmed : trimmed.slice(idx + 1);
    })
    .join('\n');
}
