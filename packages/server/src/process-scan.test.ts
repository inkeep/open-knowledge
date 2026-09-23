import type { SpawnSyncReturns } from 'node:child_process';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.fn();
const execFileSyncMock = vi.fn();
const existsSyncMock = vi.fn();
const readdirSyncMock = vi.fn();
const lstatSyncMock = vi.fn();

let scanLockProcesses: typeof import('./process-scan.ts').scanLockProcesses;
let discoverLockDirs: typeof import('./process-scan.ts').discoverLockDirs;
let findOkProcessPids: typeof import('./process-scan.ts').findOkProcessPids;
let readPidCwds: typeof import('./process-scan.ts').readPidCwds;
let isDefunctProcess: typeof import('./process-scan.ts').isDefunctProcess;
let isLockProcessRunning: typeof import('./process-scan.ts').isLockProcessRunning;
let readProcessState: typeof import('./process-scan.ts').readProcessState;
let realCp: typeof import('node:child_process');
let realFs: typeof import('node:fs');

beforeAll(async () => {
  realCp = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  execFileSyncMock.mockImplementation(realCp.execFileSync);
  vi.doMock('node:child_process', () => ({
    ...realCp,
    spawnSync: spawnSyncMock,
    execFileSync: execFileSyncMock,
  }));
  vi.doMock('node:fs', () => ({
    ...realFs,
    existsSync: existsSyncMock,
    readdirSync: readdirSyncMock,
    lstatSync: lstatSyncMock,
  }));
  ({
    scanLockProcesses,
    discoverLockDirs,
    findOkProcessPids,
    readPidCwds,
    isDefunctProcess,
    isLockProcessRunning,
    readProcessState,
  } = await import('./process-scan.ts'));
});

function refuseUnmockedSpawn(command: string, args: readonly string[] = []): never {
  throw new Error(`unmocked spawnSync escaped to the host: ${command} ${args.join(' ')}`);
}

function makeSpawnResult(overrides: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> {
  return {
    pid: 0,
    output: [],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null,
    error: undefined,
    ...overrides,
  };
}

describe('findOkProcessPids', () => {
  let spawnSyncSpy: typeof spawnSyncMock;

  beforeEach(() => {
    spawnSyncMock.mockReset().mockImplementation(refuseUnmockedSpawn);
    spawnSyncSpy = spawnSyncMock;
  });

  afterEach(() => {
    spawnSyncMock.mockReset();
  });

  it('returns PIDs parsed from pgrep output when pgrep is available', async () => {
    spawnSyncSpy.mockReturnValue(
      makeSpawnResult({
        stdout:
          '12345 /usr/local/bin/bun /path/to/open-knowledge/packages/cli/dist/cli.mjs start\n',
        status: 0,
      }),
    );

    const pids = await findOkProcessPids();
    expect(pids).toEqual([12345]);
    const [cmd, args] = spawnSyncSpy.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('pgrep');
    expect(args.join(' ')).toContain('open-knowledge');
  });

  it('finds npx-installed open-knowledge bin processes', async () => {
    spawnSyncSpy.mockReturnValue(
      makeSpawnResult({
        stdout:
          '54321 /usr/local/bin/node /Users/mike/.npm/_npx/64e3e56af53daa3b/node_modules/.bin/open-knowledge start\n',
        status: 0,
      }),
    );

    const pids = await findOkProcessPids();
    expect(pids).toEqual([54321]);
  });

  it('finds Electron utility processes by explicit lock-dir marker', async () => {
    const encoded = Buffer.from('/Users/mike/notes/.ok/local', 'utf8').toString('base64url');
    spawnSyncSpy.mockReturnValue(
      makeSpawnResult({
        stdout: `24680 /Applications/OpenKnowledge.app/Contents/Frameworks/OpenKnowledge Helper --type=utility --ok-lock-dir-b64=${encoded}\n`,
        status: 0,
      }),
    );

    const pids = await findOkProcessPids();
    expect(pids).toEqual([24680]);
  });

  it('finds packaged OpenKnowledge Helper processes without lock-dir marker', async () => {
    spawnSyncSpy.mockReturnValue(
      makeSpawnResult({
        stdout:
          '5816 /Applications/OpenKnowledge.app/Contents/Frameworks/OpenKnowledge Helper.app/Contents/MacOS/OpenKnowledge Helper --type=utility --utility-sub-type=node.mojom.NodeService\n',
        status: 0,
      }),
    );

    const pids = await findOkProcessPids();
    expect(pids).toEqual([5816]);
  });

  it('still finds a pre-rename "Open Knowledge" packaged Helper (backward-compat regex)', async () => {
    spawnSyncSpy.mockReturnValue(
      makeSpawnResult({
        stdout:
          '5817 /Applications/Open Knowledge.app/Contents/Frameworks/Open Knowledge Helper.app/Contents/MacOS/Open Knowledge Helper --type=utility --utility-sub-type=node.mojom.NodeService\n',
        status: 0,
      }),
    );

    const pids = await findOkProcessPids();
    expect(pids).toEqual([5817]);
  });

  it('falls back to ps when pgrep is unavailable (ENOENT)', async () => {
    const enoent = Object.assign(new Error('pgrep not found'), { code: 'ENOENT' });

    spawnSyncSpy
      .mockReturnValueOnce(makeSpawnResult({ error: enoent as NodeJS.ErrnoException }))
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout:
            'PID COMMAND\n' +
            ' 99999 /usr/local/bin/open-knowledge start\n' +
            '   123 some-other-process\n',
          status: 0,
        }),
      );

    const pids = await findOkProcessPids();
    expect(pids).toEqual([99999]);

    const calls = spawnSyncSpy.mock.calls as [string, string[]][];
    expect(calls[0]?.[0]).toBe('pgrep');
    expect(calls[1]?.[0]).toBe('ps');
  });

  it('returns empty array when pgrep exits 1 (no matches) — does NOT fall back to ps', async () => {
    spawnSyncSpy.mockReturnValue(makeSpawnResult({ stdout: '', status: 1 }));

    const pids = await findOkProcessPids();
    expect(pids).toEqual([]);
    expect(spawnSyncSpy.mock.calls.length).toBe(1);
  });

  it('falls back to ps when pgrep returns PID-only lines', async () => {
    spawnSyncSpy
      .mockReturnValueOnce(makeSpawnResult({ stdout: '12345\n', status: 0 }))
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout:
            'PID COMMAND\n 12345 /usr/local/bin/node /path/node_modules/.bin/open-knowledge start\n',
          status: 0,
        }),
      );

    const pids = await findOkProcessPids();
    expect(pids).toEqual([12345]);
    expect(spawnSyncSpy.mock.calls.map((call) => call[0])).toEqual(['pgrep', 'ps']);
  });

  it('filters out non-ok processes from ps output', async () => {
    const enoent = Object.assign(new Error('pgrep not found'), { code: 'ENOENT' });

    spawnSyncSpy
      .mockReturnValueOnce(makeSpawnResult({ error: enoent as NodeJS.ErrnoException }))
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout:
            '  PID COMMAND\n' +
            '  111 /usr/bin/ruby some-script.rb\n' +
            '  222 /usr/local/bin/ok start\n' +
            '  333 /usr/local/bin/bun run dev packages/app\n',
          status: 0,
        }),
      );

    const pids = await findOkProcessPids();
    expect(pids).toContain(222);
    expect(pids).toContain(333);
    expect(pids).not.toContain(111);
  });
});

describe('readPidCwds', () => {
  let spawnSyncSpy: typeof spawnSyncMock;

  beforeEach(() => {
    spawnSyncMock.mockReset().mockImplementation(refuseUnmockedSpawn);
    spawnSyncSpy = spawnSyncMock;
  });

  afterEach(() => {
    spawnSyncMock.mockReset();
  });

  it('maps each pid to its CWD from lsof -Fn output', async () => {
    spawnSyncSpy.mockReturnValue(
      makeSpawnResult({
        stdout: 'p12345\nfcwd\nn/Users/mike/my-notes\n',
        status: 0,
      }),
    );

    expect(readPidCwds([12345]).get(12345)).toBe('/Users/mike/my-notes');
  });

  it('reports a failed query when lsof is unavailable (ENOENT) — no crash', async () => {
    const enoent = Object.assign(new Error('lsof not found'), { code: 'ENOENT' });
    spawnSyncSpy.mockReturnValue(makeSpawnResult({ error: enoent as NodeJS.ErrnoException }));

    expect(readPidCwds([12345]).size).toBe(0);
  });

  it('reports no cwd for a pid whose lsof output has no cwd line', async () => {
    spawnSyncSpy.mockReturnValue(makeSpawnResult({ stdout: 'p12345\n', status: 0 }));

    expect(readPidCwds([12345]).has(12345)).toBe(false);
  });

  it('keeps the answers of the responsive pids when the batched query fails', async () => {
    const timeoutErr = Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
    spawnSyncSpy
      .mockReturnValueOnce(makeSpawnResult({ error: timeoutErr as NodeJS.ErrnoException }))
      .mockReturnValueOnce(makeSpawnResult({ error: timeoutErr as NodeJS.ErrnoException }))
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'p22\nfcwd\nn/b\n', status: 0 }))
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'p33\nfcwd\nn/c\n', status: 0 }));

    const cwds = readPidCwds([11, 22, 33]);
    expect(cwds.has(11)).toBe(false);
    expect(cwds.get(22)).toBe('/b');
    expect(cwds.get(33)).toBe('/c');
  });

  it('attributes each cwd to its own pid when a batch answers for only some of them', async () => {
    spawnSyncSpy.mockReturnValue(
      makeSpawnResult({ stdout: 'p11\nfcwd\nn/a\np22\np33\nfcwd\nn/c\n', status: 0 }),
    );

    const cwds = readPidCwds([11, 22, 33]);
    expect(cwds.get(11)).toBe('/a');
    expect(cwds.has(22)).toBe(false);
    expect(cwds.get(33)).toBe('/c');
  });

  it('issues no second query when the failing batch already covered a single pid', async () => {
    const timeoutErr = Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
    spawnSyncSpy.mockReturnValue(makeSpawnResult({ error: timeoutErr as NodeJS.ErrnoException }));

    expect(readPidCwds([688]).size).toBe(0);

    const cwdQueries = spawnSyncSpy.mock.calls.filter(
      (call) => call[0] === 'lsof' && (call[1] as string[]).includes('cwd'),
    );
    expect(cwdQueries).toHaveLength(1);
  });

  it('attributes a batch from Linux lsof output, which omits the fcwd line', async () => {
    spawnSyncSpy.mockReturnValue(
      makeSpawnResult({ stdout: 'p249\nn/srv/notes\np250\nn/home/mike/second-notes\n', status: 0 }),
    );

    const cwds = readPidCwds([249, 250]);
    expect(cwds.get(249)).toBe('/srv/notes');
    expect(cwds.get(250)).toBe('/home/mike/second-notes');
  });

  it('keeps the first cwd line for a pid (parity pin: real lsof emits one per pid)', async () => {
    spawnSyncSpy.mockReturnValue(
      makeSpawnResult({ stdout: 'p11\nfcwd\nn/first\nn/second\n', status: 0 }),
    );

    expect(readPidCwds([11]).get(11)).toBe('/first');
  });

  it('reports a failed query on timeout (error but not ENOENT)', async () => {
    const timeoutErr = Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
    spawnSyncSpy.mockReturnValue(makeSpawnResult({ error: timeoutErr as NodeJS.ErrnoException }));

    expect(readPidCwds([99999]).size).toBe(0);
  });
});

describe('discoverLockDirs', () => {
  let spawnSyncSpy: typeof spawnSyncMock;
  let existsSyncSpy: typeof existsSyncMock;
  let readdirSyncSpy: typeof readdirSyncMock;
  let lstatSyncSpy: typeof lstatSyncMock;

  beforeEach(() => {
    spawnSyncMock.mockReset().mockImplementation(refuseUnmockedSpawn);
    existsSyncMock.mockReset().mockImplementation(realFs.existsSync);
    lstatSyncMock.mockReset().mockImplementation(realFs.lstatSync);
    readdirSyncMock
      .mockReset()
      .mockImplementation(() => [] as unknown as ReturnType<typeof realFs.readdirSync>);
    spawnSyncSpy = spawnSyncMock;
    existsSyncSpy = existsSyncMock;
    readdirSyncSpy = readdirSyncMock;
    lstatSyncSpy = lstatSyncMock;
  });

  afterEach(() => {
    spawnSyncMock.mockReset();
    existsSyncMock.mockReset();
    readdirSyncMock.mockReset();
    lstatSyncMock.mockReset();
  });

  it('returns deduped lock dirs when multiple discovery routes find the same path', async () => {
    spawnSyncSpy
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout: '111 /usr/local/bin/bun /path/packages/cli/dist/cli.mjs start\n',
          status: 0,
        }),
      )
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout: 'p111\nfcwd\nn/Users/mike/notes\n',
          status: 0,
        }),
      )
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout: 'COMMAND  PID USER   FD   TYPE\nbun      111 mike  ...\n',
          status: 0,
        }),
      );

    existsSyncSpy.mockImplementation(
      (p: unknown) =>
        p === '/Users/mike/notes/.ok/local' || p === '/Users/mike/notes/.ok/local/server.lock',
    );

    const dirs = await discoverLockDirs();
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toContain('.ok/local');

    const calls = spawnSyncSpy.mock.calls as [string, string[]][];
    expect(calls[0]?.[0]).toBe('pgrep');
    expect(calls[1]?.[0]).toBe('lsof');
    expect(calls[2]?.[0]).toBe('lsof');
  });

  it('returns empty array when no ok processes and no lock dirs exist', async () => {
    spawnSyncSpy
      .mockReturnValueOnce(makeSpawnResult({ stdout: '', status: 1 }))
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'COMMAND PID USER\n', status: 0 }));

    existsSyncSpy.mockReturnValue(false);

    const dirs = await discoverLockDirs();
    expect(dirs).toHaveLength(0);
  });

  it('discovers Electron utility lock dirs from the explicit argv marker', async () => {
    const lockDir = '/Users/mike/notes with spaces/.ok/local';
    const encoded = Buffer.from(lockDir, 'utf8').toString('base64url');
    spawnSyncSpy
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout: `77 /Applications/OpenKnowledge.app/Contents/Frameworks/OpenKnowledge Helper --type=utility --ok-lock-dir-b64=${encoded}\n`,
          status: 0,
        }),
      )
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout: 'p77\nfcwd\nn/Applications/OpenKnowledge.app/Contents/Resources\n',
          status: 0,
        }),
      )
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'COMMAND PID USER\n', status: 0 }));

    existsSyncSpy.mockImplementation((p: unknown) => p === lockDir);

    const dirs = await discoverLockDirs();
    expect(dirs).toEqual([lockDir]);

    const calls = spawnSyncSpy.mock.calls as [string, string[]][];
    expect(calls[0]?.[0]).toBe('pgrep');
    expect(calls[1]?.[0]).toBe('lsof');
    expect(calls[2]?.[0]).toBe('lsof');
  });

  it('discovers desktop project locks from renderer --ok-project-path argv', async () => {
    const projectPath = '/Users/mike/Documents/OpenKnowledge/garth_nix';
    const lockDir = `${projectPath}/.ok/local`;

    spawnSyncSpy
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout: `93943 /Applications/OpenKnowledge.app/Contents/Frameworks/OpenKnowledge Helper (Renderer).app/Contents/MacOS/OpenKnowledge Helper (Renderer) --type=renderer --ok-collab-url=ws://localhost:51473/collab --ok-project-path=${projectPath} --ok-project-name=garth_nix --seatbelt-client=53\n`,
          status: 0,
        }),
      )
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'p93943\nfcwd\nn/\n', status: 0 }))
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'COMMAND PID USER\n', status: 0 }));

    existsSyncSpy.mockImplementation(
      (p: unknown) => p === lockDir || p === `${lockDir}/server.lock`,
    );

    const dirs = await discoverLockDirs();
    expect(dirs).toEqual([lockDir]);
  });

  it('ignores renderer --ok-project-path argv with a relative path', async () => {
    spawnSyncSpy
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout:
            '93943 /Applications/OpenKnowledge Helper (Renderer) --type=renderer --ok-project-path=relative/notes --ok-project-name=notes\n',
          status: 0,
        }),
      )
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'p93943\nfcwd\nn/\n', status: 0 }))
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'COMMAND PID USER\n', status: 0 }));

    existsSyncSpy.mockReturnValue(false);

    const dirs = await discoverLockDirs();
    expect(dirs).toHaveLength(0);
  });

  it('does not discover lock dirs holding only a legacy ui.lock', async () => {
    const projectPath = '/Users/mike/notes';
    const lockDir = `${projectPath}/.ok/local`;

    spawnSyncSpy
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout: '77 /usr/local/bin/ok ui\n',
          status: 0,
        }),
      )
      .mockReturnValueOnce(makeSpawnResult({ stdout: `p77\nfcwd\nn${projectPath}\n`, status: 0 }))
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'COMMAND PID USER\n', status: 0 }));

    existsSyncSpy.mockImplementation((p: unknown) => p === lockDir || p === `${lockDir}/ui.lock`);

    const dirs = await discoverLockDirs();
    expect(dirs).toHaveLength(0);
  });

  it('ignores Electron marker with empty payload', async () => {
    spawnSyncSpy
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout:
            '42 /Applications/OpenKnowledge.app/Contents/Frameworks/Helper --ok-lock-dir-b64=\n',
          status: 0,
        }),
      )
      .mockReturnValueOnce(
        makeSpawnResult({ stdout: 'p42\nfcwd\nn/Applications/Helper\n', status: 0 }),
      )
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'COMMAND PID USER\n', status: 0 }));

    existsSyncSpy.mockReturnValue(false);

    const dirs = await discoverLockDirs();
    expect(dirs).toHaveLength(0);
  });

  it('ignores Electron marker with a relative-path payload', async () => {
    const encoded = Buffer.from('relative/path/.ok/local', 'utf8').toString('base64url');
    spawnSyncSpy
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout: `42 /Applications/Helper --ok-lock-dir-b64=${encoded}\n`,
          status: 0,
        }),
      )
      .mockReturnValueOnce(
        makeSpawnResult({ stdout: 'p42\nfcwd\nn/Applications/Helper\n', status: 0 }),
      )
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'COMMAND PID USER\n', status: 0 }));

    existsSyncSpy.mockReturnValue(false);

    const dirs = await discoverLockDirs();
    expect(dirs).toHaveLength(0);
  });

  it('discovers child project locks from the current-directory subtree fallback', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd');
    const parent = '/Users/mike/Documents/OpenKnowledge';
    const child = `${parent}/garth_nix`;
    const lockDir = `${child}/.ok/local`;

    spawnSyncSpy
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout:
            '5816 /Applications/OpenKnowledge.app/Contents/Frameworks/OpenKnowledge Helper.app/Contents/MacOS/OpenKnowledge Helper --type=utility --utility-sub-type=node.mojom.NodeService\n',
          status: 0,
        }),
      )
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'p5816\nfcwd\nn/\n', status: 0 }))
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'COMMAND PID USER\n', status: 0 }));
    existsSyncSpy.mockImplementation(
      (p: unknown) => p === lockDir || p === `${lockDir}/server.lock`,
    );
    readdirSyncSpy.mockImplementation((p: unknown) => {
      if (p === parent) return ['garth_nix'] as unknown as ReturnType<typeof realFs.readdirSync>;
      return [] as unknown as ReturnType<typeof realFs.readdirSync>;
    });
    lstatSyncSpy.mockImplementation(
      () => ({ isDirectory: () => true }) as unknown as ReturnType<typeof realFs.lstatSync>,
    );

    try {
      cwdSpy.mockReturnValue(parent);
      const dirs = await discoverLockDirs();
      expect(dirs).toEqual([lockDir]);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('runs subtree fallback for slash-cwd helpers even when another candidate was found', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd');
    const parent = '/Users/mike/Documents/OpenKnowledge';
    const directProject = '/Users/mike/direct-notes';
    const directLockDir = `${directProject}/.ok/local`;
    const childProject = `${parent}/garth_nix`;
    const childLockDir = `${childProject}/.ok/local`;

    spawnSyncSpy
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout:
            '11 /usr/local/bin/ok start\n' +
            '22 /Applications/OpenKnowledge.app/Contents/Frameworks/OpenKnowledge Helper.app/Contents/MacOS/OpenKnowledge Helper --type=utility --utility-sub-type=node.mojom.NodeService\n',
          status: 0,
        }),
      )
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout: `p11\nfcwd\nn${directProject}\np22\nfcwd\nn/\n`,
          status: 0,
        }),
      )
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'COMMAND PID USER\n', status: 0 }));
    existsSyncSpy.mockImplementation(
      (p: unknown) =>
        p === directLockDir ||
        p === `${directLockDir}/server.lock` ||
        p === childLockDir ||
        p === `${childLockDir}/server.lock`,
    );
    readdirSyncSpy.mockImplementation((p: unknown) => {
      if (p === parent) return ['garth_nix'] as unknown as ReturnType<typeof realFs.readdirSync>;
      return [] as unknown as ReturnType<typeof realFs.readdirSync>;
    });
    lstatSyncSpy.mockImplementation(
      () => ({ isDirectory: () => true }) as unknown as ReturnType<typeof realFs.lstatSync>,
    );

    try {
      cwdSpy.mockReturnValue(parent);
      const dirs = await discoverLockDirs();
      expect(dirs).toEqual(expect.arrayContaining([directLockDir, childLockDir]));
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('degrades gracefully when lsof is unavailable for working-directory and listener reads', async () => {
    const enoent = Object.assign(new Error('lsof not found'), { code: 'ENOENT' });
    const cwdSpy = vi.spyOn(process, 'cwd');

    spawnSyncSpy
      .mockImplementation(() => makeSpawnResult({ error: enoent as NodeJS.ErrnoException }))
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout: '55 /usr/local/bin/ok start\n',
          status: 0,
        }),
      );

    existsSyncSpy.mockImplementation(realFs.existsSync);

    try {
      cwdSpy.mockReturnValue('/nonexistent-open-knowledge-test-root');
      const dirs = await discoverLockDirs();
      expect(dirs).toHaveLength(0);
    } finally {
      cwdSpy.mockRestore();
    }
  });
});

describe('lock recovery process evidence', () => {
  let stderrWrites: string[];
  beforeEach(() => {
    spawnSyncMock.mockReset();
    execFileSyncMock.mockReset().mockImplementation(realCp.execFileSync);
    stderrWrites = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    spawnSyncMock.mockReset();
    execFileSyncMock.mockReset().mockImplementation(realCp.execFileSync);
  });

  it('does not mistake failed process enumeration for evidence of absence', async () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult({ status: 2, stderr: 'permission denied' }));
    const scan = await scanLockProcesses();
    expect(scan.candidates).toEqual([]);
    expect(scan.unavailable).toEqual(['Could not enumerate processes with pgrep or ps']);
  });
  it('accepts a successful empty process and listener scan', async () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult({ status: 1 }));
    expect(await scanLockProcesses()).toEqual({ candidates: [], unavailable: [] });
  });
  it('retains listener inspection failures', async () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult({ status: 1 }))
      .mockReturnValueOnce(makeSpawnResult({ status: 1, stderr: 'permission denied' }));
    expect((await scanLockProcesses()).unavailable).toEqual([
      'Could not enumerate TCP listeners with lsof',
    ]);
  });
  it('treats a listener query that exits non-zero with a table as incomplete enumeration', async () => {
    spawnSyncMock.mockReturnValueOnce(makeSpawnResult({ status: 1 })).mockReturnValueOnce(
      makeSpawnResult({
        status: 1,
        stdout: `COMMAND PID USER\nnode ${process.pid} user\n`,
      }),
    );
    expect((await scanLockProcesses()).unavailable).toEqual([
      'Could not enumerate TCP listeners with lsof',
    ]);
  });
  it('keeps explicit process provenance even without a lock file on disk', async () => {
    const lockDir = '/missing/project/.ok/local';
    spawnSyncMock
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout: `${process.pid} node --ok-lock-dir-b64=${Buffer.from(lockDir).toString('base64url')}\n`,
        }),
      )
      .mockReturnValueOnce(makeSpawnResult({ status: 1 }));
    expect(await scanLockProcesses()).toEqual({
      candidates: [{ lockDir, pid: process.pid, source: 'lock-dir-argument' }],
      unavailable: [],
    });
  });
  it('recognizes the production server process title and its working directory', async () => {
    spawnSyncMock
      .mockReturnValueOnce(
        makeSpawnResult({ stdout: `${process.pid} open-knowledge-server notes\n` }),
      )
      .mockReturnValueOnce(makeSpawnResult({ status: 1 }))
      .mockReturnValueOnce(makeSpawnResult({ stdout: `p${process.pid}\nfcwd\nn/notes\n` }));
    expect((await scanLockProcesses()).candidates).toContainEqual({
      lockDir: '/notes/.ok/local',
      pid: process.pid,
      source: 'process-cwd',
    });
  });
  it('retains a live candidate with an unreadable working directory as uncertainty', async () => {
    spawnSyncMock
      .mockReturnValueOnce(
        makeSpawnResult({ stdout: `${process.pid} open-knowledge-server notes\n` }),
      )
      .mockReturnValueOnce(makeSpawnResult({ status: 1 }))
      .mockReturnValueOnce(makeSpawnResult({ status: 1 }));
    expect((await scanLockProcesses()).unavailable).toEqual([
      `Could not read the working directory of process ${process.pid}`,
    ]);
  });

  it('retains a live candidate whose process-state probe could not answer', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync ps ENOENT'), { code: 'ENOENT' });
    });
    spawnSyncMock
      .mockReturnValueOnce(
        makeSpawnResult({ stdout: `${process.pid} open-knowledge-server notes\n` }),
      )
      .mockReturnValueOnce(makeSpawnResult({ status: 1 }))
      .mockReturnValueOnce(makeSpawnResult({ status: 1 }));

    const scan = await scanLockProcesses();

    const stateProbes = execFileSyncMock.mock.calls.filter((call) =>
      (call[1] as string[] | undefined)?.includes(String(process.pid)),
    );
    expect(stateProbes).toHaveLength(1);
    expect(scan.unavailable).toEqual([
      `Could not read the working directory of process ${process.pid}`,
    ]);
    expect(stderrWrites.join('')).toContain(
      `could not read the state of process ${process.pid} (ENOENT)`,
    );
  });
  it('reports a process-state probe that ran and could not answer', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed: ps'), {
        status: 1,
        stderr: 'ps: nosuchcol: keyword not found\nps: no valid keywords\n',
      });
    });
    spawnSyncMock
      .mockReturnValueOnce(
        makeSpawnResult({ stdout: `${process.pid} open-knowledge-server notes\n` }),
      )
      .mockReturnValueOnce(makeSpawnResult({ status: 1 }))
      .mockReturnValueOnce(makeSpawnResult({ status: 1 }));

    const scan = await scanLockProcesses();

    expect(scan.unavailable).toEqual([
      `Could not read the working directory of process ${process.pid}`,
    ]);
    expect(stderrWrites.join('')).toContain(
      `could not read the state of process ${process.pid} (ps: nosuchcol: keyword not found)`,
    );
  });

  it('reports a probe failure whose reason follows a blank stderr line', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed: ps'), {
        status: 1,
        stderr: '\nps: nosuchcol: keyword not found\nps: no valid keywords\n',
      });
    });
    spawnSyncMock
      .mockReturnValueOnce(
        makeSpawnResult({ stdout: `${process.pid} open-knowledge-server notes\n` }),
      )
      .mockReturnValueOnce(makeSpawnResult({ status: 1 }))
      .mockReturnValueOnce(makeSpawnResult({ status: 1 }));

    const scan = await scanLockProcesses();

    expect(scan.unavailable).toEqual([
      `Could not read the working directory of process ${process.pid}`,
    ]);
    expect(stderrWrites.join('')).toContain(
      `could not read the state of process ${process.pid} (ps: nosuchcol: keyword not found)`,
    );
  });

  it('renders a multi-line probe failure as one diagnostic line', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed: ps'), {
        status: 1,
        stderr: 'error: unknown user-defined format specifier "bogus"\n\nUsage:\n ps [options]\n',
      });
    });
    spawnSyncMock
      .mockReturnValueOnce(
        makeSpawnResult({ stdout: `${process.pid} open-knowledge-server notes\n` }),
      )
      .mockReturnValueOnce(makeSpawnResult({ status: 1 }))
      .mockReturnValueOnce(makeSpawnResult({ status: 1 }));

    await scanLockProcesses();

    const written = stderrWrites.join('');
    expect(written).toContain(
      `could not read the state of process ${process.pid} (error: unknown user-defined format specifier "bogus")`,
    );
    expect(written.trimEnd().split('\n')).toHaveLength(1);
  });

  it('keeps no uncertainty and stays silent when the process-state probe finds the pid already gone', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed: ps'), { status: 1, stderr: '' });
    });
    spawnSyncMock
      .mockReturnValueOnce(
        makeSpawnResult({ stdout: `${process.pid} open-knowledge-server notes\n` }),
      )
      .mockReturnValueOnce(makeSpawnResult({ status: 1 }))
      .mockReturnValueOnce(makeSpawnResult({ status: 1 }));

    const scan = await scanLockProcesses();

    const stateProbes = execFileSyncMock.mock.calls.filter((call) =>
      (call[1] as string[] | undefined)?.includes(String(process.pid)),
    );
    expect(stateProbes).toHaveLength(1);
    expect(scan.unavailable).toEqual([]);
    expect(stderrWrites.join('')).toBe('');
  });

  it('warns once per process when one scan probes the same pid twice', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync ps ENOENT'), { code: 'ENOENT' });
    });
    spawnSyncMock
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout: `${process.pid} open-knowledge-server notes\n${process.pid} node cli.mjs --ok-project-path=/notes\n`,
        }),
      )
      .mockReturnValueOnce(makeSpawnResult({ status: 1 }))
      .mockReturnValueOnce(makeSpawnResult({ status: 1 }));

    await scanLockProcesses();

    const stateProbes = execFileSyncMock.mock.calls.filter((call) =>
      (call[1] as string[] | undefined)?.includes(String(process.pid)),
    );
    expect(stateProbes).toHaveLength(2);
    const warnings = stderrWrites
      .join('')
      .split('\n')
      .filter((line) => line.includes(`could not read the state of process ${process.pid}`));
    expect(warnings).toHaveLength(1);
  });

  it('retains a live candidate the batched query could not answer for', async () => {
    spawnSyncMock
      .mockReturnValueOnce(
        makeSpawnResult({ stdout: `${process.pid} open-knowledge-server notes\n` }),
      )
      .mockReturnValueOnce(makeSpawnResult({ status: 1 }))
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'p1\nfcwd\nn/other\n', status: 0 }));
    expect((await scanLockProcesses()).unavailable).toEqual([
      `Could not read the working directory of process ${process.pid}`,
    ]);
  });
  it('reads every candidate working directory in one lsof query, not one per process', async () => {
    const pids = [process.pid, process.pid + 1, process.pid + 2, process.pid + 3];
    spawnSyncMock
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout: pids.map((pid) => `${pid} open-knowledge-server notes`).join('\n'),
        }),
      )
      .mockReturnValueOnce(makeSpawnResult({ status: 1 }))
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout: pids.map((pid) => `p${pid}\nfcwd\nn/notes-${pid}`).join('\n'),
        }),
      );
    const scan = await scanLockProcesses();
    const cwdQueries = spawnSyncMock.mock.calls.filter(
      (call) => call[0] === 'lsof' && (call[1] as string[]).includes('cwd'),
    );
    expect(cwdQueries).toHaveLength(1);
    expect(cwdQueries[0]?.[1]).toContain(pids.join(','));
    for (const pid of pids) {
      expect(scan.candidates).toContainEqual({
        lockDir: `/notes-${pid}/.ok/local`,
        pid,
        source: 'process-cwd',
      });
    }
  });
  it('keeps listener provenance without asserting the process is an OpenKnowledge server', async () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult({ status: 1 }))
      .mockReturnValueOnce(
        makeSpawnResult({ stdout: `COMMAND PID USER\nnode ${process.pid} user\n` }),
      )
      .mockReturnValueOnce(makeSpawnResult({ stdout: `p${process.pid}\nfcwd\nn/notes\n` }));
    expect((await scanLockProcesses()).candidates).toContainEqual({
      lockDir: '/notes/.ok/local',
      pid: process.pid,
      source: 'listener-cwd',
    });
  });
});

describe('isDefunctProcess', () => {
  const realPlatform = process.platform;
  let stderrWrites: string[];
  beforeEach(() => {
    execFileSyncMock.mockReset();
    stderrWrites = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    vi.restoreAllMocks();
    execFileSyncMock.mockReset().mockImplementation(realCp.execFileSync);
  });

  it('skips the probe entirely on an unsupported platform', () => {
    execFileSyncMock.mockReturnValue('SN  \n');
    expect(isDefunctProcess(4242)).toBe(false);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(isDefunctProcess(4242)).toBe(false);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });
  it('reads a zombie state as defunct', () => {
    execFileSyncMock.mockReturnValue('Z+  \n');
    expect(isDefunctProcess(4242)).toBe(true);
  });
  it('reads any other state as not defunct', () => {
    execFileSyncMock.mockReturnValue('SN  \n');
    expect(isDefunctProcess(4242)).toBe(false);
  });
  it('reads a ps-confirmed absence as not defunct without reporting', () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed: ps'), { status: 1, stderr: '' });
    });
    expect(isDefunctProcess(4242)).toBe(false);
    expect(stderrWrites.join('')).toBe('');
  });
  it('reads a probe that could not run as not defunct and reports why', () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync ps ENOENT'), { code: 'ENOENT' });
    });
    expect(isDefunctProcess(4242)).toBe(false);
    expect(stderrWrites.join('')).toContain('could not read the state of process 4242 (ENOENT)');
  });
});

describe('readProcessState', () => {
  const realPlatform = process.platform;
  let stderrWrites: string[];
  beforeEach(() => {
    execFileSyncMock.mockReset();
    stderrWrites = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    vi.restoreAllMocks();
    execFileSyncMock.mockReset().mockImplementation(realCp.execFileSync);
  });

  it('tells a confirmed absence apart from a confirmed live process', () => {
    execFileSyncMock.mockReturnValue('SN  \n');
    expect(readProcessState(4242)).toEqual({ status: 'running' });
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed: ps'), { status: 1, stderr: '' });
    });
    expect(readProcessState(4242)).toEqual({ status: 'gone' });
  });
  it('tells a zombie apart from a probe that could not answer', () => {
    execFileSyncMock.mockReturnValue('Z+  \n');
    expect(readProcessState(4242)).toEqual({ status: 'defunct' });
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync ps ENOENT'), { code: 'ENOENT' });
    });
    expect(readProcessState(4242)).toEqual({ status: 'unreadable', reason: 'ENOENT' });
  });
  it('reports an unsupported platform as unreadable without probing or writing', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(readProcessState(4242)).toEqual({
      status: 'unreadable',
      reason: 'no process-state query on win32',
    });
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(stderrWrites.join('')).toBe('');
  });
});

describe('isLockProcessRunning', () => {
  const realPlatform = process.platform;
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    vi.restoreAllMocks();
    execFileSyncMock.mockReset().mockImplementation(realCp.execFileSync);
  });

  it('lets a probe-confirmed absence override a process that was alive a moment earlier', () => {
    execFileSyncMock.mockReturnValue('SN  \n');
    expect(isLockProcessRunning(process.pid)).toBe(true);
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed: ps'), { status: 1, stderr: '' });
    });
    expect(isLockProcessRunning(process.pid)).toBe(false);
  });
  it('keeps a live process running when the probe could not answer', () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync ps ENOENT'), { code: 'ENOENT' });
    });
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(isLockProcessRunning(process.pid)).toBe(true);
  });
  it('keeps a foreign-owned process running when the probe cannot see it', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    });
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed: ps'), { status: 1, stderr: '' });
    });
    expect(isLockProcessRunning(4242)).toBe(true);
  });
});
