import fs, {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { isTestOnlySourceFile } from '../../../../test-support/test-only-source-file.mjs';

const APP_ROOT = join(import.meta.dir, '..', '..');

const ALLOWLIST: Record<string, string> = {};

interface DoMockCall {
  specifier: string | null;
  factory: string | null;
}

const DO_MOCK_SITE = /\b(?:vi|vitest)\s*\.\s*doMock\b/g;

const DO_MOCK_HEAD =
  /^\s*(?:<[^>]*>\s*)?\(\s*(?:(?:await\s+)?import\s*\(\s*(['"`])([^'"`$]+)\1\s*\)|(['"`])([^'"`$]+)\3)\s*([,)])/;

function extractDoMockCalls(src: string): DoMockCall[] {
  const calls: DoMockCall[] = [];
  for (const site of src.matchAll(DO_MOCK_SITE)) {
    const afterName = (site.index ?? 0) + site[0].length;
    const head = DO_MOCK_HEAD.exec(src.slice(afterName));
    if (head === null) {
      calls.push({ specifier: null, factory: null });
      continue;
    }
    const specifier = head[2] ?? head[4] ?? '';
    if (head[5] === ')') {
      calls.push({ specifier, factory: null });
      continue;
    }
    const start = afterName + head[0].length;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    calls.push({ specifier, factory: src.slice(start, i) });
  }
  return calls;
}

function factoryHasActualSpread(factory: string): boolean {
  return /\.\.\.\s*actual[A-Za-z_$]?[\w$]*/.test(factory);
}

const posixRelative = (from: string, to: string): string => relative(from, to).split(sep).join('/');

interface FactoryScan {
  scanned: string[];
  factories: number;
  exempted: string[];
  violations: string[];
}

async function scanPlainTestFactories(
  packageRoot: string,
  allowlist: Record<string, string>,
): Promise<FactoryScan> {
  const sourceRoot = join(packageRoot, 'src');
  const glob = new Bun.Glob('**/*.test.{ts,tsx}');
  const scan: FactoryScan = { scanned: [], factories: 0, exempted: [], violations: [] };
  for await (const file of glob.scan(sourceRoot)) {
    if (file.includes('.dom.test.')) continue;
    const abs = join(sourceRoot, file);
    const rel = posixRelative(packageRoot, abs);
    scan.scanned.push(rel);
    for (const call of extractDoMockCalls(readFileSync(abs, 'utf-8'))) {
      if (call.specifier === null) {
        scan.violations.push(
          `${rel} names vi.doMock where this guard cannot read a string-literal specifier. ` +
            'If it is a call, write the specifier as a string literal so its factory can be checked; ' +
            'if it is text (a test title, string or directive reason), reword it so vi.doMock does not appear.',
        );
        continue;
      }
      if (call.factory === null) continue;
      scan.factories += 1;
      if (factoryHasActualSpread(call.factory)) continue;
      const allowKey = `${rel}::${call.specifier}`;
      if (allowKey in allowlist) {
        scan.exempted.push(allowKey);
        continue;
      }
      scan.violations.push(
        `${rel} mocks '${call.specifier}' with a partial factory (no \`...actual*\`-convention spread). ` +
          `Spread the real module (static-import it as actual, then \`...actual\` first in the factory) ` +
          `or add '${allowKey}' to ALLOWLIST with a safety rationale.`,
      );
    }
  }
  scan.scanned.sort();
  return scan;
}

function plainTestFilesUnder(packageRoot: string): string[] {
  return readdirSync(join(packageRoot, 'src'), { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory() && isTestOnlySourceFile(entry.name, 'vitest'))
    .map((entry) => posixRelative(packageRoot, join(entry.parentPath, entry.name)))
    .filter((rel) => !rel.includes('.dom.test.'))
    .filter((rel) => !rel.split('/').some((segment) => segment.startsWith('.')))
    .sort();
}

const violatingFile = (violation: string) => violation.split(' ')[0];

describe('vi.doMock factory completeness', () => {
  test('every plain-test factory spreads the real module or is allowlisted', async () => {
    const scan = await scanPlainTestFactories(APP_ROOT, ALLOWLIST);
    expect(scan.violations).toEqual([]);
  });

  test('the walk reads every plain source test file and checks real factories', async () => {
    const scan = await scanPlainTestFactories(APP_ROOT, ALLOWLIST);
    const expected = plainTestFilesUnder(APP_ROOT);
    expect(
      expected,
      'Found no plain test files under src/: the package root or the test-file pattern is wrong.',
    ).not.toEqual([]);
    expect(
      scan.scanned,
      "The walk must read exactly the plain test files under src/. Lines marked '-' are files it missed, " +
        "lines marked '+' are files it read that are not plain src/ tests: fix scanPlainTestFactories' root or glob.",
    ).toEqual(expected);
    expect(
      scan.factories,
      'No plain src/ test calls vi.doMock with a factory, so this guard checks nothing: fix the walk, ' +
        'or retire the guard if those mocks are gone.',
    ).toBeGreaterThan(0);
  });

  test('every ALLOWLIST entry still exempts a partial factory', async () => {
    const scan = await scanPlainTestFactories(APP_ROOT, ALLOWLIST);
    const stale = Object.keys(ALLOWLIST).filter((key) => !scan.exempted.includes(key));
    expect(
      stale,
      'These ALLOWLIST entries exempt nothing: the factory now spreads ...actual*, or the file or ' +
        'specifier is gone. Delete them from ALLOWLIST.',
    ).toEqual([]);
  });
});

describe('the walk, on a fixture package', () => {
  const partial = "vi.doMock('sonner', () => ({ toast: { error() {} } }));\n";
  const spread = "vi.doMock('sonner', () => ({ ...actualSonner, toast: { error() {} } }));\n";
  const fixtureRoots: string[] = [];
  let shared = '';

  const makeFixture = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'ok-mock-completeness-'));
    fixtureRoots.push(root);
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    return root;
  };

  const fixturePackage = (): string => {
    shared ||= makeFixture({
      'src/root.test.ts': partial,
      'src/nested/deep/inner.test.tsx': partial,
      'src/compliant.test.ts': spread,
      'src/view.dom.test.tsx': partial,
      'src/.cache/hidden.test.ts': partial,
      'src/shared.test-helper.ts': partial,
      'dist/src/built.test.ts': partial,
      'tests/integration/outside.test.ts': partial,
    });
    return shared;
  };

  afterAll(() => {
    for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
  });

  test('fires on a partial factory at the source root and nested below it, and nowhere else', async () => {
    const scan = await scanPlainTestFactories(fixturePackage(), {});
    expect(scan.violations.map(violatingFile).sort()).toEqual([
      'src/nested/deep/inner.test.tsx',
      'src/root.test.ts',
    ]);
    expect(scan.scanned).toEqual([
      'src/compliant.test.ts',
      'src/nested/deep/inner.test.tsx',
      'src/root.test.ts',
    ]);
    expect(scan.scanned).toEqual(plainTestFilesUnder(fixturePackage()));
    expect(scan.factories).toBe(3);
  });

  test('reads no directory outside the source root', async () => {
    const root = fixturePackage();
    const readdir = vi.spyOn(fs, 'readdirSync');
    let read: string[] = [];
    try {
      await scanPlainTestFactories(root, {});
      read = readdir.mock.calls
        .map(([dir]) => posixRelative(root, String(dir)))
        .filter((dir) => !dir.startsWith('..'));
    } finally {
      readdir.mockRestore();
    }
    expect(read).toContain('src');
    expect(read.filter((dir) => dir !== 'src' && !dir.startsWith('src/'))).toEqual([]);
  });

  test('an ALLOWLIST entry exempts only its own file and specifier', async () => {
    const exact = await scanPlainTestFactories(fixturePackage(), {
      'src/root.test.ts::sonner': 'fixture',
    });
    expect(exact.violations.map(violatingFile)).toEqual(['src/nested/deep/inner.test.tsx']);
    expect(exact.exempted).toEqual(['src/root.test.ts::sonner']);

    const otherSpecifier = await scanPlainTestFactories(fixturePackage(), {
      'src/root.test.ts::next-themes': 'fixture',
    });
    expect(otherSpecifier.violations.map(violatingFile).sort()).toEqual([
      'src/nested/deep/inner.test.tsx',
      'src/root.test.ts',
    ]);
    expect(otherSpecifier.exempted).toEqual([]);
  });

  test('fails on a vi.doMock specifier it cannot read, and leaves an automock alone', async () => {
    const root = makeFixture({
      'src/forms.test.ts': "vi.doMock('@/lib/auto');\nvi.doMock(MODULE, () => ({}));\n",
    });
    const scan = await scanPlainTestFactories(root, {});
    expect(scan.factories).toBe(0);
    expect(scan.violations.map(violatingFile)).toEqual(['src/forms.test.ts']);
    expect(scan.violations[0]).toContain('cannot read');
  });
});

describe('guard self-test (bidirectional + planted-positive)', () => {
  test('extractDoMockCalls: finds every call (planted-positive), nothing in clean source', () => {
    const twoCalls = [
      "vi.doMock('sonner', () => ({ toast }));",
      "vi.doMock('@/editor/DocumentContext', () => ({ useDocumentContext: () => ({}) }));",
    ].join('\n');
    expect(extractDoMockCalls(twoCalls).map((c) => c.specifier)).toEqual([
      'sonner',
      '@/editor/DocumentContext',
    ]);
    expect(extractDoMockCalls('const x = 1; await import("./y");')).toEqual([]);
  });

  test('extractDoMockCalls: reads every specifier form Vitest accepts, and marks the rest unreadable', () => {
    const forms = [
      "vi.doMock(import('sonner'), () => ({ toast }));",
      "vi.doMock(await import('next-themes'), () => ({ useTheme }));",
      'vi.doMock(`@/lib/a`, () => ({ a }));',
      "vitest.doMock('@/lib/b', () => ({ b }));",
      "vi .doMock('@/lib/c', () => ({ c }));",
      "vi.doMock<typeof import('@/lib/d')>('@/lib/d', () => ({ d }));",
      "vi.doMock('@/lib/auto');",
      'vi.doMock(MODULE, () => ({}));',
      `vi.doMock(\`@/lib/\${name}\`, () => ({}));`,
      "test('resets vi.doMock state between cases', () => {});",
    ].join('\n');
    expect(
      extractDoMockCalls(forms).map((c) => [c.specifier, c.factory === null ? 'none' : 'factory']),
    ).toEqual([
      ['sonner', 'factory'],
      ['next-themes', 'factory'],
      ['@/lib/a', 'factory'],
      ['@/lib/b', 'factory'],
      ['@/lib/c', 'factory'],
      ['@/lib/d', 'factory'],
      ['@/lib/auto', 'none'],
      [null, 'none'],
      [null, 'none'],
      [null, 'none'],
    ]);
  });

  test('factoryHasActualSpread: accepts ...actual* spreads (must-fire-true)', () => {
    expect(factoryHasActualSpread('() => ({ ...actualSonner, toast })')).toBe(true);
    expect(factoryHasActualSpread('() => ({ ...actual, useDocumentContext: () => ({}) })')).toBe(
      true,
    );
    expect(
      factoryHasActualSpread('() => ({\n  ...actualNextThemes,\n  useTheme: () => ({}),\n})'),
    ).toBe(true);
  });

  test('factoryHasActualSpread: rejects partial and non-actual spreads (adjacent negatives)', () => {
    expect(factoryHasActualSpread('() => ({ useDocumentContext: () => ({}) })')).toBe(false);
    expect(factoryHasActualSpread('() => ({ wrap: (...args) => fn(...args) })')).toBe(false);
    expect(factoryHasActualSpread('() => ({ ...localConfig, toast })')).toBe(false);
  });

  test('end-to-end: a partial factory is flagged, an ...actual factory is not', () => {
    const flagged = (src: string) =>
      extractDoMockCalls(src).filter(
        (c) => c.factory !== null && !factoryHasActualSpread(c.factory),
      ).length;
    expect(flagged("vi.doMock('sonner', () => ({ toast: { error() {} } }));")).toBe(1);
    expect(
      flagged("vi.doMock('sonner', () => ({ ...actualSonner, toast: { error() {} } }));"),
    ).toBe(0);
  });
});
