import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { resolvePrebuiltDevApp } from '../stress/_helpers/prebuilt/prebuilt-dev-app';
import {
  PREBUILT_BUILD_OPTIONS,
  PREBUILT_MANIFEST_FILE,
} from '../stress/_helpers/prebuilt/prebuilt-serving';
import { prebuiltManifest } from './test-server-inputs';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
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

const APP_MODULE = fileURLToPath(
  new URL('../stress/_helpers/prebuilt/prebuilt-dev-app.ts', import.meta.url),
);
const SERVING_MODULE = fileURLToPath(
  new URL('../stress/_helpers/prebuilt/prebuilt-serving.ts', import.meta.url),
);

const OTHER_BUILDER = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePrebuiltDevApp } from ${JSON.stringify(APP_MODULE)};
import { PREBUILT_BUILD_OPTIONS } from ${JSON.stringify(SERVING_MODULE)};
const [okRoot, outRoot] = process.argv.slice(1);
const app = await resolvePrebuiltDevApp({
  okRoot,
  outRoot,
  options: PREBUILT_BUILD_OPTIONS,
  build: async (distDir) => {
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><p>landed first</p>\\n');
  },
});
app.use.release();
process.stdout.write(JSON.stringify({ built: app.built, distDir: app.distDir }));
`;

const OTHER_BUILDER_DEADLINE_MS = 20_000;

type OtherBuild = { readonly built: boolean; readonly distDir: string };

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
  const root = scratch('ok-prebuilt-race-tree-');
  for (const [path, content] of Object.entries(OK_TREE)) write(root, path, content);
  return root;
}

function resolveSecond(okRoot: string, outRoot: string, beforeLanding: () => void = () => {}) {
  return resolvePrebuiltDevApp({
    okRoot,
    outRoot,
    options: PREBUILT_BUILD_OPTIONS,
    build: async (distDir) => {
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, 'index.html'), '<!doctype html><p>built second</p>\n');
      beforeLanding();
    },
  });
}

function beforeTheRename(land: (outputDir: string) => void): void {
  vi.mocked(renameSync).mockImplementationOnce((from, to) => {
    land(String(to));
    actualFs.renameSync(from, to);
  });
}

function otherBuilderLandsFirst(okRoot: string, outRoot: string) {
  let other: OtherBuild | undefined;
  const land = () => {
    const run = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', OTHER_BUILDER, okRoot, outRoot],
      { encoding: 'utf8', timeout: OTHER_BUILDER_DEADLINE_MS },
    );
    process.stdout.write(
      `other builder terminal: ${JSON.stringify({ pid: run.pid, code: run.status, signal: run.signal })}\n`,
    );
    if (run.status !== 0) {
      throw new Error(`the other builder exited with ${run.status ?? run.signal}: ${run.stderr}`);
    }
    other = JSON.parse(run.stdout) as OtherBuild;
  };
  return Object.assign(() => other, { land });
}

function stagingLeft(outRoot: string): string[] {
  return readdirSync(outRoot).filter((name) => name.startsWith('.staging-'));
}

afterEach(() => {
  vi.mocked(renameSync).mockReset();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
    if (existsSync(root)) throw new Error(`the owned fixture root remains: ${root}`);
    process.stdout.write(`concurrent-builder fixture removed: ${root}\n`);
  }
});

describe('two builders of the same inputs at once', () => {
  test('a builder joins another complete same-input build that lands during its build', async () => {
    const okRoot = okTree();
    const outRoot = scratch('ok-prebuilt-race-out-');
    const other = otherBuilderLandsFirst(okRoot, outRoot);

    const second = await resolveSecond(okRoot, outRoot, other.land);
    second.use.release();

    expect(other()).toEqual({ built: true, distDir: second.distDir });
    expect(second.built).toBe(false);
    expect(readFileSync(join(second.distDir, 'index.html'), 'utf8')).toContain('landed first');
    expect(stagingLeft(outRoot)).toEqual([]);
  });

  test('a builder whose rename finds a directory without a build manifest there still fails', async () => {
    const okRoot = okTree();
    const outRoot = scratch('ok-prebuilt-race-out-');
    beforeTheRename((outputDir) => {
      write(outputDir, 'dist/index.html', '<!doctype html><p>no manifest</p>\n');
    });

    await expect(resolveSecond(okRoot, outRoot)).rejects.toMatchObject({
      code: expect.stringMatching(/^(ENOTEMPTY|EEXIST)$/),
    });
    expect(stagingLeft(outRoot)).toEqual([]);
  });

  test('a builder whose rename finds a build of other inputs there still fails', async () => {
    const okRoot = okTree();
    const outRoot = scratch('ok-prebuilt-race-out-');
    const manifest = prebuiltManifest(okRoot, PREBUILT_BUILD_OPTIONS);
    beforeTheRename((outputDir) => {
      write(outputDir, 'dist/index.html', '<!doctype html><p>other inputs</p>\n');
      write(
        outputDir,
        PREBUILT_MANIFEST_FILE,
        JSON.stringify({
          ...manifest,
          inputs: { ...manifest.inputs, 'packages/app/src/App.tsx': 'other' },
        }),
      );
    });

    await expect(resolveSecond(okRoot, outRoot)).rejects.toMatchObject({
      code: expect.stringMatching(/^(ENOTEMPTY|EEXIST)$/),
    });
    expect(stagingLeft(outRoot)).toEqual([]);
  });
});
