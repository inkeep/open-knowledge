import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function appendOkIgnoreSync(projectDir: string, patterns: string): void {
  const path = join(projectDir, '.okignore');
  const trimmed = patterns.trim();
  if (trimmed.length === 0) return;
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const toAppend = filterDuplicateLines(existing, trimmed).trim();
  if (toAppend.length === 0) return;
  const sep = existing.length === 0 ? '' : !existing.endsWith('\n') ? '\n\n' : '\n';
  writeFileSync(path, `${existing + sep + toAppend}\n`, 'utf8');
}

function filterDuplicateLines(existing: string, patterns: string): string {
  const existingLines = new Set(existing.split('\n').map((l) => l.trim()));
  return patterns
    .split('\n')
    .filter((l) => !existingLines.has(l.trim()))
    .join('\n');
}
