/**
 * Shipped skill assets must call `links` with parameter names the MCP tool
 * actually declares (`docName` / `sourceDocNames` shipped for months
 * and errored or silently audited the whole corpus). The key list mirrors the
 * `inputSchema` in `src/mcp/tools/links.ts` — update both together.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const LINKS_INPUT_KEYS = new Set(['kind', 'document', 'sourceDocuments', 'mode', 'limit', 'cwd']);
const SKILLS_DIR = join(import.meta.dirname, '../assets/skills');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : name.endsWith('.md') ? [p] : [];
  });
}

describe('shipped skills call links() with declared parameter names', () => {
  for (const file of walk(SKILLS_DIR)) {
    const text = readFileSync(file, 'utf-8');
    const calls = [...text.matchAll(/links\(\{([^}]*)\}\)/g)];
    if (calls.length === 0) continue;
    test(file.slice(SKILLS_DIR.length + 1), () => {
      for (const [, body] of calls) {
        const keys = [...body.matchAll(/(?:^|,)\s*([A-Za-z_]+)\s*:/g)].map((m) => m[1]);
        for (const key of keys) expect(LINKS_INPUT_KEYS, `links({ ${key}: … })`).toContain(key);
      }
    });
  }
});
