
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Glob } from 'bun';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const RENDERER_ROOT = join(REPO_ROOT, 'packages/app/src');

const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /from\s+['"]y-prosemirror['"]/g,
  /from\s+['"]y-prosemirror\/[^'"]+['"]/g,
  /require\(\s*['"]y-prosemirror['"]\s*\)/g,
  /import\(\s*['"]y-prosemirror['"]\s*\)/g,
  /\bimport\s+['"]y-prosemirror['"]/g,
];

function isExcludedPath(absPath: string): boolean {
  if (absPath.endsWith('.d.ts')) return true;
  if (absPath.includes('/node_modules/')) return true;
  if (absPath.includes('/dist/')) return true;
  return false;
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

interface ScanResult {
  readonly violations: readonly Violation[];
  readonly filesScanned: number;
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

function scanRenderer(): ScanResult {
  const violations: Violation[] = [];
  let filesScanned = 0;
  const glob = new Glob('**/*.{ts,tsx}');
  for (const rel of glob.scanSync({ cwd: RENDERER_ROOT })) {
    const abs = join(RENDERER_ROOT, rel);
    if (isExcludedPath(abs)) continue;
    filesScanned++;
    const content = readFileSync(abs, 'utf8');
    for (const pattern of FORBIDDEN_PATTERNS) {
      const matches = content.matchAll(new RegExp(pattern.source, pattern.flags));
      for (const m of matches) {
        violations.push({
          file: relative(REPO_ROOT, abs),
          line: lineOf(content, m.index ?? 0),
          match: m[0],
        });
      }
    }
  }
  return { violations, filesScanned };
}

const MIN_RENDERER_FILES = 50;

describe('renderer y-prosemirror import coverage', () => {
  test('scan covers a non-trivial number of renderer files (anti-vacuousness)', () => {
    const { filesScanned } = scanRenderer();
    expect(filesScanned).toBeGreaterThanOrEqual(MIN_RENDERER_FILES);
  });

  test('packages/app/src/**/*.{ts,tsx} contains no direct y-prosemirror imports', () => {
    const { violations } = scanRenderer();
    if (violations.length > 0) {
      const report = violations.map((v) => `  ${v.file}:${v.line} — ${v.match}`).join('\n');
      throw new Error(
        `Renderer imports from 'y-prosemirror' directly (single prosemirror-binding-stack invariant).\n` +
          `Migrate the import to '@tiptap/y-tiptap' (TipTap v3 official path; aligns with editor-cache.ts).\n` +
          `Rationale: each library ships its own \`new PluginKey('y-sync')\` at module load, so a renderer that imports from both ends up with two distinct PluginKey instances and silently breaks \`Y.UndoManager.trackedOrigins\` Set-by-identity matching.\n` +
          `Violations:\n${report}`,
      );
    }
    expect(violations).toEqual([]);
  });
});
