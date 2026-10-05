import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function makeTree(root: string, files: Record<string, string | Uint8Array>): string {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

export function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}
