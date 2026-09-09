import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  loadScopeConfig,
  SCOPE_CONFIG_FILENAME,
  ScopeConfigError,
  ScopeConfigMissingError,
  unitsRequiringFiles,
} from './config.mjs';
import {
  diagnoseScope,
  discoverInScopeFiles,
  discoverInScopeFilesWithSkips,
  globToRegExp,
  isExcluded,
  isInScope,
  SUBJECT_ROOT as REPO_ROOT,
  scopeForRoot,
  subjectScope,
  unitFor,
} from './scope.mjs';
import {
  configWith,
  createScratchRoot,
  removeScratchRoots,
} from './scratch-root.test-helper.mjs';

const CONFIG = subjectScope().config;

const privateTestPath = (dir, stem) => `${dir}/${stem}.private.test.ts`;

describe('glob compilation', () => {
  const cases = [
    ['packages/**/src/**/*.ts', 'packages/app/src/lib/a.ts', true],
    ['packages/**/src/**/*.ts', 'packages/core/src/a.ts', true],
    ['packages/**/src/**/*.ts', 'packages/app/tests/a.ts', false],
    ['**/*.d.ts', 'docs/next-env.d.ts', true],
    ['**/*.d.ts', 'a.d.ts', true],
    ['**/*.d.mts', 'docs/next-env.d.mts', true],
    ['**/*.d.cts', 'docs/lib/types.d.cts', true],
    ['**/*.d.mts', 'docs/vitest.real-source.config.mts', false],
    ['*.ts', 'oxlint.config.ts', true],
    ['*.ts', 'docs/tailwind.config.ts', false],
    ['*.ts', 'vitest.scripts.config.mts', false],
    ['docs/**/*.mts', 'docs/vitest.real-source.config.mts', true],
    ['**/*.private.*', privateTestPath('packages/core/src', 'a'), true],
  ];

  test.each(cases)('%s vs %s is %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
});

describe('scope membership', () => {
  const inScope = [
    'packages/app/src/components/Foo.tsx',
    'packages/core/src/index.ts',
    'packages/desktop/tests/integration/a.ts',
    'scripts/comment-fidelity.mjs',
    '.github/scripts/bridge-public-pr-to-monorepo.mjs',
    'docs/tailwind.config.ts',
    'docs/vitest.real-source.config.mts',
    'docs/lib/a.cts',
    'oxlint.config.ts',
    'vitest.scripts.config.mts',
    'packages/desktop/scripts/afterPack.mjs',
    'packages/app/src/build/app-version.ts',
    'packages/app/src/build/rejection-loop-guard-script.js',
    'packages/desktop/tests/unit/packaged-report-path.test.mjs',
    'packages/app/tests/perf/fixtures/cache-regime-rotation/vault.ts',
    'packages/core/src/markdown/fixtures/index.ts',
    'test-support/vitest.base.ts',
    'test-support/strip-comments.test-helper.mjs',
    'plugins/ok/skills/bug-triage/scripts/linear-issue.mjs',
    'packages/app/src/lib/a.mjs',
    'packages/app/tests/fidelity/invariant-i17.test.ts',
    'packages/desktop/tests/lume-qa/scenarios/ok-e2e-claude.ts',
    'packages/desktop/tests/lume-qa/lume-qa-happy-path.e2e.ts',
    'scripts/lume-bake/bake.sh',
    'packages/app/scripts/perf-prod.sh',
    'packages/desktop/build/deb-postinst.sh',
    'plugins/ok/skills/linux-vm/scripts/linuxvm.sh',
    '.husky/pre-commit',
    '.husky/pre-push',
  ];
  const outOfScope = [
    'knip.config.ts',
    'packages/md-conformance/md-audit/src/lib/tags.ts',
    privateTestPath('packages/core/src/markdown', 'a'),
    'packages/app/src/locales/en/messages.ts',
    'docs/next-env.d.ts',
    'docs/next-env.d.mts',
    'docs/lib/types.d.cts',
    'types.d.mts',
    'lint-plugins/no-comments/__fixtures__/must-fire.fixture.ts',
    'packages/app/node_modules/x/src/a.ts',
    'tech-probes/r1-preflight-gate/probe.mjs',
    'packages/native-config/index.js',
    'packages/md-conformance/md-audit/src/lib/registry.mjs',
    '.claude/hooks/no-comments-guard.sh',
    'reports/comment-policy-adoption/scripts/measure.sh',
    'specs/2026-09-02-no-comments-substrate-hardening/probe.sh',
    'sandbox-recipes/claude-code/setup.sh',
    'packages/md-conformance/scripts/tournament-orchestrate.sh',
  ];

  test.each(inScope)('%s is in scope', (path) => expect(isInScope(path)).toBe(true));
  test.each(outOfScope)('%s is out of scope', (path) => expect(isInScope(path)).toBe(false));

  test('a windows-style path is normalised before matching', () => {
    expect(isInScope('packages\\app\\src\\a.ts')).toBe(true);
  });

  test('the fixture corpus is excluded so the gate cannot self-trip', () => {
    expect(CONFIG.exclude).toContain('**/__fixtures__/**');
    expect(CONFIG.exclude).toContain('**/*.fixture.ts');
  });

  test('an authored fixtures/ directory is ordinary source, not a carve-out', () => {
    expect(CONFIG.exclude).not.toContain('**/fixtures/**');
    expect(isInScope('packages/app/tests/perf/fixtures/generate-view-count-fixtures.ts')).toBe(
      true,
    );
  });
});

describe('the non-vacuity floor excuses a unit this tree does not carry', () => {
  const unitsFor = (roots) =>
    unitsRequiringFiles(
      loadScopeConfig(
        createScratchRoot({
          prefix: 'no-comments-floor-',
          config: configWith({
            units: [
              { id: 'app', family: 'typescript', roots: ['packages/*/src'] },
              { id: 'absent', family: 'typescript', roots },
            ],
          }),
          files: { 'packages/a/src/a.ts': 'export const a = 1;\n' },
        }),
      ),
    );

  test('a unit whose every declared root is absent is excused', () => {
    expect(unitsFor(['plugins'])).toEqual(['app']);
  });

  test('a unit whose root exists but holds no in-scope file is still required', () => {
    expect(unitsFor(['packages/*/src'])).toEqual(['app', 'absent']);
  });

  test('a unit carrying one present root and one absent root is still required', () => {
    expect(unitsFor(['plugins', 'packages/*/src'])).toEqual(['app', 'absent']);
  });

  test('a config that never stat-ed the tree is refused rather than read as all-present', () => {
    expect(() => unitsRequiringFiles({ units: CONFIG.units, declaredPaths: [] })).toThrow(
      /declaredAbsent/,
    );
  });
});

describe('discovery over the real tree', () => {
  const discovered = discoverInScopeFiles(REPO_ROOT, { readdirSync, statSync, lstatSync });

  test('discovery finds a substantial corpus', () => {
    expect(discovered.length).toBeGreaterThan(1000);
  });

  const required = unitsRequiringFiles(CONFIG);

  test('the non-vacuity floor itself covers units', () => {
    expect(required.length).toBeGreaterThan(0);
  });

  test.each(required)('unit %s is non-vacuous', (id) => {
    expect(discovered.filter((path) => unitFor(path) === id).length).toBeGreaterThan(0);
  });

  test('every discovered file belongs to exactly one declared unit', () => {
    expect(discovered.filter((path) => unitFor(path) === null)).toEqual([]);
  });

  test('every file discovery finds is a file git tracks', () => {
    const tracked = new Set(
      execFileSync('git', ['ls-files', '-z'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 1 << 28,
      })
        .split('\0')
        .filter(Boolean),
    );
    expect(
      discovered.filter((path) => !tracked.has(path)),
      'track it if it is source, move it outside the declared roots if it is scratch, or add it ' +
        'to exclude if it is generated output',
    ).toEqual([]);
  });

  test('no excluded tree leaks into discovery', () => {
    const leaks = discovered.filter(
      (path) =>
        path.includes('node_modules/') ||
        path.includes('/dist/') ||
        path.includes('.private.') ||
        path.includes('md-conformance/') ||
        /\.d\.[mc]?ts$/.test(path),
    );
    expect(leaks).toEqual([]);
  });
});

describe('the scope definition is derived, not restated', () => {
  test('include is the flatten of the per-unit globs the matcher itself compiles', () => {
    expect(CONFIG.include).toEqual(CONFIG.units.flatMap((unit) => unit.include));
  });

  test('isInScope admits exactly the paths some unit claims', () => {
    const probes = CONFIG.include
      .map((glob) => glob.replace(/\*\*\//g, 'x/').replace(/\*/g, 'a'))
      .concat(['README.md', 'packages/md-conformance/anything.ts', 'packages/app/src/a.md']);
    expect(probes.filter((path) => isInScope(path) !== (unitFor(path) !== null))).toEqual([]);
  });

  test('the config the predicate reads is the one committed at the repository root', () => {
    expect(loadScopeConfig(REPO_ROOT).include).toEqual(CONFIG.include);
  });

  test('isExcluded reports the exclusion independently of the include set', () => {
    expect(isExcluded('packages/md-conformance/anything.ts')).toBe(true);
    expect(isExcluded('README.md')).toBe(false);
    expect(isInScope('README.md')).toBe(false);
  });
});

describe('a directory-name-shaped exclude prunes that directory during the walk', () => {
  const roots = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const syntheticRoot = (excludeGlob) => {
    const root = mkdtempSync(join(tmpdir(), 'no-comments-prune-'));
    roots.push(root);
    for (const rel of [
      'packages/pkg/src/real.ts',
      'packages/pkg/src/vendored/deep/one.ts',
      'packages/pkg/src/vendored/deep/two.ts',
    ]) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), 'export const a = 1;\n');
    }
    writeFileSync(
      join(root, 'no-comments.config.jsonc'),
      JSON.stringify({
        version: 1,
        families: { ts: { extensions: ['.ts'], extractor: 'c-family' } },
        units: [{ id: 'src', family: 'ts', roots: ['packages/**/src'] }],
        exclude: [excludeGlob],
      }),
    );
    return root;
  };

  const discoverCountingReads = (root) => {
    const read = [];
    const files = discoverInScopeFiles(root, {
      readdirSync: (dir) => {
        read.push(basename(dir));
        return readdirSync(dir);
      },
      statSync,
      lstatSync,
    });
    return { files, read };
  };

  test('the same membership is reachable with and without the prune, so the rule is observable', () => {
    const pruned = discoverCountingReads(syntheticRoot('**/vendored/**'));
    const walked = discoverCountingReads(syntheticRoot('packages/pkg/src/vendored/**'));
    expect(pruned.files).toEqual(['packages/pkg/src/real.ts']);
    expect(walked.files).toEqual(pruned.files);
    expect(pruned.read).not.toContain('vendored');
    expect(walked.read).toContain('vendored');
    expect(walked.read).toContain('deep');
  });

  test('no directory a real-tree exclude names is ever read, and the walk did meet some', () => {
    const read = [];
    const met = [];
    discoverInScopeFiles(REPO_ROOT, {
      readdirSync: (dir) => {
        read.push(basename(dir));
        const entries = readdirSync(dir);
        for (const entry of entries) {
          if (CONFIG.pruneDirectories.includes(entry)) met.push(entry);
        }
        return entries;
      },
      statSync,
      lstatSync,
    });
    expect(read.filter((name) => CONFIG.pruneDirectories.includes(name))).toEqual([]);
    expect(met).toContain('node_modules');
    expect(met.length).toBeGreaterThan(1);
  });
});

describe('a unit can name files no extension would reach', () => {
  const roots = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const rootWithHooks = () => {
    const root = mkdtempSync(join(tmpdir(), 'no-comments-files-'));
    roots.push(root);
    writeFileSync(
      join(root, 'no-comments.config.jsonc'),
      JSON.stringify({
        version: 1,
        families: { shell: { extensions: ['.sh'], extractor: 'hash-family' } },
        units: [
          {
            id: 'shell',
            family: 'shell',
            roots: ['scripts'],
            files: ['.husky/pre-commit', '.husky/never-written'],
          },
        ],
        exclude: [],
      }),
    );
    for (const rel of ['scripts/build.sh', '.husky/pre-commit']) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), '#!/usr/bin/env bash\n');
    }
    return root;
  };

  test('an extensionless member is discovered and attributed to the unit that names it', () => {
    const root = rootWithHooks();
    expect(discoverInScopeFiles(root, { readdirSync, statSync, lstatSync })).toStrictEqual([
      '.husky/pre-commit',
      'scripts/build.sh',
    ]);
    const scope = scopeForRoot(root);
    expect(scope.isInScope('.husky/pre-commit')).toBe(true);
    expect(scope.unitFor('.husky/pre-commit')).toBe('shell');
  });

  test('a named file the tree lacks is recorded as declared-absent, never as an error', () => {
    const root = rootWithHooks();
    const { declaredAbsent } = discoverInScopeFilesWithSkips(root, {
      readdirSync,
      statSync,
      lstatSync,
    });
    expect(declaredAbsent).toStrictEqual([
      { unit: 'shell', kind: 'file', path: '.husky/never-written' },
    ]);
  });
});

describe('a hash family may not declare a dialect no reference measures', () => {
  afterAll(removeScratchRoots);

  const rootDeclaring = (extensions) =>
    createScratchRoot({
      prefix: 'no-comments-unmeasured-dialect-',
      config: configWith({
        families: { probe: { extensions, extractor: 'hash-family' } },
        units: [{ id: 'probe', family: 'probe', roots: ['scripts'] }],
      }),
    });

  test('a .py family is refused at load, naming the dialect and what it lacks', () => {
    let thrown;
    try {
      scopeForRoot(rootDeclaring(['.py']));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ScopeConfigError);
    expect(thrown.key).toBe('families.probe.extensions');
    expect(thrown.message).toContain('python');
    expect(thrown.message).toContain('comment-position reference');
  });

  test('the refusal is the missing reference, not the hash family: a .sh family loads', () => {
    expect(scopeForRoot(rootDeclaring(['.sh'])).isInScope('scripts/build.sh')).toBe(true);
  });

  test('it names a move the adopter can make, not only one a contributor to this file can', () => {
    let thrown;
    try {
      scopeForRoot(rootDeclaring(['.sh', '.py']));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ScopeConfigError);
    expect(thrown.message).toContain('Drop .py from this family');
    expect(thrown.message).not.toContain('.sh from this family');
    expect(thrown.message).toContain('lint-plugins/no-comments/extract-hash.mjs');
    expect(thrown.message).toContain('DIALECTS');
  });
});

describe('a ./ prefix is a spelling, never a membership decision', () => {
  afterAll(removeScratchRoots);

  const TREE = {
    'packages/pkg/src/a.ts': 'export const a = 1;\n',
    'packages/pkg/src/vendored/deep/b.ts': 'export const b = 2;\n',
    'tools/present.ts': 'export const present = true;\n',
  };

  const rootDeclaring = ({ roots = ['packages/**/src'], files, exclude = [] }) =>
    createScratchRoot({
      prefix: 'no-comments-spelling-',
      config: {
        version: 1,
        families: { ts: { extensions: ['.ts'], extractor: 'c-family' } },
        units: [{ id: 'src', family: 'ts', roots, ...(files === undefined ? {} : { files }) }],
        exclude,
      },
      files: TREE,
    });

  const discover = (root) =>
    discoverInScopeFilesWithSkips(root, { readdirSync, statSync, lstatSync });

  const cells = [
    ['canonical spelling of a file the tree has', 'tools/present.ts', true],
    ['./ spelling of a file the tree has', './tools/present.ts', true],
    ['canonical spelling of a file the tree lacks', 'tools/missing.ts', false],
    ['./ spelling of a file the tree lacks', './tools/missing.ts', false],
  ];

  test.each(cells)('%s', (_label, entry, exists) => {
    const root = rootDeclaring({ files: [entry] });
    const { files, declaredAbsent } = discover(root);
    const canonical = entry.replace(/^\.\//, '');
    expect(scopeForRoot(root).unitFor(canonical)).toBe('src');
    expect(files.includes(canonical)).toBe(exists);
    expect(declaredAbsent).toStrictEqual(
      exists ? [] : [{ unit: 'src', kind: 'file', path: canonical }],
    );
  });

  test('a ./-prefixed exclude excludes exactly what its canonical spelling excludes', () => {
    const canonical = discover(rootDeclaring({ exclude: ['**/vendored/**'] }));
    const dotted = discover(rootDeclaring({ exclude: ['./**/vendored/**'] }));
    expect(canonical.files).toStrictEqual(['packages/pkg/src/a.ts']);
    expect(dotted.files).toStrictEqual(canonical.files);
  });

  test('a trailing-slash root discovers exactly what the bare root discovers', () => {
    const bare = discover(rootDeclaring({ roots: ['packages'] }));
    const slashed = discover(rootDeclaring({ roots: ['packages/'] }));
    expect(bare.files.length).toBeGreaterThan(0);
    expect(slashed.files).toStrictEqual(bare.files);
    expect(slashed.declaredAbsent).toStrictEqual(bare.declaredAbsent);
  });

  test('a root that leaves the tree is refused by name rather than walked', () => {
    const root = rootDeclaring({ roots: ['../outside'] });
    const diagnosis = diagnoseScope(root);
    expect(diagnosis.status).toBe('invalid');
    expect(diagnosis.key).toBe('units[0].roots[0]');
    expect(diagnosis.message).toContain('scope-config: UNREADABLE');
  });
});

describe('every directory-name-shaped exclude is pinned to what it hides', () => {
  const SHAPED = [
    '**/node_modules/**',
    '**/dist/**',
    '**/.next/**',
    '**/.turbo/**',
    '**/.git/**',
    '**/coverage/**',
    '**/__fixtures__/**',
  ];

  const tracked = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\0')
    .filter(Boolean);

  const includeRes = CONFIG.include.map(globToRegExp);
  const hiddenBy = (glob) => {
    const own = globToRegExp(glob);
    const others = CONFIG.exclude.filter((other) => other !== glob).map(globToRegExp);
    return tracked.filter(
      (path) =>
        includeRes.some((re) => re.test(path)) &&
        own.test(path) &&
        !others.some((re) => re.test(path)),
    );
  };

  test('the pinned list is exactly the directory-name-shaped excludes the config declares', () => {
    const shaped = CONFIG.exclude.filter((glob) => /^\*\*\/[^/*]+\/\*\*$/.test(glob));
    expect(shaped.slice().sort()).toEqual(SHAPED.slice().sort());
  });

  test.each(SHAPED)('%s hides no tracked in-scope file', (glob) => {
    expect(hiddenBy(glob)).toEqual([]);
  });

  test('no build-named glob hides tracked source under packages/app/src/build/', () => {
    expect(CONFIG.exclude).not.toContain('**/build/**');
    expect(CONFIG.exclude).not.toContain('packages/app/src/build/**');
    expect(isInScope('packages/app/src/build/rejection-loop-guard-plugin.ts')).toBe(true);
  });
});

test('globToRegExp refuses syntax it does not implement instead of mis-compiling it', () => {
  for (const glob of [
    'packages/**/{src,tests}/**/*.ts',
    'packages/**/*.?s',
    '!packages/foo/**',
    'src/[abc]/*.ts',
  ]) {
    expect(() => globToRegExp(glob), glob).toThrow(/unsupported glob syntax/);
  }
});

describe('a long-lived host reads the config as it is now, not as it was at first compile', () => {
  afterAll(removeScratchRoots);

  const PINNED_EPOCH_SECONDS = 1_700_000_000;

  const configScoping = (unitRoot) =>
    configWith({ units: [{ id: 'app', family: 'typescript', roots: [unitRoot] }] });

  let pinsIssued = 0;
  const pinDistinctMtime = (configPath) => {
    pinsIssued += 1;
    const seconds = PINNED_EPOCH_SECONDS + pinsIssued;
    utimesSync(configPath, seconds, seconds);
    return configPath;
  };

  const rootScoping = (unitRoot) => {
    const root = createScratchRoot({
      prefix: 'no-comments-config-mtime-',
      config: configScoping(unitRoot),
    });
    pinDistinctMtime(join(root, SCOPE_CONFIG_FILENAME));
    return root;
  };

  const writeConfig = (configPath, unitRoot) => {
    writeFileSync(configPath, `${JSON.stringify(configScoping(unitRoot), null, 2)}\n`);
    return configPath;
  };

  const rewrite = (root, unitRoot) =>
    pinDistinctMtime(writeConfig(join(root, SCOPE_CONFIG_FILENAME), unitRoot));

  test('an edit between two calls in one process moves the scope boundary with it', () => {
    const root = rootScoping('packages/*/src');
    expect(scopeForRoot(root).isInScope('packages/app/src/a.ts')).toBe(true);
    expect(scopeForRoot(root).isInScope('tools/a.ts')).toBe(false);

    rewrite(root, 'tools');

    expect(scopeForRoot(root).isInScope('tools/a.ts')).toBe(true);
    expect(scopeForRoot(root).isInScope('packages/app/src/a.ts')).toBe(false);
  });

  test('an unedited config keeps serving the compile it already paid for', () => {
    const root = rootScoping('packages/*/src');
    expect(scopeForRoot(root)).toBe(scopeForRoot(root));
  });

  test('a config deleted after it was compiled raises rather than serving the stale compile', () => {
    const root = rootScoping('packages/*/src');
    expect(scopeForRoot(root).isInScope('packages/app/src/a.ts')).toBe(true);

    rmSync(join(root, SCOPE_CONFIG_FILENAME));

    expect(() => scopeForRoot(root)).toThrow(ScopeConfigMissingError);
  });

  test('an edit that leaves the config mtime unchanged still moves the scope boundary', () => {
    const root = rootScoping('packages/*/src');
    const configPath = join(root, SCOPE_CONFIG_FILENAME);
    const mtimeAtFirstCompile = statSync(configPath).mtimeMs;

    expect(scopeForRoot(root).isInScope('packages/app/src/a.ts')).toBe(true);
    expect(scopeForRoot(root).isInScope('tools/a.ts')).toBe(false);

    writeConfig(configPath, 'tools');
    utimesSync(configPath, mtimeAtFirstCompile / 1000, mtimeAtFirstCompile / 1000);
    expect(statSync(configPath).mtimeMs).toBe(mtimeAtFirstCompile);
    expect(readFileSync(configPath, 'utf8')).toContain('"tools"');

    expect(scopeForRoot(root).isInScope('tools/a.ts')).toBe(true);
    expect(scopeForRoot(root).isInScope('packages/app/src/a.ts')).toBe(false);
  });
});
