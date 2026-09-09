import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { classifyComment, DIRECTIVE_PATTERNS } from './allowlist.mjs';
import { extractComments } from './extract.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function listDirectories(relPath) {
  try {
    return readdirSync(join(REPO_ROOT, relPath), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${relPath}/${entry.name}`);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

const WORKSPACE_MANIFESTS = ['.', 'docs', ...listDirectories('packages')]
  .map((dir) => ({ dir, manifest: readJson(dir === '.' ? 'package.json' : `${dir}/package.json`) }))
  .filter((entry) => entry.manifest !== null);

const LOCKFILE = readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8');

function manifestsDeclaring(name) {
  return WORKSPACE_MANIFESTS.filter(({ manifest }) =>
    DEPENDENCY_FIELDS.some((field) => manifest[field]?.[name] !== undefined),
  );
}

function snapshotResolves(carrier, dependency) {
  const snapshots = LOCKFILE.slice(LOCKFILE.indexOf('\nsnapshots:\n'));
  const entry = new RegExp(
    `\\n  ${carrier}@[^\\n]*:\\n(?<body>(?:    [^\\n]*\\n|\\n)+)`,
    'g',
  );
  for (const match of snapshots.matchAll(entry)) {
    if (new RegExp(`^      ${dependency}: \\S`, 'm').test(match.groups.body)) return true;
  }
  return false;
}

const RESOLVERS = {
  declared(consumer) {
    const declaring = manifestsDeclaring(consumer.package);
    expect(declaring.map(({ dir }) => dir), `nothing declares ${consumer.package}`).not.toEqual([]);
    const invoking = declaring.filter(({ manifest }) => manifest.scripts?.[consumer.invokedBy]);
    expect(
      invoking.map(({ dir }) => dir),
      `no package declaring ${consumer.package} runs a "${consumer.invokedBy}" script`,
    ).not.toEqual([]);
  },
  transitive(consumer) {
    const declaring = manifestsDeclaring(consumer.via);
    expect(declaring.map(({ dir }) => dir), `nothing declares ${consumer.via}`).not.toEqual([]);
    const invoking = declaring.filter(({ manifest }) => manifest.scripts?.[consumer.invokedBy]);
    expect(
      invoking.map(({ dir }) => dir),
      `no package declaring ${consumer.via} runs a "${consumer.invokedBy}" script`,
    ).not.toEqual([]);
    expect(
      snapshotResolves(consumer.via, consumer.package),
      `the lockfile does not resolve ${consumer.package} under ${consumer.via}`,
    ).toBe(true);
  },
  latent(consumer) {
    const present = consumer.packages.filter((name) => manifestsDeclaring(name).length > 0);
    expect(present, 'a latent consumer arrived; promote this row to a declared claim').toEqual([]);
    expect(consumer.activatesWhen.length).toBeGreaterThan(0);
  },
  external(consumer) {
    expect(consumer.consumer.length).toBeGreaterThan(0);
    expect(consumer.admittedOn.length).toBeGreaterThan(0);
  },
};

function tsconfigSources() {
  const sources = ['.', 'docs', ...listDirectories('packages')]
    .map((dir) => (dir === '.' ? 'tsconfig.json' : `${dir}/tsconfig.json`))
    .map((path) => {
      try {
        return readFileSync(join(REPO_ROOT, path), 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    })
    .filter((source) => source !== null);
  expect(sources.length).toBeGreaterThan(0);
  return sources;
}

describe('every admitted directive shape names a consumer this repo runs', () => {
  test('the workspace surface the claims resolve against is really there', () => {
    expect(WORKSPACE_MANIFESTS.length).toBeGreaterThan(3);
    expect(LOCKFILE).toContain('\nsnapshots:\n');
  });

  test.each(DIRECTIVE_PATTERNS.map((pattern) => [pattern.id, pattern]))(
    '%s carries a claim, a reach verdict, and the shapes it governs',
    (_id, pattern) => {
      expect(pattern.shapes.length).toBeGreaterThan(0);
      expect(Object.keys(RESOLVERS)).toContain(pattern.consumer.kind);
      expect(['reached', 'unreached', 'latent']).toContain(pattern.reach.verdict);
      if (pattern.reach.verdict !== 'reached') {
        expect(pattern.reach.note.length, `${_id} records no reach verdict`).toBeGreaterThan(0);
      }
    },
  );

  test.each(DIRECTIVE_PATTERNS.map((pattern) => [pattern.id, pattern.consumer]))(
    '%s resolves its consumer claim',
    (_id, consumer) => {
      RESOLVERS[consumer.kind](consumer);
    },
  );

  test('every claim kind the table uses has a resolver, and every resolver is used', () => {
    const used = new Set(DIRECTIVE_PATTERNS.map((pattern) => pattern.consumer.kind));
    expect([...used].sort()).toStrictEqual(Object.keys(RESOLVERS).sort());
  });

  test.each(
    DIRECTIVE_PATTERNS.flatMap((pattern) =>
      pattern.shapes.map((shape) => [`${pattern.id} governs ${shape}`, pattern.id, shape]),
    ),
  )('%s', (_label, id, shape) => {
    const source = shape.startsWith('/') ? shape : `// ${shape}`;
    const [comment] = extractComments(source.replace(/\{[^}]+\}/g, 'x'), { jsx: false });
    const verdict = classifyComment(comment, { precedentRegistry: new Set() });
    expect({ allowed: verdict.allowed, detail: verdict.detail }).toStrictEqual({
      allowed: true,
      detail: id,
    });
  });

  test('no shape is claimed by two entries', () => {
    const shapes = DIRECTIVE_PATTERNS.flatMap((pattern) => pattern.shapes);
    expect(shapes.length).toBe(new Set(shapes).size);
  });

  test('one entry per governable shape: no id is spelled twice', () => {
    const ids = DIRECTIVE_PATTERNS.map((pattern) => pattern.id);
    expect(ids.length).toBe(new Set(ids).size);
  });
});

describe('the dispositions that removed a shape stay justified by the config that removed it', () => {
  test('no tsconfig selects a classic JSX runtime, so the factory pragmas stay out', () => {
    const classic = tsconfigSources().filter((source) =>
      /"jsx"\s*:\s*"(?:react|preserve|react-native)"/.test(source),
    );
    expect(classic, 're-admit @jsx and @jsxFrag: a tsconfig went back to the classic runtime').toEqual(
      [],
    );
  });

  test('no tsconfig sets checkJs, which is what leaves @ts-check unreached', () => {
    const checking = tsconfigSources().filter((source) => /"checkJs"\s*:\s*true/.test(source));
    expect(checking, 'promote the @ts-check reach verdict: checkJs is on somewhere').toEqual([]);
  });
});
