import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { resolvePrebuiltDevApp } from '../stress/_helpers/prebuilt/prebuilt-dev-app';
import { PREBUILT_BUILD_OPTIONS } from '../stress/_helpers/prebuilt/prebuilt-serving';

const OK_TREE: Readonly<Record<string, string>> = {
  'package.json': '{"name":"open-knowledge"}\n',
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  'packages/app/package.json': '{"name":"@inkeep/open-knowledge-app"}\n',
  'packages/app/index.html': '<!doctype html><div id="root"></div>\n',
  'packages/app/src/App.tsx': 'export const App = () => 1;\n',
  'packages/core/src/index.ts': 'export const core = 1;\n',
  'packages/server/src/index.ts': 'export const server = 1;\n',
};

const BUILD_USE_MODULE = fileURLToPath(
  new URL('../stress/_helpers/prebuilt/prebuilt-build-use.ts', import.meta.url),
);

const HOLDER = `
import { holdPrebuiltBuildUse } from ${JSON.stringify(BUILD_USE_MODULE)};
holdPrebuiltBuildUse(process.argv[1], process.argv[2]);
process.stdout.write('held\\n');
process.stdin.on('data', () => {});
process.stdin.on('end', () => process.exit(0));
`;

const roots: string[] = [];
const holders: ChildProcess[] = [];

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
  const root = scratch('ok-prebuilt-use-tree-');
  for (const [path, content] of Object.entries(OK_TREE)) write(root, path, content);
  return root;
}

function setApp(okRoot: string, value: number): void {
  write(okRoot, 'packages/app/src/App.tsx', `export const App = () => ${value};\n`);
}

async function build(okRoot: string, distDir: string): Promise<void> {
  mkdirSync(distDir, { recursive: true });
  const app = readFileSync(join(okRoot, 'packages/app/src/App.tsx'), 'utf8');
  writeFileSync(join(distDir, 'index.html'), `<!doctype html><script>${app}</script>\n`);
}

function resolveApp(okRoot: string, outRoot: string) {
  return resolvePrebuiltDevApp({
    okRoot,
    outRoot,
    options: PREBUILT_BUILD_OPTIONS,
    build: (distDir) => build(okRoot, distDir),
  });
}

async function holdInAnotherProcess(outRoot: string, digest: string): Promise<ChildProcess> {
  const holder = spawn(process.execPath, ['--input-type=module', '-e', HOLDER, outRoot, digest], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  holders.push(holder);
  const [chunk] = await once(holder.stdout, 'data');
  expect(String(chunk)).toBe('held\n');
  return holder;
}

async function endWithoutRelease(holder: ChildProcess): Promise<number | null> {
  const exited = once(holder, 'exit');
  holder.stdin?.end();
  const [code] = await exited;
  return code;
}

afterEach(async () => {
  for (const holder of holders.splice(0)) {
    if (holder.exitCode === null && holder.signalCode === null) await endWithoutRelease(holder);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('a prebuilt DEV build in use', () => {
  test('a build a run serves after a newer build replaced it survives another run building after it, and goes once that run releases it', async () => {
    const okRoot = okTree();
    const outRoot = scratch('ok-prebuilt-use-out-');
    (await resolveApp(okRoot, outRoot)).use.release();
    setApp(okRoot, 2);
    (await resolveApp(okRoot, outRoot)).use.release();

    setApp(okRoot, 1);
    const served = await resolveApp(okRoot, outRoot);
    setApp(okRoot, 3);
    const next = await resolveApp(okRoot, outRoot);
    next.use.release();

    expect(served.built).toBe(false);
    expect(next.built).toBe(true);
    expect(existsSync(join(served.distDir, 'index.html'))).toBe(true);
    expect(readFileSync(join(served.distDir, 'index.html'), 'utf8')).toContain('App = () => 1');

    served.use.release();
    setApp(okRoot, 4);
    (await resolveApp(okRoot, outRoot)).use.release();

    expect(existsSync(served.outputDir)).toBe(false);
  });

  test('a build another process holds stays while that process runs, and goes at the next build after it exits without releasing', async () => {
    const okRoot = okTree();
    const outRoot = scratch('ok-prebuilt-use-out-');
    const held = await resolveApp(okRoot, outRoot);
    held.use.release();
    const holder = await holdInAnotherProcess(outRoot, held.manifest.digest);

    for (const value of [2, 3]) {
      setApp(okRoot, value);
      (await resolveApp(okRoot, outRoot)).use.release();
    }
    expect(existsSync(join(held.distDir, 'index.html'))).toBe(true);

    expect(await endWithoutRelease(holder)).toBe(0);
    setApp(okRoot, 4);
    (await resolveApp(okRoot, outRoot)).use.release();

    expect(existsSync(held.outputDir)).toBe(false);
  });
});
