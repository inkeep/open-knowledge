import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import type { SpawnSyncReturns } from 'node:child_process';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import { discoverLockDirs, findOkProcessPids, pidCwd } from './process-scan.ts';

// Helpers to build a minimal SpawnSyncReturns-shaped object
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
  let spawnSyncSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSyncSpy = spyOn(cp, 'spawnSync');
  });

  afterEach(() => {
    spawnSyncSpy.mockRestore();
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
    // Confirms pgrep was called (not ps)
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
    // A user mid-migration may have an OLD build running. The `Open ?Knowledge`
    // matcher must keep finding its spaced bundle name so `ok ps`/`ok stop` work
    // across the rename. With no lock-dir marker, only the bundle-name pattern
    // can match — so this exercises the backward-compat `?` quantifier directly.
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
      // First call: pgrep — fails with ENOENT
      .mockReturnValueOnce(makeSpawnResult({ error: enoent as NodeJS.ErrnoException }))
      // Second call: ps — succeeds
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
    // Only one spawn call — no ps fallback
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
    // 222 matches "ok start", 333 matches bun + packages/app
    expect(pids).toContain(222);
    expect(pids).toContain(333);
    // 111 is a ruby script — no ok patterns
    expect(pids).not.toContain(111);
  });
});

describe('pidCwd', () => {
  let spawnSyncSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSyncSpy = spyOn(cp, 'spawnSync');
  });

  afterEach(() => {
    spawnSyncSpy.mockRestore();
  });

  it('returns the CWD from lsof -Fn output', async () => {
    spawnSyncSpy.mockReturnValue(
      makeSpawnResult({
        stdout: 'p12345\nfcwd\nn/Users/mike/my-notes\n',
        status: 0,
      }),
    );

    const cwd = await pidCwd(12345);
    expect(cwd).toBe('/Users/mike/my-notes');
  });

  it('returns null when lsof is unavailable (ENOENT) — no crash', async () => {
    const enoent = Object.assign(new Error('lsof not found'), { code: 'ENOENT' });
    spawnSyncSpy.mockReturnValue(makeSpawnResult({ error: enoent as NodeJS.ErrnoException }));

    const cwd = await pidCwd(12345);
    expect(cwd).toBeNull();
  });

  it('returns null when lsof output has no cwd line', async () => {
    spawnSyncSpy.mockReturnValue(makeSpawnResult({ stdout: 'p12345\n', status: 0 }));

    const cwd = await pidCwd(12345);
    expect(cwd).toBeNull();
  });

  it('returns null on timeout (error but not ENOENT)', async () => {
    const timeoutErr = Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
    spawnSyncSpy.mockReturnValue(makeSpawnResult({ error: timeoutErr as NodeJS.ErrnoException }));

    const cwd = await pidCwd(99999);
    expect(cwd).toBeNull();
  });
});

describe('discoverLockDirs', () => {
  let spawnSyncSpy: ReturnType<typeof spyOn>;
  let existsSyncSpy: ReturnType<typeof spyOn>;
  let readdirSyncSpy: ReturnType<typeof spyOn>;
  let lstatSyncSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSyncSpy = spyOn(cp, 'spawnSync');
    existsSyncSpy = spyOn(fs, 'existsSync');
    readdirSyncSpy = spyOn(fs, 'readdirSync');
    lstatSyncSpy = spyOn(fs, 'lstatSync');
    readdirSyncSpy.mockImplementation(() => [] as unknown as ReturnType<typeof fs.readdirSync>);
  });

  afterEach(() => {
    spawnSyncSpy.mockRestore();
    existsSyncSpy.mockRestore();
    readdirSyncSpy.mockRestore();
    lstatSyncSpy.mockRestore();
  });

  it('returns deduped lock dirs when multiple discovery routes find the same path', async () => {
    spawnSyncSpy
      // pgrep finds PID 111 — command comes from pgrep output, no separate processCommand call
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout: '111 /usr/local/bin/bun /path/packages/cli/dist/cli.mjs start\n',
          status: 0,
        }),
      )
      // pidCwd for PID 111
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout: 'p111\nfcwd\nn/Users/mike/notes\n',
          status: 0,
        }),
      )
      // lsof -iTCP port scan also returns PID 111 (same process, different route)
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout: 'COMMAND  PID USER   FD   TYPE\nbun      111 mike  ...\n',
          status: 0,
        }),
      );
    // Note: PID 111 is in okEntries so lsof port scan skips it (already known)

    // .ok/local/ dir and server lock exist for /Users/mike/notes
    existsSyncSpy.mockImplementation(
      (p: unknown) =>
        p === '/Users/mike/notes/.ok/local' || p === '/Users/mike/notes/.ok/local/server.lock',
    );

    const dirs = await discoverLockDirs();
    expect(dirs).toHaveLength(1);
    // The result may be the realpath-resolved form of the path
    expect(dirs[0]).toContain('.ok/local');

    const calls = spawnSyncSpy.mock.calls as [string, string[]][];
    expect(calls[0]?.[0]).toBe('pgrep');
    expect(calls[1]?.[0]).toBe('lsof'); // pidCwd
    expect(calls[2]?.[0]).toBe('lsof'); // port scan
  });

  it('returns empty array when no ok processes and no lock dirs exist', async () => {
    // pgrep returns nothing
    spawnSyncSpy
      .mockReturnValueOnce(makeSpawnResult({ stdout: '', status: 1 }))
      // port scan also returns nothing
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'COMMAND PID USER\n', status: 0 }));

    existsSyncSpy.mockReturnValue(false);

    const dirs = await discoverLockDirs();
    expect(dirs).toHaveLength(0);
  });

  it('discovers Electron utility lock dirs from the explicit argv marker', async () => {
    const lockDir = '/Users/mike/notes with spaces/.ok/local';
    const encoded = Buffer.from(lockDir, 'utf8').toString('base64url');
    // Command string comes from pgrep output — no separate processCommand spawn needed.
    spawnSyncSpy
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout: `77 /Applications/OpenKnowledge.app/Contents/Frameworks/OpenKnowledge Helper --type=utility --ok-lock-dir-b64=${encoded}\n`,
          status: 0,
        }),
      )
      // pidCwd for PID 77 (Electron utility cwd is inside the app bundle, not the project)
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout: 'p77\nfcwd\nn/Applications/OpenKnowledge.app/Contents/Resources\n',
          status: 0,
        }),
      )
      // lsof -iTCP port scan
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'COMMAND PID USER\n', status: 0 }));

    existsSyncSpy.mockImplementation((p: unknown) => p === lockDir);

    const dirs = await discoverLockDirs();
    expect(dirs).toEqual([lockDir]);

    const calls = spawnSyncSpy.mock.calls as [string, string[]][];
    expect(calls[0]?.[0]).toBe('pgrep');
    expect(calls[1]?.[0]).toBe('lsof'); // pidCwd
    expect(calls[2]?.[0]).toBe('lsof'); // port scan
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

  it('discovers cwd-derived lock dirs when only ui.lock is present', async () => {
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
    expect(dirs).toEqual([lockDir]);
  });

  it('ignores Electron marker with empty payload', async () => {
    // --ok-lock-dir-b64= with nothing after the = should not add any candidate
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
    // base64url of a relative path — isAbsolute guard must reject it
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
    const cwdSpy = spyOn(process, 'cwd');
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
      if (p === parent) return ['garth_nix'] as unknown as ReturnType<typeof fs.readdirSync>;
      return [] as unknown as ReturnType<typeof fs.readdirSync>;
    });
    lstatSyncSpy.mockImplementation(
      () => ({ isDirectory: () => true }) as unknown as ReturnType<typeof fs.lstatSync>,
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
    const cwdSpy = spyOn(process, 'cwd');
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
      .mockReturnValueOnce(makeSpawnResult({ stdout: `p11\nfcwd\nn${directProject}\n`, status: 0 }))
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'p22\nfcwd\nn/\n', status: 0 }))
      .mockReturnValueOnce(makeSpawnResult({ stdout: 'COMMAND PID USER\n', status: 0 }));
    existsSyncSpy.mockImplementation(
      (p: unknown) =>
        p === directLockDir ||
        p === `${directLockDir}/server.lock` ||
        p === childLockDir ||
        p === `${childLockDir}/server.lock`,
    );
    readdirSyncSpy.mockImplementation((p: unknown) => {
      if (p === parent) return ['garth_nix'] as unknown as ReturnType<typeof fs.readdirSync>;
      return [] as unknown as ReturnType<typeof fs.readdirSync>;
    });
    lstatSyncSpy.mockImplementation(
      () => ({ isDirectory: () => true }) as unknown as ReturnType<typeof fs.lstatSync>,
    );

    try {
      cwdSpy.mockReturnValue(parent);
      const dirs = await discoverLockDirs();
      expect(dirs).toEqual(expect.arrayContaining([directLockDir, childLockDir]));
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('degrades gracefully when lsof is unavailable for pidCwd calls', async () => {
    const enoent = Object.assign(new Error('lsof not found'), { code: 'ENOENT' });

    spawnSyncSpy
      // pgrep finds PID 55 — command included in output
      .mockReturnValueOnce(
        makeSpawnResult({
          stdout: '55 /usr/local/bin/ok start\n',
          status: 0,
        }),
      )
      // pidCwd for PID 55 — lsof unavailable
      .mockReturnValueOnce(makeSpawnResult({ error: enoent as NodeJS.ErrnoException }))
      // port scan lsof — also unavailable
      .mockReturnValueOnce(makeSpawnResult({ error: enoent as NodeJS.ErrnoException }));

    existsSyncSpy.mockReturnValue(false);

    // Should not throw, should return empty
    const dirs = await discoverLockDirs();
    expect(dirs).toHaveLength(0);
  });
});
