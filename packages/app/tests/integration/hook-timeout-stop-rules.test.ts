/**
 * Mechanical STOP rule: every `beforeAll` in the scanned suites must pass an
 * explicit timeout (second argument) so its boot budget is
 * invocation-independent.
 *
 * Why: boot-bearing `beforeAll` hooks (canonical shape:
 * `beforeAll(async () => { server = await createTestServer(); });`) otherwise
 * ride whatever budget the *invocation* supplies. Bun's undocumented default
 * is 5s, and it governs `beforeAll` (empirically pinned). Any invocation path that
 * omits `--timeout` (direct `bun test tests/integration/<file>.test.ts`, the
 * `test:conversion` script) reverts hooks to the 5s default; under host load
 * a killed boot hook leaves `server` undefined and the unconditional
 * `afterAll` cleanup converts the failure into a misleading
 * `TypeError: undefined is not an object (evaluating 'server.cleanup')`.
 *
 * Scope / exclusion criteria (deliberate):
 *   - Directories: `tests/integration/` and `tests/conversion/`, recursive,
 *     `*.test.ts` only. `tests/integration/` is the boot-bearing suite;
 *     `tests/conversion/` is included because its `test:conversion` script
 *     passes NO `--timeout`, so hooks there have only the 5s default even in
 *     CI. Other tiers (`test:fidelity`, `test:perf:sessions`) are excluded —
 *     same latent shape, but out of this rule's enumerated class; widen
 *     deliberately if their scripts ever drop their `--timeout` flags.
 *   - Hooks: `beforeAll` only. Every `beforeAll` in the scanned dirs rides
 *     the boot budget (most await `createTestServer()` /
 *     `createRestartableServer()` directly; the rest do other async setup on
 *     the same budget), so "every `beforeAll` must pass a timeout" is the
 *     cheapest zero-false-positive rule. `beforeEach`/`afterAll`/`afterEach`
 *     are excluded: none of them performs harness boot today, and widening
 *     would flag sites outside the diagnosed class.
 *   - Compliance: ANY non-empty second argument counts (numeric literal like
 *     `30_000`, or a named constant like `HARNESS_BOOT_TIMEOUT_MS`). The
 *     scanner is structural (a TypeScript AST walk), so the multi-line
 *     closing form `}, 30_000);` is compliant.
 *
 * Canonical compliant shape:
 *   beforeAll(async () => {
 *     server = await createTestServer();
 *   }, HARNESS_BOOT_TIMEOUT_MS);
 *
 */

import { describe, expect, test } from 'bun:test';
import { type Dirent, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SCANNED_DIRS = [import.meta.dirname, join(import.meta.dirname, '..', 'conversion')];

interface ScannedFile {
  /** Repo-relative path for failure messages. */
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
      // A scanned dir may not exist in a partial checkout; the sanity test
      // below still requires that at least one file was found overall. Every
      // other error class (EACCES, EMFILE, ...) must fail loud — a partially
      // walked corpus would silently under-report violations.
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
  /** 1-based line of the `beforeAll(` opening. */
  line: number;
  /** True when the call passes a non-empty second argument. */
  hasTimeoutArg: boolean;
}

/**
 * Structural scan for `beforeAll(...)` call sites and whether each passes a
 * second (timeout) argument. A line-based grep cannot do this: the compliant
 * form closes the call on a different line (`}, 30_000);`), which is exactly
 * the shape a naive single-line sweep misclassifies as unprotected.
 *
 * The scan is a TypeScript AST walk (the compiler is already a
 * devDependency of this package), so strings, templates, comments, regex
 * literals, and arbitrary nesting are handled by a real parser — no
 * hand-rolled lexing heuristics to corrupt on adversarial syntax. A site is
 * compliant when the call expression carries a second argument node; a
 * trailing comma with nothing after it does not produce an argument node and
 * so does NOT count. Only bare `beforeAll(...)` identifier calls match —
 * member calls (`x.beforeAll(...)`), import specifiers, and mentions inside
 * strings or comments are not call sites.
 */
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
    // These files close their beforeAll with the multi-line `}, 30_000);` /
    // `}, 60_000);` forms — the exact shape a naive single-line sweep
    // misclassifies as unprotected. Each must scan as exactly one site,
    // protected, or the scanner has regressed on the compliant form.
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

  /**
   * Planted-positive + adjacent-negative self-tests. The main rule is an
   * absence-checker once the codemod lands, so without these a rotted
   * scanner would read as perpetual green.
   */
  test('scanner fires on a planted unprotected beforeAll and not on adjacent negatives', () => {
    // Planted positive: the canonical unprotected boot hook.
    const planted = ['beforeAll(async () => {', '  server = await createTestServer();', '});'].join(
      '\n',
    );
    const fired = scanBeforeAllSites(planted);
    expect(fired.length).toBe(1);
    expect(fired[0]?.line).toBe(1);
    expect(fired[0]?.hasTimeoutArg).toBe(false);

    // Adjacent negative: multi-line numeric closing form `}, 30_000);` —
    // the shape a naive single-line sweep misclassifies as unprotected.
    const numericClose = [
      'beforeAll(async () => {',
      '  server = await createTestServer();',
      '}, 30_000);',
    ].join('\n');
    expect(scanBeforeAllSites(numericClose)[0]?.hasTimeoutArg).toBe(true);

    // Adjacent negative: named-constant timeout arg (the codemod's target
    // shape) — acceptance is syntactic; the constant need not exist yet.
    const constantClose = [
      'beforeAll(async () => {',
      '  server = await createTestServer();',
      '}, HARNESS_BOOT_TIMEOUT_MS);',
    ].join('\n');
    expect(scanBeforeAllSites(constantClose)[0]?.hasTimeoutArg).toBe(true);

    // Adjacent negative: single-line compliant call.
    expect(scanBeforeAllSites('beforeAll(boot, 30000);')[0]?.hasTimeoutArg).toBe(true);

    // Planted positive: trailing comma with no second argument is still
    // unprotected.
    expect(scanBeforeAllSites('beforeAll(boot,);')[0]?.hasTimeoutArg).toBe(false);

    // Adjacent negative: import specifier is not a call site.
    expect(scanBeforeAllSites("import { beforeAll, test } from 'bun:test';").length).toBe(0);

    // Adjacent negative: mentions inside comments and strings are skipped.
    const inertMentions = [
      '// beforeAll(async () => {});',
      '/* beforeAll( */',
      "const s = 'beforeAll(';",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture deliberately embeds template-interpolation syntax for the scanner to skip
      'const t = `beforeAll(${x})`;',
    ].join('\n');
    expect(scanBeforeAllSites(inertMentions).length).toBe(0);

    // Adjacent negative: other hooks are out of scope.
    expect(scanBeforeAllSites('beforeEach(async () => {});').length).toBe(0);

    // Robustness: template interpolation and a regex literal inside the hook
    // body must not corrupt the second-argument detection.
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

    // Robustness: a regex literal in return position whose body contains an
    // unbalanced `)`. Paren-depth heuristics misread this as division and
    // silently lose the site (under-count = a vacuously green rule); a
    // structural scanner must keep both sites and their classifications.
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
