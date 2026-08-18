/**
 * Managed-runtime download path: checksum verification, atomic install, and
 * fast-path reuse. The download is exercised
 * end-to-end against a real `tar` extract of a synthetic runtime tree served
 * through a fake `fetch` — no network, but the archive → verify → extract →
 * rename → locate-launcher pipeline runs for real.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { getLogger } from '../logger.ts';
import { shaForFile } from './archive.ts';
import {
  describeRuntime,
  ensureManagedRuntime,
  findManagedRuntime,
  quarantineManagedRuntime,
  RuntimeInstallError,
  runtimeForInterpreter,
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
  label?: string,
): { bytes: Buffer; sha: string } {
  const treeRoot = join(dir, `tree-${innerDir}`);
  const inner = join(treeRoot, innerDir);
  mkdirSync(inner, { recursive: true });
  for (const f of files) {
    const path = join(inner, f);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `#!/bin/sh\necho ${label ?? f}\n`, { mode: 0o755 });
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

  test('stages the install beside the destination before downloading', async () => {
    const stage = tmp();
    const root = tmp();
    const { bytes, sha } = buildTarball(stage, 'node-vTEST', ['bin/node', 'bin/npx']);
    const baseFetch = makeFetch(bytes, sha);
    let observedStagingDir: string | undefined;
    const inspectingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      observedStagingDir = readdirSync(join(root, 'node')).find((name) =>
        name.startsWith('.install-'),
      );
      return baseFetch(input, init);
    }) as typeof fetch;

    await ensureManagedRuntime('node', log, { root, fetchImpl: inspectingFetch });

    expect(observedStagingDir).toBeDefined();
    expect(readdirSync(join(root, 'node'))).not.toContain(observedStagingDir);
  });

  test('removes crash-orphaned staging directories on the next install', async () => {
    const stage = tmp();
    const root = tmp();
    const staleDir = join(root, 'node', '.install-v24.18.0-orphaned');
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, 'partial-archive'), 'partial');
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    utimesSync(staleDir, staleTime, staleTime);
    const { bytes, sha } = buildTarball(stage, 'node-vTEST', ['bin/node', 'bin/npx']);

    await ensureManagedRuntime('node', log, { root, fetchImpl: makeFetch(bytes, sha) });

    expect(existsSync(staleDir)).toBe(false);
  });

  test('concurrent installers adopt the first completed runtime', async () => {
    const firstStage = tmp();
    const secondStage = tmp();
    const root = tmp();
    const first = buildTarball(firstStage, 'node-vFIRST', ['bin/node', 'bin/npx'], 'first');
    const second = buildTarball(secondStage, 'node-vSECOND', ['bin/node', 'bin/npx'], 'second');
    let arrivals = 0;
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const beforeCommit = async () => {
      arrivals += 1;
      if (arrivals === 2) releaseCommit();
      await commitGate;
    };
    const installAndReadLauncher = async (archive: typeof first) => {
      const runtime = await ensureManagedRuntime('node', log, {
        root,
        fetchImpl: makeFetch(archive.bytes, archive.sha),
        beforeCommit,
      });
      if (runtime.kind !== 'node') throw new Error('unreachable');
      return readFileSync(runtime.npxBin, 'utf8');
    };

    const launchers = await Promise.all([
      installAndReadLauncher(first),
      installAndReadLauncher(second),
    ]);

    expect(arrivals).toBe(2);
    expect(launchers[0]).toBe(launchers[1]);
    expect(await findManagedRuntime('node', root)).not.toBeNull();
  });

  test('adopts a completed runtime when the commit lock times out', async () => {
    const stage = tmp();
    const root = tmp();
    const versionDir = join(root, 'node', describeRuntime('node').version);
    const { bytes, sha } = buildTarball(stage, 'node-vTEST', ['bin/node', 'bin/npx']);

    const runtime = await ensureManagedRuntime('node', log, {
      root,
      fetchImpl: makeFetch(bytes, sha),
      commitLockTimeoutMs: 100,
      beforeCommit: async () => {
        const binDir = join(versionDir, 'winner', 'bin');
        mkdirSync(binDir, { recursive: true });
        writeFileSync(join(binDir, 'npx'), '#!/bin/sh\n', { mode: 0o755 });
        writeFileSync(`${versionDir}.install.lock`, 'held');
        const future = new Date(Date.now() + 60_000);
        utimesSync(`${versionDir}.install.lock`, future, future);
      },
    });

    expect(runtime.kind).toBe('node');
    if (runtime.kind !== 'node') throw new Error('unreachable');
    expect(runtime.npxBin).toBe(join(versionDir, 'winner', 'bin', 'npx'));
  });

  test('throws when the commit lock times out without an installed winner', async () => {
    const stage = tmp();
    const root = tmp();
    const versionDir = join(root, 'node', describeRuntime('node').version);
    const { bytes, sha } = buildTarball(stage, 'node-vTEST', ['bin/node', 'bin/npx']);

    const error = await ensureManagedRuntime('node', log, {
      root,
      fetchImpl: makeFetch(bytes, sha),
      commitLockTimeoutMs: 100,
      beforeCommit: async () => {
        writeFileSync(`${versionDir}.install.lock`, 'held');
        const future = new Date(Date.now() + 60_000);
        utimesSync(`${versionDir}.install.lock`, future, future);
      },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RuntimeInstallError);
    expect(error).toHaveProperty('message', expect.stringContaining('Could not acquire file lock'));
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

  test('rejects an archive that contains no usable launcher', async () => {
    const stage = tmp();
    const root = tmp();
    const { bytes, sha } = buildTarball(stage, 'node-vTEST', ['bin/notlauncher']);

    const error = await ensureManagedRuntime('node', log, {
      root,
      fetchImpl: makeFetch(bytes, sha),
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RuntimeInstallError);
    expect((error as Error).message).toContain('no usable launcher');
    expect(await findManagedRuntime('node', root)).toBeNull();
  });

  test('preserves the underlying failure as the error cause', async () => {
    const root = tmp();
    const failure = new Error('network unreachable');
    const failingFetch = (async () => {
      throw failure;
    }) as unknown as typeof fetch;

    const error = await ensureManagedRuntime('node', log, {
      root,
      fetchImpl: failingFetch,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RuntimeInstallError);
    expect((error as Error).cause).toBe(failure);
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

describe('quarantineManagedRuntime', () => {
  test('clears the way for a re-download and drops the damaged tree', async () => {
    const stage = tmp();
    const root = tmp();
    const { bytes, sha } = buildTarball(stage, 'node-vTEST', ['bin/node', 'bin/npx']);
    await ensureManagedRuntime('node', log, { root, fetchImpl: makeFetch(bytes, sha) });
    expect(await findManagedRuntime('node', root)).not.toBeNull();

    expect(await quarantineManagedRuntime('node', log, root)).toBe(true);

    // Gone from the fast path, and nothing left behind for the staging sweep
    // to trip over — the install-shaped name is the fallback, not the plan.
    expect(await findManagedRuntime('node', root)).toBeNull();
    expect(readdirSync(join(root, 'node'))).toHaveLength(0);
    const again = await ensureManagedRuntime('node', log, {
      root,
      fetchImpl: makeFetch(bytes, sha),
    });
    expect(existsSync(again.kind === 'node' ? again.npxBin : again.uvxBin)).toBe(true);
  });

  // Denying write on the parent is how this forces the rename to fail. Root
  // ignores the mode, and Windows doesn't enforce it that way at all — on
  // either the rename would succeed and the assertion would measure nothing.
  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports failure instead of pretending the tree is gone',
    async () => {
      const stage = tmp();
      const root = tmp();
      const { bytes, sha } = buildTarball(stage, 'node-vTEST', ['bin/node', 'bin/npx']);
      await ensureManagedRuntime('node', log, { root, fetchImpl: makeFetch(bytes, sha) });
      const kindDir = join(root, 'node');
      // Renaming the version dir needs write permission on its parent. Denying
      // it is the portable stand-in for the Windows EBUSY this guards: another
      // agent holding the launcher open blocks the rename there. A false verdict
      // would send the caller on to re-download, adopt the SAME damaged copy off
      // the fast path, and blame the machine for a fresh copy that never landed.
      chmodSync(kindDir, 0o500);
      try {
        expect(await quarantineManagedRuntime('node', log, root)).toBe(false);
        expect(await findManagedRuntime('node', root)).not.toBeNull();
      } finally {
        chmodSync(kindDir, 0o700);
      }
    },
  );

  test('treats an already-absent runtime as cleared', async () => {
    expect(await quarantineManagedRuntime('node', log, tmp())).toBe(true);
  });
});
