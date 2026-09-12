import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_ABSENT,
  checkConditions,
  checkDeclarationEmit,
  checkMember,
  checkRoot,
  checkSourceCondition,
  checkTsconfigConditions,
  collectViolations,
  declarationBuildConfigs,
  declarationEmitConfigs,
  declarationEmitEntries,
  dtsBindings,
  evaluate,
  GATE_LINE,
  memberDirs,
  NESTED_BUILD_OUTPUTS,
  outputDirRules,
  probeMember,
  publishesDeclarations,
  SHIM_LINE,
  SOURCE_CONDITION,
  sourceConditionSites,
  staleNonTscListing,
  tsconfigConditions,
  tsconfigFiles,
  unbundleCensus,
  versionLine,
} from './check-typescript-resolution.mjs';
import { stripJsonc } from './read-jsonc.mjs';

const OK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realConfig = (pkg) =>
  fs.readFileSync(path.join(OK_ROOT, 'packages', pkg, 'tsdown.config.ts'), 'utf8');
const withoutLinesMatching = (text, pattern) =>
  text
    .split('\n')
    .filter((line) => !pattern.test(line))
    .join('\n');

const writeTree = (prefix, files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [relative, body] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`);
  }
  return dir;
};

const withTree = (files, assertions) => {
  const dir = writeTree('ts-resolution-walk-', files);
  try {
    assertions(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const healthyRoot = { binVersion: '7.0.2', shimVersion: '6.0.3', tsserverBytes: 272 };

const gatedMember = (over = {}) => ({
  name: '@inkeep/open-knowledge-core',
  dir: '/ok/packages/core',
  declaredRange: '^7.0.2',
  resolvedVersion: '7.0.2',
  binVersion: '7.0.2',
  scripts: { typecheck: 'tsc --noEmit' },
  ...over,
});

describe('versionLine', () => {
  it('reduces a full version to its minor line', () => {
    expect(versionLine('7.0.2')).toBe('7.0');
    expect(versionLine('6.0.3')).toBe('6.0');
    expect(versionLine('7.1.0-beta.1')).toBe('7.1');
  });

  it('reports no line for a version it cannot read', () => {
    expect(versionLine(null)).toBeNull();
    expect(versionLine('')).toBeNull();
    expect(versionLine('Version 7')).toBeNull();
  });
});

describe('checkRoot', () => {
  it('accepts the gate compiler on the bin over a language-server shim', () => {
    expect(checkRoot(healthyRoot)).toEqual([]);
  });

  it('rejects a root bin that fell back to the shim compiler', () => {
    const [violation] = checkRoot({ ...healthyRoot, binVersion: '6.0.3' });
    expect(violation).toContain('root `tsc` bin reports 6.0.3');
    expect(violation).toContain(`${GATE_LINE}.x`);
  });

  it('rejects a root bin that is absent entirely', () => {
    expect(checkRoot({ ...healthyRoot, binVersion: null })[0]).toContain('reports nothing');
  });

  it('rejects a root shim bumped onto the gate line, which ships no tsserver', () => {
    const [violation] = checkRoot({ ...healthyRoot, shimVersion: '7.0.2' });
    expect(violation).toContain('root `typescript` package is 7.0.2');
    expect(violation).toContain(`${SHIM_LINE}.x`);
  });

  it('rejects a shim whose tsserver entry point is missing or empty', () => {
    expect(checkRoot({ ...healthyRoot, tsserverBytes: 0 })[0]).toContain(
      'tsserver.js is missing or empty',
    );
  });

  it('reports the wrong-line shim once rather than also reporting its tsserver', () => {
    expect(checkRoot({ ...healthyRoot, shimVersion: '7.0.2', tsserverBytes: 0 })).toHaveLength(1);
  });
});

describe('checkMember', () => {
  it('accepts a package that declares and resolves the gate compiler', () => {
    expect(checkMember(gatedMember())).toEqual([]);
  });

  it('names the package whose resolution silently sits on the shim line', () => {
    const [violation] = checkMember(gatedMember({ resolvedVersion: '6.0.3' }));
    expect(violation).toContain('@inkeep/open-knowledge-core');
    expect(violation).toContain('resolves 6.0.3');
  });

  it('catches a declared range that resolved to nothing at all', () => {
    expect(checkMember(gatedMember({ resolvedVersion: null }))[0]).toContain('resolves nothing');
  });

  it('catches a package whose bin disagrees with its resolved package', () => {
    const [violation] = checkMember(gatedMember({ binVersion: '6.0.3' }));
    expect(violation).toContain('runs a `tsc` reporting 6.0.3');
  });

  it('accepts a package that neither declares typescript nor runs tsc', () => {
    expect(
      checkMember({
        name: '@inkeep/open-knowledge-native-config',
        dir: '/ok/packages/native-config',
        declaredRange: null,
        resolvedVersion: null,
        binVersion: null,
        scripts: { build: 'node scripts/build.mjs --release' },
      }),
    ).toEqual([]);
  });

  it('catches a package that runs tsc without declaring the compiler it runs', () => {
    const [violation] = checkMember({
      name: '@inkeep/open-knowledge-plugin',
      dir: '/ok/packages/plugin',
      declaredRange: null,
      resolvedVersion: null,
      binVersion: null,
      scripts: { typecheck: 'tsc --noEmit' },
    });
    expect(violation).toContain('@inkeep/open-knowledge-plugin');
    expect(violation).toContain('without declaring typescript');
  });

  it('reads a path-qualified tsc, which resolves the same undeclared binary', () => {
    const violations = checkMember({
      name: '@inkeep/example',
      dir: '/ok/packages/example',
      declaredRange: null,
      resolvedVersion: null,
      binVersion: null,
      scripts: { typecheck: 'node_modules/.bin/tsc --noEmit' },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('without declaring typescript');
  });

  it('reads tsgo, the other name the Go compiler ships its binary under', () => {
    const violations = checkMember({
      name: '@inkeep/example',
      dir: '/ok/packages/example',
      declaredRange: null,
      resolvedVersion: null,
      binVersion: null,
      scripts: { typecheck: 'tsgo --noEmit' },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('without declaring typescript');
  });

  it('does not match a lookalike that merely starts with the compiler name', () => {
    expect(
      checkMember({
        name: '@inkeep/example',
        dir: '/ok/packages/example',
        declaredRange: null,
        resolvedVersion: null,
        binVersion: null,
        scripts: { lint: 'tsgo-files --noEmit' },
      }),
    ).toEqual([]);
  });

  it('reads tsc out of a compound script without matching a lookalike command', () => {
    const scripts = {
      typecheck: 'pnpm run typecheck:bash && tsc',
      build: 'tsdown && node scripts/postbuild.mjs',
      lint: 'tsc-files --noEmit',
    };
    const violations = checkMember({
      name: '@inkeep/example',
      dir: '/ok/packages/example',
      declaredRange: null,
      resolvedVersion: null,
      binVersion: null,
      scripts,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('`typecheck` script');
  });
});

const healthyConditions = {
  baseConditions: [SOURCE_CONDITION],
  declarationBuild: {
    configs: [
      ['packages/core/tsconfig.build.json', []],
      ['packages/server/tsconfig.build.json', []],
      ['packages/cli/tsconfig.build.json', []],
    ],
    missing: [],
  },
};

describe('checkConditions', () => {
  it('accepts the split the declaration architecture rests on', () => {
    expect(checkConditions(healthyConditions)).toEqual([]);
  });

  it('reports a base that lost the source condition, which makes every leaf typecheck build-first', () => {
    const [violation] = checkConditions({ ...healthyConditions, baseConditions: [] });
    expect(violation).toContain('the base tsconfig');
    expect(violation).toContain(SOURCE_CONDITION);
  });

  it('reports a declaration build config that inherits the source condition instead of resetting it', () => {
    const violations = checkConditions({
      ...healthyConditions,
      declarationBuild: {
        configs: [
          ['packages/core/tsconfig.build.json', undefined],
          ['packages/server/tsconfig.build.json', [SOURCE_CONDITION]],
          ['packages/cli/tsconfig.build.json', []],
        ],
        missing: [],
      },
    });
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain('packages/core/tsconfig.build.json');
    expect(violations[1]).toContain('packages/server/tsconfig.build.json');
  });
});

describe('probeMember', () => {
  it('reports a blind reason for a manifest it cannot read, rather than dropping the package', () => {
    const result = probeMember('/ok/packages/broken', () => null);
    expect(result.blind).toContain('/ok/packages/broken');
    expect(result.name).toBeUndefined();
  });

  it('reports a blind reason for a manifest that parses but declares no name', () => {
    expect(probeMember('/ok/packages/nameless', () => ({ type: 'module' })).blind).toBeTruthy();
  });
});

describe('collectViolations', () => {
  const boundEmit = [
    [
      'packages/core/tsdown.config.ts',
      "export default defineConfig({ dts: { tsconfig: 'tsconfig.build.json' } });",
    ],
  ];
  const sourceSites = [
    { name: '@inkeep/open-knowledge-core', private: true, total: 1, missing: [], present: ['.'] },
  ];

  it('reports nothing for a healthy workspace', () => {
    expect(collectViolations(healthyRoot, [gatedMember()], null, boundEmit, sourceSites)).toEqual(
      [],
    );
  });

  it('reports the root and every offending member together', () => {
    const violations = collectViolations(
      { ...healthyRoot, binVersion: '6.0.3' },
      [
        gatedMember(),
        gatedMember({ name: '@inkeep/open-knowledge-server', resolvedVersion: '6.0.3' }),
      ],
      null,
      boundEmit,
      sourceSites,
    );
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain('root `tsc` bin');
    expect(violations[1]).toContain('@inkeep/open-knowledge-server');
  });

  it('refuses when the source-condition corpus it was handed is empty', () => {
    const violations = collectViolations(healthyRoot, [gatedMember()], null, boundEmit, []);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('Refusing to report a pass');
  });
});

describe('memberDirs', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const collect = (yaml) => {
    const unparsed = [];
    const empty = [];
    const dirs = memberDirs(
      root,
      yaml,
      (line) => unparsed.push(line),
      (pattern) => empty.push(pattern),
    );
    return { dirs, unparsed, empty };
  };

  it('enumerates the real workspace, nested member and docs included', () => {
    const { dirs, unparsed, empty } = collect(
      fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
    );
    expect(unparsed).toEqual([]);
    expect(empty).toEqual([]);
    const names = dirs.map((dir) => path.relative(root, dir));
    expect(names).toContain('docs');
    expect(names).toContain(path.join('packages', 'md-conformance', 'md-audit'));
    expect(names).toContain(path.join('packages', 'core'));
    expect(dirs.length).toBeGreaterThanOrEqual(8);
  });

  it('keeps enumerating past a comment interleaved in the packages list', () => {
    const withComment = collect(
      "packages:\n  - 'docs'\n  # a nested package needs its own entry\n\n  - 'packages/md-conformance/md-audit'\n",
    );
    const withoutComment = collect(
      "packages:\n  - 'docs'\n  - 'packages/md-conformance/md-audit'\n",
    );
    expect(withComment.dirs).toEqual(withoutComment.dirs);
    expect(withComment.dirs).toHaveLength(2);
  });

  it('stops at the next top-level key instead of swallowing a later list', () => {
    const { dirs } = collect(
      "packages:\n  - 'docs'\n\nminimumReleaseAgeExclude:\n  - '@inkeep/*'\n  - '@visimer/*'\n",
    );
    expect(dirs.map((dir) => path.relative(root, dir))).toEqual(['docs']);
  });

  it('reports a pattern it cannot expand rather than dropping it silently', () => {
    const { unparsed } = collect("packages:\n  - 'docs'\n  - 'packages/*/*'\n");
    expect(unparsed).toEqual(['packages/*/*']);
  });

  it('reports a pattern that matched no package.json', () => {
    const { empty } = collect("packages:\n  - 'docs'\n  - 'no-such-directory'\n");
    expect(empty).toEqual(['no-such-directory']);
  });

  it('reports an empty packages block rather than returning a clean pass', () => {
    const { dirs, empty } = collect('packages:\n\noverrides:\n  react: 19.2.5\n');
    expect(dirs).toEqual([]);
    expect(empty).toEqual(['the packages: block itself']);
  });
});

describe('declarationBuildConfigs', () => {
  const publisher = { exports: { '.': { types: './dist/index.d.mts' } } };
  const reset = { compilerOptions: { customConditions: [] } };
  const fixture = {
    '/ok/packages/core/package.json': publisher,
    '/ok/packages/server/package.json': publisher,
    '/ok/packages/cli/package.json': publisher,
    '/ok/packages/app/package.json': { name: '@inkeep/open-knowledge-app', private: true },
    '/ok/packages/core/tsconfig.build.json': reset,
    '/ok/packages/server/tsconfig.build.json': reset,
    '/ok/packages/app/tsconfig.build.json': reset,
  };
  const dirs = ['/ok/packages/app', '/ok/packages/cli', '/ok/packages/core', '/ok/packages/server'];
  const readConfig = (file) =>
    file in fixture ? { ok: true, value: fixture[file] } : { ok: false, reason: `${file} is gone` };
  const derive = () =>
    declarationBuildConfigs(
      '/ok',
      dirs,
      (file) => fixture[file] ?? null,
      (file) => file in fixture,
      readConfig,
    );

  it('names the publishing package that carries no build config rather than shrinking the corpus', () => {
    const { configs, missing } = derive();

    expect(missing).toEqual(['packages/cli/tsconfig.build.json']);
    expect(configs.map(([file]) => file)).toEqual([
      'packages/core/tsconfig.build.json',
      'packages/server/tsconfig.build.json',
    ]);
  });

  it('enrols an exports-sugar package regardless of whether dist has been built yet', () => {
    const fixture = { '/ok/p/package.json': { exports: { '.': './dist/i.mjs' } } };
    const derive = (exists) =>
      declarationBuildConfigs('/ok', ['/ok/p'], (f) => fixture[f] ?? null, exists);

    for (const exists of [(f) => f in fixture, (f) => f in fixture || f === '/ok/p/dist/i.d.mts']) {
      const { configs, missing } = derive(exists);
      expect(missing).toEqual(['p/tsconfig.build.json']);
      expect(configs).toEqual([]);
    }
  });

  it('leaves a build config out of the corpus when its package publishes no declaration', () => {
    const { configs, missing } = derive();

    expect(missing).not.toContain('packages/app/tsconfig.build.json');
    expect(configs.map(([file]) => file)).not.toContain('packages/app/tsconfig.build.json');
  });

  it('reads a build config that carries JSONC comments rather than reporting it as condition-less', () => {
    const commented = {
      '/ok/packages/core/package.json': publisher,
      '/ok/packages/core/tsconfig.build.json': true,
    };
    const { configs, blind } = declarationBuildConfigs(
      '/ok',
      ['/ok/packages/core'],
      (file) => commented[file] ?? null,
      (file) => file in commented,
      () => ({
        ok: true,
        value: JSON.parse(
          stripJsonc(
            '{\n  // reset for the published surface\n  "compilerOptions": { "customConditions": [] },\n}\n',
          ),
        ),
      }),
    );

    expect(blind).toEqual([]);
    expect(configs).toEqual([['packages/core/tsconfig.build.json', []]]);
  });

  it('reports an unparseable build config as a blind spot rather than as no conditions', () => {
    const broken = {
      '/ok/packages/core/package.json': publisher,
      '/ok/packages/core/tsconfig.build.json': true,
    };
    const { configs, blind } = declarationBuildConfigs(
      '/ok',
      ['/ok/packages/core'],
      (file) => broken[file] ?? null,
      (file) => file in broken,
      (file) => ({ ok: false, reason: `${file} is malformed rather than merely commented` }),
    );

    expect(configs).toEqual([]);
    expect(blind).toEqual([
      '/ok/packages/core/tsconfig.build.json is malformed rather than merely commented',
    ]);
  });

  it('enrols every real workspace package that points a types entry at a dist declaration', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const onDisk = memberDirs(
      root,
      fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
      () => {},
      () => {},
    );
    const { configs, missing } = declarationBuildConfigs(root, onDisk);

    expect(missing).toEqual([]);
    expect(configs.map(([file]) => file).sort()).toEqual([
      'packages/cli/tsconfig.build.json',
      'packages/core/tsconfig.build.json',
      'packages/server/tsconfig.build.json',
    ]);
    expect(configs.every(([, conditions]) => Array.isArray(conditions))).toBe(true);
  });
});

describe('publishesDeclarations', () => {
  it('enrols a package that emits declarations into an output directory', () => {
    expect(publishesDeclarations({ exports: { '.': { types: './dist/index.d.mts' } } })).toBe(true);
    expect(publishesDeclarations({ exports: { '.': { types: './build/index.d.mts' } } })).toBe(
      true,
    );
    expect(publishesDeclarations({ types: 'lib/index.d.cts' })).toBe(true);
  });

  it('reads the publishConfig overlay a workspace uses when dev-time exports point at source', () => {
    expect(
      publishesDeclarations({ publishConfig: { exports: { '.': { types: './dist/i.d.mts' } } } }),
    ).toBe(true);
  });

  it('enrols a package-root declaration that nothing exempts, rather than reading its shape as proof', () => {
    expect(publishesDeclarations({ name: '@x/y', types: 'index.d.ts' })).toBe(true);
    expect(publishesDeclarations({ name: '@x/y', private: true })).toBe(false);
  });

  it('exempts only the packages named in the non-tsc list', () => {
    expect(
      publishesDeclarations({ name: '@inkeep/open-knowledge-native-config', types: 'index.d.ts' }),
    ).toBe(false);
  });
});

describe('staleNonTscListing', () => {
  it('says nothing about a package that is not on the list', () => {
    expect(staleNonTscListing({ name: '@x/y', types: 'dist/index.d.mts' })).toBe(null);
    expect(staleNonTscListing(null)).toBe(null);
  });

  it('stays quiet while the listed package really does emit its declaration outside tsc', () => {
    expect(
      staleNonTscListing({
        name: '@inkeep/open-knowledge-native-config',
        types: 'index.d.ts',
      }),
    ).toBe(null);
  });

  it('refuses the exemption once the listed package publishes from an output directory', () => {
    const stale = staleNonTscListing({
      name: '@inkeep/open-knowledge-native-config',
      types: 'dist/index.d.mts',
    });

    expect(stale).toContain('dist/index.d.mts');
    expect(stale).toContain('remove it from NON_TSC_DECLARATIONS');
  });
});

describe('checkConditions reports a missing build config beside its siblings', () => {
  it('emits one violation per missing config rather than pre-empting the batch', () => {
    const violations = checkConditions({
      baseConditions: [SOURCE_CONDITION],
      declarationBuild: {
        configs: [['packages/server/tsconfig.build.json', [SOURCE_CONDITION]]],
        missing: ['packages/core/tsconfig.build.json'],
      },
    });

    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain('packages/core/tsconfig.build.json does not exist');
    expect(violations[1]).toContain(
      'packages/server/tsconfig.build.json declares customConditions',
    );
  });

  it('stays silent when every publisher carries a build config that resets the condition', () => {
    expect(
      checkConditions({
        baseConditions: [SOURCE_CONDITION],
        declarationBuild: { configs: [['packages/core/tsconfig.build.json', []]], missing: [] },
      }),
    ).toEqual([]);
  });
});

describe('evaluate wires every probe into the verdict', () => {
  const healthy = {
    root: '/ok',
    rootProbe: { binVersion: '7.0.2', shimVersion: '6.0.3', tsserverBytes: 272 },
    members: [
      {
        name: '@inkeep/open-knowledge-core',
        declaredRange: '^7.0.2',
        resolvedVersion: '7.0.2',
        binVersion: '7.0.2',
        scripts: { typecheck: 'tsc --noEmit' },
      },
    ],
    gated: [{ name: '@inkeep/open-knowledge-core' }],
    baseConditions: [SOURCE_CONDITION],
    declarationBuild: { configs: [['packages/core/tsconfig.build.json', []]], missing: [] },
    emitConfigs: [
      [
        'packages/core/tsdown.config.ts',
        "export default defineConfig({ dts: { tsconfig: 'tsconfig.build.json' }, unbundle: true });",
      ],
    ],
    sourceSites: [
      { name: '@inkeep/open-knowledge-core', private: true, total: 1, missing: [], present: ['.'] },
    ],
    tsconfigs: {
      files: ['packages/core/tsconfig.build.json', 'packages/core/tsconfig.json', 'tsconfig.json'],
      sites: [
        ['packages/core/tsconfig.build.json', []],
        ['tsconfig.json', [SOURCE_CONDITION]],
      ],
    },
  };

  it('counts the tsconfigs it walked in the OK line', () => {
    expect(evaluate(healthy).out.join(' ')).toContain('of the 3 tsconfig files under the root');
  });

  it('fails when a leaf tsconfig declares customConditions of its own', () => {
    const result = evaluate({
      ...healthy,
      tsconfigs: {
        files: [...healthy.tsconfigs.files],
        sites: [...healthy.tsconfigs.sites, ['packages/core/tsconfig.json', []]],
      },
    });

    expect(result.code).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain(
      'packages/core/tsconfig.json declares customConditions []',
    );
  });

  it('reports OK when every probe holds', () => {
    const result = evaluate(healthy);

    expect(result.code).toBe(0);
    expect(result.out.join(' ')).toContain('check-typescript-resolution: OK at /ok');
    expect(result.out.join(' ')).toContain('1 tsdown configs');
    expect(result.out.join(' ')).toContain('1 packages declare an `exports` field');
  });

  it('names the redirect in the OK line when the root came from the environment', () => {
    const result = evaluate({ ...healthy, rootSource: 'OK_RESOLUTION_ROOT' });

    expect(result.out.join(' ')).toContain('OK at /ok [from OK_RESOLUTION_ROOT]');
  });

  it('fails when a tsdown config emits declarations under the base tsconfig', () => {
    const result = evaluate({
      ...healthy,
      emitConfigs: [
        ['packages/core/tsdown.config.ts', 'export default defineConfig({ dts: true });'],
      ],
    });

    expect(result.code).toBe(1);
    expect(result.violations[0]).toContain('emits declarations with dts: true');
  });

  it('fails when a private package omits the source condition on a subpath', () => {
    const result = evaluate({
      ...healthy,
      sourceSites: [
        {
          name: '@inkeep/open-knowledge-core',
          private: true,
          total: 1,
          missing: ['.'],
          present: [],
        },
      ],
    });

    expect(result.code).toBe(1);
    expect(result.violations[0]).toContain('is private and 1 of its 1');
  });

  it('fails when a publishing package carries no build config', () => {
    const result = evaluate({
      ...healthy,
      declarationBuild: { configs: [], missing: ['packages/core/tsconfig.build.json'] },
    });

    expect(result.code).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('packages/core/tsconfig.build.json does not exist');
  });

  it('fails when a build config does not reset the source condition', () => {
    const result = evaluate({
      ...healthy,
      declarationBuild: {
        configs: [['packages/core/tsconfig.build.json', [SOURCE_CONDITION]]],
        missing: [],
      },
    });

    expect(result.code).toBe(1);
    expect(result.violations[0]).toContain('declares customConditions');
  });

  it('fails when the base tsconfig drops the source condition', () => {
    const result = evaluate({ ...healthy, baseConditions: [] });

    expect(result.code).toBe(1);
    expect(result.violations[0]).toContain('the base tsconfig declares customConditions');
  });
});

describe('checkDeclarationEmit', () => {
  const build = "dts: { tsconfig: 'tsconfig.build.json' },";

  it('accepts an emit bound to the condition-clearing build config', () => {
    expect(checkDeclarationEmit([['packages/core/tsdown.config.ts', build]])).toEqual([]);
  });

  it('accepts an entry that emits no declaration at all', () => {
    expect(checkDeclarationEmit([['packages/cli/tsdown.config.ts', 'dts: false,']])).toEqual([]);
  });

  it('accepts a config that mixes a disabled entry with a bound one', () => {
    expect(
      checkDeclarationEmit([['packages/cli/tsdown.config.ts', `dts: false,\n${build}`]]),
    ).toEqual([]);
  });

  it('rejects a bare dts: true, which emits under the base tsconfig', () => {
    const [violation] = checkDeclarationEmit([['packages/core/tsdown.config.ts', 'dts: true,']]);

    expect(violation).toContain('emits declarations with dts: true');
    expect(violation).toContain('resolves siblings from ../<sibling>/src');
  });

  it('rejects an emit pointed at some other tsconfig', () => {
    const [violation] = checkDeclarationEmit([
      ['packages/core/tsdown.config.ts', "dts: { tsconfig: 'tsconfig.json' },"],
    ]);

    expect(violation).toContain('emits declarations with dts:');
  });

  it('refuses a config that binds no dts option rather than passing it', () => {
    const [violation] = checkDeclarationEmit([
      ['packages/core/tsdown.config.ts', 'format: "esm",'],
    ]);

    expect(violation).toContain('binds no dts option');
  });

  it('refuses an unreadable config rather than reporting a pass on it', () => {
    const [violation] = checkDeclarationEmit([['packages/core/tsdown.config.ts', null]]);

    expect(violation).toContain('could not be read');
    expect(violation).toContain('Refusing to report a pass');
  });

  it('refuses a config the package needs but does not have', () => {
    const [violation] = checkDeclarationEmit([['packages/core/tsdown.config.ts', CONFIG_ABSENT]]);

    expect(violation).toContain('packages/core/tsdown.config.ts does not exist');
    expect(violation).toContain('Refusing to report a pass');
  });

  it('reads a binding whose object nests another object as one binding', () => {
    expect(
      checkDeclarationEmit([
        [
          'packages/core/tsdown.config.ts',
          "dts: { tsconfig: 'tsconfig.build.json', compilerOptions: { declarationMap: true } },",
        ],
      ]),
    ).toEqual([]);
  });

  it('accepts the relative spelling of the build config path', () => {
    expect(
      checkDeclarationEmit([
        ['packages/core/tsdown.config.ts', "dts: { tsconfig: './tsconfig.build.json' },"],
      ]),
    ).toEqual([]);
  });

  it('accepts the build config path written as a template literal', () => {
    expect(
      checkDeclarationEmit([
        ['packages/core/tsdown.config.ts', 'dts: { tsconfig: `tsconfig.build.json` },'],
      ]),
    ).toEqual([]);
  });

  it('ignores a dts binding that only appears inside a comment', () => {
    const [violation] = checkDeclarationEmit([
      ['packages/core/tsdown.config.ts', '// dts: true,\nformat: "esm",'],
    ]);

    expect(violation).toContain('binds no dts option');
  });
});

describe('dtsBindings', () => {
  it('walks to the matching brace instead of stopping at the first nested one', () => {
    expect(
      dtsBindings("dts: { tsconfig: 'tsconfig.build.json', compilerOptions: { a: 1 } },"),
    ).toEqual(["{ tsconfig: 'tsconfig.build.json', compilerOptions: { a: 1 } }"]);
  });

  it('reads the literal spellings and reports both entries of a two-entry config', () => {
    expect(dtsBindings('dts: false, x: 1, dts: true')).toEqual(['false', 'true']);
  });

  it('does not read a brace inside a string as the end of the binding', () => {
    expect(dtsBindings("dts: { banner: '}' }")).toEqual(["{ banner: '}' }"]);
  });
});

describe('checkDeclarationEmit reads an array config one entry at a time', () => {
  const REAL_CONFIGS = [
    ['packages/core/tsdown.config.ts', realConfig('core')],
    ['packages/server/tsdown.config.ts', realConfig('server')],
    ['packages/cli/tsdown.config.ts', realConfig('cli')],
  ];

  it('accepts every tsdown config the workspace actually ships', () => {
    expect(checkDeclarationEmit(REAL_CONFIGS)).toEqual([]);
  });

  for (const [pkg, dropped] of [
    ['core', /dts: \{ tsconfig: 'tsconfig\.build\.json', emitDtsOnly: true \},/],
    ['cli', /dts: \{ tsconfig: 'tsconfig\.build\.json' \},/],
  ]) {
    it(`reds when ${pkg}'s second entry loses its dts binding while the first still binds false`, () => {
      const file = `packages/${pkg}/tsdown.config.ts`;
      const mutated = withoutLinesMatching(realConfig(pkg), dropped);

      expect(mutated).not.toEqual(realConfig(pkg));
      const [violation] = checkDeclarationEmit([[file, mutated]]);
      expect(violation).toContain(`${file} entry [1] binds no dts option`);
    });
  }

  it('names the offending entry rather than the whole file', () => {
    const [violation] = checkDeclarationEmit([
      [
        'packages/core/tsdown.config.ts',
        'export default defineConfig([{ dts: false }, { dts: true }]);',
      ],
    ]);

    expect(violation).toContain('entry [1] emits declarations with dts: true');
  });

  it('reads a lone object config as the single entry it is', () => {
    const [violation] = checkDeclarationEmit([
      ['packages/server/tsdown.config.ts', 'export default defineConfig({ format: "esm" });'],
    ]);

    expect(violation).toContain('packages/server/tsdown.config.ts binds no dts option');
    expect(violation).not.toContain('entry [');
  });

  it('keeps splitting entries across a template literal that nests another one', () => {
    const open = '${';
    const source = [
      'export default defineConfig([',
      `  { entry: { a: 'src/a.ts' }, dts: false, banner: \`${open}xs.map((v) => \`}${open}v}\`).join('')}\` },`,
      "  { entry: { b: 'src/b.ts' }, format: 'esm' },",
      ']);',
    ].join('\n');

    expect(source).toContain(`banner: \`${open}xs.map((v) => \`}${open}v}\`).join('')}\``);
    const violations = checkDeclarationEmit([['packages/core/tsdown.config.ts', source]]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('entry [1] binds no dts option');
  });

  it('does not read a commented-out binding as a live one', () => {
    const [violation] = checkDeclarationEmit([
      [
        'packages/core/tsdown.config.ts',
        "export default defineConfig([{ dts: false }, {\n  // dts: { tsconfig: 'tsconfig.build.json' },\n  format: 'esm',\n}]);",
      ],
    ]);

    expect(violation).toContain('entry [1] binds no dts option');
  });

  it('records the unbundle option per entry so a flip is visible in the pass line', () => {
    expect(declarationEmitEntries(REAL_CONFIGS)).toEqual([
      {
        file: 'packages/core/tsdown.config.ts',
        label: '[0]',
        dts: 'false',
        unbundle: 'false',
      },
      {
        file: 'packages/core/tsdown.config.ts',
        label: '[1]',
        dts: "{ tsconfig: 'tsconfig.build.json', emitDtsOnly: true }",
        unbundle: 'true',
      },
      {
        file: 'packages/server/tsdown.config.ts',
        label: null,
        dts: "{ tsconfig: 'tsconfig.build.json' }",
        unbundle: 'false',
      },
      {
        file: 'packages/cli/tsdown.config.ts',
        label: '[0]',
        dts: 'false',
        unbundle: 'false',
      },
      {
        file: 'packages/cli/tsdown.config.ts',
        label: '[1]',
        dts: "{ tsconfig: 'tsconfig.build.json' }",
        unbundle: 'false',
      },
    ]);
    expect(unbundleCensus(REAL_CONFIGS)).toBe(
      '5 build entries across them, unbundle true on 1 and false on 4 and unbound on 0',
    );
  });
});

describe('declarationEmitConfigs', () => {
  const publisher = {
    exports: { '.': { types: './dist/index.d.mts' } },
    devDependencies: { tsdown: '^0.22.14' },
  };
  const fixture = {
    '/ok/packages/core/package.json': publisher,
    '/ok/packages/cli/package.json': publisher,
    '/ok/packages/plugin/package.json': {
      exports: { '.': { types: './dist/index.d.mts' } },
    },
    '/ok/packages/app/package.json': { name: '@inkeep/open-knowledge-app', private: true },
    '/ok/packages/core/tsdown.config.ts': 'dts: false,',
  };
  const dirs = ['/ok/packages/app', '/ok/packages/cli', '/ok/packages/core', '/ok/packages/plugin'];
  const derive = () =>
    declarationEmitConfigs(
      '/ok',
      dirs,
      (file) => fixture[file] ?? null,
      (file) => fixture[file] ?? null,
      (file) => file in fixture,
    );

  it('records a tsdown builder whose config is absent rather than dropping it from the corpus', () => {
    expect(derive()).toEqual([
      ['packages/cli/tsdown.config.ts', CONFIG_ABSENT],
      ['packages/core/tsdown.config.ts', 'dts: false,'],
    ]);
  });

  it('leaves out a publisher that does not build with tsdown at all', () => {
    expect(derive().map(([file]) => file)).not.toContain('packages/plugin/tsdown.config.ts');
  });

  it('enrols every real tsdown builder in the workspace', () => {
    const onDisk = memberDirs(
      OK_ROOT,
      fs.readFileSync(path.join(OK_ROOT, 'pnpm-workspace.yaml'), 'utf8'),
      () => {},
      () => {},
    );
    const entries = declarationEmitConfigs(OK_ROOT, onDisk);

    expect(entries.map(([file]) => file).sort()).toEqual([
      'packages/cli/tsdown.config.ts',
      'packages/core/tsdown.config.ts',
      'packages/server/tsdown.config.ts',
    ]);
    expect(entries.every(([, source]) => typeof source === 'string')).toBe(true);
  });
});

describe('main() refuses rather than passing', () => {
  const run = (root) =>
    spawnSync('node', ['scripts/check-typescript-resolution.mjs'], {
      cwd: OK_ROOT,
      encoding: 'utf8',
      env: { ...process.env, OK_RESOLUTION_ROOT: root },
    });

  it('refuses when there is no workspace file to enumerate from', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-resolution-empty-'));
    try {
      const result = run(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('no pnpm-workspace.yaml');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses when the workspace enumerates no members', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-resolution-partial-'));
    try {
      fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "nope/*"\n');
      const result = run(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('cannot enumerate the workspace');
      expect(result.stderr).toContain('matched no package.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const fixtureRoot = (files) => writeTree('ts-resolution-', files);

  const WORKSPACE = "packages:\n  - 'packages/*'\n";
  const GATED = { typescript: '^7.0.2' };
  const BASE_TSCONFIG = { compilerOptions: { customConditions: [SOURCE_CONDITION] } };

  const refusalCase = (files, expected) => {
    const dir = fixtureRoot(files);
    try {
      const result = run(dir);
      expect(result.status).toBe(1);
      for (const fragment of expected) expect(result.stderr).toContain(fragment);
      return result;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('refuses when a matched package.json parses but cannot be probed', () => {
    refusalCase(
      { 'pnpm-workspace.yaml': WORKSPACE, 'packages/nameless/package.json': { type: 'module' } },
      ['cannot enumerate the workspace', 'declares no name'],
    );
  });

  it('refuses when no enumerated package declares the compiler', () => {
    refusalCase({ 'pnpm-workspace.yaml': WORKSPACE, 'packages/a/package.json': { name: 'a' } }, [
      'no workspace package declares typescript',
      'Refusing to report a pass on an empty corpus',
    ]);
  });

  it('refuses when no enumerated package publishes an emitted declaration', () => {
    refusalCase(
      {
        'pnpm-workspace.yaml': WORKSPACE,
        'packages/a/package.json': { name: 'a', private: true, devDependencies: GATED },
        'tsconfig.json': BASE_TSCONFIG,
      },
      ['no workspace package publishes an emitted declaration'],
    );
  });

  it('refuses when a declaration publisher builds without a tsdown config to inspect', () => {
    refusalCase(
      {
        'pnpm-workspace.yaml': WORKSPACE,
        'packages/a/package.json': {
          name: 'a',
          private: true,
          devDependencies: GATED,
          exports: { '.': { '@inkeep/source': './src/index.ts', types: './dist/index.d.mts' } },
        },
        'packages/a/tsconfig.build.json': { compilerOptions: { customConditions: [] } },
        'tsconfig.json': BASE_TSCONFIG,
      },
      ['none of the packages that publish an emitted declaration has a tsdown.config.ts'],
    );
  });

  it('reads a base tsconfig that carries comments rather than calling it condition-less', () => {
    const result = refusalCase(
      {
        'pnpm-workspace.yaml': WORKSPACE,
        'packages/a/package.json': {
          name: 'a',
          private: true,
          devDependencies: GATED,
          exports: { '.': { '@inkeep/source': './src/index.ts', types: './dist/index.d.mts' } },
        },
        'packages/a/tsconfig.build.json': { compilerOptions: { customConditions: [] } },
        'tsconfig.json':
          '{\n  // the source condition every leaf typecheck resolves through\n  "compilerOptions": { "customConditions": ["@inkeep/source"] },\n}\n',
      },
      ['none of the packages that publish an emitted declaration has a tsdown.config.ts'],
    );

    expect(result.stderr).not.toContain('the base tsconfig declares customConditions');
  });

  it('names the malformed tsconfig and its cause rather than reporting a content violation', () => {
    const result = refusalCase(
      {
        'pnpm-workspace.yaml': WORKSPACE,
        'packages/a/package.json': { name: 'a', private: true, devDependencies: GATED },
        'tsconfig.json': '{ "compilerOptions": ',
      },
      ['cannot read a tsconfig this gate has to inspect', 'malformed rather than merely commented'],
    );

    expect(result.stderr).toContain('tsconfig.json');
    expect(result.stderr).not.toContain('declares customConditions');
  });

  const EMITTING_PACKAGE = {
    name: 'a',
    private: true,
    devDependencies: { ...GATED, tsdown: '^0.15.6' },
    exports: { '.': { '@inkeep/source': './src/index.ts', types: './dist/index.d.mts' } },
  };
  const evaluatedTree = (extra) => ({
    'pnpm-workspace.yaml': WORKSPACE,
    'tsconfig.json': BASE_TSCONFIG,
    'packages/a/package.json': EMITTING_PACKAGE,
    'packages/a/tsconfig.build.json': { compilerOptions: { customConditions: [] } },
    'packages/a/tsdown.config.ts':
      "export default defineConfig({ dts: { tsconfig: 'tsconfig.build.json' } });\n",
    ...extra,
  });

  it('fails on a leaf tsconfig that switches its own program onto dist resolution', () => {
    const result = refusalCase(
      evaluatedTree({ 'packages/a/tsconfig.json': { compilerOptions: { customConditions: [] } } }),
      ['packages/a/tsconfig.json declares customConditions []', 'REPLACES the base array'],
    );

    expect(result.stderr).not.toContain('packages/a/tsconfig.build.json declares');
  });

  it('flags a published package that carries the source condition on one arm of a nested group', () => {
    const result = refusalCase(
      evaluatedTree({
        'packages/a/package.json': {
          ...EMITTING_PACKAGE,
          private: false,
          exports: {
            '.': {
              import: { types: './dist/index.d.mts', default: './dist/index.mjs' },
              require: { '@inkeep/source': './src/index.ts', default: './dist/index.cjs' },
            },
          },
        },
      }),
      ['is published and 1 of its', 'not in the published tarball'],
    );

    expect(result.stderr).not.toContain('is private and');
  });

  it('says nothing about a leaf tsconfig that leaves the base resolution alone', () => {
    const result = refusalCase(
      evaluatedTree({ 'packages/a/tsconfig.json': { extends: '../../tsconfig.json' } }),
      ['the declaration and compiler contract this workspace declares does not hold'],
    );

    expect(result.stderr).not.toContain('packages/a/tsconfig.json declares customConditions');
  });
});

describe('sourceConditionSites', () => {
  it('ignores a manifest with no exports field', () => {
    expect(sourceConditionSites({ name: 'x' })).toBe(null);
  });

  it('ignores an exports map with no subpaths at all', () => {
    expect(sourceConditionSites({ name: 'x', private: true, exports: {} })).toBe(null);
  });

  it('splits subpaths by whether they carry the source condition', () => {
    const site = sourceConditionSites({
      name: 'x',
      private: true,
      exports: {
        '.': { '@inkeep/source': './src/index.ts', default: './dist/index.mjs' },
        './b': { default: './dist/b.mjs' },
      },
    });

    expect(site).toMatchObject({ private: true, total: 2, present: ['.'], missing: ['./b'] });
  });

  it('reads a conditions-only exports map as the one "." subpath it is sugar for', () => {
    const site = sourceConditionSites({
      name: 'x',
      private: false,
      exports: { '@inkeep/source': './src/index.ts', default: './dist/index.mjs' },
    });

    expect(site).toMatchObject({ private: false, total: 1, present: ['.'], missing: [] });
  });

  it('reads a top-level fallback array and a bare string as the one "." subpath', () => {
    const array = sourceConditionSites({
      name: 'x',
      private: true,
      exports: [{ '@inkeep/source': './src/index.ts' }, './dist/index.mjs'],
    });
    expect(array).toMatchObject({ total: 1, present: ['.'], missing: ['.'] });

    const string = sourceConditionSites({ name: 'x', private: true, exports: './dist/index.mjs' });
    expect(string).toMatchObject({ total: 1, present: [], missing: ['.'] });

    expect(sourceConditionSites({ name: 'x', private: true, exports: [] })).toBe(null);
  });

  it('sees the source condition inside a nested condition group or a fallback array', () => {
    const site = sourceConditionSites({
      name: 'x',
      private: false,
      exports: {
        './nested': {
          import: { default: './dist/n.mjs' },
          require: { '@inkeep/source': './src/n.ts', default: './dist/n.cjs' },
        },
        './array': [{ '@inkeep/source': './src/a.ts' }, './dist/a.mjs'],
        './flat': { types: './dist/f.d.mts', default: './dist/f.mjs' },
      },
    });

    expect(site).toMatchObject({ private: false, total: 3, present: ['./nested', './array'] });
    expect(site.missing).toEqual(['./nested', './array', './flat']);
  });

  it('counts a subpath that orders another condition ahead of the source one as missing', () => {
    const site = sourceConditionSites({
      name: 'x',
      private: true,
      exports: {
        '.': {
          types: './dist/index.d.mts',
          '@inkeep/source': './src/index.ts',
          default: './dist/index.mjs',
        },
      },
    });

    expect(site.missing).toEqual(['.']);
    expect(site.present).toEqual(['.']);
  });

  it('keeps a string-valued subpath in the corpus, where it can never carry a condition', () => {
    const site = sourceConditionSites({
      name: 'x',
      private: true,
      exports: {
        '.': { '@inkeep/source': './src/index.ts', default: './dist/index.mjs' },
        './b': './dist/b.mjs',
      },
    });

    expect(site.total).toBe(2);
    expect(site.missing).toEqual(['./b']);
    expect(site.present).toEqual(['.']);
  });

  it('refuses to classify a package that declares an exports map and no private field', () => {
    const site = sourceConditionSites({
      name: 'x',
      exports: { '.': { '@inkeep/source': './src/index.ts' } },
    });

    expect(site).toMatchObject({ unclassified: true, total: 1 });
    expect(site.private).toBeUndefined();
  });

  it('reads private: false as published rather than folding it in with an absent field', () => {
    const site = sourceConditionSites({
      name: 'x',
      private: false,
      exports: { '.': './dist/i.mjs' },
    });

    expect(site.private).toBe(false);
    expect(site.unclassified).toBeUndefined();
  });

  it('classifies every real workspace package that declares an exports field', () => {
    const onDisk = memberDirs(
      OK_ROOT,
      fs.readFileSync(path.join(OK_ROOT, 'pnpm-workspace.yaml'), 'utf8'),
      () => {},
      () => {},
    );
    const sites = onDisk
      .map((dir) =>
        sourceConditionSites(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))),
      )
      .filter((site) => site !== null);

    expect(sites.length).toBeGreaterThanOrEqual(3);
    expect(sites.every((site) => site.unclassified === undefined)).toBe(true);
    expect(checkSourceCondition(sites)).toEqual([]);
  });
});

describe('checkSourceCondition', () => {
  const privateComplete = {
    name: 'core',
    private: true,
    total: 2,
    missing: [],
    present: ['.', './b'],
  };
  const publishedClean = { name: 'cli', private: false, total: 1, missing: ['.'], present: [] };

  it('accepts a private package that carries the condition on every subpath', () => {
    expect(checkSourceCondition([privateComplete, publishedClean])).toEqual([]);
  });

  it('refuses an empty corpus rather than passing against nothing', () => {
    const [violation] = checkSourceCondition([]);
    expect(violation).toContain('Refusing to report a pass');
  });

  it('rejects a private package that omits the condition on a subpath', () => {
    const [violation] = checkSourceCondition([
      { ...privateComplete, missing: ['./b'], present: ['.'] },
    ]);
    expect(violation).toContain('is private and 1 of its 2');
    expect(violation).toContain('can pass against a stale dist');
  });

  it('rejects a published package that declares the condition', () => {
    const [violation] = checkSourceCondition([{ ...publishedClean, missing: [], present: ['.'] }]);
    expect(violation).toContain('is published and 1 of its');
    expect(violation).toContain('not in the published tarball');
  });

  it('refuses a package it could not classify instead of guessing a direction', () => {
    const violations = checkSourceCondition([
      { name: 'newcomer', unclassified: true, total: 3, missing: [], present: [] },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('newcomer declares an `exports` field with 3 subpaths');
    expect(violations[0]).toContain('no explicit `private` field');
  });

  it('names ordering as a cause alongside omission, since the two need different edits', () => {
    const [violation] = checkSourceCondition([
      { ...privateComplete, missing: ['./b'], present: ['.', './b'] },
    ]);

    expect(violation).toContain('orders another condition ahead of it');
  });
});

describe('checkTsconfigConditions', () => {
  const canonical = [
    ['packages/cli/tsconfig.check.json', []],
    ['packages/core/tsconfig.build.json', []],
    ['tsconfig.json', [SOURCE_CONDITION]],
  ];

  it('accepts the base condition beside the build and check configs that reset it', () => {
    expect(checkTsconfigConditions(canonical)).toEqual([]);
  });

  it('names the leaf config that moves its program onto dist, and the value it carries', () => {
    const [violation] = checkTsconfigConditions([...canonical, ['packages/app/tsconfig.json', []]]);

    expect(violation).toContain('packages/app/tsconfig.json declares customConditions []');
    expect(violation).toContain('REPLACES the base array');
  });

  it('rejects a leaf that claims the source condition only the base may declare', () => {
    const [violation] = checkTsconfigConditions([['docs/tsconfig.json', [SOURCE_CONDITION]]]);

    expect(violation).toContain(
      `docs/tsconfig.json declares customConditions ["${SOURCE_CONDITION}"]`,
    );
  });

  it('rejects a reset-named config outside a canonical package location, even when it resets', () => {
    const violations = checkTsconfigConditions([
      ...canonical,
      ['tsconfig.build.json', []],
      ['packages/a/nested/deep/tsconfig.check.json', []],
    ]);

    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain('tsconfig.build.json declares customConditions []');
    expect(violations[0]).toContain('outside the canonical locations');
    expect(violations[0]).toContain(
      '(packages/<package> or packages/md-conformance/md-audit or docs)',
    );
    expect(violations[1]).toContain('packages/a/nested/deep/tsconfig.check.json');
    expect(violations[1]).toContain('outside the canonical locations');
  });

  it('leaves a non-reset leaf outside a canonical location to the leaf message', () => {
    const violations = checkTsconfigConditions([
      ...canonical,
      ['packages/app/e2e/tsconfig.json', []],
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('REPLACES the base array');
    expect(violations[0]).not.toContain('outside the canonical locations');
  });

  it('accepts the reset at every canonical location the guard recognises', () => {
    expect(
      checkTsconfigConditions([
        ...canonical,
        ['packages/md-conformance/md-audit/tsconfig.build.json', []],
        ['docs/tsconfig.check.json', []],
      ]),
    ).toEqual([]);
  });

  it('rejects a build or check config carrying anything other than a reset', () => {
    const violations = checkTsconfigConditions([
      ['packages/cli/tsconfig.check.json', [SOURCE_CONDITION]],
      ['packages/core/tsconfig.build.json', null],
    ]);

    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain('A tsconfig.check.json exists to reset');
    expect(violations[1]).toContain(
      'packages/core/tsconfig.build.json declares customConditions null, not []',
    );
  });

  it('leaves a build config already asserted by the declaration check to that check', () => {
    expect(
      checkTsconfigConditions(
        [['packages/core/tsconfig.build.json', [SOURCE_CONDITION]]],
        ['packages/core/tsconfig.build.json'],
      ),
    ).toEqual([]);
  });
});

describe('tsconfigFiles', () => {
  it('walks the root and its packages, past node_modules and dot directories', () => {
    withTree(
      {
        'tsconfig.json': {},
        'tsconfig.md': 'not a config at all',
        'packages/a/package.json': {},
        'packages/a/tsconfig.json': {},
        'packages/a/tsconfig.build.json': {},
        'packages/a/nested/deep/tsconfig.check.json': {},
        'packages/a/node_modules/dep/tsconfig.json': {},
        '.turbo/tsconfig.json': {},
      },
      (dir) => {
        expect(tsconfigFiles(dir).files).toEqual([
          'packages/a/nested/deep/tsconfig.check.json',
          'packages/a/tsconfig.build.json',
          'packages/a/tsconfig.json',
          'tsconfig.json',
        ]);
      },
    );
  });

  it('skips every directory the gitignore rules name, at their declared anchor or by name and prefix', () => {
    const rules = outputDirRules(
      [
        'node_modules/',
        'dist/',
        'packages/desktop/out/',
        'packages/desktop/build/parcel-watcher-staging/',
        'tmp/',
        'playwright-report-*/',
        'desktop-smoke-test-results-*/',
        '/rooted-only/',
        'packages/*/coverage/',
      ].join('\n'),
    );
    const files = Object.fromEntries(
      [
        'tsconfig.json',
        'packages/a/tsconfig.build.json',
        'packages/a/dist/tsconfig.json',
        'packages/a/deep/tmp/tsconfig.json',
        'packages/a/playwright-report-linux/tsconfig.build.json',
        'packages/a/desktop-smoke-test-results-win/tsconfig.json',
        'packages/desktop/out/tsconfig.json',
        'packages/desktop/build/parcel-watcher-staging/tsconfig.json',
        'packages/app/out/tsconfig.json',
        'rooted-only/tsconfig.json',
        'packages/a/rooted-only/tsconfig.json',
        'packages/a/coverage/tsconfig.json',
      ].map((rel) => [rel, {}]),
    );
    withTree(files, (dir) => {
      expect(tsconfigFiles(dir, fs.readdirSync, rules).files).toEqual([
        'packages/a/coverage/tsconfig.json',
        'packages/a/rooted-only/tsconfig.json',
        'packages/a/tsconfig.build.json',
        'packages/app/out/tsconfig.json',
        'tsconfig.json',
      ]);
    });
  });

  it('keeps a root-anchored single-segment pattern at the root only', () => {
    const rules = outputDirRules('/perf-fixtures/\nperf-cache/\n');
    expect(rules.anchored.has('perf-fixtures')).toBe(true);
    expect(rules.names.has('perf-fixtures')).toBe(false);
    expect(rules.names.has('perf-cache')).toBe(true);
  });

  it('walks a directory the gitignore names with a wildcard path, rather than skipping it', () => {
    const rules = outputDirRules('packages/*/coverage/\n');
    expect(rules.anchored.size).toBe(0);
    expect(rules.names.size).toBe(0);
  });

  it('takes its rules from the gitignore beside the root it walks when none are passed', () => {
    withTree(
      {
        '.gitignore': 'generated/\nreport-*/\npackages/b/out/\n',
        'tsconfig.json': {},
        'packages/a/tsconfig.build.json': {},
        'packages/a/generated/tsconfig.json': {},
        'packages/a/report-ci/tsconfig.json': {},
        'packages/b/out/tsconfig.json': {},
        'packages/a/out/tsconfig.json': {},
      },
      (dir) => {
        expect(tsconfigFiles(dir).files).toEqual([
          'packages/a/out/tsconfig.json',
          'packages/a/tsconfig.build.json',
          'tsconfig.json',
        ]);
      },
    );
  });

  it('walks every directory when no gitignore sits beside the root', () => {
    withTree({ 'tsconfig.json': {}, 'packages/a/dist/tsconfig.json': {} }, (dir) => {
      expect(tsconfigFiles(dir).files).toEqual(['packages/a/dist/tsconfig.json', 'tsconfig.json']);
    });
  });

  it('skips the nested build output at its one declared path, with or without a root gitignore', () => {
    expect(NESTED_BUILD_OUTPUTS).toEqual(['packages/native-config/target']);
    const files = {
      'tsconfig.json': {},
      'packages/native-config/target/tsconfig.json': {},
      'packages/native-config/tsconfig.json': {},
      'packages/other/target/tsconfig.json': {},
    };
    const listed = [
      'packages/native-config/tsconfig.json',
      'packages/other/target/tsconfig.json',
      'tsconfig.json',
    ];
    withTree(files, (dir) => {
      expect(tsconfigFiles(dir).files).toEqual(listed);
    });
    withTree({ ...files, '.gitignore': 'dist/\n' }, (dir) => {
      expect(tsconfigFiles(dir).files).toEqual(listed);
    });
  });

  it('drops a root-anchored wildcard pattern rather than turning it into a bare prefix', () => {
    const rules = outputDirRules('/report-*/\nreport-*/\n');
    expect(rules.anchored.size).toBe(0);
    expect(rules.prefixes).toEqual(['report-']);
  });

  const rootGitignore = path.join(OK_ROOT, '.gitignore');

  it.runIf(fs.existsSync(rootGitignore))(
    'derives real rules from whichever gitignore sits beside the walk root',
    () => {
      const real = outputDirRules(fs.readFileSync(rootGitignore, 'utf8'));
      expect(real.names.has('dist')).toBe(true);
      expect(real.names.has('out')).toBe(false);
      expect(real.anchored.has('packages/desktop/out')).toBe(true);
      expect(real.names.has('target')).toBe(false);
    },
  );

  const nativeConfigGitignore = path.join(OK_ROOT, 'packages/native-config/.gitignore');

  it.runIf(fs.existsSync(nativeConfigGitignore))(
    'carves out the one nested build output its own gitignore anchors without a trailing slash',
    () => {
      expect(fs.readFileSync(nativeConfigGitignore, 'utf8')).toMatch(/^\/target$/m);
    },
  );

  it.runIf(fs.existsSync(path.join(OK_ROOT, 'specs')))(
    'derives the subtree record in full when the walk root is the subtree itself',
    () => {
      const real = outputDirRules(fs.readFileSync(rootGitignore, 'utf8'));
      expect(real.prefixes).toEqual(
        expect.arrayContaining([
          'playwright-report-',
          'test-results-',
          'desktop-smoke-report-',
          'desktop-smoke-test-results-',
        ]),
      );
      expect(real.anchored.has('packages/desktop/build/parcel-watcher-staging')).toBe(true);
      expect(real.anchored.has('perf-fixtures')).toBe(true);
      expect(real.names.has('perf-fixtures')).toBe(false);
    },
  );

  it('reports a directory it cannot list rather than walking past it', () => {
    const { files, blind } = tsconfigFiles('/ok', () => {
      throw new Error('EACCES');
    });

    expect(files).toEqual([]);
    expect(blind).toHaveLength(1);
    expect(blind[0]).toContain('could not be listed (EACCES)');
    expect(blind[0]).toContain('could sit there unseen');
  });
});

describe('tsconfigConditions', () => {
  it('reports every config that declares the key, and only those, with the value it declares', () => {
    withTree(
      {
        'tsconfig.json': { compilerOptions: { customConditions: [SOURCE_CONDITION] } },
        'packages/a/tsconfig.json': { compilerOptions: { customConditions: [] } },
        'packages/b/tsconfig.build.json': { compilerOptions: { customConditions: null } },
        'packages/c/tsconfig.json': { compilerOptions: { strict: true } },
        'packages/d/tsconfig.json': { extends: '../../tsconfig.json' },
      },
      (dir) => {
        expect(tsconfigConditions(dir, tsconfigFiles(dir).files)).toEqual({
          blind: [],
          sites: [
            ['packages/a/tsconfig.json', []],
            ['packages/b/tsconfig.build.json', null],
            ['tsconfig.json', [SOURCE_CONDITION]],
          ],
        });
      },
    );
  });

  it('reads a config through its comments rather than calling it condition-less', () => {
    withTree(
      {
        'packages/a/tsconfig.json':
          '{\n  // a stray reset hiding under a comment\n  "compilerOptions": { "customConditions": [] },\n}\n',
      },
      (dir) => {
        expect(tsconfigConditions(dir, tsconfigFiles(dir).files).sites).toEqual([
          ['packages/a/tsconfig.json', []],
        ]);
      },
    );
  });

  it('reports an unparseable config as a blind spot rather than as no conditions', () => {
    withTree({ 'packages/a/tsconfig.json': '{ "compilerOptions": ' }, (dir) => {
      const { sites, blind } = tsconfigConditions(dir, tsconfigFiles(dir).files);

      expect(sites).toEqual([]);
      expect(blind).toHaveLength(1);
      expect(blind[0]).toContain('malformed rather than merely commented');
    });
  });
});

describe('the tsconfigs on disk', () => {
  it('declares customConditions only in the base config and in configs that reset it', () => {
    const listed = tsconfigFiles(OK_ROOT);
    const declared = tsconfigConditions(OK_ROOT, listed.files);

    expect(listed.blind).toEqual([]);
    expect(declared.blind).toEqual([]);
    expect(declared.sites).toEqual([
      ['packages/cli/tsconfig.build.json', []],
      ['packages/cli/tsconfig.check.json', []],
      ['packages/core/tsconfig.build.json', []],
      ['packages/server/tsconfig.build.json', []],
      ['tsconfig.json', [SOURCE_CONDITION]],
    ]);
    expect(checkTsconfigConditions(declared.sites)).toEqual([]);
  });
});
