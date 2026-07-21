/**
 * Managed-runtime download path: checksum verification, atomic install,
 * fast-path reuse, and consent persistence. The download is exercised
 * end-to-end against a real `tar` extract of a synthetic runtime tree served
 * through a fake `fetch` — no network, but the archive → verify → extract →
 * rename → locate-launcher pipeline runs for real.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { getLogger } from '../logger.ts';
import { shaForFile } from './archive.ts';
import {
  describeRuntime,
  ensureManagedRuntime,
  findManagedRuntime,
  type ManagedRuntimeKind,
  RuntimeInstallError,
  readRuntimeConsent,
  runtimeForInterpreter,
  writeRuntimeConsent,
} from './managed-runtime.ts';

const log = getLogger('managed-runtime-test');

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'managed-runtime-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** Build a `.tar.gz` containing `<innerDir>/<file>` entries and return its sha. */
function buildTarball(
  dir: string,
  innerDir: string,
  files: string[],
): { bytes: Buffer; sha: string } {
  const treeRoot = join(dir, `tree-${innerDir}`);
  const inner = join(treeRoot, innerDir);
  mkdirSync(inner, { recursive: true });
  for (const f of files) {
    const path = join(inner, f);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `#!/bin/sh\necho ${f}\n`, { mode: 0o755 });
  }
  const tarPath = join(dir, `${innerDir}.tar.gz`);
  execFileSync('tar', ['-czf', tarPath, '-C', treeRoot, innerDir]);
  const bytes = readFileSync(tarPath);
  return { bytes, sha: createHash('sha256').update(bytes).digest('hex') };
}

const NODE_NAMES = [
  'darwin-arm64.tar.gz',
  'darwin-x64.tar.gz',
  'linux-arm64.tar.gz',
  'linux-x64.tar.gz',
  'win-x64.zip',
  'win-arm64.zip',
];

/** A fake fetch that serves `bytes` for any archive URL and `sha` in the checksum sidecar. */
function makeFetch(bytes: Buffer, sha: string): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('SHASUMS256.txt')) {
      const body = `${NODE_NAMES.map((n) => `${sha}  node-v24.18.0-${n}`).join('\n')}\n`;
      return new Response(body, { status: 200 });
    }
    if (u.endsWith('.sha256')) {
      const base = u.slice(u.lastIndexOf('/') + 1, -'.sha256'.length);
      return new Response(`${sha}  ${base}\n`, { status: 200 });
    }
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { 'content-length': String(bytes.length) },
    });
  }) as unknown as typeof fetch;
}

describe('shaForFile', () => {
  test('parses a multi-line SHASUMS body by basename', () => {
    const body = [
      'aaaa  node-v1-darwin-arm64.tar.gz',
      `${'b'.repeat(64)}  node-v1-linux-x64.tar.gz`,
    ].join('\n');
    expect(shaForFile(body, 'node-v1-linux-x64.tar.gz')).toBe('b'.repeat(64));
  });

  test('handles a binary-mode marker and a path prefix on the name', () => {
    const body = `${'c'.repeat(64)}  *dist/uv-x86_64-apple-darwin.tar.gz`;
    expect(shaForFile(body, 'uv-x86_64-apple-darwin.tar.gz')).toBe('c'.repeat(64));
  });

  test('returns null when the file is absent', () => {
    expect(shaForFile(`${'d'.repeat(64)}  other.tar.gz`, 'missing.tar.gz')).toBeNull();
  });

  test('ignores lines that are not a valid checksum', () => {
    expect(shaForFile('not-a-checksum  node.tar.gz', 'node.tar.gz')).toBeNull();
  });
});

describe('descriptors', () => {
  test('runtimeForInterpreter maps npx→node, uvx→uv', () => {
    expect(runtimeForInterpreter('npx')).toBe('node');
    expect(runtimeForInterpreter('uvx')).toBe('uv');
  });
  test('describeRuntime carries the download disclosure', () => {
    const node = describeRuntime('node');
    expect(node.displayName).toBe('Node.js');
    expect(node.provides).toBe('npx');
    expect(node.sourceHost).toBe('nodejs.org');
    expect(node.approxSizeMB).toBeGreaterThan(0);
    expect(describeRuntime('uv').provides).toBe('uvx');
  });
});

describe('findManagedRuntime', () => {
  test('returns null when nothing is installed', async () => {
    const root = tmp();
    expect(await findManagedRuntime('node', root)).toBeNull();
  });
});

describe('ensureManagedRuntime', () => {
  test('downloads, verifies, installs, and locates the launcher (node)', async () => {
    const stage = tmp();
    const root = tmp();
    const { bytes, sha } = buildTarball(stage, 'node-vTEST', ['bin/node', 'bin/npx']);
    const runtime = await ensureManagedRuntime('node', log, {
      root,
      fetchImpl: makeFetch(bytes, sha),
    });
    expect(runtime.kind).toBe('node');
    if (runtime.kind !== 'node') throw new Error('unreachable');
    expect(existsSync(runtime.npxBin)).toBe(true);
    expect(runtime.npxBin.endsWith('npx')).toBe(true);
    // Bin dir (for PATH) holds the sibling node the launcher needs.
    expect(existsSync(join(runtime.binDir, 'node'))).toBe(true);
    // Now discoverable via the fast path.
    const found = await findManagedRuntime('node', root);
    expect(found?.npxBin).toBe(runtime.npxBin);
  });

  test('downloads and installs uv via its per-asset .sha256', async () => {
    const stage = tmp();
    const root = tmp();
    const { bytes, sha } = buildTarball(stage, 'uv-TEST', ['uv', 'uvx']);
    const runtime = await ensureManagedRuntime('uv', log, {
      root,
      fetchImpl: makeFetch(bytes, sha),
    });
    expect(runtime.kind).toBe('uv');
    if (runtime.kind !== 'uv') throw new Error('unreachable');
    expect(existsSync(runtime.uvxBin)).toBe(true);
    expect(existsSync(join(runtime.binDir, 'uv'))).toBe(true);
  });

  test('reuses an installed runtime without re-fetching', async () => {
    const stage = tmp();
    const root = tmp();
    const { bytes, sha } = buildTarball(stage, 'node-vTEST', ['bin/node', 'bin/npx']);
    await ensureManagedRuntime('node', log, { root, fetchImpl: makeFetch(bytes, sha) });
    // A fetch that would throw proves the second call never hits the network.
    const throwingFetch = (async () => {
      throw new Error('should not fetch');
    }) as unknown as typeof fetch;
    const again = await ensureManagedRuntime('node', log, { root, fetchImpl: throwingFetch });
    expect(again.kind).toBe('node');
  });

  test('rejects a checksum mismatch and installs nothing', async () => {
    const stage = tmp();
    const root = tmp();
    const { bytes } = buildTarball(stage, 'node-vTEST', ['bin/node', 'bin/npx']);
    const wrongSha = 'e'.repeat(64);
    await expect(
      ensureManagedRuntime('node', log, { root, fetchImpl: makeFetch(bytes, wrongSha) }),
    ).rejects.toThrow(RuntimeInstallError);
    expect(await findManagedRuntime('node', root)).toBeNull();
  });
});

describe('runtime consent persistence', () => {
  test('round-trips a per-runtime decision and merges without clobbering', async () => {
    const home = tmp();
    expect(await readRuntimeConsent(home)).toEqual({});
    await writeRuntimeConsent('node', 'granted', log, home);
    expect(await readRuntimeConsent(home)).toEqual({ node: 'granted' });
    await writeRuntimeConsent('uv', 'declined', log, home);
    expect(await readRuntimeConsent(home)).toEqual({ node: 'granted', uv: 'declined' });
  });

  test('ignores an unparseable consent file', async () => {
    const home = tmp();
    writeFileSync(join(home, 'acp-runtime-consent.json'), '{ not json');
    expect(await readRuntimeConsent(home)).toEqual({});
  });

  const kinds: ManagedRuntimeKind[] = ['node', 'uv'];
  test.each(kinds)('overwrites a prior %s decision', async (kind) => {
    const home = tmp();
    await writeRuntimeConsent(kind, 'declined', log, home);
    await writeRuntimeConsent(kind, 'granted', log, home);
    expect((await readRuntimeConsent(home))[kind]).toBe('granted');
  });
});
