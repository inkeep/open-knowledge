import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildDesktopUninstallHandoffScript,
  buildDesktopUninstallResultScript,
  launchDesktopUninstallHandoff,
  runDesktopUninstallHandoffStep,
} from '../../src/main/desktop-uninstall-handoff.ts';

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ok-uninstall-handoff-'));
  fixtures.push(dir);
  const executable = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    return path;
  };
  const events = join(dir, 'events');
  const commands = {
    osascript: executable('notice', `printf '%s\\n' "$*" >> '${events}'\nprintf 'Close\\n'`),
    open: executable('reveal', `printf 'reveal\\n' >> '${events}'`),
  };
  return { dir, executable, events, commands };
}

describe.skipIf(process.platform === 'win32')('desktop uninstall after exit', () => {
  test('waits for final application writes before removing state and reporting success', async () => {
    const f = fixture();
    const state = join(f.dir, 'state.json');
    const sentinel = join(f.dir, 'crash.json');
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {
        fs.writeFileSync(${JSON.stringify(state)}, 'final window snapshot');
        fs.writeFileSync(${JSON.stringify(sentinel)}, 'final crash state');
        process.exit(0);
      });
      console.log('ready');
      setInterval(() => {}, 1000);
    `,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await once(parent.stdout, 'data');
    const parentPid = parent.pid as number;
    const parentStartedAt = execFileSync('/bin/ps', ['-p', String(parentPid), '-o', 'lstart='], {
      encoding: 'utf8',
    }).trim();
    const cliPath = f.executable(
      'cli',
      `test -f '${state}' && test -f '${sentinel}' || exit 12\nrm '${state}' '${sentinel}'\nprintf 'cleanup\\n' >> '${f.events}'`,
    );
    const child = spawn(
      '/bin/sh',
      [
        '-c',
        buildDesktopUninstallHandoffScript(
          {
            cliPath,
            projectPaths: [],
            logPath: join(f.dir, 'cleanup.log'),
            appBundlePath: '/Applications/OpenKnowledge.app',
            parentPid,
            parentStartedAt,
          },
          f.commands,
        ),
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const completion = once(child, 'close');
    try {
      await once(child.stdout, 'data');
      expect(existsSync(f.events)).toBe(false);
      parent.kill('SIGTERM');
      await expect(completion).resolves.toEqual([0, null]);
      expect(existsSync(state)).toBe(false);
      expect(existsSync(sentinel)).toBe(false);
      const events = readFileSync(f.events, 'utf8');
      expect(events.indexOf('cleanup')).toBeLessThan(
        events.indexOf('OpenKnowledge files were removed'),
      );
      expect(readFileSync(join(f.dir, 'cleanup.log'), 'utf8')).toContain(
        'Cleanup result: succeeded',
      );
    } finally {
      parent.kill('SIGKILL');
      child.kill('SIGKILL');
    }
  });

  test('does no cleanup and reports failure when the original process remains alive', async () => {
    const f = fixture();
    const parentStartedAt = 'unchanged process';
    const script = buildDesktopUninstallHandoffScript(
      {
        cliPath: f.executable('cli', `printf 'cleanup\\n' >> '${f.events}'`),
        projectPaths: [],
        logPath: join(f.dir, 'cleanup.log'),
        appBundlePath: '/Applications/OpenKnowledge.app',
        parentPid: 123,
        parentStartedAt,
      },
      {
        ...f.commands,
        ps: f.executable('ps', `printf '${parentStartedAt}\\n'`),
        sleep: f.executable('sleep', 'exit 0'),
      },
    );
    const child = spawn('/bin/sh', ['-c', script], { stdio: 'ignore' });
    await expect(once(child, 'close')).resolves.toEqual([1, null]);
    expect(readFileSync(f.events, 'utf8')).toContain('Cleanup didn’t finish');
    expect(readFileSync(f.events, 'utf8')).not.toContain('cleanup\n');
    expect(readFileSync(f.events, 'utf8')).not.toContain('OpenKnowledge files were removed');
  });

  test('reports cleanup errors without a success dialog or app removal instruction', async () => {
    const f = fixture();
    const script = buildDesktopUninstallHandoffScript(
      {
        cliPath: f.executable('cli', 'exit 1'),
        projectPaths: [],
        logPath: join(f.dir, 'cleanup.log'),
        appBundlePath: '/Applications/OpenKnowledge.app',
        parentPid: 123,
        parentStartedAt: 'original process',
      },
      { ...f.commands, ps: f.executable('ps', 'exit 1') },
    );
    const child = spawn('/bin/sh', ['-c', script], { stdio: 'ignore' });
    await expect(once(child, 'close')).resolves.toEqual([1, null]);
    const events = readFileSync(f.events, 'utf8');
    expect(events).toContain('Cleanup didn’t finish');
    expect(events).not.toContain('OpenKnowledge files were removed');
    expect(events).not.toContain('Trash');
  });
});

describe('desktop uninstall handoff readiness', () => {
  class Child extends EventEmitter {
    stdout = new PassThrough();
    kill = vi.fn();
    unref = vi.fn();
  }
  const input = {
    cliPath: '/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh',
    projectPaths: [],
    logPath: '/tmp/uninstall.log',
    appBundlePath: '/Applications/OpenKnowledge.app',
  };

  test('detaches only after the helper reports readiness', async () => {
    const child = new Child();
    const spawn = vi.fn(() => child);
    const launched = launchDesktopUninstallHandoff(input, {
      spawn,
      readParentStartedAt: () => 'original process',
    });
    expect(child.unref).not.toHaveBeenCalled();
    child.stdout.write('OK_UNINSTALL_');
    expect(child.unref).not.toHaveBeenCalled();
    child.stdout.write('READY\n');
    await expect(launched).resolves.toEqual({ ok: true });
    expect(child.unref).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  });

  test('surfaces a helper launch error without declaring readiness', async () => {
    const child = new Child();
    const launched = launchDesktopUninstallHandoff(input, {
      spawn: () => child,
      readParentStartedAt: () => 'original process',
    });
    child.emit('error', new Error('spawn EACCES'));
    await expect(launched).resolves.toEqual({ ok: false, error: 'spawn EACCES' });
    expect(child.unref).not.toHaveBeenCalled();
  });

  test('allows the progress renderer to start before applying the bounded readiness timeout', async () => {
    vi.useFakeTimers();
    try {
      const child = new Child();
      const launched = launchDesktopUninstallHandoff(input, {
        spawn: () => child,
        readParentStartedAt: () => 'original process',
        resultCommand: ['/owned/Electron'],
      });
      await vi.advanceTimersByTimeAsync(5000);
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(35_000);
      await expect(launched).resolves.toMatchObject({ ok: false });
      expect(child.kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test('stops a helper that never becomes ready', async () => {
    vi.useFakeTimers();
    try {
      const child = new Child();
      const launched = launchDesktopUninstallHandoff(input, {
        spawn: () => child,
        readParentStartedAt: () => 'original process',
      });
      await vi.advanceTimersByTimeAsync(5000);
      await expect(launched).resolves.toMatchObject({ ok: false });
      expect(child.kill).toHaveBeenCalledOnce();
      expect(child.unref).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('desktop uninstall handoff flow', () => {
  test('waits for optional feedback before starting the bounded handoff and suppresses updates before quitting', async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      let finishFeedback: () => void = () => {};
      const completed = runDesktopUninstallHandoffStep({
        collectFeedback: () =>
          new Promise<void>((resolve) => {
            events.push('feedback');
            finishFeedback = resolve;
          }),
        launchHandoff: async () => {
          events.push('handoff');
          return { ok: true };
        },
        showFailure: async () => {
          events.push('failure');
        },
        suppressAutoInstallOnQuit: () => {
          events.push('suppress update');
        },
        quit: () => {
          events.push('quit');
        },
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(events).toEqual(['feedback']);
      finishFeedback();
      await completed;
      expect(events).toEqual(['feedback', 'handoff', 'suppress update', 'quit']);
    } finally {
      vi.useRealTimers();
    }
  });

  test('keeps the app running and displays the error when the helper cannot start', async () => {
    const showFailure = vi.fn(async () => {});
    const suppressAutoInstallOnQuit = vi.fn();
    const quit = vi.fn();
    await runDesktopUninstallHandoffStep({
      collectFeedback: async () => {},
      launchHandoff: async () => ({ ok: false, error: 'spawn EACCES' }),
      showFailure,
      suppressAutoInstallOnQuit,
      quit,
    });
    expect(showFailure).toHaveBeenCalledWith({ ok: false, error: 'spawn EACCES' });
    expect(suppressAutoInstallOnQuit).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === 'win32')('desktop cleanup failure boundaries', () => {
  test('reports failure when selected projects succeed but global cleanup fails', async () => {
    const f = fixture();
    const project = join(f.dir, 'project');
    mkdirSync(join(project, '.ok'), { recursive: true });
    const logPath = join(f.dir, 'cleanup.log');
    const script = buildDesktopUninstallHandoffScript(
      {
        cliPath: f.executable(
          'cli',
          `printf '%s\\n' "$1" >> '${f.events}'
if [ "$1" = 'uninstall' ]; then exit 31; fi`,
        ),
        projectPaths: [project],
        logPath,
        appBundlePath: '/Applications/OpenKnowledge.app',
        parentPid: 123,
        parentStartedAt: 'original process',
      },
      { ...f.commands, ps: f.executable('ps', 'exit 1') },
    );
    const child = spawn('/bin/sh', ['-c', script], { stdio: 'ignore' });
    await expect(once(child, 'close')).resolves.toEqual([1, null]);
    const events = readFileSync(f.events, 'utf8');
    expect(events).toMatch(/^deinit\nuninstall\n/);
    expect(events).toContain('Cleanup didn’t finish');
    expect(events).not.toContain('Trash');
    expect(events).not.toContain('OpenKnowledge files were removed');
    const log = readFileSync(logPath, 'utf8');
    expect(log).toContain('deinit=0 global=31');
    expect(log).toContain('Cleanup result: failed');
  });

  test('retains global settings after any selected project fails while still trying other selected projects', async () => {
    const f = fixture();
    const projects = [join(f.dir, 'failed'), join(f.dir, 'succeeded')];
    for (const project of projects) mkdirSync(join(project, '.ok'), { recursive: true });
    const cliPath = f.executable(
      'cli',
      `printf '%s\\n' "$1 $3" >> '${f.events}'
if [ "$3" = '${projects[0]}' ]; then exit 1; fi`,
    );
    const script = buildDesktopUninstallHandoffScript(
      {
        cliPath,
        projectPaths: projects,
        logPath: join(f.dir, 'cleanup.log'),
        appBundlePath: '/Applications/OpenKnowledge.app',
        parentPid: 123,
        parentStartedAt: 'original process',
      },
      { ...f.commands, ps: f.executable('ps', 'exit 1') },
    );
    const child = spawn('/bin/sh', ['-c', script], { stdio: 'ignore' });
    await expect(once(child, 'close')).resolves.toEqual([1, null]);
    const events = readFileSync(f.events, 'utf8');
    for (const project of projects) expect(events).toContain(`deinit ${project}`);
    expect(events).not.toContain('uninstall ');
    expect(events).toContain('Cleanup didn’t finish');
  });

  test('does not delete files when process inspection fails', async () => {
    const f = fixture();
    const script = buildDesktopUninstallHandoffScript(
      {
        cliPath: f.executable('cli', `printf 'cleanup\\n' >> '${f.events}'`),
        projectPaths: [],
        logPath: join(f.dir, 'cleanup.log'),
        appBundlePath: '/Applications/OpenKnowledge.app',
        parentPid: 123,
        parentStartedAt: 'original process',
      },
      { ...f.commands, ps: f.executable('ps', 'exit 2') },
    );
    const child = spawn('/bin/sh', ['-c', script], { stdio: 'ignore' });
    await expect(once(child, 'close')).resolves.toEqual([1, null]);
    const events = readFileSync(f.events, 'utf8');
    expect(events).toContain('Could not verify that OpenKnowledge stopped');
    expect(events).not.toContain('cleanup\n');
  });
});

describe.skipIf(process.platform === 'win32')('desktop cleanup result', () => {
  test.each([true, false])(
    'records the outcome before attempting a dialog that fails (ok=%s)',
    async (ok) => {
      const f = fixture();
      const logPath = join(f.dir, 'cleanup.log');
      const script = buildDesktopUninstallHandoffScript(
        {
          cliPath: f.executable('cli', ok ? 'exit 0' : 'exit 1'),
          projectPaths: [],
          logPath,
          appBundlePath: '/Applications/OpenKnowledge.app',
          parentPid: 123,
          parentStartedAt: 'original process',
        },
        {
          ...f.commands,
          ps: f.executable('ps', 'exit 1'),
          osascript: f.executable('notice-fails', `cat '${logPath}' > '${f.events}'\nexit 1`),
        },
      );
      const child = spawn('/bin/sh', ['-c', script], { stdio: 'ignore' });
      await expect(once(child, 'close')).resolves.toEqual([ok ? 0 : 1, null]);
      expect(readFileSync(f.events, 'utf8')).toContain(
        `Cleanup result: ${ok ? 'succeeded' : 'failed'}`,
      );
    },
  );

  test.each([true, false])(
    'previews the actual native result without invoking cleanup (ok=%s)',
    async (ok) => {
      const f = fixture();
      const appBundlePath = join(f.dir, 'OpenKnowledge.app');
      const settings = join(appBundlePath, 'settings');
      mkdirSync(appBundlePath);
      writeFileSync(settings, 'pre-existing settings');
      const script = buildDesktopUninstallResultScript(
        {
          appBundlePath,
          logPath: join(f.dir, 'preview.log'),
          cleanup: ok ? { ok: true } : { ok: false, error: 'simulated failure' },
        },
        f.commands,
      );
      const child = spawn('/bin/sh', ['-c', script], { stdio: 'ignore' });
      await expect(once(child, 'close')).resolves.toEqual([0, null]);
      expect(readFileSync(settings, 'utf8')).toBe('pre-existing settings');
      const events = readFileSync(f.events, 'utf8');
      expect(events).toContain(ok ? 'OpenKnowledge files were removed' : 'Cleanup didn’t finish');
      if (!ok) expect(events).not.toContain('Trash');
    },
  );
});

describe.skipIf(process.platform === 'win32')('result dialog dismissal', () => {
  test.each([
    [true, 'Cleanup log', false],
    [false, 'Cleanup log', false],
    [true, 'Reveal in Finder', false],
    [false, 'Close', false],
    [true, 'Cleanup log', true],
    [false, 'Cleanup log', true],
  ] as const)('dismisses once (ok=%s, action=%s, revealFails=%s)', (ok, action, revealFails) => {
    const f = fixture();
    const logPath = join(f.dir, 'cleanup.log');
    const appBundlePath = join(f.dir, 'OpenKnowledge.app');
    mkdirSync(appBundlePath);
    const count = join(f.dir, 'count');
    const commands = {
      ps: f.executable('ps', 'exit 1'),
      osascript: f.executable(
        'notice-once',
        `
if [ -f '${count}' ]; then
  printf 'dialog-again\\n' >> '${f.events}'
  printf 'Close\\n'
else
  touch '${count}'
  printf 'dialog\\n' >> '${f.events}'
  printf '%s\\n' '${action}'
fi`,
      ),
      open: f.executable(
        'reveal-result',
        `printf 'reveal:%s\\n' "$2" >> '${f.events}'
${revealFails ? "printf 'Finder unavailable\\n' >&2\nexit 7" : 'exit 0'}`,
      ),
    };
    const script = buildDesktopUninstallHandoffScript(
      {
        cliPath: f.executable(
          'cleanup-once',
          `printf 'cleanup\\n' >> '${f.events}'\nexit ${ok ? 0 : 31}`,
        ),
        projectPaths: [],
        logPath,
        appBundlePath,
        parentPid: 123,
        parentStartedAt: 'original',
      },
      commands,
    );
    const result = spawnSync('/bin/sh', ['-c', script], { timeout: 5000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(ok ? 0 : 1);
    const events = readFileSync(f.events, 'utf8').trim().split('\n');
    expect(events.filter((event) => event.startsWith('dialog'))).toEqual(['dialog']);
    expect(events.filter((event) => event === 'cleanup')).toEqual(['cleanup']);
    expect(events.filter((event) => event.startsWith('reveal:'))).toEqual(
      action === 'Close' ? [] : [`reveal:${action === 'Cleanup log' ? logPath : appBundlePath}`],
    );
    const log = readFileSync(logPath, 'utf8');
    expect(log).toContain(`Cleanup result: ${ok ? 'succeeded' : 'failed'}`);
    expect(log).not.toContain(`Cleanup result: ${ok ? 'failed' : 'succeeded'}`);
    if (revealFails) expect(log).toContain('Finder unavailable');
  });
});

describe.skipIf(process.platform === 'win32')('rendered uninstall result handoff', () => {
  test.each([
    [true, 0, undefined],
    [true, 10, 'log'],
    [true, 11, 'app'],
    [false, 0, undefined],
    [false, 10, 'log'],
  ] as const)(
    'waits for the result window to exit before revealing (ok=%s, result=%s)',
    (ok, result, reveal) => {
      const f = fixture();
      const logPath = join(f.dir, 'cleanup.log');
      const appBundlePath = join(f.dir, 'OpenKnowledge.app');
      const commands = {
        ...f.commands,
        ps: f.executable('ps', 'exit 1'),
        result: [
          f.executable(
            'result-ui',
            `profile="${'$'}{1#--user-data-dir=}"
printf '%s' "$profile" > '${f.dir}/profile-path'
if [ "$2" = '--ok-uninstall-progress' ]; then
  printf 'progress-ui\\n' >> '${f.events}'
  touch "$profile/ready"
  while [ ! -f "$profile/result" ]; do /bin/sleep 0.01; done
  cp "$profile/result" '${f.dir}/result'
fi
printf 'result-ui\\nresult-exited\\n' >> '${f.events}'
exit ${result}`,
          ),
        ],
        open: f.executable('finder', `printf 'reveal:%s\\n' "$2" >> '${f.events}'`),
      };
      const script = buildDesktopUninstallHandoffScript(
        {
          cliPath: f.executable('cli', `printf 'cleanup\\n' >> '${f.events}'\nexit ${ok ? 0 : 1}`),
          projectPaths: [],
          logPath,
          appBundlePath,
          parentPid: 123,
          parentStartedAt: 'old',
        },
        commands,
      );
      const outcome = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
      expect(outcome.status).toBe(ok ? 0 : 1);
      const events = readFileSync(f.events, 'utf8').trim().split('\n');
      expect(events).toEqual([
        'progress-ui',
        'cleanup',
        'result-ui',
        'result-exited',
        ...(reveal ? [`reveal:${reveal === 'log' ? logPath : appBundlePath}`] : []),
      ]);
      expect(readFileSync(join(f.dir, 'result'), 'utf8').split('\0')[0]).toBe(
        ok ? 'OpenKnowledge files were removed' : 'Cleanup didn’t finish',
      );
      const profile = readFileSync(join(f.dir, 'profile-path'), 'utf8');
      expect(profile).not.toBe('');
      expect(existsSync(profile)).toBe(false);
      expect(readFileSync(logPath, 'utf8')).toContain(
        `Cleanup result: ${ok ? 'succeeded' : 'failed'}`,
      );
    },
  );
});

describe.skipIf(process.platform === 'win32')('continuous uninstall progress', () => {
  test('keeps the original app open and does no cleanup if the progress window cannot start', () => {
    const f = fixture();
    const outcome = spawnSync(
      '/bin/sh',
      [
        '-c',
        buildDesktopUninstallHandoffScript(
          {
            cliPath: f.executable('cli', `printf 'cleanup\\n' >> '${f.events}'`),
            projectPaths: [],
            logPath: join(f.dir, 'cleanup.log'),
            appBundlePath: '/Applications/OpenKnowledge.app',
            parentPid: 123,
            parentStartedAt: 'old',
          },
          {
            ...f.commands,
            ps: f.executable('ps', 'exit 1'),
            result: [
              f.executable(
                'broken-ui',
                `printf '%s' "${'$'}{1#--user-data-dir=}" > '${f.dir}/profile-path'\nexit 7`,
              ),
            ],
          },
        ),
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    expect(outcome.status).toBe(1);
    expect(outcome.stdout).not.toContain('OK_UNINSTALL_READY');
    expect(existsSync(f.events)).toBe(false);
    expect(existsSync(readFileSync(join(f.dir, 'profile-path'), 'utf8'))).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('progress window failure boundaries', () => {
  test('falls back once when the progress process dies and preserves a cleanup failure', () => {
    const f = fixture();
    const outcome = spawnSync(
      '/bin/sh',
      [
        '-c',
        buildDesktopUninstallHandoffScript(
          {
            cliPath: f.executable(
              'cli',
              `touch '${f.dir}/cleaning'\nprintf 'cleanup\\n' >> '${f.events}'\nexit 31`,
            ),
            projectPaths: [],
            logPath: join(f.dir, 'cleanup.log'),
            appBundlePath: '/Applications/OpenKnowledge.app',
            parentPid: 123,
            parentStartedAt: 'old',
          },
          {
            ...f.commands,
            ps: f.executable('ps', 'exit 1'),
            result: [
              f.executable(
                'crashing-ui',
                `profile="${'$'}{1#--user-data-dir=}"
printf '%s' "$profile" > '${f.dir}/profile-path'
touch "$profile/ready"
while [ ! -f '${f.dir}/cleaning' ]; do /bin/sleep 0.01; done
exit 7`,
              ),
            ],
          },
        ),
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    expect(outcome.status).toBe(1);
    const events = readFileSync(f.events, 'utf8');
    expect(events.match(/cleanup\n/g)).toHaveLength(1);
    expect(events.match(/-e on run argv/g)).toHaveLength(1);
    expect(events).toContain('Cleanup didn’t finish');
    expect(events).not.toContain('OpenKnowledge files were removed');
    expect(existsSync(readFileSync(join(f.dir, 'profile-path'), 'utf8'))).toBe(false);
  });

  test('reaps its own progress process and profile if the handoff is interrupted', async () => {
    const f = fixture();
    const script = buildDesktopUninstallHandoffScript(
      {
        cliPath: f.executable('cli', `touch '${f.dir}/cleaning'`),
        projectPaths: [],
        logPath: join(f.dir, 'cleanup.log'),
        appBundlePath: '/Applications/OpenKnowledge.app',
        parentPid: 123,
        parentStartedAt: 'old',
      },
      {
        ...f.commands,
        ps: f.executable('ps', "printf 'old'"),
        result: [
          f.executable(
            'waiting-ui',
            `profile="${'$'}{1#--user-data-dir=}"
printf '%s' "$profile" > '${f.dir}/profile-path'
printf '%s' "$$" > '${f.dir}/ui-pid'
touch "$profile/ready"
exec /bin/sleep 60`,
          ),
        ],
      },
    );
    const child = spawn('/bin/sh', ['-c', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await once(child.stdout, 'data');
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      await closed;
      const pid = Number(readFileSync(join(f.dir, 'ui-pid'), 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
      expect(existsSync(readFileSync(join(f.dir, 'profile-path'), 'utf8'))).toBe(false);
      expect(existsSync(join(f.dir, 'cleaning'))).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  });
});

test.skipIf(!existsSync('/bin/dash')).each([
  { state: 'empty', ps: 'exit 0', status: 1, cleanup: false },
  { state: 'absent', ps: 'exit 1', status: 0, cleanup: true },
  { state: 'reused', ps: "printf 'replacement'", status: 0, cleanup: true },
])(
  'reaps the query watchdog promptly under dash when the parent is $state',
  ({ ps, status, cleanup }) => {
    const f = fixture();
    const script = buildDesktopUninstallHandoffScript(
      {
        cliPath: f.executable('cli', `touch '${f.dir}/cleanup-ran'`),
        projectPaths: [],
        logPath: join(f.dir, 'cleanup.log'),
        appBundlePath: '/owned/App.app',
        parentPid: 123,
        parentStartedAt: 'original',
      },
      { ...f.commands, ps: f.executable('ps', ps) },
    );
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = spawnSync('/bin/dash', ['-c', script], {
        encoding: 'utf8',
        timeout: 3000,
        env: { ...process.env, TMPDIR: f.dir },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(status);
    }
    expect(existsSync(join(f.dir, 'cleanup-ran'))).toBe(cleanup);
    expect(readdirSync(f.dir).filter((name) => name.startsWith('ok-uninstall-ps.'))).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'fails closed when process-query output cannot be read',
  () => {
    const f = fixture();
    const script = buildDesktopUninstallHandoffScript(
      {
        cliPath: f.executable('cli', `touch '${f.dir}/cleanup-ran'`),
        projectPaths: [],
        logPath: join(f.dir, 'cleanup.log'),
        appBundlePath: '/owned/App.app',
        parentPid: 123,
        parentStartedAt: 'original',
      },
      {
        ...f.commands,
        ps: f.executable(
          'ps',
          `for probe in '${f.dir}'/ok-uninstall-ps.*; do /bin/rm -f "$probe/output"; done
exit 1`,
        ),
      },
    );
    const result = spawnSync('/bin/sh', ['-c', script], {
      encoding: 'utf8',
      timeout: 3000,
      env: { ...process.env, TMPDIR: f.dir },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(existsSync(join(f.dir, 'cleanup-ran'))).toBe(false);
    expect(readFileSync(f.events, 'utf8')).toContain('Could not verify that OpenKnowledge stopped');
    expect(readdirSync(f.dir).filter((name) => name.startsWith('ok-uninstall-ps.'))).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'bounds a stuck parent identity query without starting cleanup',
  () => {
    const f = fixture();
    const script = buildDesktopUninstallHandoffScript(
      {
        cliPath: f.executable('cli', `printf 'cleanup\\n' >> '${f.events}'`),
        projectPaths: [],
        logPath: join(f.dir, 'cleanup.log'),
        appBundlePath: '/owned/App.app',
        parentPid: 123,
        parentStartedAt: 'original',
      },
      { ...f.commands, ps: f.executable('ps', 'exec /bin/sleep 30'), psTimeoutSeconds: 0.05 },
    );
    const result = spawnSync('/bin/sh', ['-c', script], {
      encoding: 'utf8',
      timeout: 3000,
      env: { ...process.env, TMPDIR: f.dir },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(readdirSync(f.dir).filter((name) => name.startsWith('ok-uninstall-ps.'))).toEqual([]);
    expect(readFileSync(f.events, 'utf8')).toContain('Could not verify that OpenKnowledge stopped');
    expect(readFileSync(f.events, 'utf8')).not.toContain('cleanup\n');
  },
);

test.skipIf(process.platform === 'win32')(
  'reports empty successful process-query output without running cleanup',
  () => {
    const f = fixture();
    const script = buildDesktopUninstallHandoffScript(
      {
        cliPath: f.executable('cli', `touch '${f.dir}/cleanup-ran'`),
        projectPaths: [],
        logPath: join(f.dir, 'cleanup.log'),
        appBundlePath: '/owned/App.app',
        parentPid: 123,
        parentStartedAt: 'original',
      },
      { ...f.commands, ps: f.executable('ps', 'exit 0') },
    );
    const result = spawnSync('/bin/sh', ['-c', script], {
      encoding: 'utf8',
      timeout: 3000,
      env: { ...process.env, TMPDIR: f.dir },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(readFileSync(f.events, 'utf8')).toContain('process query returned no start time');
    expect(readFileSync(f.events, 'utf8')).not.toContain('process query exit 0');
    expect(existsSync(join(f.dir, 'cleanup-ran'))).toBe(false);
  },
);
