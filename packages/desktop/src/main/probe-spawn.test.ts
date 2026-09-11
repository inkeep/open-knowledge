import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { TERMINAL_CLI_IDS, TERMINAL_CLIS } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createScratchHomeWithOkBin,
  firstShellOnDisk,
  MINIMAL_PARENT_PATH,
} from '../../tests/support/ok-bin-scratch-home.test-helper.ts';
import { okManagedBinDirs } from '../shared/ok-child-env.ts';
import { buildShellEnv } from '../utility/pty-host.ts';
import { cliProbeArgs, runLoginShellProbe } from './claude-readiness.ts';
import {
  okProbeSpawnEnv,
  probeEnvVerdict,
  probeSpawnArgs,
  realProbeSpawn,
  realProbeTimers,
} from './probe-spawn.ts';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

const probeLog = vi.hoisted(() => {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  };
  return logger;
});
vi.mock('./desktop-logger.ts', () => ({ getLogger: () => probeLog }));

function compositionRecords(): Record<string, unknown>[] {
  return probeLog.info.mock.calls
    .map(([attrs]) => attrs as Record<string, unknown>)
    .filter((attrs) => 'verdict' in attrs);
}

const SLIDEV_BIN = 'slidev';
const TERMINAL_CLI_BINS = TERMINAL_CLI_IDS.map((cli) => TERMINAL_CLIS[cli].bin);
const FIXTURE_ONLY_BIN = `ok-probe-spawn-fixture-${randomUUID()}`;

describe('probeSpawnArgs', () => {
  test('reasserts the managed path in the initialized POSIX shell', () => {
    const { args, reassert, family } = probeSpawnArgs(
      '/bin/zsh',
      ['-i', '-c', 'command -v codex'],
      {
        platform: 'linux',
        home: "/home/o'brien",
      },
    );
    expect(reassert).toBe('applied');
    expect(family).toBe('posix');
    expect(args.slice(0, -1)).toEqual(['-i', '-c']);
    expect(args.at(-1)).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in an expected command string, not a JS template placeholder
      "case \":$PATH:\" in *:'/home/o'\\''brien/.ok/bin':*) ;; *) PATH='/home/o'\\''brien/.ok/bin'\"${PATH:+:$PATH}\" ;; esac; export PATH; command -v codex",
    );
  });

  test('uses the configured shell family syntax', () => {
    const options = { platform: 'linux' as const, home: "/home/o'brien" };
    expect(
      probeSpawnArgs('/usr/bin/fish', ['-i', '-c', 'command -v codex'], options).args.at(-1),
    ).toBe(
      "if not contains '/home/o\\'brien/.ok/bin' $PATH; set -gx PATH '/home/o\\'brien/.ok/bin' $PATH; end; command -v codex",
    );
  });

  test('delegates unknown shell families to a POSIX command shell', () => {
    for (const shell of ['/usr/bin/nu', '/bin/tcsh']) {
      const { args, family } = probeSpawnArgs(shell, ['-i', '-c', 'command -v codex'], {
        platform: 'linux',
        home: '/home/alice',
      });
      expect(family).toBe('fallback');
      expect(args.at(-1)).toContain('exec /bin/sh -c');
      expect(args.at(-1)).toContain('command -v codex');
    }
  });

  test('leaves Windows and non-command argv unchanged', () => {
    const windows = ['/d', '/s', '/c', 'where.exe codex'];
    expect(
      probeSpawnArgs('cmd.exe', windows, {
        platform: 'win32',
        home: 'C:\\Users\\alice',
        cliBinDir: 'C:\\OpenKnowledge\\cli\\bin',
      }),
    ).toEqual({ args: windows, reassert: 'skipped-win32', family: undefined });
    const direct = ['--version'];
    expect(probeSpawnArgs('/bin/sh', direct, { platform: 'linux', home: '/home/alice' })).toEqual({
      args: direct,
      reassert: 'skipped-shape',
      family: 'posix',
    });
  });

  test.skipIf(process.platform === 'win32')(
    'warns with the shell family and the reassert reason when probe argv cannot carry a reassert',
    () => {
      probeLog.warn.mockClear();
      const child = realProbeSpawn('/bin/sh', ['--version']);
      child.onError(() => {});
      try {
        expect(
          probeLog.warn,
          'this is the third record the shell-family convergence renamed, and the only one whose warn call no test reaches: probeSpawnArgs returning the skipped-shape shape is pinned above, its consumer was not',
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            event: 'probe-reassert-skipped',
            shellCommandFamily: 'posix',
            reassert: 'skipped-shape',
          }),
          expect.any(String),
        );
      } finally {
        child.kill();
      }
    },
  );
});

describe.skipIf(process.platform === 'win32')('the production CLI-presence probe adapter', () => {
  let scratchHome: string;
  let shell: string;
  let previousHome: string | undefined;
  let previousPath: string | undefined;
  let previousZdotdir: string | undefined;

  beforeAll(() => {
    scratchHome = createScratchHomeWithOkBin({
      prefix: 'ok-probe-spawn-',
      bins: [SLIDEV_BIN, ...TERMINAL_CLI_BINS, FIXTURE_ONLY_BIN],
    });
    previousHome = process.env.HOME;
    previousPath = process.env.PATH;
    previousZdotdir = process.env.ZDOTDIR;
    process.env.HOME = scratchHome;
    process.env.PATH = MINIMAL_PARENT_PATH;
    delete process.env.ZDOTDIR;
    shell = firstShellOnDisk();
  });

  afterAll(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousZdotdir !== undefined) process.env.ZDOTDIR = previousZdotdir;
    rmSync(scratchHome, { recursive: true, force: true });
  });

  function okBinGrantedToOwnShells(): string {
    return (
      (buildShellEnv(process.env, { platform: process.platform }).env.PATH ?? '').split(':')[0] ??
      ''
    );
  }

  function probeThroughProductionAdapter(bin: string): Promise<number | null> {
    return runLoginShellProbe(
      realProbeSpawn,
      shell,
      realProbeTimers,
      undefined,
      cliProbeArgs(bin, process.platform),
    );
  }

  test('leads the probe PATH with the same OK-managed bin dir the app grants its own shells', () => {
    const env = okProbeSpawnEnv();
    expect((env.PATH ?? '').split(':')[0]).toBe(okBinGrantedToOwnShells());
    expect(env.PATH).not.toBe(process.env.PATH);
    expect(env).not.toBe(process.env);
  });

  test('does not mark the probe child as the OK Desktop terminal', () => {
    expect(okProbeSpawnEnv().OK_DESKTOP_TERMINAL).toBeUndefined();
  });

  test('resolves a ~/.ok/bin CLI that the bare app environment cannot reach', async () => {
    expect(await probeThroughProductionAdapter(FIXTURE_ONLY_BIN)).toBe(0);
  });
});

const WIN_CLI_BIN = 'C:\\Program Files\\Open Knowledge\\resources\\cli\\bin';

describe('probeEnvVerdict', () => {
  test('reports inherited when the app PATH already carries the OK-managed bin dir', () => {
    expect(
      probeEnvVerdict(
        { PATH: '/Users/alice/.ok/bin:/usr/bin' },
        { platform: 'darwin', home: '/Users/alice' },
      ),
    ).toBe('inherited');
  });

  test('reports injected when the app PATH does not, which is the reported bug precondition', () => {
    expect(
      probeEnvVerdict({ PATH: '/usr/bin' }, { platform: 'darwin', home: '/Users/alice' }),
    ).toBe('injected');
  });

  test('separates "no managed dir applies" from either grant', () => {
    expect(probeEnvVerdict({ PATH: '/usr/bin' }, { platform: 'darwin' })).toBe(
      'not-applicable-no-home',
    );
    expect(probeEnvVerdict({ Path: 'C:\\Windows' }, { platform: 'win32' })).toBe('not-applicable');
    expect(
      probeEnvVerdict({ Path: 'C:\\Windows' }, { platform: 'win32', cliBinDir: WIN_CLI_BIN }),
    ).toBe('injected');
    expect(
      probeEnvVerdict(
        { Path: `${WIN_CLI_BIN};C:\\Windows` },
        { platform: 'win32', cliBinDir: WIN_CLI_BIN },
      ),
    ).toBe('inherited');
  });

  test('every verdict is reachable from a real okProbeSpawnEnv parent environment', () => {
    const reached = new Set<string>();
    for (const [parent, options] of [
      [{ PATH: '/usr/bin' }, { platform: 'darwin' as const }],
      [{ Path: 'C:\\Windows' }, { platform: 'win32' as const }],
      [{ PATH: '/usr/bin' }, { platform: 'darwin' as const, home: '/Users/alice' }],
      [
        { PATH: '/Users/alice/.ok/bin:/usr/bin' },
        { platform: 'darwin' as const, home: '/Users/alice' },
      ],
    ] as const) {
      reached.add(probeEnvVerdict(parent, options));
    }
    expect(reached).toEqual(
      new Set(['not-applicable', 'not-applicable-no-home', 'inherited', 'injected']),
    );
  });
});

describe('the probe env composition line', () => {
  test('classifies an explicitly empty POSIX home as missing', () => {
    expect(probeEnvVerdict({}, { platform: 'linux', home: '' })).toBe('not-applicable-no-home');
  });

  test.skipIf(process.platform === 'win32')(
    'warns when the resolved POSIX home is empty',
    async () => {
      vi.stubEnv('HOME', '');
      vi.mocked(homedir).mockReturnValueOnce('');
      try {
        const mod = await freshProbeSpawn();
        mod.okProbeSpawnEnv();
        expect(probeLog.warn).toHaveBeenCalledWith(
          expect.objectContaining({ verdict: 'not-applicable-no-home', okManagedBinDirs: [] }),
          expect.any(String),
        );
        expect(probeLog.info).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  beforeEach(() => {
    vi.resetModules();
    probeLog.info.mockClear();
    probeLog.warn.mockClear();
  });

  async function freshProbeSpawn() {
    return await import('./probe-spawn.ts');
  }

  test('logs the composition once per run, not once per probe', async () => {
    const mod = await freshProbeSpawn();
    mod.okProbeSpawnEnv();
    mod.okProbeSpawnEnv();
    mod.okProbeSpawnEnv();
    expect(compositionRecords()).toHaveLength(1);
  });

  test('names the verdict and the dir it resolved, at info level', async () => {
    const mod = await freshProbeSpawn();
    mod.okProbeSpawnEnv();
    const [record] = compositionRecords();
    expect(record?.verdict).toBe(
      probeEnvVerdict(process.env, {
        platform: process.platform,
        home: homedir(),
        cliBinDir: undefined,
      }),
    );
    expect(record?.okManagedBinDirs).toEqual(
      okManagedBinDirs({ platform: process.platform, home: homedir(), cliBinDir: undefined }),
    );
    expect(probeLog.warn).not.toHaveBeenCalled();
  });
});
