import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const OXLINT_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'oxlint');
const FIXTURE_DIR = 'lint-plugins/no-comments/__fixtures__';
const ALL_SCOPE_CONFIG = `${FIXTURE_DIR}/oxlint.fixture.json`;
const DECLARED_SCOPE_CONFIG = `${FIXTURE_DIR}/oxlint.declared-scope.fixture.json`;
const PLUGIN_REL = './lint-plugins/no-comments/plugin.mjs';
const RULE_ID = 'no-comments/no-comments';

type Diagnostic = { line: number; column: number; class: string; message: string };
type Run = { status: number | null; raw: string; diagnostics: Diagnostic[] };
type RunOxlint = (input: { bin: string; cwd: string; config: string; target: string }) => Run;

let runOxlintHelper: RunOxlint;

async function loadRunOxlint(): Promise<RunOxlint> {
  const moduleUrl = pathToFileURL(
    join(REPO_ROOT, 'lint-plugins/no-comments/run-oxlint.test-helper.mjs'),
  ).href;
  const loaded = (await import(/* @vite-ignore */ moduleUrl)) as { runOxlint: RunOxlint };
  return loaded.runOxlint;
}

function runOxlint(config: string, fixture: string): Run {
  return runOxlintHelper({
    bin: OXLINT_BIN,
    cwd: REPO_ROOT,
    config,
    target: `${FIXTURE_DIR}/${fixture}`,
  });
}

type Violation = { class: string; comment: { line: number; column: number } };
type NoCommentsModule = {
  analyzeSource: (input: { source: string; relPath: string; precedentNumbers: unknown }) => {
    violations: Violation[];
  };
  loadPrecedentNumbers: (repoRoot: string) => unknown;
};

async function predicateViolations(fixture: string): Promise<Violation[]> {
  const moduleUrl = pathToFileURL(join(REPO_ROOT, 'lint-plugins/no-comments/index.mjs')).href;
  const { analyzeSource, loadPrecedentNumbers } = (await import(
    /* @vite-ignore */ moduleUrl
  )) as NoCommentsModule;
  const relPath = `${FIXTURE_DIR}/${fixture}`;
  return analyzeSource({
    source: readFileSync(join(REPO_ROOT, relPath), 'utf-8'),
    relPath,
    precedentNumbers: loadPrecedentNumbers(REPO_ROOT),
  }).violations;
}

const PARITY_FIXTURES = [
  'must-fire.fixture.ts',
  'must-not-fire.fixture.ts',
  'jsx-text.fixture.tsx',
  'jsdoc-types.fixture.mjs',
];

const runs = new Map<string, Run>();

beforeAll(async () => {
  runOxlintHelper = await loadRunOxlint();
  for (const fixture of [
    ...PARITY_FIXTURES,
    'suppression-blind.fixture.ts',
    'line-terminators.fixture.ts',
  ]) {
    runs.set(fixture, runOxlint(ALL_SCOPE_CONFIG, fixture));
  }
  runs.set('declared-scope', runOxlint(DECLARED_SCOPE_CONFIG, 'must-fire.fixture.ts'));
});

function run(key: string): Run {
  const value = runs.get(key);
  if (!value) throw new Error(`no oxlint run recorded for ${key}`);
  return value;
}

describe('no-comments oxlint plugin', () => {
  test('fires once per non-allowlisted comment, naming the class, the fix and the docs anchor', () => {
    const { status, diagnostics, raw } = run('must-fire.fixture.ts');
    expect(status).toBe(1);
    expect(diagnostics).toHaveLength(21);

    const classes = diagnostics.map((d) => d.class);
    expect(classes).toStrictEqual([
      'prose',
      'prose',
      'prose',
      'prose',
      'banned-directive',
      'prose',
      'unreasoned-directive',
      'invalid-upstream-referent',
      'rot-in-survivor',
      'unreasoned-directive',
      'prose',
      'prose',
      'prose',
      'prose',
      'prose',
      'prose',
      'prose',
      'prose',
      'prose',
      'prose',
      'prose',
    ]);

    expect(diagnostics.map((d) => d.line)).toStrictEqual([
      1, 4, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 47, 53, 56, 59, 63, 66, 69, 72,
    ]);

    expect(raw).toContain(
      'Delete it. Put the reasoning in the commit message, the PR body, AGENTS.md, or the spec.',
    );
    expect(raw).toContain('Use `@ts-expect-error <reason>`');
    expect(raw).toContain('Use a resolvable referent');
    for (const diagnostic of diagnostics) {
      expect(diagnostic.message).toMatch(
        /See https:\/\/github\.com\/inkeep\/open-knowledge\/blob\/main\/lint-plugins\/no-comments\/README\.md#[a-z-]+$/,
      );
    }
  });

  test('stays silent on every allowlist class', () => {
    const { status, diagnostics } = run('must-not-fire.fixture.ts');
    expect(diagnostics).toStrictEqual([]);
    expect(status).toBe(0);
  });

  test('renders positions from the linter line map: U+2028 inside a string does not shift the squiggle', () => {
    const { diagnostics } = run('line-terminators.fixture.ts');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.line).toBe(3);
    expect(diagnostics[0]?.column).toBe(1);
  });

  test('reads JSX text as text and a JSX expression comment as a comment', () => {
    const { diagnostics } = run('jsx-text.fixture.tsx');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.line).toBe(5);
  });

  test('a rule disable silences this lane, which is why the backstop sweep exists', () => {
    const { status, diagnostics } = run('suppression-blind.fixture.ts');
    expect(diagnostics).toStrictEqual([]);
    expect(status).toBe(0);
  });

  test('leaves the fixture corpus alone under the declared scope, so a whole-tree lint stays quiet', () => {
    const { status, diagnostics } = run('declared-scope');
    expect(diagnostics).toStrictEqual([]);
    expect(status).toBe(0);
  });

  test('agrees with the shared predicate on every fixture, class for class and line for line', async () => {
    let compared = 0;
    for (const fixture of PARITY_FIXTURES) {
      const { diagnostics } = run(fixture);
      const violations = await predicateViolations(fixture);
      expect(diagnostics.map((d) => `${d.line}:${d.column}:${d.class}`)).toStrictEqual(
        violations.map((v) => `${v.comment.line}:${v.comment.column}:${v.class}`),
      );
      compared += violations.length;
    }
    expect(compared).toBe(22);

    const admitted = run('jsdoc-types.fixture.mjs');
    expect(admitted.raw).toContain('"number_of_files": 1');
    expect(admitted.diagnostics).toStrictEqual([]);
  });

  test('is registered in the repo oxlint config as a JS plugin with a staged severity', async () => {
    const config = (await import('../../../../oxlint.config')).default as {
      jsPlugins?: string[];
      rules?: Record<string, unknown>;
    };
    expect(config.jsPlugins).toContain(PLUGIN_REL);
    expect(Object.keys(config.rules ?? {})).toContain(RULE_ID);
    expect(['off', 'error']).toContain(config.rules?.[RULE_ID]);
  });

  test('loads from the path the shipped config names, not just the one the fixtures name', () => {
    const result = spawnSync(
      OXLINT_BIN,
      ['--max-warnings', '0', 'lint-plugins/no-comments/index.mjs'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
      },
    );
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.error) throw new Error(`oxlint did not run: ${result.error.message}\n${output}`);
    expect(output).not.toContain('Failed to load JS plugin');
    expect(output).not.toContain('Failed to load config');
    expect(output).not.toContain('Failed to parse');
    expect(result.status).toBe(0);
  });

  test('resolves a real repo path into declared scope, so the rule cannot go silently inert', async () => {
    const { relativePathFor } = await import('../../../../lint-plugins/no-comments/plugin.mjs');
    const { isInScope } = await import('../../../../lint-plugins/no-comments/scope.mjs');

    const absolute = join(REPO_ROOT, 'packages', 'core', 'src', 'index.ts');
    const relPath = relativePathFor({ physicalFilename: absolute });

    expect(relPath).toBe('packages/core/src/index.ts');
    expect(isInScope(relPath)).toBe(true);
    expect(relativePathFor({ filename: absolute })).toBe(relPath);
  });
});
