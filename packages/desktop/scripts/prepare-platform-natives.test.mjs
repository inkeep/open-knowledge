import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  extractWithTar,
  installedState,
  NativesError,
  prepareNatives,
  readTarEntries,
} from './prepare-platform-natives.mjs';

const VERSION = '1.3.0';
const ARM64 = '@napi-rs/keyring-win32-arm64-msvc';
const X64 = '@napi-rs/keyring-win32-x64-msvc';

function tarHeader(name, size, type = '0') {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'latin1');
  header.write('0000000\0', 108, 8, 'latin1');
  header.write('0000000\0', 116, 8, 'latin1');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1');
  header.write('00000000000\0', 136, 12, 'latin1');
  header.write('        ', 148, 8, 'latin1');
  header.write(type, 156, 1, 'latin1');
  header.write('ustar\0', 257, 6, 'latin1');
  header.write('00', 263, 2, 'latin1');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return header;
}

function tarBytes(entries) {
  const parts = [];
  for (const { name, data = Buffer.alloc(0), type = '0' } of entries) {
    parts.push(tarHeader(name, data.length, type), data);
    parts.push(Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const nativeBytes = Buffer.alloc(40_000, 7);
const manifest = Buffer.from(JSON.stringify({ name: ARM64, version: VERSION }));
const archive = gzipSync(
  tarBytes([
    { name: 'package/', type: '5' },
    { name: 'package/package.json', data: manifest },
    { name: 'package/README.md', data: Buffer.from('readme') },
    { name: 'package/keyring.win32-arm64-msvc.node', data: nativeBytes },
  ]),
);
const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;

let server;
let registry;
let mode = 'ok';
let hits = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    hits += 1;
    if (mode === 'drop') {
      request.socket.destroy();
      return;
    }
    if (mode === 'unavailable') {
      response.writeHead(503, 'Service Unavailable').end();
      return;
    }
    if (!request.url.endsWith(`/keyring-win32-arm64-msvc-${VERSION}.tgz`)) {
      response.writeHead(404, 'Not Found').end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(mode === 'tampered' ? gzipSync(tarBytes([])) : archive);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  registry = `http://127.0.0.1:${server.address().port}/`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

const roots = [];
afterEach(() => {
  mode = 'ok';
  for (const root of roots.splice(0)) {
    chmodSync(join(root, 'node_modules', '@napi-rs'), 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'prepare-platform-natives-'));
  roots.push(root);
  const napi = join(root, 'node_modules', '@napi-rs');
  mkdirSync(join(napi, 'keyring'), { recursive: true });
  writeFileSync(join(napi, 'keyring', 'package.json'), JSON.stringify({ version: VERSION }));
  const store = join(root, 'node_modules', '.pnpm', `@napi-rs+keyring-win32-x64-msvc@${VERSION}`);
  const hostPackage = join(store, 'node_modules', '@napi-rs', 'keyring-win32-x64-msvc');
  mkdirSync(hostPackage, { recursive: true });
  writeFileSync(join(hostPackage, 'package.json'), JSON.stringify({ name: X64, version: VERSION }));
  symlinkSync(hostPackage, join(napi, 'keyring-win32-x64-msvc'));
  writeFileSync(
    join(root, 'pnpm-lock.yaml'),
    `packages:\n\n  '${ARM64}@${VERSION}':\n    resolution: {integrity: ${integrity}}\n`,
  );
  return root;
}

const run = (root, overrides = {}) => {
  const lines = [];
  return prepareNatives({
    repoRoot: root,
    platform: 'win32',
    registry,
    extract: extractWithTar('tar'),
    log: (line) => lines.push(line),
    ...overrides,
  }).then(() => lines);
};

const arm64Dir = (root) => join(root, 'node_modules', '@napi-rs', 'keyring-win32-arm64-msvc');
const hostManifest = (root) =>
  join(root, 'node_modules', '@napi-rs', 'keyring-win32-x64-msvc', 'package.json');
const parseFailure = (text) => {
  try {
    JSON.parse(text);
  } catch (error) {
    return error.message;
  }
};
const leftovers = (root) =>
  readdirSync(join(root, 'node_modules', '@napi-rs')).filter((name) => name.startsWith('.staging'));

describe('prepare-platform-natives', () => {
  test('publishes a verified prebuild and records its completion marker', async () => {
    const root = fixtureRoot();
    const lines = await run(root);
    expect(readFileSync(join(arm64Dir(root), 'keyring.win32-arm64-msvc.node'))).toEqual(
      nativeBytes,
    );
    expect(lines.join('\n')).toContain(`${X64}@${VERSION} present (pnpm-managed) — skip`);
    expect(
      installedState({
        repoRoot: root,
        targetDir: arm64Dir(root),
        pkgName: ARM64,
        version: VERSION,
        integrity,
      }),
    ).toEqual({ valid: true, reason: 'verified' });
    expect(leftovers(root)).toEqual([]);
  });

  test('skips a verified install without touching the registry', async () => {
    const root = fixtureRoot();
    await run(root);
    const before = hits;
    const lines = await run(root);
    expect(hits).toBe(before);
    expect(lines.join('\n')).toContain(`${ARM64}@${VERSION} present (verified) — skip`);
  });

  test('refuses bytes that do not match the lockfile as a hash mismatch', async () => {
    const root = fixtureRoot();
    mode = 'tampered';
    await expect(run(root)).rejects.toThrow(/sha512 hash mismatch, expected sha512-/);
    expect(existsSync(arm64Dir(root))).toBe(false);
    expect(leftovers(root)).toEqual([]);
  });

  test('names an HTTP failure by its status', async () => {
    const root = fixtureRoot();
    mode = 'unavailable';
    await expect(run(root)).rejects.toThrow(/→ HTTP 503 Service Unavailable/);
    expect(existsSync(arm64Dir(root))).toBe(false);
  });

  test('names a dropped connection by its cause code', async () => {
    const root = fixtureRoot();
    mode = 'drop';
    await expect(run(root)).rejects.toThrow(/failed: (UND_ERR_SOCKET|ECONNRESET)/);
  });

  test('rebuilds a partial install from verified bytes', async () => {
    const root = fixtureRoot();
    mkdirSync(arm64Dir(root), { recursive: true });
    writeFileSync(join(arm64Dir(root), 'package.json'), manifest);
    writeFileSync(
      join(arm64Dir(root), 'keyring.win32-arm64-msvc.node'),
      nativeBytes.subarray(0, 100),
    );
    const lines = await run(root);
    expect(lines.join('\n')).toContain('no completion marker — fetching');
    expect(readFileSync(join(arm64Dir(root), 'keyring.win32-arm64-msvc.node'))).toEqual(
      nativeBytes,
    );
  });

  test('keeps a partial install unverified when the bytes cannot be fetched', async () => {
    const root = fixtureRoot();
    mkdirSync(arm64Dir(root), { recursive: true });
    writeFileSync(join(arm64Dir(root), 'package.json'), manifest);
    writeFileSync(
      join(arm64Dir(root), 'keyring.win32-arm64-msvc.node'),
      nativeBytes.subarray(0, 100),
    );
    mode = 'unavailable';
    await expect(run(root)).rejects.toThrow(/HTTP 503/);
    await expect(run(root, { checkOnly: true })).rejects.toThrow(
      new RegExp(`${ARM64}@${VERSION} \\(no completion marker\\)`),
    );
  });

  test('catches a truncated file behind a valid marker', async () => {
    const root = fixtureRoot();
    await run(root);
    writeFileSync(
      join(arm64Dir(root), 'keyring.win32-arm64-msvc.node'),
      nativeBytes.subarray(0, 100),
    );
    await expect(run(root, { checkOnly: true })).rejects.toThrow(
      /differs from the verified archive/,
    );
    await run(root);
    expect(readFileSync(join(arm64Dir(root), 'keyring.win32-arm64-msvc.node'))).toEqual(
      nativeBytes,
    );
  });

  test('publishes nothing when extraction does not reproduce the verified archive', async () => {
    const root = fixtureRoot();
    const partialExtract = (_archivePath, destination) => {
      writeFileSync(join(destination, 'package.json'), manifest);
    };
    await expect(run(root, { extract: partialExtract })).rejects.toThrow(
      /extraction does not match the verified archive/,
    );
    expect(existsSync(arm64Dir(root))).toBe(false);
    expect(leftovers(root)).toEqual([]);
  });

  test.skipIf(process.getuid?.() === 0)('names a failed publish rename by its code', async () => {
    const root = fixtureRoot();
    const napi = join(root, 'node_modules', '@napi-rs');
    const lockParent = (archivePath, destination) => {
      extractWithTar('tar')(archivePath, destination);
      chmodSync(napi, 0o555);
    };
    await expect(run(root, { extract: lockParent })).rejects.toThrow(/publish rename failed: E/);
  });

  test('names a completion marker it cannot write by its code', async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, 'node_modules', '.cache'), 'not a directory');
    await expect(run(root)).rejects.toThrow(/publish marker write failed: E/);
  });

  test.skipIf(process.getuid?.() === 0)(
    'logs a staging directory it cannot remove after a failed publish',
    async () => {
      const root = fixtureRoot();
      const napi = join(root, 'node_modules', '@napi-rs');
      const staging = join(napi, `.staging-keyring-win32-arm64-msvc-${process.pid}`);
      const lockParent = (archivePath, destination) => {
        extractWithTar('tar')(archivePath, destination);
        chmodSync(napi, 0o555);
      };
      const lines = [];
      await expect(
        run(root, { extract: lockParent, log: (line) => lines.push(line) }),
      ).rejects.toThrow(/publish rename failed: E/);
      expect(lines.filter((line) => line.includes(staging))).toEqual([
        expect.stringMatching(/^\[prepare-platform-natives\] .*: E[A-Z]+$/),
      ]);
    },
  );

  test.skipIf(process.getuid?.() === 0)(
    'logs a leftover staging directory it cannot remove and still publishes',
    async () => {
      const root = fixtureRoot();
      const leftover = join(
        root,
        'node_modules',
        '@napi-rs',
        '.staging-keyring-win32-arm64-msvc-earlier',
      );
      const locked = join(leftover, 'locked');
      mkdirSync(locked, { recursive: true });
      writeFileSync(join(locked, 'keyring.win32-arm64-msvc.node'), 'partial');
      chmodSync(locked, 0o555);
      let lines;
      try {
        lines = await run(root);
      } finally {
        chmodSync(locked, 0o755);
      }
      expect(lines.filter((line) => line.includes(leftover))).toEqual([
        expect.stringMatching(/^\[prepare-platform-natives\] .*: E[A-Z]+$/),
      ]);
      expect(readFileSync(join(arm64Dir(root), 'keyring.win32-arm64-msvc.node'))).toEqual(
        nativeBytes,
      );
    },
  );

  test('refetches when the lockfile pins another archive', async () => {
    const root = fixtureRoot();
    await run(root);
    const other = `sha512-${createHash('sha512').update('other').digest('base64')}`;
    writeFileSync(
      join(root, 'pnpm-lock.yaml'),
      `packages:\n\n  '${ARM64}@${VERSION}':\n    resolution: {integrity: ${other}}\n`,
    );
    await expect(run(root, { checkOnly: true })).rejects.toThrow(
      `${ARM64}@${VERSION} (completion marker is for another version or archive)`,
    );
    const before = hits;
    await expect(run(root)).rejects.toThrow(/sha512 hash mismatch/);
    expect(hits).toBe(before + 1);
  });

  test('refuses a marker once the wrapper moves to another version', async () => {
    const root = fixtureRoot();
    await run(root);
    writeFileSync(
      join(root, 'node_modules', '@napi-rs', 'keyring', 'package.json'),
      JSON.stringify({ version: '1.4.0' }),
    );
    writeFileSync(
      join(root, 'pnpm-lock.yaml'),
      `packages:\n\n  '${ARM64}@1.4.0':\n    resolution: {integrity: ${integrity}}\n`,
    );
    await expect(run(root, { checkOnly: true })).rejects.toThrow(
      `${ARM64}@1.4.0 (completion marker is for another version or archive)`,
    );
  });

  test('rebuilds a published tree that gained an extra file', async () => {
    const root = fixtureRoot();
    await run(root);
    writeFileSync(join(arm64Dir(root), 'extra.node'), 'stray');
    await expect(run(root, { checkOnly: true })).rejects.toThrow(
      /4 file\(s\) on disk, 3 in the verified archive/,
    );
    await run(root);
    expect(existsSync(join(arm64Dir(root), 'extra.node'))).toBe(false);
  });

  test('does not trust a host link that leaves the pnpm store', async () => {
    const root = fixtureRoot();
    await run(root);
    const elsewhere = join(root, 'elsewhere', 'keyring-win32-x64-msvc');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'package.json'), JSON.stringify({ name: X64, version: VERSION }));
    const link = join(root, 'node_modules', '@napi-rs', 'keyring-win32-x64-msvc');
    rmSync(link);
    symlinkSync(elsewhere, link);
    await expect(run(root, { checkOnly: true })).rejects.toThrow(
      `${X64}@${VERSION} (a link outside the pnpm store or at another version)`,
    );
  });

  test('names a corrupt store manifest behind a host link by its parse error', async () => {
    const root = fixtureRoot();
    await run(root);
    const corrupt = `{"version": "${VERSION}"`;
    writeFileSync(hostManifest(root), corrupt);
    const failure = await run(root, { checkOnly: true }).catch((error) => error);
    expect(failure).toBeInstanceOf(NativesError);
    expect(failure.message).toContain(`${X64}@${VERSION} (`);
    expect(failure.message).toContain(parseFailure(corrupt));
    expect(failure.message).not.toContain('a link outside the pnpm store or at another version');
  });

  test.skipIf(process.getuid?.() === 0)(
    'names an unreadable store manifest behind a host link by its code',
    async () => {
      const root = fixtureRoot();
      await run(root);
      chmodSync(hostManifest(root), 0o000);
      const failure = await run(root, { checkOnly: true }).catch((error) => error);
      expect(failure).toBeInstanceOf(NativesError);
      expect(failure.message).toContain(`${X64}@${VERSION} (`);
      expect(failure.message).toMatch(/EACCES/);
      expect(failure.message).not.toContain('a link outside the pnpm store or at another version');
    },
  );

  test.skipIf(process.getuid?.() === 0)(
    'names a previous target it cannot remove before publishing',
    async () => {
      const root = fixtureRoot();
      await run(root);
      writeFileSync(
        join(arm64Dir(root), 'keyring.win32-arm64-msvc.node'),
        nativeBytes.subarray(0, 100),
      );
      chmodSync(arm64Dir(root), 0o555);
      try {
        await expect(run(root)).rejects.toThrow(
          /publish could not remove the previous target: E[A-Z]+/,
        );
      } finally {
        chmodSync(arm64Dir(root), 0o755);
      }
    },
  );

  test('check mode verifies without fetching', async () => {
    const root = fixtureRoot();
    await run(root);
    const before = hits;
    const lines = await run(root, { checkOnly: true });
    expect(hits).toBe(before);
    expect(lines.join('\n')).toContain(`${ARM64}@${VERSION}: verified (verified)`);
  });

  test('refuses an unpinned package', async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'packages:\n');
    await expect(run(root)).rejects.toThrow(/no integrity entry in pnpm-lock.yaml/);
  });

  test('is a no-op on a platform it does not stage', async () => {
    const root = fixtureRoot();
    const lines = await run(root, { platform: 'darwin' });
    expect(lines.join('\n')).toContain('no-op');
  });
});

describe('readTarEntries', () => {
  test('hashes regular files under the stripped package root and honours pax paths', () => {
    const pax = Buffer.from('30 path=package/long-name.txt\n');
    const entries = readTarEntries(
      tarBytes([
        { name: 'package/a.txt', data: Buffer.from('a') },
        { name: 'PaxHeader', data: pax, type: 'x' },
        { name: 'package/short', data: Buffer.from('b') },
      ]),
    );
    expect([...entries.keys()]).toEqual(['a.txt', 'long-name.txt']);
  });

  test.each([
    ['a link entry', [{ name: 'package/link', type: '2' }], /unsupported entry type "2"/],
    ['an unsafe path', [{ name: '../escape', data: Buffer.from('x') }], /unsafe path/],
    [
      'a duplicate entry',
      [
        { name: 'package/a', data: Buffer.from('1') },
        { name: 'package/a', data: Buffer.from('2') },
      ],
      /duplicate entry/,
    ],
  ])('rejects %s', (_name, entries, message) => {
    expect(() => readTarEntries(tarBytes(entries))).toThrow(message);
  });

  test('rejects a corrupted header', () => {
    const bytes = tarBytes([{ name: 'package/a', data: Buffer.from('1') }]);
    bytes[10] ^= 0xff;
    expect(() => readTarEntries(bytes)).toThrow(NativesError);
  });
});
