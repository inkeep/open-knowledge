import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export function listAgentWriteSpineFiles(serverSrcRoot: string): string[] {
  return readdirSync(serverSrcRoot, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.test.tsx') &&
        !entry.name.endsWith('.test-helper.ts') &&
        !entry.name.endsWith('.test-helper.tsx'),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => readFileSync(path, 'utf8').includes('applyAgentMarkdownWrite'))
    .map((path) => relative(serverSrcRoot, path))
    .sort();
}
