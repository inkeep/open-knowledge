import { statSync } from 'node:fs';
import { applyEdits as applyJsoncEdits, modify as modifyJsonc } from 'jsonc-parser';

function detectJsonIndent(body: string): { insertSpaces: boolean; tabSize: number } {
  for (const line of body.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.length === 0 || trimmed.length === line.length) continue;
    if (line.charCodeAt(0) === 0x09) return { insertSpaces: false, tabSize: 1 };
    return { insertSpaces: true, tabSize: line.length - trimmed.length };
  }
  return { insertSpaces: true, tabSize: 2 };
}

export function isCrlfDominant(text: string): boolean {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return false;
  const bareLf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf >= bareLf;
}

export function existingFileMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}

export function surgicalJsonDelete(
  raw: string,
  path: (string | number)[],
): { text: string; changed: boolean } {
  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const body = hasBom ? raw.slice(1) : raw;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const edits = modifyJsonc(body, path, undefined, {
    formattingOptions: { ...detectJsonIndent(body), eol },
  });
  if (edits.length === 0) return { text: raw, changed: false };
  const text = `${hasBom ? '\uFEFF' : ''}${applyJsoncEdits(body, edits)}`;
  return { text, changed: text !== raw };
}
