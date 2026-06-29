import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepoRoot(): string {
  return join(__dirname, '..', '..', '..');
}

const REPO_ROOT = findRepoRoot();

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
  test('both patches are registered in root package.json patchedDependencies', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const patched = pkg.patchedDependencies as Record<string, string> | undefined;
    expect(patched).toBeDefined();

    expect(patched?.['y-prosemirror@1.3.7']).toBeDefined();
    expect(patched?.['y-prosemirror@1.3.7']).toContain('patches/');
    expect(patched?.['y-prosemirror@1.3.7']).toContain('y-prosemirror');

    expect(patched?.['@tiptap/y-tiptap@3.0.3']).toBeDefined();
    expect(patched?.['@tiptap/y-tiptap@3.0.3']).toContain('patches/');
    expect(patched?.['@tiptap/y-tiptap@3.0.3']).toContain('y-tiptap');
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

      test('patched throw sites do NOT retain upstream destructive _item.delete calls', () => {
        const src = readFileSync(resolvePatchedBundlePath(bundle), 'utf8');

        const hunks = src.split(/R13 patch:/);
        for (let i = 1; i < hunks.length; i++) {
          const hunk = hunks[i].slice(0, 4000);
          expect(hunk).not.toMatch(/_item\.delete\(transaction\)/);
        }

        expect(src).not.toMatch(/_item\.delete\(transaction\)/);
      });
    });
  }

  test('y-prosemirror patch file exists on disk and references y-prosemirror', () => {
    const patchPath = join(REPO_ROOT, 'patches', 'y-prosemirror@1.3.7.patch');
    const patchContent = readFileSync(patchPath, 'utf8');
    expect(patchContent).toContain('y-prosemirror.cjs');
    expect(patchContent).toContain('R13 patch:');
    expect(patchContent).toContain('rawMdxFallback');
    expect(patchContent).toContain('__okYpsCounters');
  });

  test('@tiptap/y-tiptap patch file exists on disk and references both bundles', () => {
    const patchPath = join(REPO_ROOT, 'patches', '@tiptap%2Fy-tiptap@3.0.3.patch');
    const patchContent = readFileSync(patchPath, 'utf8');
    expect(patchContent).toContain('dist/y-tiptap.cjs');
    expect(patchContent).toContain('dist/y-tiptap.js');
    expect(patchContent).toContain('R13 patch:');
    expect(patchContent).toContain('rawMdxFallback');
    expect(patchContent).toContain('__okYpsCounters');
  });

  test('dep-tree invariant: no destructive _item.delete(transaction) in any dist bundle', () => {
    const offending: Array<{ path: string; line: number }> = [];

    function scanDistDir(distDir: string) {
      let entries: string[];
      try {
        entries = readdirSync(distDir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.js') && !entry.endsWith('.cjs')) continue;
        const full = join(distDir, entry);
        let src: string;
        try {
          src = readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        if (!src.includes('_item.delete(transaction)')) continue;
        const lines = src.split('\n');
        const lineIdx = lines.findIndex((l) => l.includes('_item.delete(transaction)'));
        offending.push({ path: full, line: lineIdx + 1 });
      }
    }

    function scanPackageDir(pkgDir: string) {
      scanDistDir(join(pkgDir, 'dist'));
    }

    walkInstalledPackageDirs(join(REPO_ROOT, 'node_modules'), scanPackageDir);

    if (offending.length > 0) {
      const details = offending.map(({ path, line }) => `  ${path}:${line}`).join('\n');
      throw new Error(
        `Found ${offending.length} bundle(s) with the upstream destructive-delete pattern ` +
          `\`_item.delete(transaction)\`. Every such bundle must be patched via \`bun patch\` ` +
          `to substitute rawMdxFallback (block-context) or log+skip (inline-context); ` +
          `otherwise a schema.node()/schema.text() throw will tombstone Y.Items and ` +
          `broadcast the delete to all peers (see PRECEDENTS.md precedent #9):\n${details}`,
      );
    }
  }, 30_000);
});
