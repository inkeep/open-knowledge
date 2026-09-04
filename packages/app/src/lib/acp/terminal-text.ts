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
      const trimmed = line.replace(/\r+$/, '');
      const idx = trimmed.lastIndexOf('\r');
      return idx === -1 ? trimmed : trimmed.slice(idx + 1);
    })
    .join('\n');
}
