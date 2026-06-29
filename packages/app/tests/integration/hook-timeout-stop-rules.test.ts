import { describe, expect, test } from 'bun:test';
import { type Dirent, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SCANNED_DIRS = [import.meta.dirname, join(import.meta.dirname, '..', 'conversion')];

interface ScannedFile {
  path: string;
  source: string;
}

function listScannedTestFiles(): ScannedFile[] {
  const out: ScannedFile[] = [];
  function walk(dir: string) {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.test.ts')) continue;
      out.push({ path: relative(REPO_ROOT, abs), source: readFileSync(abs, 'utf-8') });
    }
  }
  for (const dir of SCANNED_DIRS) walk(dir);
  return out;
}

interface BeforeAllSite {
  line: number;
  hasTimeoutArg: boolean;
}

function scanBeforeAllSites(source: string): BeforeAllSite[] {
  const sourceFile = ts.createSourceFile('scanned.test.ts', source, ts.ScriptTarget.Latest, true);
  const sites: BeforeAllSite[] = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'beforeAll'
    ) {
      sites.push({
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        hasTimeoutArg: node.arguments.length >= 2,
      });
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  return sites;
}

describe('hook-timeout STOP rule — beforeAll must carry an explicit timeout', () => {
  const files = listScannedTestFiles();

  test('there are scanned files (sanity)', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.path.includes('tests/conversion/'))).toBe(true);
  });

  test('every beforeAll in tests/{integration,conversion} *.test.ts passes an explicit timeout', () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const site of scanBeforeAllSites(file.source)) {
        if (!site.hasTimeoutArg) {
          violations.push(`  ${file.path}:${site.line}`);
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `${violations.length} beforeAll site(s) without an explicit timeout argument. ` +
          `Hooks without one ride the invocation's budget (Bun default: 5s) — direct ` +
          `\`bun test <file>\` runs and the flag-less test:conversion script kill slow boots ` +
          `and surface a misleading 'server.cleanup' TypeError from afterAll. ` +
          `Add a second argument, preferably the shared constant: ` +
          `\`beforeAll(async () => { ... }, HARNESS_BOOT_TIMEOUT_MS);\` ` +
          `(a numeric literal like \`}, 30_000);\` is also accepted):\n${violations.join('\n')}`,
      );
    }
  });

  test('real-corpus negative controls: already-protected sites are classified compliant', () => {
    for (const name of [
      'document-list-depth1.test.ts',
      'showall-single-flight.test.ts',
      'showall-streaming.test.ts',
    ]) {
      const file = files.find((f) => f.path.endsWith(name));
      expect(file).toBeDefined();
      const sites = scanBeforeAllSites(file?.source ?? '');
      expect(sites.length).toBe(1);
      expect(sites[0]?.hasTimeoutArg).toBe(true);
    }
  });

  test('scanner fires on a planted unprotected beforeAll and not on adjacent negatives', () => {
    const planted = ['beforeAll(async () => {', '  server = await createTestServer();', '});'].join(
      '\n',
    );
    const fired = scanBeforeAllSites(planted);
    expect(fired.length).toBe(1);
    expect(fired[0]?.line).toBe(1);
    expect(fired[0]?.hasTimeoutArg).toBe(false);

    const numericClose = [
      'beforeAll(async () => {',
      '  server = await createTestServer();',
      '}, 30_000);',
    ].join('\n');
    expect(scanBeforeAllSites(numericClose)[0]?.hasTimeoutArg).toBe(true);

    const constantClose = [
      'beforeAll(async () => {',
      '  server = await createTestServer();',
      '}, HARNESS_BOOT_TIMEOUT_MS);',
    ].join('\n');
    expect(scanBeforeAllSites(constantClose)[0]?.hasTimeoutArg).toBe(true);

    expect(scanBeforeAllSites('beforeAll(boot, 30000);')[0]?.hasTimeoutArg).toBe(true);

    expect(scanBeforeAllSites('beforeAll(boot,);')[0]?.hasTimeoutArg).toBe(false);

    expect(scanBeforeAllSites("import { beforeAll, test } from 'bun:test';").length).toBe(0);

    const inertMentions = [
      '// beforeAll(async () => {});',
      '/* beforeAll( */',
      "const s = 'beforeAll(';",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture deliberately embeds template-interpolation syntax for the scanner to skip
      'const t = `beforeAll(${x})`;',
    ].join('\n');
    expect(scanBeforeAllSites(inertMentions).length).toBe(0);

    expect(scanBeforeAllSites('beforeEach(async () => {});').length).toBe(0);

    const gnarlyBody = [
      'beforeAll(async () => {',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture deliberately embeds template-interpolation syntax for the scanner to skip
      '  const url = `${base}/api/{x}`;',
      '  const re = /[)}({]/;',
      "  await fetch(url, { method: 'POST' });",
      '}, 30_000);',
      'beforeAll(async () => {',
      '  const re2 = /\\(/;',
      '});',
    ].join('\n');
    const gnarly = scanBeforeAllSites(gnarlyBody);
    expect(gnarly.length).toBe(2);
    expect(gnarly[0]?.hasTimeoutArg).toBe(true);
    expect(gnarly[1]?.hasTimeoutArg).toBe(false);
    expect(gnarly[1]?.line).toBe(6);

    const returnPositionRegex = [
      'beforeAll(async () => {',
      '  if (cond) { return /\\)/.test(s); }',
      '  server = await createTestServer();',
      '}, HARNESS_BOOT_TIMEOUT_MS);',
      'beforeAll(async () => {',
      '  server = await createTestServer();',
      '});',
    ].join('\n');
    const returnRegex = scanBeforeAllSites(returnPositionRegex);
    expect(returnRegex.length).toBe(2);
    expect(returnRegex[0]?.hasTimeoutArg).toBe(true);
    expect(returnRegex[1]?.line).toBe(5);
    expect(returnRegex[1]?.hasTimeoutArg).toBe(false);
  });
});
