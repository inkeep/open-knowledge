import { markdownToPlainText } from '@inkeep/open-knowledge-core/markdown/plain-text';
import { createCodeFenceTracker } from '@inkeep/open-knowledge-core/utils/code-fence-tracker';

function plainLines(markdown: string, toPlainText: (markdown: string) => string): string[] {
  return toPlainText(markdown)
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

function lastCodeLine(lines: readonly string[]): string | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').replace(/\s+/g, ' ').trim();
    if (line !== '') return line;
  }
  return undefined;
}

function streamingPreview(text: string, toPlainText: (markdown: string) => string): string {
  const lines = text.trimEnd().split('\n');
  const isFenced = createCodeFenceTracker();
  let blockStart = 0;
  let fenceStart = -1;
  lines.forEach((line, index) => {
    const insideBefore = isFenced('');
    const fenced = isFenced(line);
    if (fenced && !insideBefore) fenceStart = index;
    if (!fenced && line.trim() === '') blockStart = index + 1;
  });
  if (isFenced('')) {
    const code = lastCodeLine(lines.slice(fenceStart + 1));
    if (code !== undefined) return code;
    const before = plainLines(lines.slice(0, fenceStart).join('\n'), toPlainText);
    return before[before.length - 1] ?? '';
  }
  const trailing = plainLines(lines.slice(blockStart).join('\n'), toPlainText);
  const all = trailing.length > 0 ? trailing : plainLines(text, toPlainText);
  return all[all.length - 1] ?? '';
}

export function thoughtPreview(
  text: string,
  streaming: boolean,
  toPlainText: (markdown: string) => string = markdownToPlainText,
): string {
  if (streaming) return streamingPreview(text, toPlainText);
  return plainLines(text, toPlainText)[0] ?? '';
}
