import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { resolvePrebuiltDevApp } from '../stress/_helpers/prebuilt/prebuilt-dev-app';
import {
  PREBUILT_BUILD_OPTIONS,
  readPrebuiltManifest,
} from '../stress/_helpers/prebuilt/prebuilt-serving';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, readdirSync: vi.fn(fs.readdirSync) };
});

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

const OK_TREE: Readonly<Record<string, string>> = {
  'package.json': '{"name":"open-knowledge"}\n',
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  'packages/app/package.json': '{"name":"@inkeep/open-knowledge-app"}\n',
  'packages/app/index.html': '<!doctype html><div id="root"></div>\n',
  'packages/app/src/App.tsx': 'export const App = () => 1;\n',
  'packages/core/src/index.ts': 'export const core = 1;\n',
  'packages/server/src/index.ts': 'export const server = 1;\n',
};

const roots: string[] = [];

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function okTree(): string {
  const root = scratch('ok-prebuilt-concurrent-prune-tree-');
  for (const [path, content] of Object.entries(OK_TREE)) write(root, path, content);
  return root;
}

function resolveWith(okRoot: string, outRoot: string) {
  return resolvePrebuiltDevApp({
    okRoot,
    outRoot,
    options: PREBUILT_BUILD_OPTIONS,
    build: async (distDir: string) => {
      const app = readFileSync(join(okRoot, 'packages/app/src/App.tsx'), 'utf8');
      write(distDir, 'index.html', `<!doctype html>${app}`);
    },
  });
}

function anotherBuilderRetiresAfterTheListing(outRoot: string, digest: string): void {
  vi.mocked(readdirSync).mockImplementation(((path: string, options?: unknown) => {
    const listing = actualFs.readdirSync(path, options as never);
    if (path === outRoot && (options as { withFileTypes?: boolean })?.withFileTypes === true) {
      vi.mocked(readdirSync).mockImplementation(actualFs.readdirSync);
      actualFs.rmSync(join(outRoot, digest), { recursive: true, force: true });
    }
    return listing;
  }) as typeof readdirSync);
}

afterEach(() => {
  vi.mocked(readdirSync).mockImplementation(actualFs.readdirSync);
  for (const root of roots.splice(0)) actualFs.rmSync(root, { recursive: true, force: true });
});

describe('builders that prune the same output root together', () => {
  test('a stale build another builder retires after this prune listed it is skipped, and the build still records itself as latest', async () => {
    const okRoot = okTree();
    const outRoot = scratch('ok-prebuilt-concurrent-prune-out-');
    const stale = await resolveWith(okRoot, outRoot);
    stale.use.release();
    write(okRoot, 'packages/app/src/App.tsx', 'export const App = () => 2;\n');
    const kept = await resolveWith(okRoot, outRoot);
    kept.use.release();

    write(okRoot, 'packages/app/src/App.tsx', 'export const App = () => 3;\n');
    anotherBuilderRetiresAfterTheListing(outRoot, stale.manifest.digest);
    const current = await resolveWith(okRoot, outRoot);
    current.use.release();

    expect(current.built).toBe(true);
    expect(readPrebuiltManifest(join(outRoot, 'latest.json'))?.digest).toBe(
      current.manifest.digest,
    );
    expect(actualFs.readdirSync(outRoot).sort()).toEqual(
      ['.uses', 'latest.json', kept.manifest.digest, current.manifest.digest].sort(),
    );
  });
});
