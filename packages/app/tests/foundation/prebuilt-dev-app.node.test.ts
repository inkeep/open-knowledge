import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { resolvePrebuiltDevApp } from '../stress/_helpers/prebuilt/prebuilt-dev-app';
import {
  E2E_SERVING_ENV,
  e2eServingMode,
  PREBUILT_APP_ENV,
  PREBUILT_BUILD_OPTIONS,
  type PrebuiltServing,
  prebuiltServerCommand,
  workerServingFromEnv,
} from '../stress/_helpers/prebuilt/prebuilt-serving';

const OK_TREE: Readonly<Record<string, string>> = {
  'package.json': '{"name":"open-knowledge"}\n',
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  'packages/app/package.json': '{"name":"@inkeep/open-knowledge-app"}\n',
  'packages/app/index.html': '<!doctype html><div id="root"></div>\n',
  'packages/app/src/App.tsx': 'export const App = () => null;\n',
  'packages/core/src/index.ts': 'export const core = 1;\n',
  'packages/server/src/index.ts': 'export const server = 1;\n',
};

const OPTIONS = PREBUILT_BUILD_OPTIONS;

function prebuiltServingFrom(env: Readonly<Record<string, string>>): PrebuiltServing {
  const serving = workerServingFromEnv(env);
  if (serving.kind === 'prebuilt') return serving;
  throw new Error(`expected prebuilt serving, got ${serving.kind}`);
}

const roots: string[] = [];

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function okTree(): string {
  const root = scratch('ok-prebuilt-tree-');
  for (const [path, content] of Object.entries(OK_TREE)) write(root, path, content);
  return root;
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function bundler(okRoot: string) {
  const builds: string[] = [];
  return {
    builds,
    build: async (distDir: string) => {
      builds.push(distDir);
      mkdirSync(distDir, { recursive: true });
      const app = readFileSync(join(okRoot, 'packages/app/src/App.tsx'), 'utf8');
      writeFileSync(join(distDir, 'index.html'), `<!doctype html><script>${app}</script>\n`);
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the prebuilt DEV app output', () => {
  test('a first run builds it once and a later run with the same inputs serves that build', async () => {
    const okRoot = okTree();
    const outRoot = scratch('ok-prebuilt-out-');
    const { builds, build } = bundler(okRoot);

    const first = await resolvePrebuiltDevApp({ okRoot, outRoot, options: OPTIONS, build });
    const second = await resolvePrebuiltDevApp({ okRoot, outRoot, options: OPTIONS, build });

    expect(first.built).toBe(true);
    expect(first.decision).toEqual({ serve: false, reason: 'missing' });
    expect(second.built).toBe(false);
    expect(second.decision).toEqual({ serve: true });
    expect(second.distDir).toBe(first.distDir);
    expect(builds).toHaveLength(1);
    expect(readFileSync(join(second.distDir, 'index.html'), 'utf8')).toContain('App = () => null');
    expect(existsSync(builds[0] ?? '')).toBe(false);
  });

  test('a server edit refuses the earlier build, names the file and serves a new build', async () => {
    const okRoot = okTree();
    const outRoot = scratch('ok-prebuilt-out-');
    const { builds, build } = bundler(okRoot);
    const before = await resolvePrebuiltDevApp({ okRoot, outRoot, options: OPTIONS, build });

    write(okRoot, 'packages/server/src/index.ts', 'export const server = 2;\n');
    const after = await resolvePrebuiltDevApp({ okRoot, outRoot, options: OPTIONS, build });

    expect(after.decision).toEqual({
      serve: false,
      reason: 'stale',
      changedInputs: ['packages/server/src/index.ts'],
      changedOptions: [],
    });
    expect(after.built).toBe(true);
    expect(after.distDir).not.toBe(before.distDir);
    expect(builds).toHaveLength(2);
  });

  test('an app edit is served from a build that contains it', async () => {
    const okRoot = okTree();
    const outRoot = scratch('ok-prebuilt-out-');
    const { build } = bundler(okRoot);
    await resolvePrebuiltDevApp({ okRoot, outRoot, options: OPTIONS, build });

    write(okRoot, 'packages/app/src/App.tsx', 'export const App = () => "edited";\n');
    const after = await resolvePrebuiltDevApp({ okRoot, outRoot, options: OPTIONS, build });

    expect(readFileSync(join(after.distDir, 'index.html'), 'utf8')).toContain('"edited"');
  });

  test('a changed build option refuses the earlier build and names the option', async () => {
    const okRoot = okTree();
    const outRoot = scratch('ok-prebuilt-out-');
    const { build } = bundler(okRoot);
    await resolvePrebuiltDevApp({ okRoot, outRoot, options: OPTIONS, build });

    const after = await resolvePrebuiltDevApp({
      okRoot,
      outRoot,
      options: { ...OPTIONS, mode: 'production' },
      build,
    });

    expect(after.decision).toEqual({
      serve: false,
      reason: 'stale',
      changedInputs: [],
      changedOptions: ['mode'],
    });
    expect(after.built).toBe(true);
  });

  test('a failed build records nothing, so the next run builds again', async () => {
    const okRoot = okTree();
    const outRoot = scratch('ok-prebuilt-out-');
    const { builds, build } = bundler(okRoot);
    const failing = async (distDir: string) => {
      await build(distDir);
      throw new Error('vite build exited 1');
    };

    await expect(
      resolvePrebuiltDevApp({ okRoot, outRoot, options: OPTIONS, build: failing }),
    ).rejects.toThrow('vite build exited 1');
    const retried = await resolvePrebuiltDevApp({ okRoot, outRoot, options: OPTIONS, build });

    expect(retried.built).toBe(true);
    expect(retried.decision).toEqual({ serve: false, reason: 'missing' });
    expect(builds).toHaveLength(2);
  });

  test('a build that writes no index.html is refused and not served later', async () => {
    const okRoot = okTree();
    const outRoot = scratch('ok-prebuilt-out-');
    const { builds, build } = bundler(okRoot);
    const empty = async (distDir: string) => {
      mkdirSync(distDir, { recursive: true });
    };

    await expect(
      resolvePrebuiltDevApp({ okRoot, outRoot, options: OPTIONS, build: empty }),
    ).rejects.toThrow('wrote no index.html');
    const retried = await resolvePrebuiltDevApp({ okRoot, outRoot, options: OPTIONS, build });

    expect(retried.built).toBe(true);
    expect(builds).toHaveLength(1);
  });

  test('an unreadable build manifest is not served and the app is rebuilt in its place', async () => {
    const okRoot = okTree();
    const outRoot = scratch('ok-prebuilt-out-');
    const { builds, build } = bundler(okRoot);
    const first = await resolvePrebuiltDevApp({ okRoot, outRoot, options: OPTIONS, build });

    writeFileSync(join(first.outputDir, 'prebuilt-manifest.json'), '{"digest":');
    const second = await resolvePrebuiltDevApp({ okRoot, outRoot, options: OPTIONS, build });

    expect(second.built).toBe(true);
    expect(second.outputDir).toBe(first.outputDir);
    expect(builds).toHaveLength(2);
  });

  test('two runs building the same inputs at once both serve the build that landed first', async () => {
    const okRoot = okTree();
    const outRoot = scratch('ok-prebuilt-out-');
    const { builds, build } = bundler(okRoot);
    let overtaken: Promise<unknown> | undefined;
    const slow = async (distDir: string) => {
      overtaken = resolvePrebuiltDevApp({ okRoot, outRoot, options: OPTIONS, build });
      await overtaken;
      await build(distDir);
    };

    const late = await resolvePrebuiltDevApp({ okRoot, outRoot, options: OPTIONS, build: slow });
    const early = await overtaken;

    expect(late.built).toBe(false);
    expect(early).toMatchObject({ built: true, distDir: late.distDir });
    expect(builds).toHaveLength(2);
    expect(readFileSync(join(late.distDir, 'index.html'), 'utf8')).toContain('App = () => null');
  });

  test('a new build keeps the one it replaces and discards older ones', async () => {
    const okRoot = okTree();
    const outRoot = scratch('ok-prebuilt-out-');
    const { build } = bundler(okRoot);
    const oldest = await resolvePrebuiltDevApp({ okRoot, outRoot, options: OPTIONS, build });
    oldest.use.release();
    write(okRoot, 'packages/app/src/App.tsx', 'export const App = () => 2;\n');
    const previous = await resolvePrebuiltDevApp({ okRoot, outRoot, options: OPTIONS, build });
    write(okRoot, 'packages/app/src/App.tsx', 'export const App = () => 3;\n');
    const current = await resolvePrebuiltDevApp({ okRoot, outRoot, options: OPTIONS, build });

    expect(existsSync(current.distDir)).toBe(true);
    expect(existsSync(previous.distDir)).toBe(true);
    expect(existsSync(oldest.outputDir)).toBe(false);
  });
});

describe('the serving mode a worker starts', () => {
  test('without the flag a worker runs the dev server', () => {
    expect(workerServingFromEnv({})).toEqual({ kind: 'dev-server' });
  });

  test('a fresh prebuilt app is served by vite preview from its own directory', async () => {
    const okRoot = okTree();
    const app = await resolvePrebuiltDevApp({
      okRoot,
      outRoot: scratch('ok-prebuilt-out-'),
      options: OPTIONS,
      build: bundler(okRoot).build,
    });
    const serving = prebuiltServingFrom({
      [E2E_SERVING_ENV]: 'prebuilt',
      [PREBUILT_APP_ENV]: app.outputDir,
    });

    expect(prebuiltServerCommand('::1', serving, okRoot)).toEqual({
      args: ['exec', 'vite', 'preview', '--config', 'vite.prebuilt-dev.ts', '--host', '::1'],
      env: { OK_TEST_PREBUILT_OUT_DIR: app.distDir },
    });
  });

  test('a core edit after the build makes a worker refuse the prebuilt app and name the file', async () => {
    const okRoot = okTree();
    const app = await resolvePrebuiltDevApp({
      okRoot,
      outRoot: scratch('ok-prebuilt-out-'),
      options: OPTIONS,
      build: bundler(okRoot).build,
    });
    const serving = prebuiltServingFrom({
      [E2E_SERVING_ENV]: 'prebuilt',
      [PREBUILT_APP_ENV]: app.outputDir,
    });

    write(okRoot, 'packages/core/src/index.ts', 'export const core = 2;\n');

    expect(() => prebuiltServerCommand('127.0.0.1', serving, okRoot)).toThrow(
      `the prebuilt DEV app at ${app.outputDir} is stale, because packages/core/src/index.ts changed since it was built`,
    );
  });

  test('a prebuilt directory without a build manifest is refused', () => {
    const outputDir = scratch('ok-prebuilt-unbuilt-');
    const serving = prebuiltServingFrom({
      [E2E_SERVING_ENV]: 'prebuilt',
      [PREBUILT_APP_ENV]: outputDir,
    });

    expect(() => prebuiltServerCommand('127.0.0.1', serving, okTree())).toThrow(
      `the prebuilt DEV app at ${outputDir} has no build manifest`,
    );
  });

  test('the prebuilt flag without a prepared app refuses rather than falling back', () => {
    expect(() => workerServingFromEnv({ [E2E_SERVING_ENV]: 'prebuilt' })).toThrow(
      `${E2E_SERVING_ENV}=prebuilt serves the prebuilt DEV app its globalSetup records in ${PREBUILT_APP_ENV}`,
    );
  });

  test('an unknown serving flag is refused', () => {
    expect(() => e2eServingMode({ [E2E_SERVING_ENV]: 'prebuild' })).toThrow(
      `${E2E_SERVING_ENV}=prebuild names no serving mode`,
    );
    expect(e2eServingMode({ [E2E_SERVING_ENV]: '' })).toBe('dev-server');
  });
});
