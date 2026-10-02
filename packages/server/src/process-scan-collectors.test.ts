import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSync, spawn, execFileSync } = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawnSync, spawn, execFileSync }));

import {
  fakeChildProcess,
  type FakeChildProcessInput as Output,
} from './process-scan.test-helper.ts';
import { discoverLockDirs, findOkProcessPids, scanLockProcesses } from './process-scan.ts';

const originalPlatform = process.platform;
const fixturePid = 24680;
const listenerHeader = 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n';
const nodeDefaultMaxBuffer = 1024 * 1024;
let directory: string;
let project: string;
let lockDir: string;

function provideOutput(read: (program: string, args: string[]) => Output) {
  spawn.mockImplementation((program: string, args: string[]) =>
    fakeChildProcess(read(program, args)),
  );
  spawnSync.mockImplementation((program: string, args: string[]) => {
    const result = read(program, args);
    let stdout = '';
    let bytes = 0;
    for (const chunk of result.stdout as Iterable<string | Buffer>) {
      stdout += chunk.toString();
      bytes += Buffer.byteLength(chunk);
      if (bytes > nodeDefaultMaxBuffer) {
        return {
          stdout,
          stderr: '',
          status: null,
          error: Object.assign(new Error('spawnSync output exceeds buffer'), { code: 'ENOBUFS' }),
        };
      }
    }
    return {
      ...result,
      stdout,
      stderr: result.stderr ?? '',
      status: result.status === undefined ? 0 : result.status,
    };
  });
}

function emptyOutput(program: string): Output {
  if (program === 'ps') return { stdout: ['PID COMMAND\n'] };
  if (program === 'lsof' || program === 'pgrep') return { stdout: [], status: 1 };
  throw new Error(`Unexpected subprocess: ${program}`);
}

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'ok-process-collectors-')));
  project = join(directory, 'project');
  lockDir = join(project, '.ok', 'local');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'server.lock'), '{}');
  const caller = join(directory, 'caller');
  mkdirSync(caller);
  vi.spyOn(process, 'cwd').mockReturnValue(caller);
  vi.spyOn(process, 'kill').mockReturnValue(true);
  Object.defineProperty(process, 'platform', { value: 'linux' });
  spawn.mockReset();
  spawnSync.mockReset();
  execFileSync.mockReset().mockReturnValue('S\n');
  provideOutput(emptyOutput);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe('process listing producers', () => {
  it.each(['Toybox', 'procps'])('discovers marked processes with %s ps', async (producer) => {
    const command = `node --ok-lock-dir-b64=${Buffer.from(lockDir).toString('base64url')}`;
    provideOutput((program, args) => {
      if (program === 'pgrep') return { stdout: [`${fixturePid} ${command}\n`] };
      if (program !== 'ps') return emptyOutput(program);
      if (producer === 'Toybox' && args.some((arg) => arg.startsWith('-') && arg.includes('x')))
        return { stdout: [], status: 1, stderr: "ps: Unknown option 'xo' (see 'ps --help')\n" };
      const format = args[args.indexOf('-o') + 1] ?? '';
      if (producer === 'procps' && format.includes('cmdline'))
        return {
          stdout: [],
          status: 1,
          stderr: 'error: unknown user-defined format specifier "cmdline"\n',
        };
      const fullCommand =
        producer === 'procps' || format.includes('args') || format.includes('cmdline');
      const control =
        producer === 'Toybox' && format.includes('args')
          ? 'open-knowledge-server --fixture-control=notes'
          : '/opt/open-knowledge-server --fixture-control=notes';
      return {
        stdout: [
          'PID COMMAND\n',
          `13579 ${control}\n`,
          `${fixturePid} ${fullCommand ? command : 'node'}\n`,
        ],
      };
    });

    expect(await scanLockProcesses()).toEqual({
      candidates: [{ lockDir, pid: fixturePid, source: 'lock-dir-argument' }],
      unavailable: [],
    });
  });

  it('retains trailing command arguments with procps ps under a narrow display width', async () => {
    const displayWidth = 20;
    const row = `${fixturePid} node /srv/fixture.cjs --ok-lock-dir-b64=${Buffer.from(lockDir).toString('base64url')}`;
    provideOutput((program, args) => {
      if (program !== 'ps') return emptyOutput(program);
      const format = args[args.indexOf('-o') + 1] ?? '';
      if (format.includes('cmdline'))
        return {
          stdout: [],
          status: 1,
          stderr: 'error: unknown user-defined format specifier "cmdline"\n',
        };
      const wide = args.includes('-ww') || args.filter((arg) => arg === '-w').length === 2;
      return { stdout: ['PID COMMAND\n', `${wide ? row : row.slice(0, displayWidth)}\n`] };
    });

    expect(await findOkProcessPids()).toEqual([fixturePid]);
    expect(await scanLockProcesses()).toEqual({
      candidates: [{ lockDir, pid: fixturePid, source: 'lock-dir-argument' }],
      unavailable: [],
    });
  });
});

describe('BusyBox process listing', () => {
  interface BusyBoxProcess {
    pid: number;
    comm: string;
    exe: string;
    cmdline: string;
  }

  const psColumns =
    'user,group,comm,args,pid,ppid,pgid,etime,nice,rgroup,ruser,time,tty,vsz,sid,stat,rss';
  const psUsage =
    'BusyBox v1.37.0 (2026-01-10 15:38:28 UTC) multi-call binary.\n\nUsage: ps [-o COL1,COL2=HEADER] [-T]\n\nShow list of processes\n\n\t-o COL1,COL2=HEADER\tSelect columns for display\n\t-T\t\t\tShow threads\n';
  const libcs = [
    ['musl', (option: string) => `ps: unrecognized option: ${option}`],
    ['glibc', (option: string) => `ps: invalid option -- '${option}'`],
  ] as const;
  const shell = { pid: 1, comm: 'sh', exe: '/bin/busybox', cmdline: '/bin/sh /srv/run.sh' };
  const ordinary = {
    pid: 11223,
    comm: 'MainThread',
    exe: '/usr/local/bin/node',
    cmdline: 'node /srv/fixture.cjs --fixture-control=ordinary',
  };
  const lookalike = {
    pid: 13579,
    comm: 'MainThread',
    exe: '/usr/local/bin/node',
    cmdline: '/opt/open-knowledge-server /srv/fixture.cjs --fixture-control=notes',
  };

  function argsColumn({ comm, cmdline }: BusyBoxProcess): string {
    const argv0 = cmdline.split(' ')[0] ?? '';
    const base = cmdline.slice(argv0.lastIndexOf('/') + 1).replace(/^-/, '');
    return base.startsWith(comm) ? cmdline : `{${comm}} ${cmdline}`;
  }

  function busyboxPs(
    processes: BusyBoxProcess[],
    args: string[],
    reject: (option: string) => string,
  ): Output {
    const columns: string[] = [];
    for (let index = 0; index < args.length; index++) {
      const arg = args[index] ?? '';
      if (!arg.startsWith('-')) throw new Error(`Unmodeled ps operand: ${arg}`);
      for (let offset = 1; offset < arg.length; offset++) {
        const option = arg[offset] ?? '';
        if (option === 'o') {
          columns.push(...(arg.slice(offset + 1) || args[++index] || '').split(','));
          break;
        }
        if (option === 'T') throw new Error('Unmodeled ps option: T');
        if (!'ZaAdefl'.includes(option))
          return { stdout: [], status: 1, stderr: `${reject(option)}\n${psUsage}` };
      }
    }
    const unknown = columns.find((column) => !psColumns.split(',').includes(column));
    if (unknown !== undefined)
      return {
        stdout: [],
        status: 1,
        stderr: `ps: bad -o argument '${unknown}', supported arguments: ${psColumns}\n`,
      };
    if (columns.join(',') !== 'pid,args')
      throw new Error(`Unmodeled ps columns: ${columns.join(',')}`);
    return {
      stdout: [
        'PID   COMMAND\n',
        ...processes.map((entry) => `${String(entry.pid).padStart(5)} ${argsColumn(entry)}\n`),
      ],
    };
  }

  function provideBusyBox(processes: BusyBoxProcess[], reject: (option: string) => string) {
    const read = (program: string, args: string[]): Output => {
      if (program === 'ps') return busyboxPs(processes, args, reject);
      if (program === 'lsof')
        return { stdout: processes.map((entry) => `${entry.pid}\t${entry.exe}\t0\t/dev/null\n`) };
      throw new Error(`Unexpected subprocess: ${program}`);
    };
    provideOutput(read);
    execFileSync.mockImplementation((program: string, args: string[]) => {
      const result = read(program, args);
      if (!result.status) return [...(result.stdout as Iterable<string>)].join('');
      throw Object.assign(new Error(`Command failed: ${program} ${args.join(' ')}`), {
        status: result.status,
        stderr: result.stderr,
      });
    });
  }

  it.each(libcs)(
    'discovers a marked process and not its lookalike with %s BusyBox ps',
    async (_libc, reject) => {
      const marked = {
        pid: fixturePid,
        comm: 'MainThread',
        exe: '/usr/local/bin/node',
        cmdline: `node /srv/fixture.cjs --ok-lock-dir-b64=${Buffer.from(lockDir).toString('base64url')}`,
      };
      provideBusyBox([shell, ordinary, lookalike, marked], reject);

      expect(await findOkProcessPids()).toEqual([fixturePid]);
      expect(await discoverLockDirs()).toEqual([lockDir]);
      expect(await scanLockProcesses(() => ({ onProbeFailure: () => {} }))).toEqual({
        candidates: [{ lockDir, pid: fixturePid, source: 'lock-dir-argument' }],
        unavailable: [],
      });
    },
  );

  it.each(libcs)(
    'reports a %s BusyBox host without OK processes as fully enumerated',
    async (_libc, reject) => {
      provideBusyBox([shell, ordinary], reject);

      expect(await findOkProcessPids()).toEqual([]);
      expect(await discoverLockDirs()).toEqual([]);
      expect(await scanLockProcesses(() => ({ onProbeFailure: () => {} }))).toEqual({
        candidates: [],
        unavailable: [],
      });
    },
  );
});

describe('process format failures', () => {
  it('does not change command formats after an incomplete process table', async () => {
    provideOutput((program, args) => {
      if (program !== 'ps') return emptyOutput(program);
      if (args.includes('pid,cmdline'))
        return { stdout: ['PID CMDLINE\n'], status: 1, stderr: 'process table unreadable\n' };
      return { stdout: ['PID ARGS\n13579 open-knowledge-server --fixture-control=notes\n'] };
    });

    expect(await findOkProcessPids()).toEqual([]);
    const scan = await scanLockProcesses();
    expect(scan.candidates).toEqual([]);
    expect(scan.unavailable).toEqual([expect.stringContaining('process table unreadable')]);
  });
});

describe('listener enumeration', () => {
  function provideLargeListenerTable() {
    const row = `node ${fixturePid} user 20u IPv4 device 0t0 TCP *:54321 (LISTEN)\n`;
    const repeats = Math.ceil(nodeDefaultMaxBuffer / Buffer.byteLength(row));
    provideOutput((program, args) => {
      if (program === 'lsof' && args.includes('-iTCP')) {
        return {
          stdout: (function* () {
            yield listenerHeader;
            for (let index = 0; index < repeats; index++)
              yield row.replace('20u', `${index + 20}u`);
          })(),
        };
      }
      if (program === 'lsof' && args.includes('cwd'))
        return { stdout: [`p${fixturePid}\nn${project}\n`] };
      return emptyOutput(program);
    });
  }

  it('discovers lock directories from an oversized listener table', async () => {
    provideLargeListenerTable();

    expect(await discoverLockDirs()).toEqual([lockDir]);
  });

  it('attributes a listener once after an oversized listener table', async () => {
    provideLargeListenerTable();

    expect(await scanLockProcesses()).toEqual({
      candidates: [
        { lockDir, pid: fixturePid, source: 'listener-cwd' },
        { lockDir: join(project, '.ok'), pid: fixturePid, source: 'listener-cwd' },
      ],
      unavailable: [],
    });
  });
});

describe('process listing diagnostics', () => {
  it.each(['ENOENT', 'EACCES'] as const)('retains a ps startup error code %s', async (code) => {
    provideOutput((program) =>
      program === 'ps'
        ? { stdout: [], error: Object.assign(new Error('could not start producer'), { code }) }
        : emptyOutput(program),
    );

    const scan = await scanLockProcesses();
    expect(scan.candidates).toEqual([]);
    expect(scan.unavailable).toEqual([expect.stringContaining('ps')]);
    expect(scan.unavailable[0]).toContain(code);
    expect(scan.unavailable[0]).toContain('could not start producer');
    expect(scan.unavailable[0]).not.toContain('pgrep');
    expect(await findOkProcessPids()).toEqual([]);
  });

  it('retains the ps output read error after receiving a matching row', async () => {
    spawn.mockImplementation(() =>
      fakeChildProcess({
        stdout: (async function* () {
          yield `PID COMMAND\n${fixturePid} node --ok-project-path=${project}\n`;
          throw Object.assign(new Error('output read failed'), { code: 'EIO' });
        })(),
      }),
    );

    const scan = await scanLockProcesses();
    expect(scan.candidates).toEqual([]);
    expect(scan.unavailable).toEqual([expect.stringMatching(/ps.*EIO/)]);
    expect(scan.unavailable[0]).toContain('output read failed');
    expect(scan.unavailable[0]).not.toContain('pgrep');
    expect(await findOkProcessPids()).toEqual([]);
  });

  it('retains the ps exit status when enumeration fails', async () => {
    provideOutput((program) =>
      program === 'ps'
        ? { stdout: ['PID COMMAND\n'], status: 7, stderr: 'ps: process data unavailable\n' }
        : emptyOutput(program),
    );

    const scan = await scanLockProcesses();
    expect(scan.candidates).toEqual([]);
    expect(scan.unavailable).toEqual([expect.stringMatching(/ps.*(?:exit|status).*7/)]);
    expect(scan.unavailable[0]).toContain('process data unavailable');
    expect(scan.unavailable[0]).not.toContain('pgrep');
  });

  it('retains the diagnostic of every rejected ps listing', async () => {
    const attempts: string[][] = [];
    const rejection = (args: string[]) => `ps: rejected [${args.join(' ')}]`;
    provideOutput((program, args) => {
      if (program !== 'ps') return emptyOutput(program);
      attempts.push(args);
      return { stdout: [], status: 1, stderr: `${rejection(args)}\n` };
    });

    const scan = await scanLockProcesses();
    expect(scan.candidates).toEqual([]);
    expect(scan.unavailable).toHaveLength(1);
    expect(attempts).not.toHaveLength(0);
    for (const args of attempts) expect(scan.unavailable[0]).toContain(rejection(args));
    expect(await findOkProcessPids()).toEqual([]);
  });

  it('retains the ps termination signal when enumeration stops', async () => {
    provideOutput((program) =>
      program === 'ps'
        ? { stdout: ['PID COMMAND\n'], status: null, signal: 'SIGTERM' }
        : emptyOutput(program),
    );

    const scan = await scanLockProcesses();
    expect(scan.candidates).toEqual([]);
    expect(scan.unavailable).toEqual([expect.stringMatching(/ps.*SIGTERM/)]);
    expect(scan.unavailable[0]).not.toContain('pgrep');
    expect(scan.unavailable[0]).not.toContain('timed out');
  });

  it.each(['ps', 'lsof'])(
    'reports the %s listing stopped by the scan time budget as a timeout',
    async (producer) => {
      provideOutput((program, args) =>
        program === producer && (program === 'ps' || args.includes('-iTCP'))
          ? { stdout: [], status: null, signal: 'SIGTERM', killed: true }
          : emptyOutput(program),
      );

      const scan = await scanLockProcesses();
      expect(scan.candidates).toEqual([]);
      expect(scan.unavailable).toEqual([
        expect.stringMatching(new RegExp(`${producer} .*timed out`)),
      ]);
    },
  );

  it('reports an lsof listing stopped by an outside signal as that signal', async () => {
    provideOutput((program, args) =>
      program === 'lsof' && args.includes('-iTCP')
        ? { stdout: [], status: null, signal: 'SIGTERM' }
        : emptyOutput(program),
    );

    const scan = await scanLockProcesses();
    expect(scan.unavailable).toEqual([
      expect.stringMatching(/TCP listeners.*lsof.*signal SIGTERM/),
    ]);
    expect(scan.unavailable[0]).not.toContain('timed out');
  });

  it.each(['ENOENT', 'EACCES'] as const)('retains an lsof startup error code %s', async (code) => {
    provideOutput((program, args) =>
      program === 'lsof' && args.includes('-iTCP')
        ? {
            stdout: [],
            error: Object.assign(new Error('could not start listener producer'), { code }),
          }
        : emptyOutput(program),
    );

    const scan = await scanLockProcesses();
    expect(scan.candidates).toEqual([]);
    expect(scan.unavailable).toEqual([expect.stringMatching(/TCP listeners.*lsof/)]);
    expect(scan.unavailable[0]).toContain(code);
    expect(scan.unavailable[0]).toContain('could not start listener producer');
  });
});
