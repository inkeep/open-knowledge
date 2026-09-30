import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSync, spawn, execFileSync } = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawnSync, spawn, execFileSync }));

import { fakeChildProcess } from './process-scan.test-helper.ts';
import { findOkProcessPids, scanLockProcesses } from './process-scan.ts';

const originalPlatform = process.platform;
const fixturePid = 24680;
const lockDir = resolve('/missing/notes-é/.ok/local');
const command = `node --ok-lock-dir-b64=${Buffer.from(lockDir).toString('base64url')}`;
const row = `${fixturePid} ${command}`;
const enobufs = Object.assign(new Error('output exceeds the buffered reader'), { code: 'ENOBUFS' });
const unavailable = Object.assign(new Error('command not found'), { code: 'ENOENT' });

function providePsStream(read: (args: string[]) => ReturnType<typeof fakeChildProcess>) {
  spawn.mockImplementation((program: string, args: string[]) =>
    program === 'lsof' ? fakeChildProcess({ stdout: [], status: 1 }) : read(args),
  );
}

function providePsOutput(chunks: readonly (string | Buffer)[], code: number | null = 0) {
  const stdout = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  const readSync = (program: string) => {
    if (program === 'ps') return { status: code, stdout };
    if (program === 'lsof') return { status: 1, stdout: '', stderr: '' };
    return { status: null, error: unavailable };
  };
  spawnSync.mockImplementation(readSync);
  providePsStream(() => fakeChildProcess({ stdout: chunks, status: code }));
  return readSync;
}

beforeEach(() => {
  spawn.mockReset().mockImplementation((program: string) => {
    if (program === 'lsof') return fakeChildProcess({ stdout: [], status: 1 });
    throw new Error('unexpected process enumeration');
  });
  spawnSync.mockReset().mockImplementation((program: string) => {
    if (program === 'lsof') return { status: 1, stdout: '', stderr: '' };
    return { status: null, error: unavailable };
  });
  execFileSync.mockReset().mockReturnValue('S\n');
  vi.spyOn(process, 'kill').mockReturnValue(true);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.restoreAllMocks();
});

describe('process enumeration', () => {
  it.each(['darwin', 'linux'] as const)('discovers matching commands on %s', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    const readSync = providePsOutput(['PID COMMAND\n', `${row}\n`]);
    spawnSync.mockImplementation((program: string, args: string[]) => {
      if (program !== 'pgrep') return readSync(program);
      const fullCommand =
        args.includes('-f') &&
        args.includes('-a') &&
        (platform !== 'darwin' || args.includes('-l'));
      return { status: 0, stdout: fullCommand ? `${row}\n` : `${fixturePid}\n` };
    });

    expect(await findOkProcessPids()).toEqual([fixturePid]);
  });

  it.each(['missing pgrep', 'PID-only pgrep', 'buffered pgrep overflow'])(
    'discovers marked processes after an oversized listing with %s',
    async (mode) => {
      const unrelated = ' 12345 /usr/bin/unrelated-service\n';
      const nodeDefaultMaxBuffer = 1024 * 1024;
      const repeats = Math.ceil(nodeDefaultMaxBuffer / Buffer.byteLength(unrelated));
      spawnSync.mockImplementation((program: string) => {
        if (program === 'pgrep') {
          if (mode === 'PID-only pgrep') return { status: 0, stdout: `${fixturePid}\n` };
          return { status: null, error: mode === 'missing pgrep' ? unavailable : enobufs };
        }
        if (program === 'ps')
          return { status: 0, error: enobufs, stdout: unrelated.repeat(repeats) };
        return { status: 1, stdout: '', stderr: '' };
      });
      providePsStream(() =>
        fakeChildProcess({
          stdout: (function* () {
            yield 'PID COMMAND\n';
            for (let index = 0; index < repeats; index++) yield unrelated;
            yield row;
          })(),
        }),
      );

      expect(await scanLockProcesses()).toEqual({
        candidates: [{ lockDir, pid: fixturePid, source: 'lock-dir-argument' }],
        unavailable: [],
      });
    },
  );

  it('retains project paths split across byte chunks and an unterminated final row', async () => {
    const project = resolve('/missing/notes-é');
    const output = Buffer.from(
      `PID COMMAND\n12345 /usr/bin/unrelated-service\n${fixturePid} node --ok-project-path=${project}`,
    );
    providePsOutput(Array.from(output, (byte) => Buffer.from([byte])));

    expect(await scanLockProcesses()).toEqual({
      candidates: [
        { lockDir: join(project, '.ok', 'local'), pid: fixturePid, source: 'project-argument' },
        { lockDir: join(project, '.ok'), pid: fixturePid, source: 'project-argument' },
      ],
      unavailable: [],
    });
  });

  it('keeps carriage returns inside a process command', async () => {
    providePsOutput(['PID COMMAND\n12345 unrelated\r97531 open-knowledge-server notes\n', row]);

    expect(await scanLockProcesses()).toEqual({
      candidates: [{ lockDir, pid: fixturePid, source: 'lock-dir-argument' }],
      unavailable: [],
    });
  });

  it.each([1, null])('discards an incomplete listing with exit status %s', async (code) => {
    providePsOutput(['PID COMMAND\n', row], code);

    expect(await scanLockProcesses()).toEqual({
      candidates: [],
      unavailable: [expect.stringContaining('Could not enumerate processes')],
    });
    expect(await findOkProcessPids()).toEqual([]);
  });

  it('keeps multiline command text within its owning process', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const readSync = providePsOutput([
      'PID COMMAND\n',
      '13579 unrelated\\01297531 open-knowledge-server notes\n',
      `${row}\n`,
    ]);
    spawnSync.mockImplementation((program: string, args: string[]) => {
      if (program !== 'pgrep') return readSync(program);
      return {
        status: 0,
        stdout: args.includes('-l')
          ? `13579 unrelated\n97531 open-knowledge-server notes\n${row}\n`
          : `13579\n${fixturePid}\n`,
      };
    });

    expect(await scanLockProcesses()).toEqual({
      candidates: [{ lockDir, pid: fixturePid, source: 'lock-dir-argument' }],
      unavailable: [],
    });
  });

  it('discovers accepted dev commands alongside a matching server on Linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const project = resolve('/missing/dev-project');
    const devPid = 13579;
    const readSync = providePsOutput([
      'PID COMMAND\n',
      `${row}\n`,
      `${devPid} /usr/local/bin/bun run dev\n`,
    ]);
    spawnSync.mockImplementation((program: string, args: string[]) => {
      if (program === 'pgrep') return { status: 0, stdout: `${row}\n` };
      if (program === 'lsof' && args.includes('cwd'))
        return { status: 0, stdout: `p${devPid}\nn${project}\n` };
      return readSync(program);
    });

    expect(await scanLockProcesses()).toEqual({
      candidates: [
        { lockDir, pid: fixturePid, source: 'lock-dir-argument' },
        { lockDir: join(project, '.ok', 'local'), pid: devPid, source: 'process-cwd' },
        { lockDir: join(project, '.ok'), pid: devPid, source: 'process-cwd' },
      ],
      unavailable: [],
    });
  });

  it('retains trailing command arguments under a narrow Linux display width', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const narrow = `PID COMMAND\n${fixturePid} /usr/local/node`;
    const complete = `PID COMMAND\n${row}`;
    const outputFor = (args: string[]) =>
      args.includes('-ww') || args.filter((arg) => arg === '-w').length === 2 ? complete : narrow;
    providePsStream((args) => fakeChildProcess({ stdout: [outputFor(args)] }));
    spawnSync.mockImplementation((program: string, args: string[]) => {
      if (program === 'ps') return { status: 0, stdout: outputFor(args) };
      if (program === 'lsof') return { status: 1, stdout: '', stderr: '' };
      return { status: null, error: unavailable };
    });

    expect(await scanLockProcesses()).toEqual({
      candidates: [{ lockDir, pid: fixturePid, source: 'lock-dir-argument' }],
      unavailable: [],
    });
  });

  it('retains existing candidate discovery with Windows Unix tools', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    spawnSync.mockImplementation((program: string) => {
      if (program === 'pgrep') return { status: 0, stdout: `${row}\n` };
      if (program === 'lsof') return { status: 1, stdout: '', stderr: '' };
      return { status: null, error: unavailable };
    });

    expect(await scanLockProcesses(() => ({ onProbeFailure: () => {} }))).toEqual({
      candidates: [{ lockDir, pid: fixturePid, source: 'lock-dir-argument' }],
      unavailable: [],
    });
  });

  it('reports a listing read failure even after receiving a matching row', async () => {
    const readError = Object.assign(new Error('could not read output'), { code: 'EIO' });
    spawnSync.mockImplementation((program: string) => {
      if (program === 'ps') return { status: 0, stdout: `PID COMMAND\n${row}`, error: readError };
      return { status: null, error: unavailable };
    });
    providePsStream(() =>
      fakeChildProcess({
        stdout: (async function* () {
          yield `PID COMMAND\n${row}\n`;
          throw readError;
        })(),
      }),
    );

    expect(await scanLockProcesses()).toEqual({
      candidates: [],
      unavailable: [expect.stringContaining('Could not enumerate processes')],
    });
  });

  it('reports an empty response as unavailable', async () => {
    providePsOutput([]);

    expect(await scanLockProcesses()).toEqual({
      candidates: [],
      unavailable: [expect.stringContaining('Could not enumerate processes')],
    });
  });

  it('accepts a complete listing without matching processes', async () => {
    providePsOutput(['PID COMMAND\n12345 /usr/bin/unrelated-service\n']);

    expect(await scanLockProcesses()).toEqual({ candidates: [], unavailable: [] });
  });

  it.each(['darwin', 'linux', 'win32'] as const)(
    'reports a process listing that cannot start on %s',
    async (platform) => {
      Object.defineProperty(process, 'platform', { value: platform });
      providePsStream(() => fakeChildProcess({ stdout: [], status: null, error: unavailable }));

      expect(await scanLockProcesses()).toEqual({
        candidates: [],
        unavailable: [expect.stringContaining('Could not enumerate processes')],
      });
    },
  );
});
