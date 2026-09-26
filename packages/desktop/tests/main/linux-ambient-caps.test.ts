import { describe, expect, test } from 'vitest';
import {
  AMBIENT_CAPS_CLEARED_ENV,
  type AmbientCapsDeps,
  clearAmbientCapsBeforeBoot,
  getBootAmbientCapsFacts,
  logAmbientCapsPosture,
  parseAmbientCaps,
  planAmbientCapsReexec,
} from '../../src/main/linux-ambient-caps.ts';

const EXEC_PATH = '/opt/OpenKnowledge/openknowledge';

function procStatus(capAmb: string): string {
  return [
    'Name:\topenknowledge',
    'Uid:\t1000\t1000\t1000\t1000',
    'CapInh:\t0000000000000001',
    'CapPrm:\t0000000000000001',
    'CapEff:\t0000000000000001',
    'CapBnd:\t0000000000000001',
    `CapAmb:\t${capAmb}`,
    'NoNewPrivs:\t1',
  ].join('\n');
}

function deps(overrides: Partial<AmbientCapsDeps> = {}): AmbientCapsDeps & {
  statusReads: number;
} {
  const base = {
    platform: 'linux' as NodeJS.Platform,
    uid: 1000,
    env: { DISPLAY: ':0' } as NodeJS.ProcessEnv,
    exists: (path: string) => path === '/usr/bin/setpriv',
    isExecutable: (path: string) => path === '/usr/bin/setpriv',
    execPath: EXEC_PATH,
    argv: [EXEC_PATH, '--no-sandbox', '--password-store=basic'],
    statusReads: 0,
    readProcStatus: () => '',
  };
  const result = { ...base, ...overrides };
  const read = overrides.readProcStatus ?? (() => procStatus('0000000000000001'));
  result.readProcStatus = () => {
    result.statusReads += 1;
    return read();
  };
  return result;
}

function withExecve(
  d: AmbientCapsDeps,
  execve: (file: string, args: string[], env: NodeJS.ProcessEnv) => void,
) {
  return { ...d, execve };
}

describe('parseAmbientCaps', () => {
  test('reads the CapAmb mask from /proc/self/status', () => {
    expect(parseAmbientCaps(procStatus('0000000000000001'))).toBe(1n);
    expect(parseAmbientCaps(procStatus('000001ffffffffff'))).toBe(0x1ffffffffffn);
    expect(parseAmbientCaps(procStatus('0000000000000000'))).toBe(0n);
  });

  test('a kernel without ambient capabilities has no CapAmb line', () => {
    expect(parseAmbientCaps('Name:\tx\nCapPrm:\t0000000000000000\n')).toBeNull();
  });
});

describe('planAmbientCapsReexec', () => {
  test('non-linux platforms never read /proc and never re-exec', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const d = deps({ platform });
      const posture = planAmbientCapsReexec(d);
      expect(posture.decision).toBe('not-linux');
      expect(posture.exec).toBeNull();
      expect(d.statusReads).toBe(0);
    }
  });

  test('root keeps its capabilities because bubblewrap accepts them for uid 0', () => {
    const d = deps({ uid: 0 });
    expect(planAmbientCapsReexec(d)).toMatchObject({ decision: 'root', exec: null });
    expect(d.statusReads).toBe(0);
  });

  test('a process without ambient capabilities boots as-is', () => {
    const posture = planAmbientCapsReexec(
      deps({ readProcStatus: () => procStatus('0000000000000000') }),
    );
    expect(posture).toMatchObject({ decision: 'none', ambientCaps: '0', exec: null });
  });

  test('ambient capabilities re-exec the same argv through setpriv with them dropped', () => {
    const posture = planAmbientCapsReexec(deps());
    expect(posture.decision).toBe('reexec');
    expect(posture.ambientCaps).toBe('1');
    expect(posture.exec).toEqual({
      file: '/usr/bin/setpriv',
      args: [
        '/usr/bin/setpriv',
        '--inh-caps=-all',
        '--ambient-caps=-all',
        EXEC_PATH,
        '--no-sandbox',
        '--password-store=basic',
      ],
      env: { DISPLAY: ':0', [AMBIENT_CAPS_CLEARED_ENV]: '1' },
    });
  });

  test('a /usr/bin/setpriv that is not executable is skipped for /bin/setpriv', () => {
    const posture = planAmbientCapsReexec(
      deps({ isExecutable: (path) => path === '/bin/setpriv' }),
    );
    expect(posture.exec?.file).toBe('/bin/setpriv');
  });

  test('without setpriv at either path the app boots with the capabilities still set', () => {
    const posture = planAmbientCapsReexec(deps({ exists: () => false, isExecutable: () => false }));
    expect(posture).toMatchObject({ decision: 'setpriv-missing', ambientCaps: '1', exec: null });
  });

  test('a setpriv that exists but cannot be executed is reported apart from a missing one', () => {
    const posture = planAmbientCapsReexec(deps({ isExecutable: () => false }));
    expect(posture).toMatchObject({
      decision: 'setpriv-not-executable',
      ambientCaps: '1',
      exec: null,
    });
  });

  test('after the re-exec, a cleared mask is recorded and never re-execs again', () => {
    const posture = planAmbientCapsReexec(
      deps({
        env: { [AMBIENT_CAPS_CLEARED_ENV]: '1' },
        readProcStatus: () => procStatus('0000000000000000'),
      }),
    );
    expect(posture).toMatchObject({
      decision: 'cleared',
      clearedFrom: '1',
      ambientCaps: '0',
      exec: null,
    });
  });

  test('capabilities that survive the re-exec are reported instead of looping', () => {
    const posture = planAmbientCapsReexec(deps({ env: { [AMBIENT_CAPS_CLEARED_ENV]: '1' } }));
    expect(posture).toMatchObject({ decision: 'still-present', ambientCaps: '1', exec: null });
  });

  test('an unreadable /proc/self/status leaves the process alone', () => {
    const error = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const unreadable = planAmbientCapsReexec(
      deps({
        readProcStatus: () => {
          throw error;
        },
      }),
    );
    expect(unreadable).toMatchObject({
      decision: 'status-unreadable',
      errorCode: 'EACCES',
      exec: null,
    });

    const noLine = planAmbientCapsReexec(deps({ readProcStatus: () => 'Name:\tx\n' }));
    expect(noLine).toMatchObject({ decision: 'status-unreadable', errorCode: null, exec: null });
  });
});

describe('clearAmbientCapsBeforeBoot', () => {
  test('execs the planned command exactly once', () => {
    const calls: Array<[string, string[], NodeJS.ProcessEnv]> = [];
    clearAmbientCapsBeforeBoot(withExecve(deps(), (...args) => calls.push(args)));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('/usr/bin/setpriv');
    expect(calls[0]?.[2][AMBIENT_CAPS_CLEARED_ENV]).toBe('1');
  });

  test('does not exec when there is nothing to drop', () => {
    let called = false;
    const posture = clearAmbientCapsBeforeBoot(
      withExecve(deps({ readProcStatus: () => procStatus('0000000000000000') }), () => {
        called = true;
      }),
    );
    expect(called).toBe(false);
    expect(posture.decision).toBe('none');
  });

  test('an execve that throws on its arguments keeps booting and records the error', () => {
    const posture = clearAmbientCapsBeforeBoot(
      withExecve(deps(), () => {
        throw Object.assign(new TypeError('bad argument'), { code: 'ERR_INVALID_ARG_TYPE' });
      }),
    );
    expect(posture).toMatchObject({ decision: 'reexec-failed', errorCode: 'ERR_INVALID_ARG_TYPE' });
  });

  test('a runtime without process.execve keeps booting and says so', () => {
    const posture = clearAmbientCapsBeforeBoot({ ...deps(), execve: undefined });
    expect(posture).toMatchObject({ decision: 'reexec-failed', errorCode: 'EXECVE_UNAVAILABLE' });
  });

  test('the re-exec marker does not leak into processes the app spawns later', () => {
    const env: NodeJS.ProcessEnv = { [AMBIENT_CAPS_CLEARED_ENV]: '1', DISPLAY: ':0' };
    clearAmbientCapsBeforeBoot(
      withExecve(deps({ env, readProcStatus: () => procStatus('0000000000000000') }), () => {}),
    );
    expect(env).toEqual({ DISPLAY: ':0' });
  });
});

describe('boot facts handed to the logger', () => {
  function bootFacts(
    d: AmbientCapsDeps,
    execve: (file: string, args: string[], env: NodeJS.ProcessEnv) => void = () => {},
  ) {
    clearAmbientCapsBeforeBoot(withExecve(d, execve));
    return getBootAmbientCapsFacts();
  }

  function logged(
    d: AmbientCapsDeps,
    execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => void,
  ) {
    const facts = bootFacts(d, execve);
    if (facts === null) throw new Error('expected boot facts');
    const lines: Array<{ level: string; facts: object }> = [];
    logAmbientCapsPosture(facts, (level, logFacts) => lines.push({ level, facts: logFacts }));
    return lines;
  }

  test('the getter returns the decision clearAmbientCapsBeforeBoot reached, without the exec or environment', () => {
    const posture = clearAmbientCapsBeforeBoot({
      ...deps({ env: { SECRET: 'x' } }),
      execve: undefined,
    });
    const facts = getBootAmbientCapsFacts();
    expect(facts).toEqual({
      decision: 'reexec-failed',
      event: 'desktop.linux-ambient-caps-posture',
      ambientCaps: '1',
      clearedFrom: null,
      errorCode: 'EXECVE_UNAVAILABLE',
    });
    expect(facts?.decision).toBe(posture.decision);
    expect(JSON.stringify(facts)).not.toContain('SECRET');
  });

  test('the common paths stay quiet', () => {
    expect(logged(deps({ platform: 'darwin' }))).toEqual([]);
    expect(logged(deps({ uid: 0 }))).toEqual([]);
    expect(logged(deps({ readProcStatus: () => procStatus('0000000000000000') }))).toEqual([]);
  });

  test('a cleared boot logs info with the mask it started with', () => {
    const lines = logged(
      deps({
        env: { [AMBIENT_CAPS_CLEARED_ENV]: '200000' },
        readProcStatus: () => procStatus('0000000000000000'),
      }),
    );
    expect(lines).toEqual([
      {
        level: 'info',
        facts: {
          decision: 'cleared',
          event: 'desktop.linux-ambient-caps-posture',
          ambientCaps: '0',
          clearedFrom: '200000',
          errorCode: null,
        },
      },
    ]);
  });

  test('every outcome that leaves capabilities in place warns', () => {
    const throwing = () => {
      throw Object.assign(new Error('EINVAL'), { code: 'ERR_INVALID_ARG_VALUE' });
    };
    const leftInPlace = [
      logged(deps({ exists: () => false, isExecutable: () => false })),
      logged(deps({ isExecutable: () => false })),
      logged(deps({ env: { [AMBIENT_CAPS_CLEARED_ENV]: '1' } })),
      logged(deps({ readProcStatus: () => 'Name:\tx\n' })),
      logged(deps(), throwing),
    ];
    for (const lines of leftInPlace) {
      expect(lines.map((line) => line.level)).toEqual(['warn']);
    }
  });
});
