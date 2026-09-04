import type { Dirent } from 'node:fs';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

function findRepoRoot(): string {
  return join(__dirname, '..', '..', '..');
}

const REPO_ROOT = findRepoRoot();

const DESTRUCTIVE_DELETE = /_item\s*\)?\s*\.delete\(transaction\)/;

const ARTIFACT_ROOTS = ['dist', 'src', 'lib', 'build', 'esm', 'cjs'] as const;

const MAX_ARTIFACT_DEPTH = 6;

function installedPackageRoots(): string[] {
  const rootNodeModules = join(REPO_ROOT, 'node_modules');
  const roots = [rootNodeModules];

  const store = join(rootNodeModules, '.pnpm');
  let storeEntries: string[];
  try {
    storeEntries = readdirSync(store);
  } catch {
    return roots;
  }
  for (const entry of storeEntries) {
    roots.push(join(store, entry, 'node_modules'));
  }
  return roots;
}

function resolveFileFromSpecifier(specifier: string): string {
  const resolved = import.meta.resolve(specifier);
  return resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved;
}

function resolveInstalledPackageDir(packageName: string): string {
  let dir = dirname(resolveFileFromSpecifier(packageName));

  while (true) {
    const pkgJsonPath = join(dir, 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: string };
      if (pkg.name === packageName) return dir;
    } catch {}

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`Could not resolve installed package directory for ${packageName}`);
}

function walkInstalledPackageDirs(
  nodeModulesDir: string,
  visitPackageDir: (pkgDir: string) => void,
  visited = new Set<string>(),
) {
  let entries: string[];
  try {
    entries = readdirSync(nodeModulesDir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const full = join(nodeModulesDir, name);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    if (name.startsWith('@')) {
      walkInstalledPackageDirs(full, visitPackageDir, visited);
      continue;
    }

    let pkgDir = full;
    try {
      pkgDir = realpathSync(full);
    } catch {}
    if (visited.has(pkgDir)) continue;
    visited.add(pkgDir);
    visitPackageDir(pkgDir);
    walkInstalledPackageDirs(join(pkgDir, 'node_modules'), visitPackageDir, visited);
  }
}

const PATCHED_BUNDLES = [
  {
    label: 'y-prosemirror CJS',
    packageName: 'y-prosemirror',
    relativePath: ['dist', 'y-prosemirror.cjs'],
  },
  {
    label: 'y-prosemirror ESM src',
    packageName: 'y-prosemirror',
    relativePath: ['src', 'plugins', 'sync-plugin.js'],
  },
  {
    label: '@tiptap/y-tiptap CJS',
    packageName: '@tiptap/y-tiptap',
    relativePath: ['dist', 'y-tiptap.cjs'],
  },
  {
    label: '@tiptap/y-tiptap ESM',
    packageName: '@tiptap/y-tiptap',
    relativePath: ['dist', 'y-tiptap.js'],
  },
] as const;

function resolvePatchedBundlePath(bundle: (typeof PATCHED_BUNDLES)[number]): string {
  return join(resolveInstalledPackageDir(bundle.packageName), ...bundle.relativePath);
}

describe('R13 patch verification (y-prosemirror + @tiptap/y-tiptap)', () => {
  test('destructive-delete matcher matches the upstream shape it guards against', () => {
    const upstreamBlockContext = '/** @type {Y.Item} */ (el._item).delete(transaction)';
    const upstreamInlineContext = '/** @type {Y.Item} */ (text._item).delete(transaction)';

    expect(upstreamBlockContext).toMatch(DESTRUCTIVE_DELETE);
    expect(upstreamInlineContext).toMatch(DESTRUCTIVE_DELETE);

    expect("schema.node('rawMdxFallback', { value: raw })").not.toMatch(DESTRUCTIVE_DELETE);
  });

  test('both patches are registered in pnpm-workspace.yaml patchedDependencies', () => {
    const workspaceYaml = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
    const block = workspaceYaml.match(/^patchedDependencies:\n((?:[ \t]+\S.*\n?)+)/m);
    expect(block).not.toBeNull();
    const patched: Record<string, string> = {};
    for (const line of (block?.[1] ?? '').split('\n')) {
      const entry = line.match(/^\s+(['"]?)(.+?)\1:\s+(\S+)\s*$/);
      if (entry) patched[entry[2]] = entry[3];
    }

    expect(patched['y-prosemirror@1.3.7']).toBeDefined();
    expect(patched['y-prosemirror@1.3.7']).toContain('patches/');
    expect(patched['y-prosemirror@1.3.7']).toContain('y-prosemirror');

    expect(patched['@tiptap/y-tiptap@3.0.3']).toBeDefined();
    expect(patched['@tiptap/y-tiptap@3.0.3']).toContain('patches/');
    expect(patched['@tiptap/y-tiptap@3.0.3']).toContain('y-tiptap');
  });

  for (const bundle of PATCHED_BUNDLES) {
    describe(bundle.label, () => {
      test('contains R13 patch body (not upstream destructive-delete)', () => {
        const src = readFileSync(resolvePatchedBundlePath(bundle), 'utf8');

        const patchMarkers = src.match(/R13 patch:/g);
        expect(patchMarkers).not.toBeNull();
        expect(patchMarkers?.length).toBeGreaterThanOrEqual(2);

        expect(src).toContain("schema.node('rawMdxFallback'");

        const counterMarkers = src.match(/__okYpsCounters/g);
        expect(counterMarkers).not.toBeNull();
        expect(counterMarkers?.length).toBeGreaterThanOrEqual(3);

        expect(src).toMatch(/\[y-prosemirror\] schema\.node\(/);
        expect(src).toMatch(/\[y-prosemirror\] schema\.text\(/);
      });

      test('contains the ymark: mark-encoding (not upstream mark-drop)', () => {
        const src = readFileSync(resolvePatchedBundlePath(bundle), 'utf8');

        const prefixMarkers = src.match(/YMARK_PREFIX/g);
        expect(prefixMarkers).not.toBeNull();
        expect(prefixMarkers?.length).toBeGreaterThanOrEqual(3);

        for (const helper of ['splitYAttrs', 'equalYMarks']) {
          const helperMarkers = src.match(new RegExp(helper, 'g'));
          expect(helperMarkers, `${helper} missing from ${bundle.label}`).not.toBeNull();
          expect(helperMarkers?.length).toBeGreaterThanOrEqual(2);
        }

        expect(src).toContain('yattr2markname');

        expect(src).toContain('ymark:');
      });

      test('patched throw sites do NOT retain upstream destructive _item.delete calls', () => {
        const src = readFileSync(resolvePatchedBundlePath(bundle), 'utf8');

        const hunks = src.split(/R13 patch:/);
        for (let i = 1; i < hunks.length; i++) {
          const hunk = hunks[i].slice(0, 4000);
          expect(hunk).not.toMatch(DESTRUCTIVE_DELETE);
        }

        expect(src).not.toMatch(DESTRUCTIVE_DELETE);
      });
    });
  }

  function expectYmarkEncoding(patchContent: string) {
    for (const identifier of ['YMARK_PREFIX', 'splitYAttrs', 'equalYMarks', 'yattr2markname']) {
      expect(patchContent, `${identifier} missing from patch file`).toContain(identifier);
    }
  }

  test('y-prosemirror patch file exists on disk and references both artifacts', () => {
    const patchPath = join(REPO_ROOT, 'patches', 'y-prosemirror@1.3.7.patch');
    const patchContent = readFileSync(patchPath, 'utf8');
    expect(patchContent).toContain('y-prosemirror.cjs');
    expect(patchContent).toContain('src/plugins/sync-plugin.js');
    expect(patchContent).toContain('R13 patch:');
    expect(patchContent).toContain('rawMdxFallback');
    expect(patchContent).toContain('__okYpsCounters');
    expectYmarkEncoding(patchContent);
  });

  test('@tiptap/y-tiptap patch file exists on disk and references both bundles', () => {
    const patchPath = join(REPO_ROOT, 'patches', '@tiptap%2Fy-tiptap@3.0.3.patch');
    const patchContent = readFileSync(patchPath, 'utf8');
    expect(patchContent).toContain('dist/y-tiptap.cjs');
    expect(patchContent).toContain('dist/y-tiptap.js');
    expect(patchContent).toContain('R13 patch:');
    expect(patchContent).toContain('rawMdxFallback');
    expect(patchContent).toContain('__okYpsCounters');
    expectYmarkEncoding(patchContent);
  });

  test('dep-tree invariant: no destructive delete in any shipped bundle', () => {
    const offending: Array<{ path: string; line: number }> = [];
    const reachedPackages = new Set<string>();

    function scanArtifactDir(dir: string, depth: number) {
      if (depth > MAX_ARTIFACT_DEPTH) return;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          scanArtifactDir(full, depth + 1);
          continue;
        }
        if (!/\.(?:js|cjs|mjs)$/.test(entry.name)) continue;
        let src: string;
        try {
          src = readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        if (!DESTRUCTIVE_DELETE.test(src)) continue;
        const lines = src.split('\n');
        const lineIdx = lines.findIndex((l) => DESTRUCTIVE_DELETE.test(l));
        offending.push({ path: full, line: lineIdx + 1 });
      }
    }

    function scanPackageDir(pkgDir: string) {
      reachedPackages.add(basename(pkgDir));
      for (const artifactRoot of ARTIFACT_ROOTS) {
        scanArtifactDir(join(pkgDir, artifactRoot), 0);
      }
    }

    const visited = new Set<string>();
    for (const root of installedPackageRoots()) {
      walkInstalledPackageDirs(root, scanPackageDir, visited);
    }

    for (const guarded of ['y-prosemirror', 'y-tiptap']) {
      expect(
        reachedPackages.has(guarded),
        `dep-tree walk never reached "${guarded}" (visited ${reachedPackages.size} packages), ` +
          `so a zero-offender result proves nothing. The node_modules layout has probably ` +
          `changed — extend installedPackageRoots() to cover it.`,
      ).toBe(true);
    }

    if (offending.length > 0) {
      const details = offending.map(({ path, line }) => `  ${path}:${line}`).join('\n');
      throw new Error(
        `Found ${offending.length} bundle(s) with the upstream destructive-delete pattern ` +
          `\`(el._item).delete(transaction)\`. Every such bundle must be patched via \`pnpm patch\` ` +
          `to substitute rawMdxFallback (block-context) or log+skip (inline-context); ` +
          `otherwise a schema.node()/schema.text() throw will tombstone Y.Items and ` +
          `broadcast the delete to all peers (see PRECEDENTS.md precedent #9):\n${details}`,
      );
    }
  }, 30_000);
});
