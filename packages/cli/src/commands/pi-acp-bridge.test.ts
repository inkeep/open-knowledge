import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildPiExtensionSource, isOwnPiExtensionSource } from '../integrations/pi-extension.ts';
import { PI_EXTENSION_OWNERSHIP_MARKER } from './editors.ts';
import { ensurePiBridge, probePiBridgeState, removePiTrustEntry } from './pi-acp-bridge.ts';

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'pi-acp-bridge-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

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
    expect(probePiBridgeState(cwd, home)).toEqual({
      cwd,
      otherExtensions: [],
      bridgePath: bridgePathIn(cwd),
      trustPath: trustPathIn(home),
      bridge: 'absent',
      trust: 'untrusted',
      bridgeLoadable: false,
    });
  });

  test('normalizes the cwd it reports and keys trust on', async () => {
    const cwd = tmp();
    const home = tmp();
    write(trustPathIn(home), JSON.stringify({ [cwd]: true }));
    const state = probePiBridgeState(`${cwd}/./`, home);
    expect(state.cwd).toBe(cwd);
    expect(state.trust).toBe('trusted');
  });

  test('classifies an own current bridge, trusted', async () => {
    const cwd = tmp();
    const home = tmp();
    write(bridgePathIn(cwd), buildPiExtensionSource({ mode: 'published' }));
    write(trustPathIn(home), JSON.stringify({ [cwd]: true }, null, 2));
    const state = probePiBridgeState(cwd, home);
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
    expect(probePiBridgeState(cwd, home)).toMatchObject({
      bridge: 'own-stale',
      bridgeLoadable: true,
    });

    write(bridgePathIn(cwd), `${PI_EXTENSION_OWNERSHIP_MARKER}-v0\n// legacy body\n`);
    expect(probePiBridgeState(cwd, home)).toMatchObject({
      bridge: 'own-stale',
      bridgeLoadable: true,
    });
  });

  test('a file OK did not write is foreign and never loadable', async () => {
    const cwd = tmp();
    const home = tmp();
    write(bridgePathIn(cwd), 'export default function mine() {}\n');
    write(trustPathIn(home), JSON.stringify({ [cwd]: true }));
    const state = probePiBridgeState(cwd, home);
    expect(state.bridge).toBe('foreign');
    expect(state.bridgeLoadable).toBe(false);
  });

  test('a blank file at the managed path is creatable, not foreign', async () => {
    const cwd = tmp();
    const home = tmp();
    write(bridgePathIn(cwd), '   \n');
    expect(probePiBridgeState(cwd, home).bridge).toBe('absent');
  });

  test('trust states: missing entry, explicit false, corrupt, non-object', async () => {
    const cwd = tmp();
    const home = tmp();

    write(trustPathIn(home), JSON.stringify({ '/somewhere/else': true }));
    expect(probePiBridgeState(cwd, home).trust).toBe('untrusted');

    write(trustPathIn(home), JSON.stringify({ [cwd]: false }));
    expect(probePiBridgeState(cwd, home).trust).toBe('untrusted');

    write(trustPathIn(home), '{not json');
    expect(probePiBridgeState(cwd, home).trust).toBe('unreadable');

    write(trustPathIn(home), JSON.stringify([cwd]));
    expect(probePiBridgeState(cwd, home).trust).toBe('unreadable');

    write(trustPathIn(home), '');
    expect(probePiBridgeState(cwd, home).trust).toBe('untrusted');
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
      const state = probePiBridgeState(cwd, home);
      expect(state.trustPath).toBe(trustPathIn(home));
      expect(state.trust).toBe('trusted');
    });

    test('without an injected home the env override is honored', async () => {
      const cwd = tmp();
      expect(probePiBridgeState(cwd).trustPath).toBe('/nonexistent/pi-agent-dir/trust.json');
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
    expect(probePiBridgeState(cwd, home).bridgeLoadable).toBe(true);
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

    const second = await ensurePiBridge(cwd, { mode: 'published' }, home);
    expect(second).toMatchObject({ ok: true, bridge: 'unchanged', trust: 'already-trusted' });
    expect(statSync(bridgePathIn(cwd)).mtimeMs).toBe(bridgeMtime);
    expect(statSync(trustPathIn(home)).mtimeMs).toBe(trustMtime);
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

describe('folder-scoped trust', () => {
  test('the probe names the other extensions the trust grant would cover', async () => {
    const cwd = tmp();
    const home = tmp();
    mkdirSync(dirname(bridgePathIn(cwd)), { recursive: true });
    write(join(dirname(bridgePathIn(cwd)), 'zeta.ts'), '// someone else');
    write(join(dirname(bridgePathIn(cwd)), 'alpha.ts'), '// someone else');
    write(join(dirname(bridgePathIn(cwd)), 'notes.md'), 'hi');
    await ensurePiBridge(cwd, { mode: 'published' }, home);
    expect(probePiBridgeState(cwd, home).otherExtensions).toEqual(['alpha.ts', 'zeta.ts']);
  });

  test('removing the bridge revokes the trust entry it added', async () => {
    const cwd = tmp();
    const home = tmp();
    await ensurePiBridge(cwd, { mode: 'published' }, home);
    expect(probePiBridgeState(cwd, home).trust).toBe('trusted');
    rmSync(bridgePathIn(cwd), { force: true });
    expect(removePiTrustEntry(cwd, home).action).toBe('removed');
    expect(probePiBridgeState(cwd, home).trust).toBe('untrusted');
  });

  test('an entry another extension still depends on is kept', async () => {
    const cwd = tmp();
    const home = tmp();
    await ensurePiBridge(cwd, { mode: 'published' }, home);
    write(join(dirname(bridgePathIn(cwd)), 'theirs.ts'), '// someone else');
    rmSync(bridgePathIn(cwd), { force: true });
    expect(removePiTrustEntry(cwd, home).action).toBe('kept-shared');
    expect(probePiBridgeState(cwd, home).trust).toBe('trusted');
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
      expect(probePiBridgeState(cwd, home).trust).toBe('trusted');
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
    expect(probePiBridgeState(other, home).trust).toBe('trusted');
  });
});
