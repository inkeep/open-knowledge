import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildPiExtensionSource, isOwnPiExtensionSource } from '../integrations/pi-extension.ts';
import { EDITOR_TARGETS, PI_EXTENSION_OWNERSHIP_MARKER } from './editors.ts';
import { removeOwnMcpEntry } from './mcp-config-removal.ts';
import { ensurePiBridge, probePiBridgeState, removePiTrustEntry } from './pi-acp-bridge.ts';
import { commitPiTrustGrant, listPiTrustGrants, preparePiTrustGrant } from './pi-trust-grants.ts';
import { withPiTrustLockSync } from './pi-trust-lock.ts';

let dirs: string[] = [];
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'pi-acp-bridge-')));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function probeReadyPiBridgeState(...args: Parameters<typeof probePiBridgeState>) {
  const state = probePiBridgeState(...args);
  if (state.project !== 'ready') throw new Error(state.error);
  return state;
}

const bridgePathIn = (cwd: string) => join(cwd, '.pi', 'extensions', 'open-knowledge.ts');
const trustPathIn = (home: string) => join(home, '.pi', 'agent', 'trust.json');

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf-8');
}

async function withDevArgv<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.argv[1];
  process.argv[1] = '/repo/packages/cli/src/cli.ts';
  try {
    return await fn();
  } finally {
    process.argv[1] = original;
  }
}

function freezeMtime(path: string): number {
  const stamp = new Date(Date.now() - 60_000);
  utimesSync(path, stamp, stamp);
  return statSync(path).mtimeMs;
}

describe('probePiBridgeState', () => {
  test('reports absent bridge + untrusted folder when nothing exists', async () => {
    const cwd = tmp();
    const home = tmp();
    expect(probeReadyPiBridgeState(cwd, home)).toEqual({
      cwd,
      project: 'ready',
      canonicalCwd: cwd,
      otherExtensions: [],
      bridgePath: bridgePathIn(cwd),
      trustPath: trustPathIn(home),
      bridge: 'absent',
      trust: 'untrusted',
      bridgeLoadable: false,
    });
  });

  test('escapes extension names for display after filtering and sorting without changing files', () => {
    const cwd = tmp();
    const home = tmp();
    const extensionDir = dirname(bridgePathIn(cwd));
    const names = [
      'safe\u202e.ts',
      'hidden\u200b.ts',
      'zeta.ts',
      'prettier.ts, tailwind.ts, eslint.ts',
      'helper.ts. No other extensions are present.ts',
      ...(process.platform === 'win32' ? [] : ['quoted"name.ts']),
    ];
    for (const name of names) write(join(extensionDir, name), `User extension ${name}`);
    write(bridgePathIn(cwd), buildPiExtensionSource({ mode: 'published' }));
    write(join(extensionDir, 'notes.txt'), 'not an extension');

    expect(probeReadyPiBridgeState(cwd, home).otherExtensions).toEqual([
      '"helper.ts. No other extensions are present.ts"',
      '"hidden\\u200b.ts"',
      '"prettier.ts, tailwind.ts, eslint.ts"',
      ...(process.platform === 'win32' ? [] : ['"quoted\\"name.ts"']),
      '"safe\\u202e.ts"',
      '"zeta.ts"',
    ]);
    expect(readdirSync(extensionDir).sort()).toEqual(
      [...names, 'open-knowledge.ts', 'notes.txt'].sort(),
    );
    for (const name of names)
      expect(readFileSync(join(extensionDir, name), 'utf8')).toBe(`User extension ${name}`);
    expect(existsSync(trustPathIn(home))).toBe(false);
  });

  test('normalizes the cwd it reports and keys trust on', async () => {
    const cwd = tmp();
    const home = tmp();
    write(trustPathIn(home), JSON.stringify({ [cwd]: true }));
    const state = probeReadyPiBridgeState(`${cwd}/./`, home);
    expect(state.cwd).toBe(cwd);
    expect(state.trust).toBe('trusted');
  });

  test('classifies an own current bridge, trusted', async () => {
    const cwd = tmp();
    const home = tmp();
    write(bridgePathIn(cwd), buildPiExtensionSource({ mode: 'published' }));
    write(trustPathIn(home), JSON.stringify({ [cwd]: true }, null, 2));
    const state = probeReadyPiBridgeState(cwd, home);
    expect(state.bridge).toBe('own-current');
    expect(state.trust).toBe('trusted');
    expect(state.bridgeLoadable).toBe(true);
  });

  test('a dev-mode drop and an older version are both own-stale, still loadable', async () => {
    const cwd = tmp();
    const home = tmp();
    write(trustPathIn(home), JSON.stringify({ [cwd]: true }));

    await withDevArgv(async () =>
      write(bridgePathIn(cwd), buildPiExtensionSource({ mode: 'dev' })),
    );
    expect(probeReadyPiBridgeState(cwd, home)).toMatchObject({
      bridge: 'own-stale',
      bridgeLoadable: true,
    });

    write(bridgePathIn(cwd), `${PI_EXTENSION_OWNERSHIP_MARKER}-v0\n// legacy body\n`);
    expect(probeReadyPiBridgeState(cwd, home)).toMatchObject({
      bridge: 'own-stale',
      bridgeLoadable: true,
    });
  });

  test('a file OK did not write is foreign and never loadable', async () => {
    const cwd = tmp();
    const home = tmp();
    write(bridgePathIn(cwd), 'export default function mine() {}\n');
    write(trustPathIn(home), JSON.stringify({ [cwd]: true }));
    const state = probeReadyPiBridgeState(cwd, home);
    expect(state.bridge).toBe('foreign');
    expect(state.bridgeLoadable).toBe(false);
  });

  test('a blank file at the managed path is creatable, not foreign', async () => {
    const cwd = tmp();
    const home = tmp();
    write(bridgePathIn(cwd), '   \n');
    expect(probeReadyPiBridgeState(cwd, home).bridge).toBe('absent');
  });

  test('trust states: missing entry, explicit false, corrupt, non-object', async () => {
    const cwd = tmp();
    const home = tmp();

    write(trustPathIn(home), JSON.stringify({ '/somewhere/else': true }));
    expect(probeReadyPiBridgeState(cwd, home).trust).toBe('untrusted');

    write(trustPathIn(home), JSON.stringify({ [cwd]: false }));
    expect(probeReadyPiBridgeState(cwd, home).trust).toBe('untrusted');

    write(trustPathIn(home), '{not json');
    expect(probeReadyPiBridgeState(cwd, home).trust).toBe('unreadable');

    write(trustPathIn(home), JSON.stringify([cwd]));
    expect(probeReadyPiBridgeState(cwd, home).trust).toBe('unreadable');

    write(trustPathIn(home), '');
    expect(probeReadyPiBridgeState(cwd, home).trust).toBe('untrusted');
  });

  describe('with PI_CODING_AGENT_DIR set on the machine', () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    beforeEach(() => {
      process.env.PI_CODING_AGENT_DIR = '/nonexistent/pi-agent-dir';
    });
    afterEach(() => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    });

    test('an injected home wins, so probes stay hermetic', async () => {
      const cwd = tmp();
      const home = tmp();
      write(trustPathIn(home), JSON.stringify({ [cwd]: true }));
      const state = probeReadyPiBridgeState(cwd, home);
      expect(state.trustPath).toBe(trustPathIn(home));
      expect(state.trust).toBe('trusted');
    });

    test('without an injected home the env override is honored', async () => {
      const cwd = tmp();
      expect(probeReadyPiBridgeState(cwd).trustPath).toBe('/nonexistent/pi-agent-dir/trust.json');
    });

    test('an explicit environment selects the same trust store for ensure, probe and removal', async () => {
      const cwd = tmp();
      const home = tmp();
      const agentDir = tmp();
      const env = { PI_CODING_AGENT_DIR: agentDir };
      const trustPath = join(agentDir, 'trust.json');
      const unrelated = tmp();
      const defaultTrust = `${JSON.stringify({ [cwd]: true })}\n`;
      write(trustPathIn(home), defaultTrust);
      write(trustPath, JSON.stringify({ [unrelated]: true }));

      expect(await ensurePiBridge(cwd, { mode: 'published' }, home, env)).toMatchObject({
        ok: true,
        trustPath,
        trust: 'added',
      });
      expect(probeReadyPiBridgeState(cwd, home, env)).toMatchObject({
        trustPath,
        bridgeLoadable: true,
      });
      expect(removePiTrustEntry(cwd, home, env).action).toBe('removed');
      expect(probeReadyPiBridgeState(cwd, home, env).trust).toBe('untrusted');
      expect(JSON.parse(readFileSync(trustPath, 'utf8'))).toEqual({ [unrelated]: true });
      expect(readFileSync(trustPathIn(home), 'utf8')).toBe(defaultTrust);
    });
  });
});

describe('ensurePiBridge', () => {
  test('provisions both halves from nothing', async () => {
    const cwd = tmp();
    const home = tmp();
    const result = await ensurePiBridge(cwd, { mode: 'published' }, home);
    expect(result).toEqual({
      ok: true,
      cwd,
      bridgePath: bridgePathIn(cwd),
      trustPath: trustPathIn(home),
      bridge: 'written',
      trust: 'added',
    });
    expect(readFileSync(bridgePathIn(cwd), 'utf-8')).toBe(
      buildPiExtensionSource({ mode: 'published' }),
    );
    expect(JSON.parse(readFileSync(trustPathIn(home), 'utf-8'))).toEqual({ [cwd]: true });
    expect(probeReadyPiBridgeState(cwd, home).bridgeLoadable).toBe(true);
  });

  test('defaults to the published shape `ok init` writes', async () => {
    const cwd = tmp();
    const home = tmp();
    expect((await ensurePiBridge(cwd, undefined, home)).ok).toBe(true);
    expect(readFileSync(bridgePathIn(cwd), 'utf-8')).toBe(
      buildPiExtensionSource({ mode: 'published' }),
    );
  });

  test('dev mode drops the dev launcher shape', async () => {
    const cwd = tmp();
    const home = tmp();
    await withDevArgv(async () => {
      expect((await ensurePiBridge(cwd, { mode: 'dev' }, home)).bridge).toBe('written');
      expect(readFileSync(bridgePathIn(cwd), 'utf-8')).toBe(
        buildPiExtensionSource({ mode: 'dev' }),
      );
    });
  });

  test('an unbuildable dev source fails structurally instead of throwing', async () => {
    const cwd = tmp();
    const home = tmp();
    write(bridgePathIn(cwd), buildPiExtensionSource({ mode: 'published' }));
    expect(await ensurePiBridge(cwd, { mode: 'dev' }, home)).toMatchObject({
      ok: false,
      bridge: 'failed',
      trust: 'skipped',
    });
    expect(() => statSync(trustPathIn(home))).toThrow();
  });

  test('is idempotent: a second call touches neither file', async () => {
    const cwd = tmp();
    const home = tmp();
    await ensurePiBridge(cwd, { mode: 'published' }, home);
    const bridgeMtime = freezeMtime(bridgePathIn(cwd));
    const trustMtime = freezeMtime(trustPathIn(home));
    const receipts = listPiTrustGrants(home, cwd);

    const second = await ensurePiBridge(cwd, { mode: 'published' }, home);
    expect(second).toMatchObject({ ok: true, bridge: 'unchanged', trust: 'already-trusted' });
    expect(statSync(bridgePathIn(cwd)).mtimeMs).toBe(bridgeMtime);
    expect(statSync(trustPathIn(home)).mtimeMs).toBe(trustMtime);
    expect(listPiTrustGrants(home, cwd)).toEqual(receipts);
  });

  test('refreshes an own stale bridge, including a mode flip', async () => {
    const cwd = tmp();
    const home = tmp();
    write(bridgePathIn(cwd), `${PI_EXTENSION_OWNERSHIP_MARKER}-v0\n// legacy body\n`);
    expect((await ensurePiBridge(cwd, { mode: 'published' }, home)).bridge).toBe('refreshed');
    expect(readFileSync(bridgePathIn(cwd), 'utf-8')).toBe(
      buildPiExtensionSource({ mode: 'published' }),
    );

    await withDevArgv(async () => {
      expect((await ensurePiBridge(cwd, { mode: 'dev' }, home)).bridge).toBe('refreshed');
      expect(readFileSync(bridgePathIn(cwd), 'utf-8')).toBe(
        buildPiExtensionSource({ mode: 'dev' }),
      );
    });
  });

  test('refuses a foreign file and never flips the folder-trust gate', async () => {
    const cwd = tmp();
    const home = tmp();
    const foreign = 'export default function mine() {}\n';
    write(bridgePathIn(cwd), foreign);

    const result = await ensurePiBridge(cwd, { mode: 'published' }, home);
    expect(result).toEqual({
      ok: false,
      cwd,
      bridgePath: bridgePathIn(cwd),
      trustPath: trustPathIn(home),
      bridge: 'refused-foreign',
      trust: 'skipped',
    });
    expect(readFileSync(bridgePathIn(cwd), 'utf-8')).toBe(foreign);
    expect(() => statSync(trustPathIn(home))).toThrow();
  });

  test('preserves existing trust entries, their order, and the trailing-newline shape', async () => {
    const cwd = tmp();
    const home = tmp();
    write(trustPathIn(home), `${JSON.stringify({ '/z/last': true, '/a/first': true }, null, 2)}\n`);

    expect((await ensurePiBridge(cwd, { mode: 'published' }, home)).trust).toBe('added');
    const raw = readFileSync(trustPathIn(home), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(Object.keys(JSON.parse(raw))).toEqual(['/z/last', '/a/first', cwd]);
  });

  test("matches pi's own no-trailing-newline serialization when creating the store", async () => {
    const cwd = tmp();
    const home = tmp();
    await ensurePiBridge(cwd, { mode: 'published' }, home);
    expect(readFileSync(trustPathIn(home), 'utf-8')).toBe(JSON.stringify({ [cwd]: true }, null, 2));
  });

  test('flips an explicit false entry to true in place', async () => {
    const cwd = tmp();
    const home = tmp();
    write(trustPathIn(home), JSON.stringify({ [cwd]: false, '/other': true }, null, 2));
    expect((await ensurePiBridge(cwd, { mode: 'published' }, home)).trust).toBe('added');
    const parsed = JSON.parse(readFileSync(trustPathIn(home), 'utf-8'));
    expect(parsed).toEqual({ [cwd]: true, '/other': true });
    expect(Object.keys(parsed)).toEqual([cwd, '/other']);
  });

  test('leaves a corrupt trust store byte-untouched and reports it', async () => {
    const cwd = tmp();
    const home = tmp();
    write(trustPathIn(home), '{not json');

    const result = await ensurePiBridge(cwd, { mode: 'published' }, home);
    expect(result).toMatchObject({
      ok: false,
      bridge: 'written',
      trust: 'refused-unreadable',
    });
    expect(result.error).toBeTruthy();
    expect(readFileSync(trustPathIn(home), 'utf-8')).toBe('{not json');
    expect(isOwnPiExtensionSource(readFileSync(bridgePathIn(cwd), 'utf-8'))).toBe(true);
  });

  test('an already-trusted folder with no bridge writes only the bridge', async () => {
    const cwd = tmp();
    const home = tmp();
    write(trustPathIn(home), JSON.stringify({ [cwd]: true }, null, 2));
    const trustMtime = freezeMtime(trustPathIn(home));

    expect(await ensurePiBridge(cwd, { mode: 'published' }, home)).toMatchObject({
      ok: true,
      bridge: 'written',
      trust: 'already-trusted',
    });
    expect(statSync(trustPathIn(home)).mtimeMs).toBe(trustMtime);
  });
});

describe.skipIf(process.platform === 'win32')('symlinked Pi trust stores', () => {
  function fixture() {
    const cwd = tmp();
    const home = tmp();
    const target = join(tmp(), 'trust.json');
    const trustPath = trustPathIn(home);
    const entries = { other: true, settings: { nested: ['preserve', 42] } };
    write(target, `${JSON.stringify(entries, null, 2)}\n`);
    chmodSync(target, 0o640);
    mkdirSync(dirname(trustPath), { recursive: true });
    symlinkSync(target, trustPath);
    return { cwd, home, target, trustPath, entries };
  }

  test('adds trust through the link and preserves the target mode and unrelated entries', async () => {
    const { cwd, home, target, trustPath, entries } = fixture();

    expect(await ensurePiBridge(cwd, { mode: 'published' }, home)).toMatchObject({
      ok: true,
      trust: 'added',
      trustPath,
    });

    expect(lstatSync(trustPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(trustPath)).toBe(target);
    expect(statSync(target).mode & 0o777).toBe(0o640);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ ...entries, [cwd]: true });
    expect(probeReadyPiBridgeState(cwd, home)).toMatchObject({ trustPath, bridgeLoadable: true });
  });

  test('preserves pre-existing trust and its symlink while removing the bridge', async () => {
    const { cwd, home, target, trustPath, entries } = fixture();
    write(target, `${JSON.stringify({ ...entries, [cwd]: true }, null, 2)}\n`);
    expect((await ensurePiBridge(cwd, { mode: 'published' }, home)).trust).toBe('already-trusted');

    expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toEqual({
      kind: 'removed',
      trust: 'kept-unowned',
      trustDetail: expect.any(String),
    });

    expect(lstatSync(trustPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(trustPath)).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe(
      `${JSON.stringify({ ...entries, [cwd]: true }, null, 2)}\n`,
    );
    expect(statSync(target).mode & 0o777).toBe(0o640);
    expect(existsSync(bridgePathIn(cwd))).toBe(false);
    expect(probeReadyPiBridgeState(cwd, home).trust).toBe('trusted');
    expect(listPiTrustGrants(home, cwd)).toEqual([]);
  });

  test.each([
    ['missing', 'the symlink target is missing', 'restore the target or correct the symlink'],
    ['cycle', 'the path or symlink could not be resolved', 'repair any symlink cycle'],
    ['malformed', 'the file is not a valid JSON object', 'repair its JSON'],
  ] as const)(
    'refuses a %s trust target without deleting the bridge and succeeds after repair',
    async (problem, cause, remedy) => {
      const { cwd, home, target, trustPath, entries } = fixture();
      const trusted = `${JSON.stringify({ ...entries, [cwd]: true }, null, 2)}\n`;
      await ensurePiBridge(cwd, { mode: 'published' }, home);
      const bridge = readFileSync(bridgePathIn(cwd), 'utf8');
      if (problem === 'missing') unlinkSync(target);
      if (problem === 'malformed') write(target, '{ broken json');
      if (problem === 'cycle') {
        unlinkSync(trustPath);
        symlinkSync(trustPath, trustPath);
      }
      const link = readlinkSync(trustPath);
      const targetBytes = problem === 'missing' ? undefined : readFileSync(target, 'utf8');

      expect(probeReadyPiBridgeState(cwd, home).trust).toBe('unreadable');
      const result = await ensurePiBridge(cwd, { mode: 'published' }, home);
      expect(result).toMatchObject({
        ok: false,
        trust: 'refused-unreadable',
      });
      expect(result.error).toContain(cause);
      expect(result.error).toContain(remedy);
      expect(result.error).toContain(trustPath);
      expect(result.error).not.toMatch(/missing-symlink-target|unresolved-symlink/);
      expect(() => removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toThrow(
        cause,
      );
      expect(readFileSync(bridgePathIn(cwd), 'utf8')).toBe(bridge);
      expect(lstatSync(trustPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(trustPath)).toBe(link);
      if (targetBytes === undefined) expect(existsSync(target)).toBe(false);
      else expect(readFileSync(target, 'utf8')).toBe(targetBytes);

      if (problem === 'cycle') {
        unlinkSync(trustPath);
        symlinkSync(target, trustPath);
      }
      write(target, trusted);
      expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd)).kind).toBe(
        'removed',
      );
      expect(readlinkSync(trustPath)).toBe(target);
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(entries);
      expect(existsSync(bridgePathIn(cwd))).toBe(false);
    },
  );

  test.skipIf(process.getuid?.() === 0)(
    'preserves an unreadable target and its bridge until permissions are repaired',
    async () => {
      const { cwd, home, target, trustPath, entries } = fixture();
      await ensurePiBridge(cwd, { mode: 'published' }, home);
      const before = readFileSync(target, 'utf8');
      const bridge = readFileSync(bridgePathIn(cwd), 'utf8');
      chmodSync(target, 0o000);
      try {
        expect(probeReadyPiBridgeState(cwd, home).trust).toBe('unreadable');
        const result = await ensurePiBridge(cwd, { mode: 'published' }, home);
        expect(result).toMatchObject({
          ok: false,
          trust: 'refused-unreadable',
        });
        expect(result.error).toContain('permission denied');
        expect(result.error).toContain('check file and parent-directory permissions');
        expect(result.error).not.toMatch(/JSON|permission-denied/);
        expect(() => removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toThrow(
          'permission denied; check file and parent-directory permissions',
        );
        expect(readFileSync(bridgePathIn(cwd), 'utf8')).toBe(bridge);
        expect(readlinkSync(trustPath)).toBe(target);
      } finally {
        chmodSync(target, 0o640);
      }
      expect(readFileSync(target, 'utf8')).toBe(before);
      expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd)).kind).toBe(
        'removed',
      );
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(entries);
      expect(statSync(target).mode & 0o777).toBe(0o640);
    },
  );

  test.each([false, true])(
    'waits for the canonical target lock and rejects a retargeted link (retarget=%s)',
    async (retarget) => {
      const { cwd, home, target, trustPath, entries } = fixture();
      const canonicalLock = `${realpathSync(target)}.ok.lock`;
      const otherTarget = join(tmp(), 'trust.json');
      const before = readFileSync(target, 'utf8');
      const otherBytes = '{"untouched": true}\n';
      write(otherTarget, otherBytes);
      write(canonicalLock, 'held');
      const pending = ensurePiBridge(cwd, { mode: 'published' }, home);
      try {
        expect(
          await Promise.race([
            pending.then(() => 'finished'),
            new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 75)),
          ]),
        ).toBe('waiting');
        expect(readFileSync(target, 'utf8')).toBe(before);
        if (retarget) {
          unlinkSync(trustPath);
          symlinkSync(otherTarget, trustPath);
        }
      } finally {
        unlinkSync(canonicalLock);
        await pending;
      }
      const result = await pending;
      if (retarget) {
        expect(result).toMatchObject({ ok: false, trust: 'refused-unreadable' });
        expect(result.error).toContain('path changed while waiting for its lock');
        expect(result.error).toContain('retry to check its current state');
        expect(result.error).not.toContain('permissions');
        expect(readFileSync(target, 'utf8')).toBe(before);
        expect(readFileSync(otherTarget, 'utf8')).toBe(otherBytes);
        expect(readlinkSync(trustPath)).toBe(otherTarget);
      } else {
        expect(result).toMatchObject({ ok: true, trust: 'added' });
        expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ ...entries, [cwd]: true });
        expect(readlinkSync(trustPath)).toBe(target);
      }
    },
  );

  test('creates and removes trust through a symlinked ancestor without replacing the directory link', async () => {
    const cwd = tmp();
    const other = tmp();
    const home = tmp();
    const realPiDir = tmp();
    const piLink = join(home, '.pi');
    const target = join(realPiDir, 'agent', 'trust.json');
    const settings = join(realPiDir, 'settings.json');
    write(settings, '{"keep": "these settings"}\n');
    symlinkSync(realPiDir, piLink, 'dir');

    expect(existsSync(target)).toBe(false);
    expect((await ensurePiBridge(cwd, { mode: 'published' }, home)).ok).toBe(true);
    expect((await ensurePiBridge(other, { mode: 'published' }, home)).ok).toBe(true);
    expect(probeReadyPiBridgeState(cwd, home).bridgeLoadable).toBe(true);
    expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toEqual({
      kind: 'removed',
      trust: 'removed',
    });

    expect(lstatSync(piLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(piLink)).toBe(realPiDir);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ [other]: true });
    expect(readFileSync(settings, 'utf8')).toBe('{"keep": "these settings"}\n');
  });

  test('refuses a dangling ancestor and succeeds after the directory target is restored', async () => {
    const cwd = tmp();
    const home = tmp();
    const realPiDir = join(tmp(), 'missing-pi');
    const piLink = join(home, '.pi');
    symlinkSync(realPiDir, piLink, 'dir');

    const first = await ensurePiBridge(cwd, { mode: 'published' }, home);
    expect(first).toMatchObject({ ok: false, trust: 'refused-unreadable' });
    expect(first.error).toContain('the symlink target is missing');
    expect(first.error).toContain('restore the target or correct the symlink');
    expect(probeReadyPiBridgeState(cwd, home).trust).toBe('unreadable');
    expect(() => removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toThrow(
      'the symlink target is missing',
    );
    expect(readlinkSync(piLink)).toBe(realPiDir);
    expect(existsSync(realPiDir)).toBe(false);
    expect(existsSync(bridgePathIn(cwd))).toBe(true);

    mkdirSync(realPiDir);
    expect((await ensurePiBridge(cwd, { mode: 'published' }, home)).ok).toBe(true);
    expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd)).kind).toBe('removed');
    expect(readlinkSync(piLink)).toBe(realPiDir);
    expect(JSON.parse(readFileSync(join(realPiDir, 'agent', 'trust.json'), 'utf8'))).toEqual({});
  });
});

describe('owned Pi trust grants', () => {
  test('restores an explicit refusal after a consented grant is removed', async () => {
    const cwd = tmp();
    const home = tmp();
    const trustPath = trustPathIn(home);
    const previous = { [dirname(cwd)]: true, [cwd]: false, other: true };
    write(trustPath, `${JSON.stringify(previous, null, 2)}\n`);

    expect((await ensurePiBridge(cwd, { mode: 'published' }, home)).ok).toBe(true);
    expect(listPiTrustGrants(home, cwd)).toMatchObject([
      { record: { state: 'committed', previous: { present: true, value: false } } },
    ]);
    expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toEqual({
      kind: 'removed',
      trust: 'removed',
    });

    expect(JSON.parse(readFileSync(trustPath, 'utf8'))).toEqual(previous);
    expect(listPiTrustGrants(home, cwd)).toEqual([]);
    expect(existsSync(bridgePathIn(cwd))).toBe(false);
  });

  test('preserves a pending grant whose successful ownership was never recorded', () => {
    const cwd = tmp();
    const home = tmp();
    const trustPath = trustPathIn(home);
    const before = `${JSON.stringify({ [cwd]: true, other: true })}\n`;
    write(trustPath, before);
    write(bridgePathIn(cwd), buildPiExtensionSource({ mode: 'published' }));
    const canonicalPath = realpathSync(trustPath);
    withPiTrustLockSync(trustPath, canonicalPath, () => {
      preparePiTrustGrant(home, cwd, trustPath, canonicalPath, { present: false });
    });

    expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toEqual({
      kind: 'removed',
      trust: 'kept-unowned',
      trustDetail: expect.any(String),
    });

    expect(readFileSync(trustPath, 'utf8')).toBe(before);
    expect(listPiTrustGrants(home, cwd)).toMatchObject([{ record: { state: 'pending' } }]);
    expect(existsSync(bridgePathIn(cwd))).toBe(false);
  });

  test('reconciles every recorded custom store without the original environment override', async () => {
    const cwd = tmp();
    const home = tmp();
    const agentDirs = [tmp(), tmp()] as const;
    const defaultTrust = `${JSON.stringify({ [cwd]: true, defaultStore: true })}\n`;
    write(trustPathIn(home), defaultTrust);
    for (const agentDir of agentDirs) {
      write(join(agentDir, 'trust.json'), '{"other":true}\n');
      expect(
        (await ensurePiBridge(cwd, { mode: 'published' }, home, { PI_CODING_AGENT_DIR: agentDir }))
          .ok,
      ).toBe(true);
    }
    expect(listPiTrustGrants(home, cwd)).toHaveLength(2);

    expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toEqual({
      kind: 'removed',
      trust: 'kept-unowned',
      trustDetail: expect.stringContaining(trustPathIn(home)),
    });

    for (const agentDir of agentDirs) {
      expect(JSON.parse(readFileSync(join(agentDir, 'trust.json'), 'utf8'))).toEqual({
        other: true,
      });
    }
    expect(readFileSync(trustPathIn(home), 'utf8')).toBe(defaultTrust);
    expect(listPiTrustGrants(home, cwd)).toEqual([]);
  });

  test('keeps a grant used by project prompts and relinquishes its ownership record', async () => {
    const cwd = tmp();
    const home = tmp();
    await ensurePiBridge(cwd, { mode: 'published' }, home);
    const before = readFileSync(trustPathIn(home), 'utf8');
    const promptPath = join(cwd, '.pi', 'prompts', 'review.md');
    write(promptPath, 'User-authored prompt\n');

    expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toEqual({
      kind: 'removed',
      trust: 'kept-shared',
      trustDetail: expect.any(String),
    });

    expect(readFileSync(trustPathIn(home), 'utf8')).toBe(before);
    expect(readFileSync(promptPath, 'utf8')).toBe('User-authored prompt\n');
    expect(listPiTrustGrants(home, cwd)).toEqual([]);
    rmSync(dirname(promptPath), { recursive: true });
    expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toEqual({
      kind: 'not-present',
    });
    expect(readFileSync(trustPathIn(home), 'utf8')).toBe(before);
  });

  test('cleans independent recorded stores while retaining a failed store and the bridge for retry', async () => {
    const cwd = tmp();
    const home = tmp();
    const agentDirs = [tmp(), tmp()] as const;
    for (const agentDir of agentDirs) {
      write(join(agentDir, 'trust.json'), '{"other":true}\n');
      await ensurePiBridge(cwd, { mode: 'published' }, home, { PI_CODING_AGENT_DIR: agentDir });
    }
    const failedPath = join(agentDirs[0], 'trust.json');
    const repairedBytes = readFileSync(failedPath, 'utf8');
    write(failedPath, '{broken trust');

    expect(() => removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toThrow(
      'repair its JSON, then retry',
    );
    expect(readFileSync(failedPath, 'utf8')).toBe('{broken trust');
    expect(JSON.parse(readFileSync(join(agentDirs[1], 'trust.json'), 'utf8'))).toEqual({
      other: true,
    });
    expect(existsSync(bridgePathIn(cwd))).toBe(true);
    expect(listPiTrustGrants(home, cwd)).toMatchObject([
      { record: { configuredTrustPath: failedPath } },
    ]);

    write(failedPath, repairedBytes);
    expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toEqual({
      kind: 'removed',
      trust: 'removed',
    });
    expect(JSON.parse(readFileSync(failedPath, 'utf8'))).toEqual({ other: true });
    expect(listPiTrustGrants(home, cwd)).toEqual([]);
  });

  test('retains shared-trust handoff guidance when the Pi lock cannot be released', async () => {
    const cwd = tmp();
    const home = tmp();
    await ensurePiBridge(cwd, { mode: 'published' }, home);
    const promptPath = join(cwd, '.pi', 'prompts', 'review.md');
    write(promptPath, 'User-authored prompt\n');
    const trustPath = trustPathIn(home);
    const before = readFileSync(trustPath, 'utf8');
    const originalLockSync = lockfile.lockSync;
    const unexpectedFile = join(`${trustPath}.lock`, 'keep.txt');
    vi.spyOn(lockfile, 'lockSync').mockImplementation((path, options) => {
      const release = originalLockSync(path, options);
      return () => {
        writeFileSync(unexpectedFile, 'preserve this file');
        release();
      };
    });

    const result = removePiTrustEntry(cwd, home);

    expect(result.action).toBe('failed');
    expect(result.error).toContain('ENOTEMPTY');
    expect(result.error).toContain(dirname(promptPath));
    expect(result.error).toContain('To remove this grant manually');
    expect(result.error).toContain('OpenKnowledge has relinquished this grant');
    expect(readFileSync(trustPath, 'utf8')).toBe(before);
    expect(listPiTrustGrants(home, cwd)).toEqual([]);
    expect(existsSync(bridgePathIn(cwd))).toBe(true);
    expect(readFileSync(unexpectedFile, 'utf8')).toBe('preserve this file');
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'retains neutral shared-trust guidance when its ownership record cannot be removed',
    async () => {
      const cwd = tmp();
      const home = tmp();
      await ensurePiBridge(cwd, { mode: 'published' }, home);
      const promptPath = join(cwd, '.pi', 'prompts', 'review.md');
      write(promptPath, 'User-authored prompt\n');
      const [receipt] = listPiTrustGrants(home, cwd);
      if (!receipt) throw new Error('expected committed receipt');
      chmodSync(dirname(receipt.path), 0o500);
      try {
        const result = removePiTrustEntry(cwd, home);
        expect(result.action).toBe('failed');
        expect(result.error).toContain(dirname(promptPath));
        expect(result.error).toContain('To remove this grant manually');
        expect(result.error).toContain('may stop Pi from loading');
        expect(result.error).not.toContain('has relinquished');
        expect(result.error).toContain(
          'check receipt and parent-directory permissions, then retry',
        );
        expect(result.error).not.toContain('retry to check its current state');
        expect(listPiTrustGrants(home, cwd)).toEqual([receipt]);
        expect(existsSync(bridgePathIn(cwd))).toBe(true);
      } finally {
        chmodSync(dirname(receipt.path), 0o700);
      }
    },
  );

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'adds retry guidance after a trust write loses directory access without losing its receipt',
    async () => {
      const cwd = tmp();
      const home = tmp();
      await ensurePiBridge(cwd, { mode: 'published' }, home);
      const trustPath = trustPathIn(home);
      const trustDirectory = dirname(trustPath);
      const before = readFileSync(trustPath, 'utf8');
      const receipts = listPiTrustGrants(home, cwd);
      const originalLockSync = lockfile.lockSync;
      vi.spyOn(lockfile, 'lockSync').mockImplementationOnce((path, options) => {
        const release = originalLockSync(path, options);
        chmodSync(trustDirectory, 0o555);
        return () => {
          chmodSync(trustDirectory, 0o700);
          release();
        };
      });

      try {
        const result = removePiTrustEntry(cwd, home);

        expect(result.action).toBe('failed');
        expect(result.error).toContain('EACCES');
        expect(result.error).toContain('retry to check its current state');
        expect(readFileSync(trustPath, 'utf8')).toBe(before);
        expect(listPiTrustGrants(home, cwd)).toEqual(receipts);
        expect(existsSync(bridgePathIn(cwd))).toBe(true);
      } finally {
        chmodSync(trustDirectory, 0o700);
      }

      expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toMatchObject({
        kind: 'removed',
        trust: 'removed',
      });
      expect(JSON.parse(readFileSync(trustPath, 'utf8'))).toEqual({});
      expect(listPiTrustGrants(home, cwd)).toEqual([]);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'preserves both stores when a recorded symlink is retargeted until the link is repaired',
    async () => {
      const cwd = tmp();
      const home = tmp();
      const trustPath = trustPathIn(home);
      const firstTarget = join(tmp(), 'first.json');
      const otherTarget = join(tmp(), 'other.json');
      write(firstTarget, '{"other":true}\n');
      write(otherTarget, `${JSON.stringify({ [cwd]: true, unrelated: true })}\n`);
      mkdirSync(dirname(trustPath), { recursive: true });
      symlinkSync(firstTarget, trustPath);
      await ensurePiBridge(cwd, { mode: 'published' }, home);
      const firstBytes = readFileSync(firstTarget, 'utf8');
      const otherBytes = readFileSync(otherTarget, 'utf8');
      unlinkSync(trustPath);
      symlinkSync(otherTarget, trustPath);

      expect(() => removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toThrow(
        'restore the intended file location or symlink, then retry',
      );
      expect(readlinkSync(trustPath)).toBe(otherTarget);
      expect(readFileSync(firstTarget, 'utf8')).toBe(firstBytes);
      expect(readFileSync(otherTarget, 'utf8')).toBe(otherBytes);
      expect(existsSync(bridgePathIn(cwd))).toBe(true);
      expect(listPiTrustGrants(home, cwd)).toHaveLength(1);

      unlinkSync(trustPath);
      symlinkSync(firstTarget, trustPath);
      expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd)).kind).toBe(
        'removed',
      );
      expect(readlinkSync(trustPath)).toBe(firstTarget);
      expect(JSON.parse(readFileSync(firstTarget, 'utf8'))).toEqual({ other: true });
      expect(readFileSync(otherTarget, 'utf8')).toBe(otherBytes);
      expect(listPiTrustGrants(home, cwd)).toEqual([]);
    },
  );

  test('forgets stale ownership after the user changes a granted decision', async () => {
    const cwd = tmp();
    const home = tmp();
    await ensurePiBridge(cwd, { mode: 'published' }, home);
    const before = `${JSON.stringify({ [cwd]: false, other: true })}\n`;
    write(trustPathIn(home), before);

    expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toEqual({
      kind: 'removed',
      trust: 'not-present',
    });

    expect(readFileSync(trustPathIn(home), 'utf8')).toBe(before);
    expect(listPiTrustGrants(home, cwd)).toEqual([]);
  });

  test('does not grant trust when its ownership record cannot be prepared', async () => {
    const cwd = tmp();
    const home = tmp();
    const trustPath = trustPathIn(home);
    const before = '{"other":true}\n';
    write(trustPath, before);
    write(join(home, '.ok', 'pi-trust'), 'not a directory');

    const result = await ensurePiBridge(cwd, { mode: 'published' }, home);

    expect(result).toMatchObject({ ok: false, trust: 'failed' });
    expect(result.error).toContain('Pi trust receipt at');
    expect(result.error).toContain('then retry');
    expect(readFileSync(trustPath, 'utf8')).toBe(before);
    expect(existsSync(bridgePathIn(cwd))).toBe(true);
  });

  test('preserves the bridge and grant if an existing ownership record cannot be read', async () => {
    const cwd = tmp();
    const home = tmp();
    await ensurePiBridge(cwd, { mode: 'published' }, home);
    const [receipt] = listPiTrustGrants(home, cwd);
    expect(receipt).toBeDefined();
    if (!receipt) throw new Error('expected committed Pi trust receipt');
    const recordBytes = readFileSync(receipt.path, 'utf8');
    const trustBytes = readFileSync(trustPathIn(home), 'utf8');
    write(receipt.path, '{broken record');

    expect(() => removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toThrow(
      'Pi trust receipt at',
    );
    expect(existsSync(bridgePathIn(cwd))).toBe(true);
    expect(readFileSync(trustPathIn(home), 'utf8')).toBe(trustBytes);
    expect(readFileSync(receipt.path, 'utf8')).toBe('{broken record');

    write(receipt.path, recordBytes);
    expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd)).kind).toBe('removed');
    expect(listPiTrustGrants(home, cwd)).toEqual([]);
  });

  test('does not inspect unrelated Pi state when only recorded grants are requested', () => {
    const cwd = join(tmp(), 'no-project');
    const home = tmp();
    write(trustPathIn(home), '{unrelated unreadable trust');

    expect(removePiTrustEntry(cwd, home, undefined, { recordedOnly: true })).toEqual({
      action: 'not-present',
    });
  });

  test('forgets a recorded grant whose ordinary trust file was already deleted', async () => {
    const cwd = tmp();
    const home = tmp();
    await ensurePiBridge(cwd, { mode: 'published' }, home);
    unlinkSync(trustPathIn(home));

    expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toEqual({
      kind: 'removed',
      trust: 'not-present',
    });
    expect(existsSync(trustPathIn(home))).toBe(false);
    expect(listPiTrustGrants(home, cwd)).toEqual([]);
  });

  test('retains the receipt and bridge when its recorded trust directory is unavailable', async () => {
    const cwd = tmp();
    const home = tmp();
    await ensurePiBridge(cwd, { mode: 'published' }, home);
    rmSync(dirname(trustPathIn(home)), { recursive: true });

    expect(() => removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toThrow(
      'Restore access to its parent directory or mounted drive, then retry',
    );
    expect(existsSync(dirname(trustPathIn(home)))).toBe(false);
    expect(existsSync(bridgePathIn(cwd))).toBe(true);
    expect(listPiTrustGrants(home, cwd)).toHaveLength(1);
  });
});

describe('canonical Pi project identity', () => {
  test.each([false, true])(
    'requires the project identity approved before setup (retarget=%s)',
    async (retarget) => {
      const approvedProject = tmp();
      const otherProject = tmp();
      const home = tmp();
      const alias = join(tmp(), 'project-link');
      symlinkSync(approvedProject, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const before = '{"unrelated":false}\n';
      write(trustPathIn(home), before);
      const approved = probeReadyPiBridgeState(alias, home).canonicalCwd;
      if (retarget) {
        unlinkSync(alias);
        symlinkSync(otherProject, alias, process.platform === 'win32' ? 'junction' : 'dir');
      }

      const result = await ensurePiBridge(alias, { mode: 'published' }, home, undefined, approved);

      if (retarget) {
        expect(result).toMatchObject({
          ok: false,
          bridge: 'refused-project-path',
          trust: 'skipped',
        });
        expect(result.error).toContain(approvedProject);
        expect(result.error).toContain(otherProject);
        expect(result.error).toContain(
          'Reopen the intended project and approve the Pi integration again',
        );
        expect(readFileSync(trustPathIn(home), 'utf8')).toBe(before);
        expect(existsSync(bridgePathIn(approvedProject))).toBe(false);
        expect(existsSync(bridgePathIn(otherProject))).toBe(false);
        expect(listPiTrustGrants(home, approvedProject)).toEqual([]);
        expect(listPiTrustGrants(home, otherProject)).toEqual([]);
      } else {
        expect(result).toMatchObject({ ok: true, bridge: 'written', trust: 'added' });
        expect(JSON.parse(readFileSync(trustPathIn(home), 'utf8'))).toEqual({
          unrelated: false,
          [approvedProject]: true,
        });
        expect(existsSync(bridgePathIn(approvedProject))).toBe(true);
        expect(existsSync(bridgePathIn(otherProject))).toBe(false);
        expect(listPiTrustGrants(home, approvedProject)).toMatchObject([
          { record: { cwd: approvedProject, state: 'committed' } },
        ]);
      }
    },
  );

  test.each([false, true])(
    'discloses an unowned alias key alongside canonical trust (%s)',
    (canonicalGrant) => {
      const cwd = tmp();
      const home = tmp();
      const alias = join(tmp(), 'project-link');
      symlinkSync(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const trustPath = trustPathIn(home);
      const before = JSON.stringify({
        [alias]: true,
        ...(canonicalGrant ? { [cwd]: true } : {}),
        unrelated: false,
      });
      write(trustPath, before);
      write(bridgePathIn(alias), buildPiExtensionSource({ mode: 'published' }));
      const lockSpy = vi.spyOn(lockfile, 'lockSync');

      const result = removeOwnMcpEntry(EDITOR_TARGETS.pi, alias, home, bridgePathIn(alias));

      expect(result).toMatchObject({ kind: 'removed', trust: 'kept-unowned' });
      expect(result).toHaveProperty('trustDetail', expect.stringContaining(JSON.stringify(alias)));
      expect(result).toHaveProperty('trustDetail', expect.stringContaining(trustPath));
      expect(result).toHaveProperty(
        'trustDetail',
        expect.stringContaining('Pi uses the real project directory instead of this key'),
      );
      if (canonicalGrant)
        expect(result).toHaveProperty('trustDetail', expect.stringContaining(JSON.stringify(cwd)));
      expect(lockSpy).toHaveBeenCalledTimes(1);
      expect(readFileSync(trustPath, 'utf8')).toBe(before);
      expect(listPiTrustGrants(home, cwd)).toEqual([]);
      expect(listPiTrustGrants(home, alias)).toEqual([]);
      expect(existsSync(bridgePathIn(cwd))).toBe(false);
    },
  );

  test.each([false, true])(
    'refuses an unresolved project alias before a recorded-only no-op (ancestor=%s)',
    async (ancestor) => {
      const target = tmp();
      const cwd = ancestor ? join(target, 'project') : target;
      mkdirSync(cwd, { recursive: true });
      const home = tmp();
      const alias = join(tmp(), 'project-link');
      const opened = ancestor ? join(alias, 'project') : alias;
      symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
      await ensurePiBridge(opened, { mode: 'published' }, home);
      const before = readFileSync(trustPathIn(home), 'utf8');
      rmSync(bridgePathIn(cwd));
      unlinkSync(alias);
      symlinkSync(join(tmp(), 'missing'), alias, process.platform === 'win32' ? 'junction' : 'dir');

      expect(removePiTrustEntry(opened, home, undefined, { recordedOnly: true })).toMatchObject({
        action: 'kept-unverified',
        error: expect.stringContaining('restore the directory or symlink'),
      });
      expect(readFileSync(trustPathIn(home), 'utf8')).toBe(before);
      expect(listPiTrustGrants(home, cwd)).toHaveLength(1);

      unlinkSync(alias);
      symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
      expect(
        removeOwnMcpEntry(EDITOR_TARGETS.pi, opened, home, bridgePathIn(opened)),
      ).toMatchObject({ kind: 'removed', trust: 'removed' });
      expect(JSON.parse(readFileSync(trustPathIn(home), 'utf8'))).toEqual({});
      expect(listPiTrustGrants(home, cwd)).toEqual([]);
    },
  );

  test('preserves a canonical receipt when a missing project lies under a healthy directory alias', async () => {
    const parent = tmp();
    const cwd = join(parent, 'project');
    mkdirSync(cwd);
    const home = tmp();
    const alias = join(tmp(), 'parent-link');
    symlinkSync(parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const opened = join(alias, 'project');
    await ensurePiBridge(opened, { mode: 'published' }, home);
    const before = readFileSync(trustPathIn(home), 'utf8');
    const moved = join(parent, 'moved-project');
    renameSync(cwd, moved);

    expect(realpathSync(alias)).toBe(parent);
    const result = removePiTrustEntry(opened, home, undefined, { recordedOnly: true });
    expect(result.action).toBe('kept-unverified');
    expect(result.error).toContain('could not be resolved or accessed');
    expect(result.error).toContain('current trust decisions were not checked');
    expect(result.error).toContain(`key ${JSON.stringify(cwd)}`);
    expect(result.error).toContain(`configured store ${JSON.stringify(trustPathIn(home))}`);
    expect(result.error).not.toContain('cleanup was left pending');
    expect(readFileSync(trustPathIn(home), 'utf8')).toBe(before);
    expect(listPiTrustGrants(home, cwd)).toHaveLength(1);
    expect(existsSync(bridgePathIn(moved))).toBe(true);

    renameSync(moved, cwd);
    expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, opened, home, bridgePathIn(opened))).toMatchObject({
      kind: 'removed',
      trust: 'removed',
    });
    expect(listPiTrustGrants(home, cwd)).toEqual([]);
  });

  test.each(['true', 'false', 'absent', 'missing-store', 'pending'] as const)(
    'discloses retained records without inferring current trust for an unresolved project (%s)',
    (state) => {
      const parent = tmp();
      const cwd = join(parent, 'project');
      mkdirSync(cwd);
      const home = tmp();
      const alias = join(tmp(), 'parent-link');
      symlinkSync(parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const opened = join(alias, 'project');
      const storeDir = tmp();
      const configuredDir = join(tmp(), 'store-link');
      symlinkSync(storeDir, configuredDir, process.platform === 'win32' ? 'junction' : 'dir');
      const configured = join(configuredDir, 'trust.json');
      const canonical = join(storeDir, 'trust.json');
      const otherStore = join(tmp(), 'other-trust.json');
      const before = `${JSON.stringify({
        ...(state === 'absent' ? {} : { [cwd]: state !== 'false' }),
        unrelated: false,
      })}\n`;
      if (state !== 'missing-store') write(canonical, before);
      write(otherStore, '{"unrelated":{"preserve":true}}\n');
      const prepared = preparePiTrustGrant(home, cwd, configured, canonical, {
        present: true,
        value: false,
      });
      const receipt = state === 'pending' ? prepared : commitPiTrustGrant(home, prepared);
      const otherReceipt = preparePiTrustGrant(home, opened, otherStore, otherStore, {
        present: false,
      });
      write(bridgePathIn(cwd), buildPiExtensionSource({ mode: 'published' }));
      const bridgeBefore = readFileSync(bridgePathIn(cwd), 'utf8');
      const receiptBefore = readFileSync(receipt.path, 'utf8');
      const otherReceiptBefore = readFileSync(otherReceipt.path, 'utf8');
      const moved = join(parent, 'moved-project');
      renameSync(cwd, moved);
      const lockSpy = vi.spyOn(lockfile, 'lockSync');

      const result = removePiTrustEntry(opened, home, undefined, { recordedOnly: true });

      expect(result.action).toBe('kept-unverified');
      expect(result.error).toContain('current trust decisions were not checked');
      for (const kept of [receipt, otherReceipt]) {
        expect(result.error?.split('\n')).toContain(
          `key ${JSON.stringify(kept.record.cwd)}; configured store ${JSON.stringify(kept.record.configuredTrustPath)}; recorded destination ${JSON.stringify(kept.record.canonicalTrustPath)}; ownership record ${JSON.stringify(kept.path)} (${kept.record.state})`,
        );
      }
      expect(result.error).toContain('A pending record does not prove setup completed');
      expect(result.error).toContain('restore the recorded previous value');
      expect(result.error).toContain('remove that key only when no previous entry was recorded');
      expect(result.error).toContain('Preserve other current decisions');
      expect(result.error).not.toContain('the grant is still in place');
      expect(lockSpy).not.toHaveBeenCalled();
      expect(readFileSync(receipt.path, 'utf8')).toBe(receiptBefore);
      expect(readFileSync(otherReceipt.path, 'utf8')).toBe(otherReceiptBefore);
      expect(readFileSync(otherStore, 'utf8')).toBe('{"unrelated":{"preserve":true}}\n');
      expect(readFileSync(bridgePathIn(moved), 'utf8')).toBe(bridgeBefore);
      expect(existsSync(cwd)).toBe(false);
      if (state === 'missing-store') expect(existsSync(canonical)).toBe(false);
      else expect(readFileSync(canonical, 'utf8')).toBe(before);
    },
  );

  test('does not claim retained ownership records for an unresolved unrecorded project', () => {
    const cwd = join(tmp(), 'missing-project');
    const home = tmp();
    const trustPath = trustPathIn(home);
    write(trustPath, '{unrelated invalid config');

    const result = removePiTrustEntry(cwd, home);

    expect(result.action).toBe('kept-unverified');
    expect(result.error).toContain('restore the directory or symlink');
    expect(result.error).not.toContain('kept these Pi trust ownership records');
    expect(readFileSync(trustPath, 'utf8')).toBe('{unrelated invalid config');
    expect(listPiTrustGrants(home, cwd)).toEqual([]);
    expect(existsSync(cwd)).toBe(false);
  });

  test('treats a missing child under a healthy alias as absent when neither current spelling has records', () => {
    const parent = tmp();
    const home = tmp();
    const alias = join(tmp(), 'parent-link');
    symlinkSync(parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const opened = join(alias, 'deleted', 'project');
    write(trustPathIn(home), '{unrelated invalid trust');

    expect(removePiTrustEntry(opened, home, undefined, { recordedOnly: true })).toEqual({
      action: 'not-present',
    });
    expect(readFileSync(trustPathIn(home), 'utf8')).toBe('{unrelated invalid trust');
    expect(existsSync(join(parent, 'deleted'))).toBe(false);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  });

  test('refuses a missing project whose existing ancestor is a file', () => {
    const parent = join(tmp(), 'not-a-directory');
    const home = tmp();
    write(parent, 'preserve');
    expect(
      removePiTrustEntry(join(parent, 'project'), home, undefined, { recordedOnly: true }),
    ).toMatchObject({
      action: 'kept-unverified',
      error: expect.stringContaining('could not be resolved or accessed'),
    });
    expect(readFileSync(parent, 'utf8')).toBe('preserve');
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses inaccessible ancestry while checking a missing project',
    () => {
      const parent = tmp();
      const home = tmp();
      const opened = join(parent, 'missing');
      chmodSync(parent, 0o000);
      try {
        const result = removePiTrustEntry(opened, home, undefined, { recordedOnly: true });
        expect(result.action).toBe('kept-unverified');
        expect(result.error).toContain('check its permissions');
        expect(result.error).toContain('cleanup was left pending');
        expect(result.error).toContain('Retry once the project path can be resolved');
      } finally {
        chmodSync(parent, 0o700);
      }
      expect(removePiTrustEntry(opened, home, undefined, { recordedOnly: true })).toEqual({
        action: 'not-present',
      });
    },
  );

  test('keeps a plainly missing unrecorded project quiet without inspecting the ambient store', () => {
    const cwd = join(tmp(), 'removed-project');
    const home = tmp();
    write(trustPathIn(home), '{unrelated invalid config');
    expect(removePiTrustEntry(cwd, home, undefined, { recordedOnly: true })).toEqual({
      action: 'not-present',
    });
    expect(readFileSync(trustPathIn(home), 'utf8')).toBe('{unrelated invalid config');
  });

  test.each([false, true])(
    'discloses ambient unowned trust while cleaning a recorded custom store (bridge absent=%s)',
    async (absentBridge) => {
      const cwd = tmp();
      const home = tmp();
      const custom = tmp();
      await ensurePiBridge(cwd, { mode: 'published' }, home, { PI_CODING_AGENT_DIR: custom });
      const before = JSON.stringify({ [cwd]: true, other: false });
      write(trustPathIn(home), before);
      if (absentBridge) rmSync(bridgePathIn(cwd));

      const result = removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd));

      expect(result).toMatchObject({ kind: 'removed', trust: 'kept-unowned' });
      expect(result).toHaveProperty('trustDetail', expect.stringContaining(trustPathIn(home)));
      expect(result).toHaveProperty('trustDetail', expect.stringContaining(JSON.stringify(cwd)));
      expect(readFileSync(trustPathIn(home), 'utf8')).toBe(before);
      expect(JSON.parse(readFileSync(join(custom, 'trust.json'), 'utf8'))).toEqual({});
      expect(listPiTrustGrants(home, cwd)).toEqual([]);
      expect(existsSync(bridgePathIn(cwd))).toBe(false);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'preserves a known pending receipt when the ambient path aliases its recorded store',
    () => {
      const cwd = tmp();
      const home = tmp();
      const trustPath = trustPathIn(home);
      const configured = join(tmp(), 'trust.json');
      const before = JSON.stringify({ [cwd]: true, other: false });
      write(trustPath, before);
      symlinkSync(trustPath, configured);
      write(bridgePathIn(cwd), buildPiExtensionSource({ mode: 'published' }));
      withPiTrustLockSync(configured, realpathSync(trustPath), () => {
        preparePiTrustGrant(home, cwd, configured, realpathSync(trustPath), { present: false });
      });
      const lockSpy = vi.spyOn(lockfile, 'lockSync');

      const result = removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd));

      expect(result).toMatchObject({ kind: 'removed', trust: 'kept-unowned' });
      expect(result).toHaveProperty(
        'trustDetail',
        expect.stringContaining('ownership record is pending'),
      );
      expect(result).toHaveProperty('trustDetail', expect.stringContaining(configured));
      expect(result).toHaveProperty('trustDetail', expect.stringContaining(trustPath));
      expect(lockSpy.mock.calls.map(([, options]) => options?.lockfilePath)).toEqual([
        `${configured}.lock`,
        `${trustPath}.lock`,
      ]);
      expect(listPiTrustGrants(home, cwd)).toMatchObject([
        { record: { state: 'pending', configuredTrustPath: configured } },
      ]);
      expect(readFileSync(trustPath, 'utf8')).toBe(before);
      expect(existsSync(bridgePathIn(cwd))).toBe(false);
      expect(lstatSync(configured).isSymbolicLink()).toBe(true);
    },
  );

  test('does not convert disclosure into removal when a new ownership record appears under the lock', () => {
    const cwd = tmp();
    const home = tmp();
    const trustPath = trustPathIn(home);
    write(trustPath, '{}');
    write(bridgePathIn(cwd), buildPiExtensionSource({ mode: 'published' }));
    const originalLockSync = lockfile.lockSync;
    vi.spyOn(lockfile, 'lockSync').mockImplementation((path, options) => {
      const release = originalLockSync(path, options);
      const pending = preparePiTrustGrant(home, cwd, trustPath, realpathSync(trustPath), {
        present: false,
      });
      writeFileSync(trustPath, JSON.stringify({ [cwd]: true }));
      commitPiTrustGrant(home, pending);
      return release;
    });

    expect(removePiTrustEntry(cwd, home)).toMatchObject({
      action: 'failed',
      error: expect.stringContaining('ownership record changed during cleanup'),
    });
    expect(JSON.parse(readFileSync(trustPath, 'utf8'))).toEqual({ [cwd]: true });
    expect(listPiTrustGrants(home, cwd)).toHaveLength(1);
    expect(existsSync(bridgePathIn(cwd))).toBe(true);
    vi.restoreAllMocks();
    expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toMatchObject({
      kind: 'removed',
      trust: 'removed',
    });
  });

  test.each([false, true])(
    'preserves the project recheck refusal through lock release (release fails=%s)',
    async (releaseFails) => {
      const cwd = tmp();
      const other = tmp();
      const home = tmp();
      const alias = join(tmp(), 'project-link');
      symlinkSync(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
      await ensurePiBridge(alias, { mode: 'published' }, home);
      const trustPath = trustPathIn(home);
      const before = readFileSync(trustPath, 'utf8');
      const originalLockSync = lockfile.lockSync;
      vi.spyOn(lockfile, 'lockSync').mockImplementation((path, options) => {
        const release = originalLockSync(path, options);
        unlinkSync(alias);
        symlinkSync(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
        return () => {
          if (releaseFails) writeFileSync(join(`${trustPath}.lock`, 'keep.txt'), 'preserve');
          release();
        };
      });

      const result = removePiTrustEntry(alias, home);

      expect(result.action).toBe(releaseFails ? 'failed' : 'kept-unverified');
      expect(result.error).toContain('changed while waiting for its trust lock');
      if (releaseFails) expect(result.error).toContain('ENOTEMPTY');
      expect(readFileSync(trustPath, 'utf8')).toBe(before);
      expect(listPiTrustGrants(home, cwd)).toHaveLength(1);
      expect(existsSync(bridgePathIn(cwd))).toBe(true);
      expect(existsSync(bridgePathIn(other))).toBe(false);

      vi.restoreAllMocks();
      if (releaseFails) rmSync(`${trustPath}.lock`, { recursive: true });
      unlinkSync(alias);
      symlinkSync(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
      expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, alias, home, bridgePathIn(alias))).toMatchObject({
        kind: 'removed',
        trust: 'removed',
      });
    },
  );

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'cleans a searchable project without requiring permission to list its root',
    async () => {
      const cwd = tmp();
      const home = tmp();
      await ensurePiBridge(cwd, { mode: 'published' }, home);
      chmodSync(cwd, 0o111);
      try {
        expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toMatchObject({
          kind: 'removed',
          trust: 'removed',
        });
        expect(JSON.parse(readFileSync(trustPathIn(home), 'utf8'))).toEqual({});
        expect(listPiTrustGrants(home, cwd)).toEqual([]);
        expect(existsSync(bridgePathIn(cwd))).toBe(false);
      } finally {
        chmodSync(cwd, 0o700);
      }
    },
  );

  test.each(['alias', 'canonical'] as const)(
    'uses canonical trust and receipts when setup starts through the %s path',
    async (setupPath) => {
      const cwd = tmp();
      const home = tmp();
      const alias = join(tmp(), 'project-link');
      symlinkSync(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');

      expect(
        (await ensurePiBridge(setupPath === 'alias' ? alias : cwd, { mode: 'published' }, home)).ok,
      ).toBe(true);
      expect(JSON.parse(readFileSync(trustPathIn(home), 'utf8'))).toEqual({ [cwd]: true });
      expect(listPiTrustGrants(home, cwd)).toMatchObject([{ record: { cwd } }]);
      expect(listPiTrustGrants(home, alias)).toEqual([]);
      expect(probeReadyPiBridgeState(alias, home)).toMatchObject({
        project: 'ready',
        canonicalCwd: cwd,
        bridgeLoadable: true,
      });
      expect(probeReadyPiBridgeState(cwd, home).bridgeLoadable).toBe(true);

      const cleanupPath = setupPath === 'alias' ? cwd : alias;
      expect(
        removeOwnMcpEntry(EDITOR_TARGETS.pi, cleanupPath, home, bridgePathIn(cleanupPath)),
      ).toMatchObject({ kind: 'removed', trust: 'removed' });
      expect(JSON.parse(readFileSync(trustPathIn(home), 'utf8'))).toEqual({});
      expect(listPiTrustGrants(home, cwd)).toEqual([]);
      expect(existsSync(bridgePathIn(cwd))).toBe(false);
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      expect(realpathSync(alias)).toBe(cwd);
    },
  );

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'discloses canonical trust after a sibling alias receipt cannot be forgotten',
    () => {
      const cwd = tmp();
      const home = tmp();
      const alias = join(tmp(), 'project-link');
      symlinkSync(cwd, alias, 'dir');
      const trustPath = trustPathIn(home);
      write(trustPath, JSON.stringify({ [cwd]: true, [alias]: true, unrelated: false }));
      write(bridgePathIn(cwd), buildPiExtensionSource({ mode: 'published' }));
      withPiTrustLockSync(trustPath, realpathSync(trustPath), () => {
        commitPiTrustGrant(
          home,
          preparePiTrustGrant(home, alias, trustPath, realpathSync(trustPath), { present: false }),
        );
      });
      const [receipt] = listPiTrustGrants(home, alias);
      if (!receipt) throw new Error('expected alias receipt');
      chmodSync(dirname(receipt.path), 0o500);
      try {
        const result = removePiTrustEntry(alias, home);
        expect(result.action).toBe('failed');
        expect(result.error).toContain(`Pi trust entry ${JSON.stringify(alias)}`);
        expect(result.error).toContain(`remove only the ${JSON.stringify(cwd)} entry`);
        expect(result.error).toContain(trustPath);
        expect(JSON.parse(readFileSync(trustPath, 'utf8'))).toEqual({
          [cwd]: true,
          unrelated: false,
        });
        expect(listPiTrustGrants(home, alias)).toEqual([receipt]);
        expect(existsSync(bridgePathIn(cwd))).toBe(true);
      } finally {
        chmodSync(dirname(receipt.path), 0o700);
      }
      expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, alias, home, bridgePathIn(alias))).toMatchObject({
        kind: 'removed',
        trust: 'kept-unowned',
      });
      expect(listPiTrustGrants(home, alias)).toEqual([]);
    },
  );

  function twoRecordedKeys() {
    const cwd = tmp();
    const home = tmp();
    const alias = join(tmp(), 'project-link');
    symlinkSync(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const trustPath = trustPathIn(home);
    write(
      trustPath,
      `${JSON.stringify({ [cwd]: true, [alias]: true, unrelated: { keep: 'yes' } })}\n`,
    );
    write(bridgePathIn(cwd), buildPiExtensionSource({ mode: 'published' }));
    withPiTrustLockSync(trustPath, realpathSync(trustPath), () => {
      commitPiTrustGrant(
        home,
        preparePiTrustGrant(home, cwd, trustPath, realpathSync(trustPath), {
          present: true,
          value: false,
        }),
      );
      commitPiTrustGrant(
        home,
        preparePiTrustGrant(home, alias, trustPath, realpathSync(trustPath), { present: false }),
      );
    });
    const [receipt] = listPiTrustGrants(home, cwd);
    if (!receipt) throw new Error('expected canonical receipt');
    return { cwd, home, alias, trustPath, receipt };
  }

  test('restores one recorded decision and removes another in the same store without resurrecting either grant', () => {
    const { cwd, home, alias, trustPath } = twoRecordedKeys();
    expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, alias, home, bridgePathIn(alias))).toMatchObject({
      kind: 'removed',
      trust: 'removed',
    });
    expect(JSON.parse(readFileSync(trustPath, 'utf8'))).toEqual({
      [cwd]: false,
      unrelated: { keep: 'yes' },
    });
    expect(readFileSync(trustPath, 'utf8').endsWith('\n')).toBe(true);
    expect(listPiTrustGrants(home, cwd)).toEqual([]);
    expect(listPiTrustGrants(home, alias)).toEqual([]);
    expect(existsSync(bridgePathIn(cwd))).toBe(false);
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'preserves the first completed decision when its receipt deletion fails and the next key succeeds',
    () => {
      const { cwd, home, alias, trustPath, receipt } = twoRecordedKeys();
      chmodSync(dirname(receipt.path), 0o500);
      try {
        const result = removePiTrustEntry(alias, home);
        expect(result.action).toBe('failed');
        expect(result.error).toContain(`Pi trust entry ${JSON.stringify(cwd)}`);
        expect(JSON.parse(readFileSync(trustPath, 'utf8'))).toEqual({
          [cwd]: false,
          unrelated: { keep: 'yes' },
        });
        expect(listPiTrustGrants(home, cwd)).toEqual([receipt]);
        expect(listPiTrustGrants(home, alias)).toEqual([]);
        expect(existsSync(bridgePathIn(cwd))).toBe(true);
      } finally {
        chmodSync(dirname(receipt.path), 0o700);
      }
      expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, alias, home, bridgePathIn(alias))).toMatchObject({
        kind: 'removed',
        trust: 'not-present',
      });
      expect(listPiTrustGrants(home, cwd)).toEqual([]);
      expect(JSON.parse(readFileSync(trustPath, 'utf8'))).toEqual({
        [cwd]: false,
        unrelated: { keep: 'yes' },
      });
    },
  );

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0).each([false, true])(
    'discloses a committed record retained through an accessible inspection path (shared=%s)',
    async (shared) => {
      const cwd = tmp();
      const home = tmp();
      const configuredDir = tmp();
      const configured = join(configuredDir, 'trust.json');
      const trustPath = trustPathIn(home);
      write(trustPath, '{"unrelated":false}\n');
      symlinkSync(trustPath, configured);
      await ensurePiBridge(cwd, { mode: 'published' }, home, {
        PI_CODING_AGENT_DIR: configuredDir,
      });
      if (shared) write(join(cwd, '.pi', 'prompts', 'user.txt'), 'keep this prompt');
      const before = readFileSync(trustPath, 'utf8');
      const bridgeBefore = readFileSync(bridgePathIn(cwd), 'utf8');
      const receipts = listPiTrustGrants(home, cwd);
      chmodSync(configuredDir, 0o500);
      try {
        const result = removePiTrustEntry(cwd, home);
        expect(result.action).toBe('failed');
        expect(result.error).toContain(
          shared
            ? 'OpenKnowledge kept the existing ownership record; cleanup of its recorded location remains incomplete.'
            : `OpenKnowledge must reconcile its recorded location at ${configured} before removing it.`,
        );
        expect(result.error).toContain(`remove only the ${JSON.stringify(cwd)} entry`);
        expect(result.error).not.toContain('has relinquished');
        expect(readFileSync(trustPath, 'utf8')).toBe(before);
        expect(readFileSync(bridgePathIn(cwd), 'utf8')).toBe(bridgeBefore);
        expect(listPiTrustGrants(home, cwd)).toEqual(receipts);
      } finally {
        chmodSync(configuredDir, 0o700);
      }
      expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toMatchObject({
        kind: 'removed',
        trust: shared ? 'kept-shared' : 'removed',
      });
      expect(JSON.parse(readFileSync(trustPath, 'utf8'))).toEqual({
        unrelated: false,
        ...(shared ? { [cwd]: true } : {}),
      });
      expect(listPiTrustGrants(home, cwd)).toEqual([]);
      expect(existsSync(bridgePathIn(cwd))).toBe(false);
      expect(lstatSync(configured).isSymbolicLink()).toBe(true);
    },
  );

  test.each(['pending', 'committed'] as const)(
    'preserves canonical trust while handling a %s legacy alias receipt',
    (state) => {
      const cwd = tmp();
      const home = tmp();
      const alias = join(tmp(), 'project-link');
      symlinkSync(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const trustPath = trustPathIn(home);
      write(trustPath, JSON.stringify({ [cwd]: true, [alias]: true, unrelated: false }));
      write(bridgePathIn(alias), buildPiExtensionSource({ mode: 'published' }));
      withPiTrustLockSync(trustPath, realpathSync(trustPath), () => {
        const pending = preparePiTrustGrant(home, alias, trustPath, realpathSync(trustPath), {
          present: false,
        });
        if (state === 'committed') commitPiTrustGrant(home, pending);
      });

      const lockSpy = vi.spyOn(lockfile, 'lockSync');
      const outcome = removeOwnMcpEntry(EDITOR_TARGETS.pi, alias, home, bridgePathIn(alias));
      expect(lockSpy).toHaveBeenCalledTimes(1);

      expect(outcome).toMatchObject({ kind: 'removed', trust: 'kept-unowned' });
      expect(outcome).toHaveProperty('trustDetail', expect.stringContaining(JSON.stringify(cwd)));
      expect(JSON.parse(readFileSync(trustPath, 'utf8'))).toEqual({
        [cwd]: true,
        ...(state === 'pending' ? { [alias]: true } : {}),
        unrelated: false,
      });
      expect(listPiTrustGrants(home, alias)).toHaveLength(state === 'pending' ? 1 : 0);
      expect(listPiTrustGrants(home, cwd)).toEqual([]);
      expect(existsSync(bridgePathIn(cwd))).toBe(false);
    },
  );

  test('does not transfer legacy alias ownership to a different target after the alias is repointed', () => {
    const original = tmp();
    const current = tmp();
    const home = tmp();
    const alias = join(tmp(), 'project-link');
    symlinkSync(original, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const trustPath = trustPathIn(home);
    write(trustPath, JSON.stringify({ [original]: true, [current]: true, [alias]: true }));
    write(bridgePathIn(original), buildPiExtensionSource({ mode: 'published' }));
    write(bridgePathIn(current), buildPiExtensionSource({ mode: 'published' }));
    withPiTrustLockSync(trustPath, realpathSync(trustPath), () => {
      const pending = preparePiTrustGrant(home, alias, trustPath, realpathSync(trustPath), {
        present: false,
      });
      commitPiTrustGrant(home, pending);
    });
    unlinkSync(alias);
    symlinkSync(current, alias, process.platform === 'win32' ? 'junction' : 'dir');

    expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, alias, home, bridgePathIn(alias))).toMatchObject({
      kind: 'removed',
      trust: 'kept-unowned',
    });
    expect(JSON.parse(readFileSync(trustPath, 'utf8'))).toEqual({
      [original]: true,
      [current]: true,
    });
    expect(existsSync(bridgePathIn(original))).toBe(true);
    expect(listPiTrustGrants(home, alias)).toEqual([]);
  });

  test('refuses missing or broken project paths without changing the real project grant or bridge', async () => {
    const cwd = tmp();
    const home = tmp();
    const alias = join(tmp(), 'project-link');
    symlinkSync(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await ensurePiBridge(alias, { mode: 'published' }, home);
    const before = readFileSync(trustPathIn(home), 'utf8');
    unlinkSync(alias);
    symlinkSync(
      join(tmp(), 'missing-project'),
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(await ensurePiBridge(alias, { mode: 'published' }, home)).toMatchObject({
      ok: false,
      bridge: 'refused-project-path',
      trust: 'skipped',
    });
    expect(removePiTrustEntry(alias, home)).toMatchObject({
      action: 'kept-unverified',
      error: expect.stringContaining('restore the directory or symlink'),
    });
    expect(probePiBridgeState(alias, home)).toEqual({
      cwd: alias,
      bridgePath: bridgePathIn(alias),
      trustPath: trustPathIn(home),
      project: 'unavailable',
      error: expect.stringContaining('restore the directory or symlink'),
    });
    expect(readFileSync(trustPathIn(home), 'utf8')).toBe(before);
    expect(listPiTrustGrants(home, cwd)).toHaveLength(1);
    expect(existsSync(bridgePathIn(cwd))).toBe(true);
  });

  test('refuses a project alias that changes while setup waits for the trust lock', async () => {
    const original = tmp();
    const other = tmp();
    const home = tmp();
    const alias = join(tmp(), 'project-link');
    symlinkSync(original, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const trustPath = trustPathIn(home);
    const before = '{"unrelated":true}\n';
    write(trustPath, before);
    const canonicalLock = `${realpathSync(trustPath)}.ok.lock`;
    write(canonicalLock, 'held');
    const pending = ensurePiBridge(alias, { mode: 'published' }, home);
    try {
      expect(
        await Promise.race([
          pending.then(() => 'finished'),
          new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 75)),
        ]),
      ).toBe('waiting');
      unlinkSync(alias);
      symlinkSync(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } finally {
      unlinkSync(canonicalLock);
      await pending;
    }

    expect(await pending).toMatchObject({
      ok: false,
      trust: 'refused-unreadable',
      error: expect.stringContaining('changed while waiting for its trust lock'),
    });
    expect(readFileSync(trustPath, 'utf8')).toBe(before);
    expect(listPiTrustGrants(home, original)).toEqual([]);
    expect(listPiTrustGrants(home, other)).toEqual([]);
    expect(existsSync(bridgePathIn(other))).toBe(false);
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses an unreadable project through the result contract and permits repair and retry',
    async () => {
      const cwd = tmp();
      const home = tmp();
      await ensurePiBridge(cwd, { mode: 'published' }, home);
      const before = readFileSync(trustPathIn(home), 'utf8');
      chmodSync(cwd, 0o000);
      try {
        expect(await ensurePiBridge(cwd, { mode: 'published' }, home)).toMatchObject({
          ok: false,
          bridge: 'refused-project-path',
          trust: 'skipped',
        });
        expect(removePiTrustEntry(cwd, home)).toMatchObject({
          action: 'kept-unverified',
          error: expect.stringContaining('check its permissions'),
        });
        expect(readFileSync(trustPathIn(home), 'utf8')).toBe(before);
        expect(listPiTrustGrants(home, cwd)).toHaveLength(1);
      } finally {
        chmodSync(cwd, 0o700);
      }
      expect(existsSync(bridgePathIn(cwd))).toBe(true);
      expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toMatchObject({
        kind: 'removed',
        trust: 'removed',
      });
    },
  );
});

describe('folder-scoped trust', () => {
  test('does not recreate a plain trust file that disappeared while waiting for the lock', async () => {
    const cwd = tmp();
    const home = tmp();
    const trustPath = trustPathIn(home);
    write(trustPath, '{"other": true}\n');
    const canonicalLock = `${realpathSync(trustPath)}.ok.lock`;
    write(canonicalLock, 'held');
    const pending = ensurePiBridge(cwd, { mode: 'published' }, home);
    try {
      expect(
        await Promise.race([
          pending.then(() => 'finished'),
          new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 75)),
        ]),
      ).toBe('waiting');
      unlinkSync(trustPath);
    } finally {
      unlinkSync(canonicalLock);
      await pending;
    }

    const result = await pending;
    expect(result).toMatchObject({ ok: false, trust: 'refused-unreadable' });
    expect(result.error).toContain('path changed while waiting for its lock');
    expect(result.error).toContain('retry to check its current state');
    expect(result.error).not.toContain('permissions');
    expect(existsSync(trustPath)).toBe(false);
    expect(existsSync(bridgePathIn(cwd))).toBe(true);
  });

  test.each([false, null, 'unknown', { future: 'decision' }] as const)(
    'removes the bridge without rewriting a non-grant trust decision (%j)',
    (decision) => {
      const cwd = tmp();
      const home = tmp();
      const trustPath = trustPathIn(home);
      const before = `${JSON.stringify({ [dirname(cwd)]: true, [cwd]: decision, other: true })}\n`;
      write(trustPath, before);
      write(bridgePathIn(cwd), buildPiExtensionSource({ mode: 'published' }));
      const mtime = freezeMtime(trustPath);

      expect(removeOwnMcpEntry(EDITOR_TARGETS.pi, cwd, home, bridgePathIn(cwd))).toEqual({
        kind: 'removed',
        trust: 'not-present',
      });

      expect(readFileSync(trustPath, 'utf8')).toBe(before);
      expect(statSync(trustPath).mtimeMs).toBe(mtime);
      expect(existsSync(bridgePathIn(cwd))).toBe(false);
    },
  );

  test('the probe names the other extensions the trust grant would cover', async () => {
    const cwd = tmp();
    const home = tmp();
    mkdirSync(dirname(bridgePathIn(cwd)), { recursive: true });
    write(join(dirname(bridgePathIn(cwd)), 'zeta.ts'), '// someone else');
    write(join(dirname(bridgePathIn(cwd)), 'alpha.ts'), '// someone else');
    write(join(dirname(bridgePathIn(cwd)), 'notes.md'), 'hi');
    await ensurePiBridge(cwd, { mode: 'published' }, home);
    expect(probeReadyPiBridgeState(cwd, home).otherExtensions).toEqual(['"alpha.ts"', '"zeta.ts"']);
  });

  test('removing the bridge revokes the trust entry it added', async () => {
    const cwd = tmp();
    const home = tmp();
    await ensurePiBridge(cwd, { mode: 'published' }, home);
    expect(probeReadyPiBridgeState(cwd, home).trust).toBe('trusted');
    rmSync(bridgePathIn(cwd), { force: true });
    expect(removePiTrustEntry(cwd, home).action).toBe('removed');
    expect(probeReadyPiBridgeState(cwd, home).trust).toBe('untrusted');
  });

  test('an entry another extension still depends on is kept', async () => {
    const cwd = tmp();
    const home = tmp();
    await ensurePiBridge(cwd, { mode: 'published' }, home);
    write(join(dirname(bridgePathIn(cwd)), 'theirs.ts'), '// someone else');
    rmSync(bridgePathIn(cwd), { force: true });
    expect(removePiTrustEntry(cwd, home).action).toBe('kept-shared');
    expect(probeReadyPiBridgeState(cwd, home).trust).toBe('trusted');
  });

  test('an unreadable extensions folder is kept, not treated as verified empty', async () => {
    const cwd = tmp();
    const home = tmp();
    await ensurePiBridge(cwd, { mode: 'published' }, home);
    const extDir = dirname(bridgePathIn(cwd));
    rmSync(bridgePathIn(cwd), { force: true });
    chmodSync(extDir, 0o000);
    try {
      expect(removePiTrustEntry(cwd, home).action).toBe('kept-unverified');
      expect(probeReadyPiBridgeState(cwd, home).trust).toBe('trusted');
    } finally {
      chmodSync(extDir, 0o755);
    }
  });

  test('a folder that is simply gone counts as verified empty', async () => {
    const cwd = tmp();
    const home = tmp();
    await ensurePiBridge(cwd, { mode: 'published' }, home);
    rmSync(dirname(bridgePathIn(cwd)), { recursive: true, force: true });
    expect(removePiTrustEntry(cwd, home).action).toBe('removed');
  });

  test('revoking a folder that was never trusted is a no-op, not a failure', async () => {
    const cwd = tmp();
    const home = tmp();
    expect(removePiTrustEntry(cwd, home).action).toBe('not-present');
  });

  test('a trust store OK cannot parse is left byte-untouched', async () => {
    const cwd = tmp();
    const home = tmp();
    const trustPath = trustPathIn(home);
    mkdirSync(dirname(trustPath), { recursive: true });
    write(trustPath, 'not json at all');
    expect(removePiTrustEntry(cwd, home).action).toBe('refused-unreadable');
    expect(readFileSync(trustPath, 'utf-8')).toBe('not json at all');
  });

  test('every other entry in the store survives the revocation', async () => {
    const cwd = tmp();
    const home = tmp();
    const other = tmp();
    await ensurePiBridge(cwd, { mode: 'published' }, home);
    await ensurePiBridge(other, { mode: 'published' }, home);
    rmSync(bridgePathIn(cwd), { force: true });
    expect(removePiTrustEntry(cwd, home).action).toBe('removed');
    expect(probeReadyPiBridgeState(other, home).trust).toBe('trusted');
  });
});
