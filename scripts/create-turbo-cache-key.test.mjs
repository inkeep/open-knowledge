import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { CACHE_KEY_FILE, cacheKey, writeCacheKey } from './create-turbo-cache-key.mjs';
import { gitCleanEnv } from './git-clean-env.mjs';

const OK_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TURBO_BIN = join(OK_ROOT, 'node_modules', '.bin', 'turbo');
const TIMEOUT = 90_000;

const readJson = (p) => JSON.parse(readFileSync(join(OK_ROOT, p), 'utf-8'));

const LINUX = { platform: 'linux', arch: 'x64', version: 'v24.18.0' };

describe('turbo platform cache key', () => {
  test('the key file is a globalDependency, so platform reaches every task hash', () => {
    expect(readJson('turbo.json').globalDependencies).toContain(CACHE_KEY_FILE);
  });

  test('postinstall regenerates it, so it exists before any turbo invocation', () => {
    expect(readJson('package.json').scripts.postinstall).toBe(
      'node scripts/create-turbo-cache-key.mjs',
    );
  });

  test('the key carries platform, arch and the running Node, and nothing else', () => {
    expect(cacheKey(LINUX)).toEqual({ platform: 'linux', arch: 'x64', node: 'v24.18.0' });
  });

  test('by default the key describes the process that writes it', () => {
    expect(cacheKey()).toEqual({
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    });
  });

  test('two platforms produce two different payloads', () => {
    const linux = JSON.stringify(cacheKey(LINUX));
    const mac = JSON.stringify(cacheKey({ ...LINUX, platform: 'darwin', arch: 'arm64' }));
    expect(linux).not.toBe(mac);
  });

  test('two Node runtimes produce two different payloads', () => {
    const older = JSON.stringify(cacheKey(LINUX));
    const newer = JSON.stringify(cacheKey({ ...LINUX, version: 'v24.99.0' }));
    expect(older).not.toBe(newer);
  });

  test('writeCacheKey emits the payload the hash reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-turbo-cache-key-'));
    try {
      const { path } = writeCacheKey(dir, {
        platform: 'win32',
        arch: 'arm64',
        version: 'v24.18.0',
      });
      expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({
        platform: 'win32',
        arch: 'arm64',
        node: 'v24.18.0',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const PACKAGES = ['a', 'b'];
const TASKS = PACKAGES.flatMap((name) => [`${name}#build`, `${name}#test`]).sort();
const realGlobalDependencies = readJson('turbo.json').globalDependencies;
const packageManager = readJson('package.json').packageManager;

function write(root, path, body) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

function isolatedEnv(extra = {}) {
  const ambient = Object.entries(gitCleanEnv()).filter(
    ([key]) => !key.startsWith('TURBO_') && !key.startsWith('GIT_CONFIG'),
  );
  return {
    ...Object.fromEntries(ambient),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    TURBO_TELEMETRY_DISABLED: '1',
    TURBO_NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
    ...extra,
  };
}

function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: isolatedEnv({
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    }),
  });
  expect(result.status, `git ${args.join(' ')}\n${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

function fixture(globalDependencies) {
  const root = mkdtempSync(join(tmpdir(), 'ok-turbo-key-hash-'));
  write(
    root,
    'package.json',
    `${JSON.stringify({ name: 'key-hash-fixture', private: true, packageManager })}\n`,
  );
  write(root, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
  for (const name of PACKAGES) {
    write(
      root,
      `packages/${name}/package.json`,
      `${JSON.stringify({ name, version: '0.0.0', scripts: { build: 'node -e 0', test: 'node -e 0' } })}\n`,
    );
    write(root, `packages/${name}/src/index.txt`, `${name}\n`);
  }
  write(root, 'unrelated/notes.txt', 'one\n');
  write(root, '.gitignore', `${CACHE_KEY_FILE}\n`);
  write(
    root,
    'turbo.json',
    `${JSON.stringify(
      {
        globalDependencies,
        tasks: {
          build: { dependsOn: ['^build'], outputs: ['dist/**'] },
          test: { dependsOn: ['build'] },
        },
      },
      null,
      2,
    )}\n`,
  );
  git(root, ['init', '-q']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'fixture']);
  return root;
}

function plan(root) {
  const result = spawnSync(TURBO_BIN, ['run', 'build', 'test', '--dry=json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: isolatedEnv(),
  });
  expect(result.error, `turbo did not exit on its own\n${result.stderr}`).toBeUndefined();
  expect(result.signal, `turbo was killed\n${result.stderr}`).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  const dry = JSON.parse(result.stdout);
  const hashes = Object.fromEntries(dry.tasks.map((task) => [task.taskId, task.hash]));
  expect(Object.keys(hashes).sort()).toEqual(TASKS);
  return { hashes, keyInput: dry.globalCacheInputs?.files?.[CACHE_KEY_FILE] ?? null };
}

const moved = (before, after) => TASKS.filter((task) => before.hashes[task] !== after.hashes[task]);

describe('the key reaches every cached task hash', () => {
  const roots = [];
  const states = {};

  beforeAll(() => {
    const declared = fixture(realGlobalDependencies);
    roots.push(declared);
    writeCacheKey(declared, LINUX);
    states.linux = plan(declared);
    states.linuxKeyHash = git(declared, ['hash-object', CACHE_KEY_FILE]);
    writeCacheKey(declared, { ...LINUX, platform: 'darwin', arch: 'arm64' });
    states.mac = plan(declared);
    writeCacheKey(declared, { ...LINUX, version: 'v24.99.0' });
    states.newerNode = plan(declared);
    writeCacheKey(declared, LINUX);
    write(declared, 'unrelated/notes.txt', 'two\n');
    states.unrelatedEdit = plan(declared);

    const undeclared = fixture(realGlobalDependencies.filter((entry) => entry !== CACHE_KEY_FILE));
    roots.push(undeclared);
    writeCacheKey(undeclared, LINUX);
    states.undeclaredLinux = plan(undeclared);
    writeCacheKey(undeclared, { ...LINUX, platform: 'darwin', arch: 'arm64' });
    states.undeclaredMac = plan(undeclared);
  }, TIMEOUT);

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  test('the key file is a turbo global input carrying the content the generator wrote', () => {
    expect(states.linux.keyInput).toBe(states.linuxKeyHash);
  });

  test('another platform moves every task hash', () => {
    expect(moved(states.linux, states.mac)).toEqual(TASKS);
  });

  test('another Node runtime moves every task hash', () => {
    expect(moved(states.linux, states.newerNode)).toEqual(TASKS);
  });

  test('a change to an unrelated tracked file moves none', () => {
    expect(moved(states.linux, states.unrelatedEdit)).toEqual([]);
  });

  test('once the key leaves globalDependencies, another platform moves none', () => {
    expect(moved(states.undeclaredLinux, states.undeclaredMac)).toEqual([]);
  });
});
