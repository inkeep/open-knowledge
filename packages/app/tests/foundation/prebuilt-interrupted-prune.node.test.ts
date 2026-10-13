import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { resolvePrebuiltDevApp } from '../stress/_helpers/prebuilt/prebuilt-dev-app';
import {
  E2E_SERVING_ENV,
  PREBUILT_APP_ENV,
  PREBUILT_BUILD_OPTIONS,
  PREBUILT_MANIFEST_FILE,
  type PrebuiltServing,
  prebuiltServerCommand,
  readPrebuiltManifest,
  workerServingFromEnv,
} from '../stress/_helpers/prebuilt/prebuilt-serving';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, rmSync: vi.fn(fs.rmSync) };
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
  const root = scratch('ok-prebuilt-prune-tree-');
  for (const [path, content] of Object.entries(OK_TREE)) write(root, path, content);
  return root;
}

function bundler(okRoot: string) {
  return async (distDir: string) => {
    const app = readFileSync(join(okRoot, 'packages/app/src/App.tsx'), 'utf8');
    write(distDir, 'index.html', `<!doctype html><script src="/assets/app.js"></script>${app}`);
    write(distDir, 'assets/app.js', app);
    write(distDir, 'assets/vendor.js', 'export {};\n');
  };
}

function resolveWith(okRoot: string, outRoot: string) {
  return resolvePrebuiltDevApp({
    okRoot,
    outRoot,
    options: PREBUILT_BUILD_OPTIONS,
    build: bundler(okRoot),
  });
}

function buildDirHolding(path: string, digest: string): string | undefined {
  const candidates = [path];
  if (statSync(path, { throwIfNoEntry: false })?.isDirectory() === true) {
    candidates.push(...readdirSync(path).map((name) => join(path, name)));
  }
  return candidates.find(
    (dir) => readPrebuiltManifest(join(dir, PREBUILT_MANIFEST_FILE))?.digest === digest,
  );
}

class Interrupted extends Error {}

function interruptTheDeletionOf(digest: string, removedBeforeTheStop: readonly string[]): void {
  vi.mocked(rmSync).mockImplementation((path, options) => {
    const buildDir = buildDirHolding(String(path), digest);
    if (buildDir === undefined) {
      actualFs.rmSync(path, options);
      return;
    }
    vi.mocked(rmSync).mockImplementation(actualFs.rmSync);
    for (const entry of removedBeforeTheStop) {
      actualFs.rmSync(join(buildDir, entry), { recursive: true, force: true });
    }
    throw new Interrupted(`the deletion of ${buildDir} stopped part-way`);
  });
}

function workerServing(outputDir: string): PrebuiltServing {
  const serving = workerServingFromEnv({
    [E2E_SERVING_ENV]: 'prebuilt',
    [PREBUILT_APP_ENV]: outputDir,
  });
  if (serving.kind === 'prebuilt') return serving;
  throw new Error(`expected prebuilt serving, got ${serving.kind}`);
}

afterEach(() => {
  vi.mocked(rmSync).mockImplementation(actualFs.rmSync);
  for (const root of roots.splice(0)) actualFs.rmSync(root, { recursive: true, force: true });
});

async function interruptedPruneThenRevisit(removedBeforeTheStop: readonly string[]) {
  const okRoot = okTree();
  const outRoot = scratch('ok-prebuilt-prune-out-');
  const first = await resolveWith(okRoot, outRoot);
  first.use.release();
  write(okRoot, 'packages/app/src/App.tsx', 'export const App = () => 2;\n');
  (await resolveWith(okRoot, outRoot)).use.release();

  write(okRoot, 'packages/app/src/App.tsx', 'export const App = () => 3;\n');
  interruptTheDeletionOf(first.manifest.digest, removedBeforeTheStop);
  await expect(resolveWith(okRoot, outRoot)).rejects.toBeInstanceOf(Interrupted);

  write(okRoot, 'packages/app/src/App.tsx', 'export const App = () => 1;\n');
  const again = await resolveWith(okRoot, outRoot);
  again.use.release();

  expect(again.manifest.digest).toBe(first.manifest.digest);
  expect(again.built).toBe(true);
  expect(readFileSync(join(again.distDir, 'index.html'), 'utf8')).toContain('App = () => 1');
  expect(readFileSync(join(again.distDir, 'assets', 'app.js'), 'utf8')).toContain('App = () => 1');
  expect(prebuiltServerCommand('127.0.0.1', workerServing(again.outputDir), okRoot).env).toEqual({
    OK_TEST_PREBUILT_OUT_DIR: again.distDir,
  });
}

describe('a prune that stops part-way through deleting a build', () => {
  test('when it leaves the build manifest over a dist without its index.html, the next run with those inputs builds again and serves a whole build', async () => {
    await interruptedPruneThenRevisit(['dist/index.html']);
  });

  test('when it leaves the build manifest over a dist missing a chunk, the next run with those inputs builds again and serves a whole build', async () => {
    await interruptedPruneThenRevisit(['dist/assets/app.js']);
  });

  test('when it leaves the build manifest and no dist, the next run with those inputs builds again and serves a whole build', async () => {
    await interruptedPruneThenRevisit(['dist']);
  });

  test('when it leaves a dist without its build manifest, the next run with those inputs builds again and serves a whole build', async () => {
    await interruptedPruneThenRevisit([PREBUILT_MANIFEST_FILE]);
  });

  test('a prune that runs to the end leaves nothing of the discarded build in the output root', async () => {
    const okRoot = okTree();
    const outRoot = scratch('ok-prebuilt-prune-out-');
    const first = await resolveWith(okRoot, outRoot);
    first.use.release();
    write(okRoot, 'packages/app/src/App.tsx', 'export const App = () => 2;\n');
    const second = await resolveWith(okRoot, outRoot);
    second.use.release();
    write(okRoot, 'packages/app/src/App.tsx', 'export const App = () => 3;\n');
    const third = await resolveWith(okRoot, outRoot);
    third.use.release();

    expect(existsSync(first.outputDir)).toBe(false);
    expect(readdirSync(outRoot).sort()).toEqual(
      ['.uses', 'latest.json', second.manifest.digest, third.manifest.digest].sort(),
    );
  });
});
