import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const TOOL_INPUT_KEYS = {
  links: new Set(['kind', 'document', 'sourceDocuments', 'mode', 'limit', 'cwd']),
  audit: new Set(['path', 'cwd']),
};
const SKILLS_DIR = join(import.meta.dirname, '../assets/skills');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : name.endsWith('.md') ? [p] : [];
  });
}

const CALL_RE = /\b(links|audit)\(\{([^}]*)\}\)/g;

describe('shipped skills call links()/audit() with declared parameter names', () => {
  const callSites = { links: 0, audit: 0 };
  for (const file of walk(SKILLS_DIR)) {
    const text = readFileSync(file, 'utf-8');
    const calls = [...text.matchAll(CALL_RE)];
    if (calls.length === 0) continue;
    for (const [, tool] of calls) callSites[tool as keyof typeof callSites]++;
    test(file.slice(SKILLS_DIR.length + 1), () => {
      expect.hasAssertions();
      for (const [, tool, body] of calls) {
        const keys = [...body.matchAll(/(?:^|,)\s*([A-Za-z_]+)\s*(?=[:,]|$)/g)].map((m) => m[1]);
        for (const key of keys) {
          expect(
            TOOL_INPUT_KEYS[tool as keyof typeof TOOL_INPUT_KEYS],
            `${tool}({ ${key}: … })`,
          ).toContain(key);
        }
      }
    });
  }
  test('scan is not vacuous', () => {
    expect(callSites.links).toBeGreaterThan(10);
    expect(callSites.audit).toBeGreaterThan(3);
  });
});

describe('shipped skills describe audit by what it reports', () => {
  test('no shipped skill frames `audit` as a dead-link-only check', () => {
    for (const file of walk(SKILLS_DIR)) {
      const text = readFileSync(file, 'utf-8');
      for (const stale of ['zero dead links', 'fix or remove every dead link']) {
        expect(text, `${file.slice(SKILLS_DIR.length + 1)}: ${stale}`).not.toContain(stale);
      }
    }
  });
});
