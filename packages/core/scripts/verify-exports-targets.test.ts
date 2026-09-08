import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectExportTargets,
  jsBelowDistTopLevel,
  nestedRelativeImports,
  REQUIRED_CONDITIONS,
  validateExportsTargets,
  verifyExportsTargets,
} from './verify-exports-targets.mjs';

type ExportTarget = { subpath: string; condition: string; target: string };

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CORE_EXPORTS = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  .exports as Record<string, Record<string, string>>;

const allExist = () => true;

const scratchRoots: string[] = [];

const makePackageRoot = (packageJson: unknown, files: string[]) => {
  const root = mkdtempSync(join(tmpdir(), 'ok-exports-targets-'));
  scratchRoots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify(packageJson));
  for (const file of files) {
    const absolute = join(root, file);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, 'export {};\n');
  }
  return root;
};

afterEach(() => {
  while (scratchRoots.length > 0) {
    rmSync(scratchRoots.pop() as string, { recursive: true, force: true });
  }
});

describe('collectExportTargets', () => {
  it('flattens every subpath and condition of the real core exports map', () => {
    const targets = collectExportTargets(CORE_EXPORTS) as ExportTarget[];

    const expected = Object.entries(CORE_EXPORTS).flatMap(([subpath, conditions]) =>
      Object.entries(conditions).map(([condition, target]) => ({ subpath, condition, target })),
    );

    expect(targets).toEqual(expected);
    expect(targets.length).toBeGreaterThan(0);
  });

  it('descends into nested condition objects and arrays', () => {
    expect(
      collectExportTargets({
        '.': { node: { types: './dist/a.d.mts', default: './dist/a.mjs' } },
        './b': { default: ['./dist/b.mjs'] },
      }),
    ).toEqual([
      { subpath: '.', condition: 'types', target: './dist/a.d.mts' },
      { subpath: '.', condition: 'default', target: './dist/a.mjs' },
      { subpath: './b', condition: 'default', target: './dist/b.mjs' },
    ]);
  });
});

describe('validateExportsTargets', () => {
  const map = {
    '.': { types: './dist/index.d.mts', default: './dist/index.mjs' },
    './acp/agent-posture': {
      types: './dist/acp-agent-posture.d.mts',
      default: './dist/acp-agent-posture.mjs',
    },
  };

  it('accepts the real core exports map when every target is on disk', () => {
    expect(validateExportsTargets(CORE_EXPORTS, allExist, () => '')).toEqual([]);
  });

  it('reds when a declarations target is missing', () => {
    expect(
      validateExportsTargets(
        map,
        (target: string) => target !== './dist/acp-agent-posture.d.mts',
        () => '',
      ),
    ).toEqual([
      'exports["./acp/agent-posture"].types points at ./dist/acp-agent-posture.d.mts, which is not a non-empty file on disk',
    ]);
  });

  it('reds when a runtime target is missing, which is the entry-rename failure mode', () => {
    expect(
      validateExportsTargets(
        map,
        (target: string) => target !== './dist/acp-agent-posture.mjs',
        () => '',
      ),
    ).toEqual([
      'exports["./acp/agent-posture"].default points at ./dist/acp-agent-posture.mjs, which is not a non-empty file on disk',
    ]);
  });

  it('reds once per required condition a subpath fails to declare', () => {
    expect(
      validateExportsTargets({ './server': { default: './dist/server.mjs' } }, allExist, () => ''),
    ).toEqual(['exports["./server"] declares no "types" condition']);
    expect(REQUIRED_CONDITIONS).toEqual(['types', 'default']);
  });

  it('reds on a target that is not a relative path', () => {
    expect(
      validateExportsTargets(
        { '.': { types: 'dist/index.d.mts', default: './dist/index.mjs' } },
        allExist,
        () => '',
      ),
    ).toEqual(['exports["."].types is "dist/index.d.mts", not a "./" relative path']);
  });

  it('reds when the exports map is absent or empty', () => {
    expect(validateExportsTargets(undefined, allExist, () => '')).toEqual([
      'package.json has no exports map',
    ]);
    expect(validateExportsTargets({}, allExist, () => '')).toEqual([
      'package.json exports map is empty',
    ]);
  });
});

describe('nestedRelativeImports', () => {
  it('reports only multi-segment relative specifiers', () => {
    const source = [
      'import { a } from "./sleep-B-7-ikbJ.mjs";',
      'import "./bridge/diff-lines.mjs";',
      'import { b } from "../core/x.mjs";',
      'import { c } from "zod";',
    ].join('\n');
    expect(nestedRelativeImports(source)).toEqual(['./bridge/diff-lines.mjs', '../core/x.mjs']);
  });
});

describe('validateExportsTargets flat JS closure', () => {
  const map = {
    '.': { types: './dist/index.d.mts', import: './dist/index.mjs', default: './dist/index.mjs' },
  };
  const allExist = () => true;

  it('is silent when the default target imports only flat siblings', () => {
    const read = () => 'import { x } from "./ok-dir-B1t7FLiw.mjs";';
    expect(validateExportsTargets(map, allExist, read)).toEqual([]);
  });

  it('reds when the default target imports a nested path, the shape an unbundled JS pass emits', () => {
    const read = () => 'import { diffLinesFast } from "./bridge/diff-lines.mjs";';
    const errors = validateExportsTargets(map, allExist, read);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('./bridge/diff-lines.mjs');
    expect(errors[0]).toContain('flat siblings');
  });

  it('reads only JS-valued targets, whatever their condition', () => {
    const seen: string[] = [];
    const read = (target: string) => {
      seen.push(target);
      return '';
    };
    validateExportsTargets(map, allExist, read);
    expect(seen).toEqual(['./dist/index.mjs']);
  });
});

describe('jsBelowDistTopLevel', () => {
  it('lists only JS files that sit below the dist top level', () => {
    const root = mkdtempSync(join(tmpdir(), 'exports-dist-'));
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'bridge'), { recursive: true });
    writeFileSync(join(dist, 'index.mjs'), 'export {};\n');
    writeFileSync(join(dist, 'index.d.mts'), 'export {};\n');
    writeFileSync(join(dist, 'bridge', 'diff-lines.mjs'), 'export {};\n');
    writeFileSync(join(dist, 'bridge', 'diff-lines.d.mts'), 'export {};\n');
    try {
      expect(jsBelowDistTopLevel(dist)).toEqual(['bridge/diff-lines.mjs']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('verifyExportsTargets', () => {
  const packageJson = {
    name: '@inkeep/open-knowledge-core-fixture',
    exports: {
      '.': {
        '@inkeep/source': './src/index.ts',
        types: './dist/index.d.mts',
        default: './dist/index.mjs',
      },
    },
  };
  const files = ['src/index.ts', 'dist/index.d.mts', 'dist/index.mjs'];

  it('passes when every declared target is a non-empty file', () => {
    expect(() => verifyExportsTargets(makePackageRoot(packageJson, files))).not.toThrow();
  });

  it('throws naming the missing file when a dist target is absent', () => {
    const root = makePackageRoot(
      packageJson,
      files.filter((file) => file !== 'dist/index.mjs'),
    );

    expect(() => verifyExportsTargets(root)).toThrow(
      /exports\["\."\]\.default points at \.\/dist\/index\.mjs/,
    );
  });

  it('throws when a dist target exists but is empty', () => {
    const root = makePackageRoot(packageJson, files);
    writeFileSync(join(root, 'dist/index.d.mts'), '');

    expect(() => verifyExportsTargets(root)).toThrow(
      /exports\["\."\]\.types points at \.\/dist\/index\.d\.mts/,
    );
  });
  it('throws when the runtime target imports a nested path, so the real reader is wired', () => {
    const root = makePackageRoot(packageJson, files);
    writeFileSync(join(root, 'dist/index.mjs'), 'import { d } from "./bridge/diff-lines.mjs";\n');
    try {
      expect(() => verifyExportsTargets(root)).toThrow(/flat siblings/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws when dist carries JS below its top level, the shape a dist-relative vendor write into a flat directory cannot take', () => {
    const root = makePackageRoot(packageJson, files);
    mkdirSync(join(root, 'dist/bridge'), { recursive: true });
    writeFileSync(join(root, 'dist/bridge/diff-lines.mjs'), 'export {};\n');
    try {
      expect(() => verifyExportsTargets(root)).toThrow(/below its top level/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
