import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  collectViolations,
  compareVersions,
  expandPackagePattern,
  findFloorViolations,
  parseExactOverrides,
  parseOverrideBlockLines,
  parsePackagePatterns,
  rangeFloor,
  WORKSPACE_DEPENDENCY_FIELDS,
  workspaceManifests,
} from './check-override-floors.mjs';

const WORKSPACE = [
  'packages:',
  "  - 'packages/*'",
  '',
  'overrides:',
  '  # a comment',
  "  'undici@7': ~7.29.0",
  "  '@codemirror/state': 6.7.1",
  "  '@codemirror/view': 6.43.3",
  "  'sharp@0.34': ~0.35.0",
  "  '@radix-ui/primitive': 1.1.4",
  '  prosemirror-model: 1.25.4',
  '  react: 19.2.5',
  '  "@types/node": ^24.7.0',
  '  "quoted-exact": 2.0.1',
  '  trailing-note: 3.1.0 # kept until the upstream fix lands',
  "  quoted-value: '4.2.0'",
  '',
  'packageExtensions:',
  "  'foo': 1.0.0",
].join('\n');

describe('parseExactOverrides', () => {
  const parsed = parseExactOverrides(WORKSPACE);

  it('keeps single-quoted keys pinned to an exact version', () => {
    expect(parsed.get('@codemirror/state')).toBe('6.7.1');
    expect(parsed.get('@codemirror/view')).toBe('6.43.3');
    expect(parsed.get('@radix-ui/primitive')).toBe('1.1.4');
  });

  it('keeps BARE and double-quoted keys too', () => {
    expect(parsed.get('prosemirror-model')).toBe('1.25.4');
    expect(parsed.get('react')).toBe('19.2.5');
    expect(parsed.get('quoted-exact')).toBe('2.0.1');
  });

  it('keeps a pin that grew a trailing comment', () => {
    expect(parsed.get('trailing-note')).toBe('3.1.0');
  });

  it('keeps a quoted VALUE, which would otherwise be reclassified as a range', () => {
    expect(parsed.get('quoted-value')).toBe('4.2.0');
  });

  it('skips version-selector keys and non-exact values', () => {
    expect(parsed.has('undici@7')).toBe(false);
    expect(parsed.has('sharp@0.34')).toBe(false);
    expect(parsed.has('@types/node')).toBe(false);
    expect(parsed.size).toBe(8);
  });

  it('stops at the end of the overrides block', () => {
    expect(parsed.has('foo')).toBe(false);
  });

  it('returns nothing when there is no overrides block', () => {
    expect(parseExactOverrides('packages:\n  - a\n').size).toBe(0);
  });
});

describe('parseOverrideBlockLines against the real pnpm-workspace.yaml', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const yamlText = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');

  function blockEntryLines() {
    const out = [];
    let inBlock = false;
    for (const line of yamlText.split('\n')) {
      if (/^overrides:\s*$/.test(line)) {
        inBlock = true;
        continue;
      }
      if (!inBlock) continue;
      if (line.trim() !== '' && !/^\s/.test(line)) break;
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      out.push(line);
    }
    return out;
  }

  it('reads every mapping line in the block, dropping none silently', () => {
    const lines = blockEntryLines();
    expect(lines.length).toBeGreaterThan(100);
    expect(parseOverrideBlockLines(yamlText)).toHaveLength(lines.length);
  });

  it('classifies the real block the way the header says it does', () => {
    const exact = parseExactOverrides(yamlText);
    expect(exact.get('@codemirror/state')).toMatch(/^\d+\.\d+\.\d+$/);
    expect(exact.get('@codemirror/view')).toMatch(/^\d+\.\d+\.\d+$/);
    expect(exact.get('react')).toMatch(/^\d+\.\d+\.\d+$/);
    expect(exact.has('undici@7')).toBe(false);
    expect(exact.has('@types/node')).toBe(false);
    expect(exact.has('@opentelemetry/core@2')).toBe(false);
  });
});

describe('parsePackagePatterns / expandPackagePattern', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  it('reads the block the real workspace uses', () => {
    expect(parsePackagePatterns("packages:\n  - 'packages/*'\n  - 'docs'\n\noverrides:\n  a: 1.0.0\n")).toEqual({
      patterns: ['packages/*', 'docs'],
      unparsed: [],
    });
  });

  it('reads the REAL block, not just a synthetic one', () => {
    const yamlText = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    const { patterns, unparsed } = parsePackagePatterns(yamlText);
    expect(unparsed).toEqual([]);
    expect(patterns).toEqual(['packages/*', 'docs']);
    expect(expandPackagePattern(root, 'packages/*')?.length).toBe(
      fs.readdirSync(path.join(root, 'packages')).length,
    );
  });

  it('keeps a pattern that grew a trailing comment', () => {
    expect(parsePackagePatterns("packages:\n  - 'packages/*' # both roots\n").patterns).toEqual(['packages/*']);
  });

  it('reports a list entry it cannot read instead of dropping it', () => {
    expect(parsePackagePatterns('packages:\n  - {weird: shape}\n  - docs\n')).toEqual({
      patterns: ['docs'],
      unparsed: ['- {weird: shape}'],
    });
  });

  it('declines a shape it cannot expand instead of yielding nothing', () => {
    for (const pattern of ['packages/**', 'packages/*/src', '!packages/legacy', 'packages/*-ui']) {
      expect(expandPackagePattern('/tmp', pattern), pattern).toBeNull();
    }
  });

  it('expands a bare directory without touching the disk', () => {
    expect(expandPackagePattern('/tmp', 'docs')).toEqual([path.join('/tmp', 'docs')]);
  });

  it('yields nothing for a glob whose parent is absent, which is not a shape error', () => {
    expect(expandPackagePattern('/tmp/definitely-not-here', 'packages/*')).toEqual([]);
  });
});

describe('rangeFloor', () => {
  it('reads the floor of the four supported syntaxes', () => {
    expect(rangeFloor('^6.7.0')).toBe('6.7.0');
    expect(rangeFloor('~1.1.4')).toBe('1.1.4');
    expect(rangeFloor('>=2.0.1')).toBe('2.0.1');
    expect(rangeFloor('1.2.3')).toBe('1.2.3');
    expect(rangeFloor(' ^6.7.0 ')).toBe('6.7.0');
  });

  it('declines rather than guesses on anything else', () => {
    for (const range of ['*', 'latest', '>1.0.0 <2.0.0', '1.x', '^1.2', 'workspace:*', '', '^18 || ^19']) {
      expect(rangeFloor(range)).toBeNull();
    }
  });
});

describe('compareVersions', () => {
  it('orders by numeric component, not lexically', () => {
    expect(compareVersions('6.10.0', '6.9.0')).toBeGreaterThan(0);
    expect(compareVersions('6.6.0', '6.7.0')).toBeLessThan(0);
    expect(compareVersions('6.7.1', '6.7.1')).toBe(0);
  });

  it('sorts a prerelease below its release', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
  });

  it('compares prerelease identifiers per semver, not as whole strings', () => {
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.2')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-beta')).toBeLessThan(0);
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0);
  });
});

describe('findFloorViolations', () => {
  const view = {
    name: '@codemirror/view',
    version: '6.43.3',
    dependencies: { '@codemirror/state': '^6.7.0', crelt: '^1.0.6' },
  };

  it('flags an override pinned below a declared floor', () => {
    expect(findFloorViolations(new Map([['@codemirror/state', '6.6.0']]), [view])).toEqual([
      {
        dependant: '@codemirror/view@6.43.3',
        field: 'dependencies',
        dep: '@codemirror/state',
        range: '^6.7.0',
        floor: '6.7.0',
        pinned: '6.6.0',
      },
    ]);
  });

  it('passes once the override satisfies the floor', () => {
    expect(findFloorViolations(new Map([['@codemirror/state', '6.7.1']]), [view])).toEqual([]);
    expect(findFloorViolations(new Map([['@codemirror/state', '6.7.0']]), [view])).toEqual([]);
  });

  it('reads peerDependencies, the only place React libraries declare a floor', () => {
    const lib = { name: 'some-react-lib', version: '1.0.0', peerDependencies: { react: '^19.3.0' } };
    const found = findFloorViolations(new Map([['react', '19.2.5']]), [lib]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ field: 'peerDependencies', dep: 'react', floor: '19.3.0' });
  });

  it('reads optionalDependencies', () => {
    const lib = { name: 'next', version: '16.2.11', optionalDependencies: { sharp: '^0.36.0' } };
    const found = findFloorViolations(new Map([['sharp', '0.35.0']]), [lib]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ field: 'optionalDependencies', floor: '0.36.0' });
  });

  it('ignores a peer marked optional, which the dependant runs without', () => {
    const lib = {
      name: 'opt',
      version: '1.0.0',
      peerDependencies: { react: '^19.3.0' },
      peerDependenciesMeta: { react: { optional: true } },
    };
    expect(findFloorViolations(new Map([['react', '19.2.5']]), [lib])).toEqual([]);
  });

  it('ignores pinning ABOVE a dependant exact pin, which is the normal use of an override', () => {
    const radix = {
      name: '@radix-ui/react-dialog',
      version: '1.1.15',
      dependencies: { '@radix-ui/primitive': '1.1.3' },
    };
    expect(findFloorViolations(new Map([['@radix-ui/primitive', '1.1.4']]), [radix])).toEqual([]);
  });

  it('reads a workspace member devDependency, which is installed unlike a third party one', () => {
    const member = {
      name: '@inkeep/open-knowledge-app',
      version: '0.67.0',
      devDependencies: { '@tiptap/starter-kit': '^3.23.0' },
    };
    expect(findFloorViolations(new Map([['@tiptap/starter-kit', '3.22.3']]), [member])).toEqual([]);
    const found = findFloorViolations(
      new Map([['@tiptap/starter-kit', '3.22.3']]),
      [member],
      WORKSPACE_DEPENDENCY_FIELDS,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ field: 'devDependencies', floor: '3.23.0' });
  });

  it('ignores packages that carry no override', () => {
    expect(findFloorViolations(new Map([['unrelated', '1.0.0']]), [view])).toEqual([]);
  });

  it('skips ranges it cannot interpret rather than reporting them', () => {
    const odd = { name: 'odd', version: '1.0.0', dependencies: { dep: '>1.0.0 <3.0.0' } };
    expect(findFloorViolations(new Map([['dep', '0.1.0']]), [odd])).toEqual([]);
  });

  it('reports each dependant once even when the manifest is seen repeatedly', () => {
    expect(findFloorViolations(new Map([['@codemirror/state', '6.6.0']]), [view, view, view])).toHaveLength(1);
  });

  it('names a versionless manifest without an undefined in it', () => {
    const [violation] = findFloorViolations(
      new Map([['pinned', '1.0.0']]),
      [{ name: 'open-knowledge', devDependencies: { pinned: '^2.0.0' } }],
      WORKSPACE_DEPENDENCY_FIELDS,
    );
    expect(violation.dependant).toBe('open-knowledge');
  });

  it('tolerates manifests with no dependency fields', () => {
    expect(findFloorViolations(new Map([['a', '1.0.0']]), [{ name: 'x', version: '1' }, null])).toEqual([]);
  });
});

describe('collectViolations', () => {
  it('gives the workspace bucket the wider field list and the installed bucket the narrower one', () => {
    const third = { name: 'third-party', version: '1.0.0', devDependencies: { pinned: '^2.0.0' } };
    const member = { name: '@inkeep/member', version: '0.1.0', devDependencies: { pinned: '^2.0.0' } };
    const found = collectViolations(new Map([['pinned', '1.0.0']]), {
      installed: [third],
      workspace: [member],
    });
    expect(found).toEqual([
      expect.objectContaining({ dependant: '@inkeep/member@0.1.0', field: 'devDependencies' }),
    ]);
  });
});

describe('workspaceManifests', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const refuse = (value) => {
    throw new Error(`unexpected callback: ${value}`);
  };

  it('reads the workspace root alongside the members', () => {
    const yamlText = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    const names = [...workspaceManifests(root, yamlText, refuse, refuse)].map((m) => m.name);
    expect(names).toContain('open-knowledge');
    expect(names).toContain('@inkeep/open-knowledge-app');
  });

  it('reports an empty corpus even though the root always parses', () => {
    const empty = [];
    const yielded = [
      ...workspaceManifests(root, 'packages: # roots\n  - undetected\n', refuse, (p) => empty.push(p)),
    ];
    expect(yielded.map((m) => m.name)).toEqual(['open-knowledge']);
    expect(empty).toEqual(['the packages: block itself']);
  });

  it('counts members AFTER reading them, so a directory with no package.json is empty', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'override-floors-'));
    try {
      fs.mkdirSync(path.join(tmp, 'pkgs', 'half-deleted'), { recursive: true });
      const empty = [];
      const yielded = [...workspaceManifests(tmp, "packages:\n  - 'pkgs/*'\n", refuse, (p) => empty.push(p))];
      expect(empty).toEqual(['pkgs/*']);
      expect(yielded).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('names the pattern that went empty, not just the total', () => {
    const empty = [];
    const yaml = "packages:\n  - 'workspaces/*'\n  - 'docs'\n";
    const names = [...workspaceManifests(root, yaml, refuse, (p) => empty.push(p))].map((m) => m.name);
    expect(empty).toEqual(['workspaces/*']);
    expect(names).toContain('@inkeep/open-knowledge-docs');
  });
});

describe('wiring', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  it('stays registered in the check:drift:guards chain', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['check:drift:guards']).toContain('node scripts/check-override-floors.mjs');
  });

});
