import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { derivedReads, deriveReadClosure } from './read-declarations-closure';
import { declares } from './read-declarations-match';
import { createTempDirFactory } from './temp-dir.test-helper';

const makeTempDir = createTempDirFactory(afterAll);

function tree(files: Record<string, string>): string {
  const root = makeTempDir('ok-read-closure-');
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

const everyPath = (glob: string, path: string): boolean => glob === path;

describe('what a declared root loads, derived from its module graph', () => {
  test('a root brings in its static imports, re-exports, literal dynamic imports and JSON imports, and no module it reaches only through a computed specifier', () => {
    const root = tree({
      'start.ts': [
        "import { a } from './a.ts';",
        "export * from './b.ts';",
        "import data from './data.json' with { type: 'json' };",
        "const name = 'computed';",
        "await import('./' + name + '.ts');",
        "await import('./c.ts');",
        'export const all = [a, data];',
        '',
      ].join('\n'),
      'a.ts': "import { deep } from './nested/deep.ts';\nexport const a = deep;\n",
      'nested/deep.ts': 'export const deep = 1;\n',
      'b.ts': 'export const b = 2;\n',
      'c.ts': 'export const c = 3;\n',
      'data.json': '{ "value": 4 }\n',
      'computed.ts': 'export const computed = 5;\n',
      'unrelated.ts': 'export const unrelated = 6;\n',
    });
    expect(deriveReadClosure(root, ['start.ts'])).toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
      'data.json',
      'nested/deep.ts',
      'start.ts',
    ]);
  });

  test('a CommonJS root brings in what it requires, through CommonJS and TypeScript modules alike', () => {
    const root = tree({
      'owner.cjs': "require('./lease.cjs');\nrequire('./server.ts');\n",
      'lease.cjs': "require('./clock.cjs');\nmodule.exports = {};\n",
      'clock.cjs': 'module.exports = {};\n',
      'server.ts': "import { port } from './port.ts';\nexport const server = port;\n",
      'port.ts': 'export const port = 0;\n',
    });
    expect(deriveReadClosure(root, ['owner.cjs'])).toEqual([
      'clock.cjs',
      'lease.cjs',
      'owner.cjs',
      'port.ts',
      'server.ts',
    ]);
  });

  test("a root brings in what it imports through its package's tsconfig path alias, and what that module imports in turn", () => {
    const root = tree({
      'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
      'packages/app/tsconfig.json': [
        '{',
        '  "extends": "../../tsconfig.json",',
        '  // the editor package',
        '  "compilerOptions": {',
        '    "allowImportingTsExtensions": true,',
        '    "paths": { "@/*": ["./src/*"] }',
        '  }',
        '}',
        '',
      ].join('\n'),
      'packages/app/tests/start.ts': "import { x } from '@/lib/x.ts';\nexport const seen = x;\n",
      'packages/app/src/lib/x.ts': "import { y } from './y.ts';\nexport const x = y;\n",
      'packages/app/src/lib/y.ts': 'export const y = 1;\n',
      'packages/app/src/lib/unused.ts': 'export const unused = 2;\n',
    });
    expect(deriveReadClosure(root, ['packages/app/tests/start.ts'])).toEqual([
      'packages/app/src/lib/x.ts',
      'packages/app/src/lib/y.ts',
      'packages/app/tests/start.ts',
    ]);
  });

  test('a tsconfig above the tree does not govern a root inside it', () => {
    const outer = tree({
      'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./tree/src/*"] } } }\n',
      'tree/start.ts': "import { x } from '@/x.ts';\nexport const seen = x;\n",
      'tree/src/x.ts': 'export const x = 1;\n',
    });
    expect(deriveReadClosure(outer, ['tree/start.ts'])).toEqual(['tree/src/x.ts', 'tree/start.ts']);
    expect(deriveReadClosure(join(outer, 'tree'), ['start.ts'])).toEqual(['start.ts']);
  });

  test('compiler options this TypeScript does not know leave the tsconfig path alias in force', () => {
    const root = tree({
      'tsconfig.json':
        '{ "compilerOptions": { "checkers": 4, "builders": 2, "paths": { "@/*": ["./src/*"] } } }\n',
      'tests/start.ts': "import { x } from '@/x.ts';\nexport const seen = x;\n",
      'src/x.ts': 'export const x = 1;\n',
    });
    expect(deriveReadClosure(root, ['tests/start.ts'])).toEqual(['src/x.ts', 'tests/start.ts']);
  });

  test('a root whose tsconfig, or a config that tsconfig extends, cannot be read is refused, naming that tsconfig', () => {
    const root = tree({
      'truncated/tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"]\n',
      'truncated/start.ts': 'export const start = 1;\n',
      'orphaned/tsconfig.json': '{ "extends": "./missing.json" }\n',
      'orphaned/start.ts': 'export const start = 2;\n',
    });
    expect(() => deriveReadClosure(root, ['truncated/start.ts'])).toThrow(
      'truncated/tsconfig.json',
    );
    expect(() => deriveReadClosure(root, ['orphaned/start.ts'])).toThrow('orphaned/tsconfig.json');
  });

  test('the walk stops at node_modules, so a package that imports back into the tree adds nothing', () => {
    const root = tree({
      'start.mjs': "import 'pkg';\n",
      'node_modules/pkg/package.json': '{ "name": "pkg", "main": "index.js" }\n',
      'node_modules/pkg/index.js': "import '../../local.mjs';\n",
      'local.mjs': 'export const local = 1;\n',
    });
    expect(deriveReadClosure(root, ['start.mjs'])).toEqual(['start.mjs']);
  });

  test('derived reads keep only the files the listing holds, and a root glob that matches none is refused by name', () => {
    const root = tree({
      'start.mjs': "import './kept.mjs';\nimport './ignored.mjs';\n",
      'kept.mjs': 'export {};\n',
      'ignored.mjs': 'export {};\n',
    });
    const listed = new Set(['start.mjs', 'kept.mjs']);
    expect(derivedReads(root, ['start.mjs'], listed, everyPath)).toEqual(['kept.mjs', 'start.mjs']);
    expect(() => derivedReads(root, ['missing.mjs'], listed, everyPath)).toThrow(
      'the root glob "missing.mjs" matches no file in this tree',
    );
  });

  test('every listed file a root glob matches is a derived read, so a shell or Python script root covers itself and nothing it runs', () => {
    const files = {
      'scripts/start.mjs': "import './helper.mjs';\n",
      'scripts/helper.mjs': 'export {};\n',
      'scripts/run.sh': '#!/bin/sh\nnode scripts/ran.mjs\n',
      'scripts/ran.mjs': 'export {};\n',
      'scripts/probe.py': 'print(1)\n',
      'tools/check.sh': 'exit 0\n',
      'tools/check.ts': 'export {};\n',
      'tools/unlisted.sh': 'exit 0\n',
    };
    const root = tree(files);
    const listed = new Set(Object.keys(files).filter((path) => path !== 'tools/unlisted.sh'));
    const globMatches = (glob: string, path: string): boolean =>
      declares({ include: [glob] }, path);
    expect(
      derivedReads(
        root,
        ['scripts/start.mjs', 'scripts/run.sh', 'scripts/probe.py', 'tools/*'],
        listed,
        globMatches,
      ),
    ).toEqual([
      'scripts/helper.mjs',
      'scripts/probe.py',
      'scripts/run.sh',
      'scripts/start.mjs',
      'tools/check.sh',
      'tools/check.ts',
    ]);
  });
});
