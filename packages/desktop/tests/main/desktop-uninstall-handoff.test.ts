import { type SpawnSyncReturns, spawn } from 'node:child_process';
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
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildDesktopUninstallHandoffScript,
  buildDesktopUninstallResultScript,
  launchDesktopUninstallHandoff,
  runDesktopUninstallHandoffStep,
} from '../../src/main/desktop-uninstall-handoff.ts';
import { UNINSTALL_PROGRESS_READY_TIMEOUT_MS } from '../../src/main/desktop-uninstall-result.ts';
import {
  BoundedSpawnTimeoutError,
  DEFAULT_BOUNDED_SPAWN_TIMEOUT_MS,
  spawnSyncBounded,
  withCallTrail,
} from '../support/bounded-sync-spawn.test-helper.ts';

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
    const parentQuery = spawnSyncBounded('/bin/ps', ['-p', String(parentPid), '-o', 'lstart='], {
      timeoutMs: DEFAULT_BOUNDED_SPAWN_TIMEOUT_MS,
    });
    expect(
      parentQuery.status,
      `the query for the parent start time exited ${String(parentQuery.status)}, so the handoff script below would be handed an empty start time and its parent-identity check would pass against anything.\nstdout: ${parentQuery.stdout.trim()}\nstderr: ${parentQuery.stderr.trim()}`,
    ).toBe(0);
    const parentStartedAt = parentQuery.stdout.trim();
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
  ] as const)(
    'dismisses once (ok=%s, action=%s, revealFails=%s)',
    async (ok, action, revealFails) => {
      const f = fixture();
      const logPath = join(f.dir, 'cleanup.log');
      const appBundlePath = join(f.dir, 'OpenKnowledge.app');
      mkdirSync(appBundlePath);
      const count = join(f.dir, 'count');
      const commands = {
        ps: f.executable('ps', 'exit 1'),
        psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
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
      const result = await runBoundedHandoffScript({
        shell: '/bin/sh',
        script,
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: 0,
        scriptStallsForMs: inMilliseconds(HANDOFF_WATCHDOG_SECONDS),
        fixtureDir: f.dir,
      });
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
    },
  );
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
    async (ok, result, reveal) => {
      const f = fixture();
      const logPath = join(f.dir, 'cleanup.log');
      const appBundlePath = join(f.dir, 'OpenKnowledge.app');
      const commands = {
        ...f.commands,
        ps: f.executable('ps', 'exit 1'),
        psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
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
      const outcome = await runBoundedHandoffScript({
        shell: '/bin/sh',
        script,
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: 0,
        scriptStallsForMs: Math.min(
          inMilliseconds(HANDOFF_WATCHDOG_SECONDS),
          UNINSTALL_PROGRESS_READY_TIMEOUT_MS,
        ),
        fixtureDir: f.dir,
      });
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
  test('keeps the original app open and does no cleanup if the progress window cannot start', async () => {
    const f = fixture();
    const outcome = await runBoundedHandoffScript({
      shell: '/bin/sh',
      script: buildDesktopUninstallHandoffScript(
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
          psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
          result: [
            f.executable(
              'broken-ui',
              `printf '%s' "${'$'}{1#--user-data-dir=}" > '${f.dir}/profile-path'\nexit 7`,
            ),
          ],
        },
      ),
      boundMs: HANDOFF_LIVENESS_BOUND_MS,
      scriptCompletesWithinMs: 0,
      scriptStallsForMs: Math.min(
        inMilliseconds(HANDOFF_WATCHDOG_SECONDS),
        UNINSTALL_PROGRESS_READY_TIMEOUT_MS,
      ),
      fixtureDir: f.dir,
    });
    expect(outcome.status).toBe(1);
    expect(outcome.stdout).not.toContain('OK_UNINSTALL_READY');
    expect(existsSync(f.events)).toBe(false);
    expect(existsSync(readFileSync(join(f.dir, 'profile-path'), 'utf8'))).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('progress window failure boundaries', () => {
  test('falls back once when the progress process dies and preserves a cleanup failure', async () => {
    const f = fixture();
    const outcome = await runBoundedHandoffScript({
      shell: '/bin/sh',
      script: buildDesktopUninstallHandoffScript(
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
          psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
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
      boundMs: HANDOFF_LIVENESS_BOUND_MS,
      scriptCompletesWithinMs: 0,
      scriptStallsForMs: Math.min(
        inMilliseconds(HANDOFF_WATCHDOG_SECONDS),
        UNINSTALL_PROGRESS_READY_TIMEOUT_MS,
      ),
      fixtureDir: f.dir,
    });
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

const HANDOFF_BOUND_OVER_SUBJECT_WORK = 3;
const HANDOFF_STALL_OVER_BOUND = 3;
const HANDOFF_WATCHDOG_SECONDS = 30;
const HANDOFF_LIVENESS_BOUND_MS = 9000;
const STUCK_QUERY_WATCHDOG_SECONDS = 0.05;
const STUCK_QUERY_SECONDS = 30;
const PROBE_SETTLE_POLL_MS = 50;
const PROBE_SETTLE_POLLS_BEFORE_UNREAPED = 6;
const PROBE_SETTLE_WINDOW_CEILING_MS = PROBE_SETTLE_POLL_MS * PROBE_SETTLE_POLLS_BEFORE_UNREAPED;
const TRAIL_SETTLE_OVERRUN_MS = PROBE_SETTLE_POLL_MS;
const TRAIL_RESERVE_MARGIN_MS = PROBE_SETTLE_WINDOW_CEILING_MS;
const DESKTOP_PACKAGE_CI_BUDGET_MS = 300_000;
const CI_BUDGET_OVER_HANDOFF_WEDGE = 3;
const HANDOFF_WEDGE_CEILING_MS = DESKTOP_PACKAGE_CI_BUDGET_MS / CI_BUDGET_OVER_HANDOFF_WEDGE;

function inMilliseconds(scriptSeconds: number) {
  return scriptSeconds * 1000;
}

function settleWindowFor(boundMs: number) {
  return Math.min(boundMs, PROBE_SETTLE_WINDOW_CEILING_MS);
}

type BoundedHandoffCase = {
  name: string;
  shell: string;
  psBody: string;
  psTimeoutSeconds: number;
  subjectWorkMs: number;
  boundMs: number;
  attempts: number;
  status: number;
  cleanupPerAttempt: boolean;
};

const boundedHandoffCases: BoundedHandoffCase[] = [
  {
    name: 'empty',
    shell: '/bin/dash',
    psBody: 'exit 0',
    psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
    subjectWorkMs: 0,
    boundMs: HANDOFF_LIVENESS_BOUND_MS,
    attempts: 20,
    status: 1,
    cleanupPerAttempt: false,
  },
  {
    name: 'absent',
    shell: '/bin/dash',
    psBody: 'exit 1',
    psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
    subjectWorkMs: 0,
    boundMs: HANDOFF_LIVENESS_BOUND_MS,
    attempts: 20,
    status: 0,
    cleanupPerAttempt: true,
  },
  {
    name: 'reused',
    shell: '/bin/dash',
    psBody: "printf 'replacement'",
    psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
    subjectWorkMs: 0,
    boundMs: HANDOFF_LIVENESS_BOUND_MS,
    attempts: 20,
    status: 0,
    cleanupPerAttempt: true,
  },
  {
    name: 'slow to answer',
    shell: '/bin/dash',
    psBody: '/bin/sleep 3.5\nexit 1',
    psTimeoutSeconds: 60,
    subjectWorkMs: 3500,
    boundMs: 20000,
    attempts: 1,
    status: 0,
    cleanupPerAttempt: true,
  },
];

const HANDOFF_EXECUTION_TIMEOUT_MS = Math.floor(
  HANDOFF_WEDGE_CEILING_MS / boundedHandoffCases.length,
);

function boundTrailReserveFor(boundMs: number) {
  return boundMs + settleWindowFor(boundMs) + TRAIL_SETTLE_OVERRUN_MS + TRAIL_RESERVE_MARGIN_MS;
}

function attemptsDeadlineFor(boundMs: number) {
  return HANDOFF_EXECUTION_TIMEOUT_MS - boundTrailReserveFor(boundMs);
}

type RowClockOverSetup<T> = {
  readRowElapsedMs: () => number;
  setup: T;
};

function startRowClockOver<T>(buildRow: () => T): RowClockOverSetup<T> {
  const rowStartedAt = Date.now();
  return { readRowElapsedMs: () => Date.now() - rowStartedAt, setup: buildRow() };
}

function readQueryProbeResidue(dir: string) {
  return readdirSync(dir).filter((name) => name.startsWith('ok-uninstall-ps.'));
}

function countCleanupRuns(dir: string) {
  const path = join(dir, 'cleanup-ran');
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '').length;
}

function describeUnreadable(readError: unknown) {
  return `<unreadable, so this carries no record of what the run had written: ${
    readError instanceof Error ? readError.message : String(readError)
  }>`;
}

function readTextOrDescribeWhyNot(path: string) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '<absent>';
  } catch (readError) {
    return describeUnreadable(readError);
  }
}

type QueryProbeResidueReading = { readonly listed: string[] } | { readonly unreadable: string };

function readQueryProbeResidueOrDescribeWhyNot(dir: string): QueryProbeResidueReading {
  try {
    return { listed: readQueryProbeResidue(dir) };
  } catch (readError) {
    return { unreadable: describeUnreadable(readError) };
  }
}

async function describeQueryProbeResidueAcrossSettleWindow(dir: string, settleWindowMs: number) {
  const atBound = readQueryProbeResidueOrDescribeWhyNot(dir);
  if (!('listed' in atBound)) {
    return { atBound: atBound.unreadable, afterSettleWindow: atBound.unreadable };
  }
  const settleDeadline = Date.now() + settleWindowMs;
  let afterSettleWindow = atBound;
  while (afterSettleWindow.listed.length > 0 && Date.now() < settleDeadline) {
    await delay(PROBE_SETTLE_POLL_MS);
    const reading = readQueryProbeResidueOrDescribeWhyNot(dir);
    if (!('listed' in reading)) {
      return { atBound: JSON.stringify(atBound.listed), afterSettleWindow: reading.unreadable };
    }
    afterSettleWindow = reading;
  }
  return {
    atBound: JSON.stringify(atBound.listed),
    afterSettleWindow: JSON.stringify(afterSettleWindow.listed),
  };
}

type HandoffStateTrail = {
  boundMs: number;
  fixtureDir: string;
  residueReadAt: string;
};

async function readHandoffStateTrail({ boundMs, fixtureDir, residueReadAt }: HandoffStateTrail) {
  const settleWindowMs = settleWindowFor(boundMs);
  const residue = await describeQueryProbeResidueAcrossSettleWindow(fixtureDir, settleWindowMs);
  return () =>
    `query probe residue ${residueReadAt}: ${residue.atBound}\n` +
    `query probe residue after a further ${settleWindowMs}ms settle window: ${residue.afterSettleWindow}\n` +
    'residue in the first reading that is gone after the settle window means a probe was still doing honest work when that reading was taken and the window it was given was sized below it; residue present in both readings means a wait outlived that window and was never reaped.\n' +
    `script log: ${readTextOrDescribeWhyNot(join(fixtureDir, 'cleanup.log'))}\n` +
    `script events: ${readTextOrDescribeWhyNot(join(fixtureDir, 'events'))}`;
}

type BoundedHandoffTrail = {
  boundMs: number;
  elapsedMs: number;
  scriptStallsForMs: number;
  fixtureDir: string;
};

async function withBoundedHandoffTrail(
  boundError: BoundedSpawnTimeoutError,
  { boundMs, elapsedMs, scriptStallsForMs, fixtureDir }: BoundedHandoffTrail,
): Promise<unknown> {
  const readStateTrail = await readHandoffStateTrail({
    boundMs,
    fixtureDir,
    residueReadAt: 'at the bound',
  });
  return withCallTrail(
    boundError,
    () =>
      `\nthe script ran ${elapsedMs}ms against its ${boundMs}ms bound, while the stall this call polices parks for ${scriptStallsForMs}ms.\n` +
      readStateTrail(),
  );
}

type BoundedHandoffSpawn = {
  shell: string;
  script: string;
  boundMs: number;
  scriptCompletesWithinMs: number;
  scriptStallsForMs: number;
  fixtureDir: string;
};

async function runBoundedHandoffScript({
  shell,
  script,
  boundMs,
  scriptCompletesWithinMs,
  scriptStallsForMs,
  fixtureDir,
}: BoundedHandoffSpawn): Promise<SpawnSyncReturns<string>> {
  expect(
    boundMs,
    `a ${boundMs}ms bound must be at least ${HANDOFF_BOUND_OVER_SUBJECT_WORK}x the ${scriptCompletesWithinMs}ms of work this call asks the script to do, or the bound preempts the script instead of backstopping it`,
  ).toBeGreaterThanOrEqual(HANDOFF_BOUND_OVER_SUBJECT_WORK * scriptCompletesWithinMs);
  expect(
    scriptStallsForMs,
    `the stall this call polices parks the script for ${scriptStallsForMs}ms, which must be at least ${HANDOFF_STALL_OVER_BOUND}x the ${boundMs}ms bound, or finishing inside the bound is no proof the script never stalled`,
  ).toBeGreaterThanOrEqual(HANDOFF_STALL_OVER_BOUND * boundMs);
  const startedAt = Date.now();
  try {
    return spawnSyncBounded(shell, ['-c', script], {
      timeoutMs: boundMs,
      cwd: '/',
      env: { ...process.env, TMPDIR: fixtureDir },
    });
  } catch (boundError) {
    if (!(boundError instanceof BoundedSpawnTimeoutError)) throw boundError;
    throw await withBoundedHandoffTrail(boundError, {
      boundMs,
      elapsedMs: Date.now() - startedAt,
      scriptStallsForMs,
      fixtureDir,
    });
  }
}

type ExhaustedAttemptsBudgetTrail = {
  attemptsRun: number;
  attempts: number;
  boundMs: number;
  elapsedMs: number;
  deadlineMs: number;
  fixtureDir: string;
};

async function withExhaustedAttemptsBudgetTrail({
  attemptsRun,
  attempts,
  boundMs,
  elapsedMs,
  deadlineMs,
  fixtureDir,
}: ExhaustedAttemptsBudgetTrail): Promise<unknown> {
  const readStateTrail = await readHandoffStateTrail({
    boundMs,
    fixtureDir,
    residueReadAt: 'when the attempts budget ran out',
  });
  return withCallTrail(
    new Error(
      `the attempts loop stopped before attempt ${attemptsRun + 1}, having run ${attemptsRun} of ${attempts} attempts: ${elapsedMs}ms of the ${HANDOFF_EXECUTION_TIMEOUT_MS}ms this row is given are spent, past the ${deadlineMs}ms deadline the loop runs its attempts under.\n` +
        `the deadline holds ${boundTrailReserveFor(boundMs)}ms back so a ${boundMs}ms bound firing on a further attempt is raised with the readings below instead of being cut off with the row, and running on would spend it.\n`,
    ),
    readStateTrail,
  );
}

type BoundedHandoffAttempts = {
  attempts: number;
  boundMs: number;
  deadlineMs: number;
  fixtureDir: string;
  readRowElapsedMs: () => number;
  runAttempt: (attempt: number) => Promise<void>;
};

async function runBoundedHandoffAttempts({
  attempts,
  boundMs,
  deadlineMs,
  fixtureDir,
  readRowElapsedMs,
  runAttempt,
}: BoundedHandoffAttempts) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const elapsedMs = readRowElapsedMs();
    if (elapsedMs > deadlineMs) {
      throw await withExhaustedAttemptsBudgetTrail({
        attemptsRun: attempt,
        attempts,
        boundMs,
        elapsedMs,
        deadlineMs,
        fixtureDir,
      });
    }
    await runAttempt(attempt);
  }
}

describe('query probe residue across a settle window', () => {
  const RESIDUE_NAME = 'ok-uninstall-ps.left-behind';

  test('keeps the residue read at the bound when a later poll cannot list the dir', async () => {
    const f = fixture();
    writeFileSync(join(f.dir, RESIDUE_NAME), '');
    setTimeout(() => rmSync(f.dir, { recursive: true, force: true }), 0);
    const described = await describeQueryProbeResidueAcrossSettleWindow(
      f.dir,
      PROBE_SETTLE_WINDOW_CEILING_MS,
    );
    expect(
      described.atBound,
      'the reading taken at the bound was replaced by the read failure a later poll hit, so the failure it is composed into no longer records whether residue existed when the bound fired',
    ).toContain(RESIDUE_NAME);
    expect(described.afterSettleWindow).toContain('<unreadable');
  });

  test('lists the residue in both readings when nothing reaps it inside the window', async () => {
    const f = fixture();
    writeFileSync(join(f.dir, RESIDUE_NAME), '');
    const described = await describeQueryProbeResidueAcrossSettleWindow(
      f.dir,
      PROBE_SETTLE_WINDOW_CEILING_MS,
    );
    expect(described.atBound).toBe(JSON.stringify([RESIDUE_NAME]));
    expect(
      described.afterSettleWindow,
      'residue that no poll ever reaped must still be listed after the settle window, or a wait that outlived the bound reads the same as a probe that cleaned up after itself',
    ).toBe(JSON.stringify([RESIDUE_NAME]));
  });

  test('reports an empty reading after the window when the residue is reaped inside it', async () => {
    const f = fixture();
    const residue = join(f.dir, RESIDUE_NAME);
    writeFileSync(residue, '');
    setTimeout(() => rmSync(residue, { force: true }), 0);
    const described = await describeQueryProbeResidueAcrossSettleWindow(
      f.dir,
      PROBE_SETTLE_WINDOW_CEILING_MS,
    );
    expect(described.atBound).toBe(JSON.stringify([RESIDUE_NAME]));
    expect(
      described.afterSettleWindow,
      'residue reaped inside the settle window must leave the later reading empty, or a probe that was still doing honest work reads the same as a wait that was never reaped',
    ).toBe('[]');
  });
});

describe('bounded uninstall handoff spawns', () => {
  test('charges the row clock for the row setup it is started over', () => {
    const { readRowElapsedMs, setup: setupSpanMs } = startRowClockOver(() => {
      const setupStartedAt = Date.now();
      let spanMs = 0;
      while (spanMs === 0) spanMs = Date.now() - setupStartedAt;
      return spanMs;
    });
    const chargedMs = readRowElapsedMs();
    expect(
      chargedMs,
      `the row clock was charged ${chargedMs}ms against ${setupSpanMs}ms that the row setup itself measured while the clock ran over it, so the clock was started after that setup rather than before it, and a deadline this file subtracts from the whole row budget would be measured against a clock the row timeout is not`,
    ).toBeGreaterThanOrEqual(setupSpanMs);
  });

  test.each(boundedHandoffCases)(
    'the $name bound outlives the work the case asks for and is outlived by the watchdog it polices',
    ({ attempts, subjectWorkMs, boundMs, psTimeoutSeconds }) => {
      const watchdogMs = inMilliseconds(psTimeoutSeconds);
      expect(
        boundMs,
        `a ${boundMs}ms bound must be at least ${HANDOFF_BOUND_OVER_SUBJECT_WORK}x the ${subjectWorkMs}ms of work this case asks the script to do, or the bound preempts the script instead of backstopping it`,
      ).toBeGreaterThanOrEqual(HANDOFF_BOUND_OVER_SUBJECT_WORK * subjectWorkMs);
      expect(
        watchdogMs,
        `an unreaped watchdog parks for ${watchdogMs}ms, which must be at least ${HANDOFF_STALL_OVER_BOUND}x the ${boundMs}ms bound, or finishing inside the bound is no proof the watchdog was reaped`,
      ).toBeGreaterThanOrEqual(HANDOFF_STALL_OVER_BOUND * boundMs);
      expect(
        HANDOFF_EXECUTION_TIMEOUT_MS,
        `the ${HANDOFF_EXECUTION_TIMEOUT_MS}ms this row is given does not cover the ${boundTrailReserveFor(boundMs)}ms one attempt needs to blow its ${boundMs}ms bound and still be raised with the ${settleWindowFor(boundMs)}ms settle window, the ${TRAIL_SETTLE_OVERRUN_MS}ms that window can overrun by, being the one poll it tests its deadline before spending rather than after, and a further ${TRAIL_RESERVE_MARGIN_MS}ms held back, which is as long again as the longest settle window this file will wait out, so this row admits no attempt at all`,
      ).toBeGreaterThanOrEqual(boundTrailReserveFor(boundMs));
      const declaredWorkMs = attempts * subjectWorkMs;
      expect(
        attemptsDeadlineFor(boundMs),
        `the ${attemptsDeadlineFor(boundMs)}ms the row leaves for ${attempts} attempts is under the ${declaredWorkMs}ms of work this case declares them (${attempts} x ${subjectWorkMs}ms), so the loop would stop on its deadline before the case had run. this reads the table and binds only where the table declares work: a case at 0ms per attempt puts no floor here whatever its attempts count holds, and what covers such a row is the loop's own deadline at run time, which stops it with the residue trail rather than letting the row overrun`,
      ).toBeGreaterThanOrEqual(declaredWorkMs);
    },
  );

  test.skipIf(!existsSync('/bin/dash')).each(boundedHandoffCases)(
    'finishes inside its bound leaving no query probe behind when the parent is $name',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (boundedCase) => {
      const {
        readRowElapsedMs,
        setup: { f, script },
      } = startRowClockOver(() => {
        const built = fixture();
        return {
          f: built,
          script: buildDesktopUninstallHandoffScript(
            {
              cliPath: built.executable('cli', `printf 'ran\\n' >> '${built.dir}/cleanup-ran'`),
              projectPaths: [],
              logPath: join(built.dir, 'cleanup.log'),
              appBundlePath: '/owned/App.app',
              parentPid: 123,
              parentStartedAt: 'original',
            },
            {
              ...built.commands,
              ps: built.executable('ps', boundedCase.psBody),
              psTimeoutSeconds: boundedCase.psTimeoutSeconds,
            },
          ),
        };
      });
      await runBoundedHandoffAttempts({
        attempts: boundedCase.attempts,
        boundMs: boundedCase.boundMs,
        deadlineMs: attemptsDeadlineFor(boundedCase.boundMs),
        fixtureDir: f.dir,
        readRowElapsedMs,
        runAttempt: async () => {
          const result = await runBoundedHandoffScript({
            shell: boundedCase.shell,
            script,
            boundMs: boundedCase.boundMs,
            scriptCompletesWithinMs: boundedCase.subjectWorkMs,
            scriptStallsForMs: inMilliseconds(boundedCase.psTimeoutSeconds),
            fixtureDir: f.dir,
          });
          expect({ status: result.status, probeResidue: readQueryProbeResidue(f.dir) }).toEqual({
            status: boundedCase.status,
            probeResidue: [],
          });
        },
      });
      expect(countCleanupRuns(f.dir)).toBe(
        boundedCase.cleanupPerAttempt ? boundedCase.attempts : 0,
      );
    },
  );

  test('stops the attempts loop with the residue trail once the reserve can no longer be funded', async () => {
    const BUDGET_EXHAUSTED_ATTEMPTS = 3;
    const BUDGET_EXHAUSTED_DEADLINE_MS = attemptsDeadlineFor(HANDOFF_LIVENESS_BOUND_MS);
    const ELAPSED_ON_THE_DEADLINE_MS = BUDGET_EXHAUSTED_DEADLINE_MS;
    const ELAPSED_PAST_THE_DEADLINE_MS = BUDGET_EXHAUSTED_DEADLINE_MS + TRAIL_SETTLE_OVERRUN_MS;
    const EXHAUSTED_BUDGET_PROBE = 'ok-uninstall-ps.budget-exhausted-wait';
    const f = fixture();
    writeFileSync(join(f.dir, EXHAUSTED_BUDGET_PROBE), '');
    const admitted: number[] = [];
    let elapsedReadings = 0;
    let raised: unknown = new Error(
      'the attempts loop ran every attempt it was given instead of stopping on its deadline',
    );
    try {
      await runBoundedHandoffAttempts({
        attempts: BUDGET_EXHAUSTED_ATTEMPTS,
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        deadlineMs: BUDGET_EXHAUSTED_DEADLINE_MS,
        fixtureDir: f.dir,
        readRowElapsedMs: () => {
          const readingIsTheFirst = elapsedReadings === 0;
          elapsedReadings += 1;
          return readingIsTheFirst ? ELAPSED_ON_THE_DEADLINE_MS : ELAPSED_PAST_THE_DEADLINE_MS;
        },
        runAttempt: async (attempt) => {
          admitted.push(attempt);
        },
      });
    } catch (budgetError) {
      raised = budgetError;
    }
    expect(
      admitted,
      `the loop reading ${ELAPSED_ON_THE_DEADLINE_MS}ms then ${ELAPSED_PAST_THE_DEADLINE_MS}ms spent against a ${BUDGET_EXHAUSTED_DEADLINE_MS}ms deadline did not admit exactly the attempt that was on the deadline and refuse the one past it, so its stopping is not decided by the deadline it was given`,
    ).toEqual([0]);
    expect(
      raised,
      'a loop stopped on its own deadline raises the type a blown spawn bound raises, so the two reds cannot be told apart by anything but prose',
    ).not.toBeInstanceOf(BoundedSpawnTimeoutError);
    if (!(raised instanceof Error)) throw raised;
    const rendered = raised.message;
    expect(
      rendered,
      `the raised failure does not say how much of the declared run it got through, so a row that stopped early reads the same as one that ran every attempt:\n${rendered}`,
    ).toContain(`having run 1 of ${BUDGET_EXHAUSTED_ATTEMPTS} attempts`);
    const spend = /(\d+)ms of the (\d+)ms this row is given are spent/.exec(rendered);
    expect(
      spend,
      `the raised failure carries no spent-against-row-budget sentence, so nothing in it says how close to the row ceiling the loop had got:\n${rendered}`,
    ).not.toBeNull();
    expect(
      Number(spend?.[2]),
      'the sentence renders a ceiling other than the one the row is given, so it is reporting the loop against some other budget',
    ).toBe(HANDOFF_EXECUTION_TIMEOUT_MS);
    expect(
      Number(spend?.[1]),
      `the sentence renders a spend other than the ${ELAPSED_PAST_THE_DEADLINE_MS}ms reading that stopped the loop, so the figure it reports is not the one the deadline was measured against`,
    ).toBe(ELAPSED_PAST_THE_DEADLINE_MS);
    expect(
      rendered,
      'the raised failure does not name the reserve the deadline was holding back, so a reader cannot tell what stopping early bought them',
    ).toContain(`holds ${boundTrailReserveFor(HANDOFF_LIVENESS_BOUND_MS)}ms back`);
    expect(
      rendered,
      `the probe planted in ${f.dir} is missing from one of the two readings, so a loop stopped on its deadline carries less of the fixture state than a fired bound does`,
    ).toContain(
      `query probe residue when the attempts budget ran out: ${JSON.stringify([EXHAUSTED_BUDGET_PROBE])}\n` +
        `query probe residue after a further ${settleWindowFor(HANDOFF_LIVENESS_BOUND_MS)}ms settle window: ${JSON.stringify([EXHAUSTED_BUDGET_PROBE])}\n`,
    );
    expect(
      rendered,
      'the raised failure reports a spawn budget being exceeded, but the loop stopped before starting the spawn that would have had one',
    ).not.toContain('spawn budget');
  });

  test.skipIf(process.platform === 'win32')(
    'reports the blown bound with the stall it polices and the residue nothing reaped',
    async () => {
      const FIRED_BOUND_MS = 400;
      const FIRED_BOUND_STALL_SECONDS = 2;
      const UNREAPED_PROBE = 'ok-uninstall-ps.unreaped-wait';
      const f = fixture();
      writeFileSync(join(f.dir, UNREAPED_PROBE), '');
      let raised: unknown = new Error('the bounded spawn returned instead of blowing its bound');
      try {
        await runBoundedHandoffScript({
          shell: '/bin/sh',
          script: `exec /bin/sleep ${FIRED_BOUND_STALL_SECONDS}`,
          boundMs: FIRED_BOUND_MS,
          scriptCompletesWithinMs: 0,
          scriptStallsForMs: inMilliseconds(FIRED_BOUND_STALL_SECONDS),
          fixtureDir: f.dir,
        });
      } catch (boundError) {
        raised = boundError;
      }
      if (!(raised instanceof BoundedSpawnTimeoutError)) throw raised;
      expect(
        raised.timeoutMs,
        'the seat did not raise the bound it was given, so the catch that composes the trail below never ran against a real fired bound',
      ).toBe(FIRED_BOUND_MS);
      const rendered = raised.message;
      const timings =
        /the script ran (\d+)ms against its (\d+)ms bound, while the stall this call polices parks for (\d+)ms\./.exec(
          rendered,
        );
      expect(
        timings,
        `the raised failure carries no elapsed-against-bound sentence, so nothing in it says how far the run got before the bound fired:\n${rendered}`,
      ).not.toBeNull();
      expect(
        { bound: Number(timings?.[2]), stall: Number(timings?.[3]) },
        'the bound and the stall this call declared are not the figures the sentence renders, so it is describing some other call',
      ).toEqual({ bound: FIRED_BOUND_MS, stall: inMilliseconds(FIRED_BOUND_STALL_SECONDS) });
      expect(
        Number(timings?.[1]),
        'the sentence renders a run that finished before the bound it reports blowing, so the elapsed and bound figures are not the ones this call bound',
      ).toBeGreaterThanOrEqual(Number(timings?.[2]));
      expect(
        rendered,
        `the probe planted in ${f.dir} is missing from one of the two readings, so the failure does not show a wait that outlived the bound and was never reaped`,
      ).toContain(
        `query probe residue at the bound: ${JSON.stringify([UNREAPED_PROBE])}\n` +
          `query probe residue after a further ${settleWindowFor(FIRED_BOUND_MS)}ms settle window: ${JSON.stringify([UNREAPED_PROBE])}\n`,
      );
    },
  );

  test.skipIf(process.platform === 'win32')(
    'reports the blown bound when the diagnostic trail cannot be read',
    async () => {
      const TRAIL_READ_FAILURE_BOUND_MS = 250;
      const unreadableFixtureDir = join(tmpdir(), 'ok-uninstall-handoff-never-created');
      expect(
        existsSync(unreadableFixtureDir),
        'this case needs a state dir the residue read cannot list, and one is present, so the read would succeed and the case would assert nothing',
      ).toBe(false);
      const startedAt = Date.now();
      let raised: unknown = new Error('the spawn returned instead of blowing its bound');
      try {
        spawnSyncBounded('/bin/sh', ['-c', 'exec /bin/sleep 1'], {
          timeoutMs: TRAIL_READ_FAILURE_BOUND_MS,
          cwd: '/',
          env: { ...process.env, TMPDIR: unreadableFixtureDir },
        });
      } catch (boundError) {
        raised =
          boundError instanceof BoundedSpawnTimeoutError
            ? await withBoundedHandoffTrail(boundError, {
                boundMs: TRAIL_READ_FAILURE_BOUND_MS,
                elapsedMs: Date.now() - startedAt,
                scriptStallsForMs: inMilliseconds(1),
                fixtureDir: unreadableFixtureDir,
              })
            : boundError;
      }
      expect(
        raised instanceof BoundedSpawnTimeoutError ? raised.timeoutMs : raised,
        'composing the diagnostic trail replaced the blown bound with an unrelated failure, so the caller can no longer tell a run that outlived its budget from a state dir that could not be read',
      ).toBe(TRAIL_READ_FAILURE_BOUND_MS);
    },
  );
});

describe('shipped process-query watchdog', () => {
  const SHIPPED_WATCHDOG_LINE = "/bin/sleep '5' &";

  test('arms the watchdog from the default when the caller supplies no timeout', () => {
    const script = buildDesktopUninstallHandoffScript(
      {
        cliPath: '/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh',
        projectPaths: [],
        logPath: '/tmp/uninstall.log',
        appBundlePath: '/Applications/OpenKnowledge.app',
        parentPid: 123,
        parentStartedAt: 'original process',
      },
      {},
    );
    expect(
      script,
      `a script built without a psTimeoutSeconds override emitted no ${SHIPPED_WATCHDOG_LINE} line, so the shipped default at src/main/desktop-uninstall-handoff.ts:219 moved`,
    ).toContain(SHIPPED_WATCHDOG_LINE);
  });
});

test.skipIf(process.platform === 'win32')(
  'fails closed when process-query output cannot be read',
  async () => {
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
        psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
      },
    );
    const result = await runBoundedHandoffScript({
      shell: '/bin/sh',
      script,
      boundMs: HANDOFF_LIVENESS_BOUND_MS,
      scriptCompletesWithinMs: 0,
      scriptStallsForMs: inMilliseconds(HANDOFF_WATCHDOG_SECONDS),
      fixtureDir: f.dir,
    });
    expect(result.status).toBe(1);
    expect(existsSync(join(f.dir, 'cleanup-ran'))).toBe(false);
    expect(readFileSync(f.events, 'utf8')).toContain('Could not verify that OpenKnowledge stopped');
    expect(readdirSync(f.dir).filter((name) => name.startsWith('ok-uninstall-ps.'))).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'bounds a stuck parent identity query without starting cleanup',
  async () => {
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
      {
        ...f.commands,
        ps: f.executable('ps', `exec /bin/sleep ${STUCK_QUERY_SECONDS}`),
        psTimeoutSeconds: STUCK_QUERY_WATCHDOG_SECONDS,
      },
    );
    const result = await runBoundedHandoffScript({
      shell: '/bin/sh',
      script,
      boundMs: HANDOFF_LIVENESS_BOUND_MS,
      scriptCompletesWithinMs: inMilliseconds(STUCK_QUERY_WATCHDOG_SECONDS),
      scriptStallsForMs: inMilliseconds(STUCK_QUERY_SECONDS),
      fixtureDir: f.dir,
    });
    expect(result.status).toBe(1);
    expect(readdirSync(f.dir).filter((name) => name.startsWith('ok-uninstall-ps.'))).toEqual([]);
    expect(readFileSync(f.events, 'utf8')).toContain('Could not verify that OpenKnowledge stopped');
    expect(readFileSync(f.events, 'utf8')).not.toContain('cleanup\n');
  },
);

test.skipIf(process.platform === 'win32')(
  'reports empty successful process-query output without running cleanup',
  async () => {
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
        ps: f.executable('ps', 'exit 0'),
        psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
      },
    );
    const result = await runBoundedHandoffScript({
      shell: '/bin/sh',
      script,
      boundMs: HANDOFF_LIVENESS_BOUND_MS,
      scriptCompletesWithinMs: 0,
      scriptStallsForMs: inMilliseconds(HANDOFF_WATCHDOG_SECONDS),
      fixtureDir: f.dir,
    });
    expect(result.status).toBe(1);
    expect(readFileSync(f.events, 'utf8')).toContain('process query returned no start time');
    expect(readFileSync(f.events, 'utf8')).not.toContain('process query exit 0');
    expect(existsSync(join(f.dir, 'cleanup-ran'))).toBe(false);
  },
);
