import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ParseError, parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import { describe, expect, onTestFinished, test } from 'vitest';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSCONFIG = 'tsconfig.test-helper-callers.json';
const TYPECHECK_SCRIPT = 'typecheck:test-helper-callers';

const HELPERS = ['wait-within-test-budget.test-helper.ts', 'expect-stable.test-helper.ts'];

const UNSCANNED_DIRS = new Set(['node_modules', 'dist', '.turbo']);

const RELATIVE_SPECIFIER = /(?:\bfrom|\bimport\s*\()\s*'(\.{1,2}\/[^']*)'/g;

function withoutTsExtension(specifier: string): string {
  return specifier.replace(/\.ts$/, '');
}

function importsAHelper(source: string): boolean {
  return [...source.matchAll(RELATIVE_SPECIFIER)].some((match) => {
    const specifier = withoutTsExtension(match[1] ?? '');
    return HELPERS.some((helper) => specifier.endsWith(`/${withoutTsExtension(helper)}`));
  });
}

function filesUnder(dir: string, suffix: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return UNSCANNED_DIRS.has(entry.name) ? [] : filesUnder(path, suffix);
    }
    return entry.isFile() && entry.name.endsWith(suffix) ? [path] : [];
  });
}

function callersOnDisk(): string[] {
  return filesUnder(PACKAGE_ROOT, '.test.ts')
    .filter((path) => importsAHelper(readFileSync(path, 'utf8')))
    .map((path) => relative(PACKAGE_ROOT, path).replaceAll('\\', '/'))
    .sort();
}

function helpersOnDisk(root: string = PACKAGE_ROOT): string[] {
  return filesUnder(root, '.test-helper.ts').map((path) => basename(path));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function namedIn(source: string): string[] {
  const errors: ParseError[] = [];
  const config = parseJsonc(source, errors, { allowTrailingComma: true }) as unknown;
  const parseError = errors[0];
  if (parseError !== undefined) {
    throw new Error(
      `${TSCONFIG} did not parse: ${printParseErrorCode(parseError.error)} at offset ` +
        `${parseError.offset}. jsonc-parser recovers past the damage and returns a partial ` +
        'value, so reading on would compare the callers on disk against whatever survived ' +
        'rather than against what the file declares, and report the difference as caller drift.',
    );
  }
  const files: unknown = (config as { files?: unknown } | null)?.files;
  if (!isStringArray(files)) {
    throw new Error(
      `${TSCONFIG} must declare files as an array of strings, the shape tsc requires: a ` +
        'different shape draws no parse error at all, and spreading it yields either nothing ' +
        'or a string split into its characters, which reads as every caller being unnamed.',
    );
  }
  return [...files].sort();
}

function namedInConfig(): string[] {
  return namedIn(readFileSync(resolve(PACKAGE_ROOT, TSCONFIG), 'utf8'));
}

function packageScripts(): Record<string, string> {
  const manifest = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return manifest.scripts ?? {};
}

describe('every caller of a shared test-only helper sits inside a typecheck program', () => {
  test(`names in ${TSCONFIG} exactly the test files that import one`, () => {
    const callers = callersOnDisk();
    expect(
      callers.length,
      'no test file in this package imports either helper, so this contract is asserting nothing',
    ).toBeGreaterThan(0);
    const named = namedInConfig();
    expect(
      {
        unnamed: callers.filter((file) => !named.includes(file)),
        stale: named.filter((file) => !callers.includes(file)),
      },
      `tsconfig.json excludes **/*.test.ts, so ${TSCONFIG} is the only program that reads these ` +
        'call sites: an unnamed caller lets a breaking helper signature change pass every ' +
        'compiler, and a stale name is a caller the program can no longer find. A name in ' +
        'files is always in the program, so naming a caller also obliges it to typecheck: ' +
        'admit a helper to HELPERS once every file importing it compiles, and until then ' +
        'leave the helper local to the file that needs it rather than sharing it.',
    ).toEqual({ unnamed: [], stale: [] });
  });

  test(`reaches that program from the package typecheck script`, () => {
    const scripts = packageScripts();
    expect(
      scripts[TYPECHECK_SCRIPT] ?? '',
      `${TYPECHECK_SCRIPT} must compile ${TSCONFIG}`,
    ).toContain(`-p ${TSCONFIG}`);
    expect(
      scripts.typecheck ?? '',
      `${TSCONFIG} compiles nothing anyone runs unless typecheck chains ${TYPECHECK_SCRIPT}`,
    ).toContain(TYPECHECK_SCRIPT);
  });

  test('detects a helper import written without its .ts extension', () => {
    const importing = (specifier: string) => `import { waitWithinTestBudget } from '${specifier}';`;

    expect(importsAHelper(importing('./wait-within-test-budget.test-helper.ts'))).toBe(true);
    expect(
      importsAHelper(importing('./wait-within-test-budget.test-helper')),
      'moduleResolution "bundler" resolves an extensionless relative import, so a caller ' +
        'spelled that way must still be found or it escapes the program unnamed',
    ).toBe(true);
    expect(importsAHelper(importing('node:path'))).toBe(false);
  });

  test('finds a helper whatever depth it sits at, which is what HELPERS can name', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-helper-scan-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'nested', 'deeper'), { recursive: true });
    writeFileSync(join(root, 'flat.test-helper.ts'), '');
    writeFileSync(join(root, 'nested', 'deeper', 'buried.test-helper.ts'), '');

    expect(
      helpersOnDisk(root).sort(),
      'importsAHelper matches a helper by basename at any depth, so an existence scan that ' +
        'reads one directory level calls a nested helper missing and, through the assertion ' +
        'below, reports every caller of a helper that is present as already covered',
    ).toEqual(['buried.test-helper.ts', 'flat.test-helper.ts']);
  });

  test('names in HELPERS only helpers that are on disk', () => {
    const present = helpersOnDisk();
    expect(
      HELPERS.filter((helper) => !present.includes(helper)),
      'a helper renamed or removed leaves its entry matching nothing, and the guard then ' +
        'reports every caller of it as already covered',
    ).toEqual([]);
  });

  test(`reads ${TSCONFIG} the way tsc does, and tells a broken file from caller drift`, () => {
    expect(
      namedIn('{\n  // the callers\n  "files": ["src/b.test.ts", "src/a.test.ts",],\n}'),
      'tsc compiles a tsconfig carrying comments and trailing commas, so a reader stricter ' +
        'than tsc would red on a config that builds',
    ).toEqual(['src/a.test.ts', 'src/b.test.ts']);

    expect(() => namedIn('{"files": ["src/a.test.ts"')).toThrow(/did not parse/);
    expect(() => namedIn('{"files": "src/a.test.ts"}')).toThrow(/array of strings/);
    expect(
      () => namedIn('null'),
      'a bare null is valid JSON and draws no parse error, so without an object check the ' +
        'reader throws a raw TypeError from inside itself rather than either diagnostic it writes',
    ).toThrow(/array of strings/);
  });
});
