import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isTestOnlySourceFile } from '../../../test-support/test-only-source-file.mjs';

export function listAgentWriteSpineFiles(serverSrcRoot: string): string[] {
  return readdirSync(serverSrcRoot, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
        !isTestOnlySourceFile(entry.name),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => readFileSync(path, 'utf8').includes('applyAgentMarkdownWrite'))
    .map((path) => relative(serverSrcRoot, path))
    .sort();
}
