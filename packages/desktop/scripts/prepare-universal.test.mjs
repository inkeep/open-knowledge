import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';

const scripts = dirname(fileURLToPath(import.meta.url));
const version = '1.3.0';
const payload = Buffer.from('complete native payload');
const resources = [];

afterEach(async () => {
  for (const { root, server } of resources.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

async function fixture({
  unavailable = false,
  missing = false,
  hostArch = 'arm64',
  targetVersion = version,
  tampered = false,
} = {}) {
  const targetArch = hostArch === 'arm64' ? 'x64' : 'arm64';
  const tarballPath = `/@napi-rs/keyring-darwin-${targetArch}/-/keyring-darwin-${targetArch}-${version}.tgz`;
  const root = mkdtempSync(join(tmpdir(), 'prepare-universal-'));
  const server = createServer((request, response) => {
    if (unavailable) response.writeHead(503, 'Service Unavailable').end();
    else if (request.url !== tarballPath) response.writeHead(404, 'Not Found').end();
    else response.writeHead(200).end(tampered ? Buffer.from('different archive') : archive);
  });
  resources.push({ root, server });
  const targetScripts = join(root, 'packages', 'desktop', 'scripts');
  mkdirSync(targetScripts, { recursive: true });
  for (const name of ['prepare-universal.mjs', 'prepare-platform-natives.mjs']) {
    copyFileSync(join(scripts, name), join(targetScripts, name));
  }
  const napi = join(root, 'node_modules', '@napi-rs');
  mkdirSync(join(napi, 'keyring'), { recursive: true });
  writeFileSync(join(napi, 'keyring', 'package.json'), JSON.stringify({ version }));
  const host = join(
    root,
    'node_modules',
    '.pnpm',
    `@napi-rs+keyring-darwin-${hostArch}@${version}`,
    'node_modules',
    '@napi-rs',
    `keyring-darwin-${hostArch}`,
  );
  mkdirSync(host, { recursive: true });
  writeFileSync(join(host, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(host, `keyring.darwin-${hostArch}.node`), payload);
  symlinkSync(host, join(napi, `keyring-darwin-${hostArch}`), 'junction');
  const target = join(napi, `keyring-darwin-${targetArch}`);
  const binary = join(target, `keyring.darwin-${targetArch}.node`);
  mkdirSync(target);
  writeFileSync(join(target, 'package.json'), JSON.stringify({ version: targetVersion }));
  if (!missing) writeFileSync(binary, payload.subarray(0, 3));
  const archiveRoot = join(root, 'archive');
  mkdirSync(join(archiveRoot, 'package'), { recursive: true });
  writeFileSync(join(archiveRoot, 'package', 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(archiveRoot, 'package', `keyring.darwin-${targetArch}.node`), payload);
  const archivePath = join(root, 'native.tgz');
  execFileSync('tar', ['--format=ustar', '-czf', archivePath, '-C', archiveRoot, 'package'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const archive = readFileSync(archivePath);
  const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
  writeFileSync(
    join(root, 'pnpm-lock.yaml'),
    `packages:\n  '@napi-rs/keyring-darwin-${targetArch}@${version}':\n    resolution: {integrity: ${integrity}}\n`,
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const fixtureRegistry = `http://127.0.0.1:${server.address().port}/`;
  const preload = join(root, 'platform.mjs');
  writeFileSync(
    preload,
    `Object.defineProperty(process, 'platform', { value: 'darwin' });
Object.defineProperty(process, 'arch', { value: ${JSON.stringify(hostArch)} });
const fetchFromNetwork = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const requested = new URL(url);
  if (requested.origin !== 'https://registry.npmjs.org') {
    return Promise.reject(new Error('unexpected registry ' + requested.origin));
  }
  return fetchFromNetwork(new URL(requested.pathname, ${JSON.stringify(fixtureRegistry)}), options);
};
`,
  );
  return { root, target, binary, preload };
}

async function run({ root, preload }) {
  const child = spawn(
    process.execPath,
    ['--import', preload, join(root, 'packages', 'desktop', 'scripts', 'prepare-universal.mjs')],
    {
      cwd: root,
      env: { ...process.env, npm_config_registry: 'https://registry.invalid/' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => {
    stdout += data;
  });
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, stdout, stderr };
}

test('fails when a partial native cannot be restored', async () => {
  const input = await fixture({ unavailable: true });
  const result = await run(input);
  expect(result.code, result.stdout + result.stderr).not.toBe(0);
  expect(result.stderr).toContain('HTTP 503');
  expect(readFileSync(input.binary)).toEqual(payload.subarray(0, 3));
});

test.each([
  { hostArch: 'arm64', missing: false },
  { hostArch: 'arm64', missing: true },
  { hostArch: 'x64', missing: false },
  { hostArch: 'x64', missing: true },
])(
  'restores an incomplete native and leaves it untouched on rerun (host=$hostArch, missing=$missing)',
  async (options) => {
    const input = await fixture(options);
    const { binary } = input;
    const result = await run(input);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(existsSync(binary)).toBe(true);
    expect(readFileSync(binary)).toEqual(payload);
    const before = statSync(binary);
    const repeated = await run(input);
    expect(repeated.code, repeated.stdout + repeated.stderr).toBe(0);
    expect(statSync(binary)).toMatchObject({ ino: before.ino, mtimeMs: before.mtimeMs });
  },
);

test('updates an older native package to the host version', async () => {
  const input = await fixture({ targetVersion: '1.2.0' });
  const result = await run(input);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(input.target, 'package.json'), 'utf8')).version).toBe(
    version,
  );
  expect(readFileSync(input.binary)).toEqual(payload);
});

test('refuses an archive that differs from the lockfile before replacing the partial target', async () => {
  const input = await fixture({ tampered: true });
  const result = await run(input);
  expect(result.code, result.stdout + result.stderr).not.toBe(0);
  expect(result.stderr).toContain('sha512 hash mismatch');
  expect(readFileSync(input.binary)).toEqual(payload.subarray(0, 3));
});
