import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Materialize a temp directory tree from a `{ relativePath: content }` map and
 * return its root. Test-only helper (`.test-helper.ts` — outside Bun test
 * discovery); never imported by production code.
 */
export function makeTree(files: Record<string, string | Uint8Array>): string {
  const root = mkdtempSync(join(tmpdir(), 'ok-migrate-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/** Read a file back from a tree by relative path. */
export function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}
