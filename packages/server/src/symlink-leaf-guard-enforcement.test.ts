import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { checkSymlinkLeaf } from './fs-safety.ts';

const SERVER_SRC = dirname(fileURLToPath(import.meta.url));

const LEAF_REFERRERS: Record<string, 'guarded' | 'seed-plane' | 'path-match'> = {
  'content/folder-frontmatter-write.ts': 'guarded',
  'content/nested-folder-rules.ts': 'guarded',
  'http/folder-template-routes.ts': 'guarded',
  'seed/plan.ts': 'seed-plane',
  'seed/starter.ts': 'seed-plane',
  'seed/index.ts': 'seed-plane',
  'content-filter.ts': 'path-match',
  'index.ts': 'path-match',
  'mcp/tools/edit.ts': 'path-match',
  'mcp/tools/write.ts': 'path-match',
  'fs-safety.ts': 'path-match',
};

const LEAF_TOKEN = /frontmatter\.yml|STARTER_FOLDER_FRONTMATTER_FILENAME/;
const GUARD_CALL = /checkSymlinkLeaf\s*\(((?:[^()]|\([^()]*\))*)\)/g;
const GUARD_DEFINING_MODULE = 'fs-safety.ts';

const GUARD_CALL_SITES: Record<string, readonly string[]> = {
  'api-extension.ts': ['okDir', 'okTemplatesDir'],
  'content/folder-frontmatter-write.ts': ['fmPath'],
  'content/nested-folder-rules.ts': ['dirname(yamlPath)', 'yamlPath'],
  'content/templates-resolver.ts': ['okDir'],
  'http/folder-template-routes.ts': [
    'foundAbs',
    'localFmPath',
    'movedAbs',
    'okAbs',
    'templateFilePath',
    'templateFilePath',
    'templatesAbs',
  ],
};

const SEED_EXCL_WRITE = /tracedWriteFileSync\([^)]*flag:\s*'wx'/;

function listServerSourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const abs = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...listServerSourceFiles(abs));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test-helper.ts')
    ) {
      out.push(abs);
    }
  }
  return out;
}

describe('symlink-leaf guard enforcement (frontmatter.yml referrers)', () => {
  const referrers = new Map<string, string>();
  for (const abs of listServerSourceFiles(SERVER_SRC)) {
    const source = readFileSync(abs, 'utf-8');
    if (LEAF_TOKEN.test(source)) {
      referrers.set(relative(SERVER_SRC, abs).split('\\').join('/'), source);
    }
  }

  test('every module naming the frontmatter.yml leaf is classified', () => {
    const unclassified = [...referrers.keys()].filter((f) => !(f in LEAF_REFERRERS));
    expect(
      unclassified,
      `These modules name the frontmatter.yml leaf but are not classified in LEAF_REFERRERS. ` +
        `Classify each as 'guarded' (refuses a symlinked leaf via checkSymlinkLeaf), 'seed-plane' ` +
        `(names the leaf only to PLAN it; the actual writer is seed/apply.ts, pinned below via ` +
        `its O_EXCL write), or 'path-match' (only matches path strings, never opens the ` +
        `leaf):\n${unclassified.map((f) => `  ${f}`).join('\n')}`,
    ).toEqual([]);

    const stale = Object.keys(LEAF_REFERRERS).filter((f) => !referrers.has(f));
    expect(
      stale,
      `Classified referrers that no longer name the leaf — remove them from LEAF_REFERRERS:\n${stale
        .map((f) => `  ${f}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  test('per-file checkSymlinkLeaf call sites (by argument expression) match the pinned map exactly', () => {
    const actual: Record<string, string[]> = {};
    for (const abs of listServerSourceFiles(SERVER_SRC)) {
      const rel = relative(SERVER_SRC, abs).split('\\').join('/');
      if (rel === GUARD_DEFINING_MODULE) continue;
      const source = readFileSync(abs, 'utf-8');
      const args = [...source.matchAll(GUARD_CALL)].map((m) => (m[1] ?? '').trim()).sort();
      if (args.length > 0) {
        actual[rel] = args;
      }
    }
    expect(
      actual,
      `checkSymlinkLeaf call sites changed. Removing one deletes a symlink refusal; ` +
        `adding or re-pointing one changes the guard surface. Review the change and update ` +
        `GUARD_CALL_SITES in this test to the new per-file argument expressions.`,
    ).toEqual(
      Object.fromEntries(
        Object.entries(GUARD_CALL_SITES).map(([f, args]) => [f, [...args].sort()]),
      ),
    );
  });

  test("every 'guarded' referrer holds a pinned call site and no 'path-match' referrer does", () => {
    const guarded = Object.entries(LEAF_REFERRERS)
      .filter(([, cls]) => cls === 'guarded')
      .map(([f]) => f);
    expect(
      guarded.filter((f) => !(f in GUARD_CALL_SITES)),
      `'guarded' referrers must appear in GUARD_CALL_SITES with at least one call`,
    ).toEqual([]);

    const pathMatch = Object.entries(LEAF_REFERRERS)
      .filter(([, cls]) => cls === 'path-match')
      .map(([f]) => f)
      .filter((f) => f !== GUARD_DEFINING_MODULE);
    expect(
      pathMatch.filter((f) => f in GUARD_CALL_SITES),
      `'path-match' referrers must not call the guard — reclassify as 'guarded' if one now does`,
    ).toEqual([]);

    const seedPlane = Object.entries(LEAF_REFERRERS)
      .filter(([, cls]) => cls === 'seed-plane')
      .map(([f]) => f);
    expect(
      seedPlane.filter((f) => f in GUARD_CALL_SITES),
      `'seed-plane' referrers plan the leaf but never open it — their writer is seed/apply.ts ` +
        `(pinned via the O_EXCL leg below); reclassify as 'guarded' if one starts calling the guard`,
    ).toEqual([]);
  });

  test('seed/apply.ts keeps the O_EXCL (flag wx) write for scaffolded leaves', () => {
    const source = readFileSync(join(SERVER_SRC, 'seed', 'apply.ts'), 'utf-8');
    expect(
      SEED_EXCL_WRITE.test(source),
      `seed/apply.ts must write scaffolded files via tracedWriteFileSync with flag: 'wx' — ` +
        `O_EXCL is what stops a write-through of a committed DANGLING symlinked leaf that ` +
        `existsSync reports as absent and seed/path-safety's ancestor walk cannot see.`,
    ).toBe(true);
  });
});

describe('checkSymlinkLeaf (tri-state semantics)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-symlink-leaf-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('a regular file is not a symlink', () => {
    const p = join(dir, 'frontmatter.yml');
    writeFileSync(p, 'title: x\n');
    expect(checkSymlinkLeaf(p)).toEqual({ kind: 'not-symlink' });
  });

  test('a symlinked leaf is reported as symlink, including a dangling one', () => {
    const live = join(dir, 'live.yml');
    writeFileSync(live, 'a: 1\n');
    const link = join(dir, 'link.yml');
    symlinkSync(live, link);
    expect(checkSymlinkLeaf(link)).toEqual({ kind: 'symlink' });

    const dangling = join(dir, 'dangling.yml');
    symlinkSync(join(dir, 'never-created.yml'), dangling);
    expect(lstatSync(dangling).isSymbolicLink()).toBe(true);
    expect(checkSymlinkLeaf(dangling)).toEqual({ kind: 'symlink' });
  });

  test('an absent leaf is not a symlink (ENOENT is benign)', () => {
    expect(checkSymlinkLeaf(join(dir, 'absent', 'frontmatter.yml'))).toEqual({
      kind: 'not-symlink',
    });
  });

  test('a non-ENOENT lstat failure is reported as unverifiable, not symlink', () => {
    const file = join(dir, 'a-file');
    writeFileSync(file, 'not a dir');
    const result = checkSymlinkLeaf(join(file, 'frontmatter.yml'));
    expect(result.kind).toBe('unverifiable');
    if (result.kind === 'unverifiable') {
      expect(result.code).toBe('ENOTDIR');
    }
  });
});
