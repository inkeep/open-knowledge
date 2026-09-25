import { type SpawnSyncReturns, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { shellQuote } from '../../src/main/desktop-uninstall.ts';
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

const NO_START_TIME_OUTCOME =
  'Could not verify that OpenKnowledge stopped (process query returned no start time); no cleanup was started.';
const QUERY_GAVE_UP_OUTCOME =
  'Could not verify that OpenKnowledge stopped (process query exit 2); no cleanup was started.';
const CLEANUP_SUCCEEDED_OUTCOME = 'Cleanup result: succeeded';

const FAILED_CLOSED_FOR_ANOTHER_REASON =
  /^Could not verify that OpenKnowledge stopped \((?!process query returned no start time\)).+\); no cleanup was started\.$/;

type BoundedHandoffCase = {
  name: string;
  shell: string;
  psBody: string;
  psTimeoutSeconds: number;
  subjectWorkMs: number;
  boundMs: number;
  attempts: number;
  status: number;
  loggedOutcome: string;
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
    loggedOutcome: NO_START_TIME_OUTCOME,
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
    loggedOutcome: CLEANUP_SUCCEEDED_OUTCOME,
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
    loggedOutcome: CLEANUP_SUCCEEDED_OUTCOME,
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
    loggedOutcome: CLEANUP_SUCCEEDED_OUTCOME,
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

function readCleanupLog(dir: string) {
  const path = join(dir, 'cleanup.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function lastLoggedLine(logText: string) {
  return logText.trimEnd().split('\n').pop() ?? '';
}

type BoundedHandoffOutcome = {
  status: number | null;
  probeResidue: string[];
  loggedOutcome: string;
};

function readBoundedHandoffOutcome(
  dir: string,
  result: SpawnSyncReturns<string>,
  logBeforeRun: string,
): BoundedHandoffOutcome {
  return {
    status: result.status,
    probeResidue: readQueryProbeResidue(dir),
    loggedOutcome: lastLoggedLine(readCleanupLog(dir).slice(logBeforeRun.length)),
  };
}

function expectedBoundedHandoffOutcome({
  status,
  loggedOutcome,
}: Pick<BoundedHandoffCase, 'status' | 'loggedOutcome'>): BoundedHandoffOutcome {
  return { status, probeResidue: [], loggedOutcome };
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
          const logBeforeRun = readCleanupLog(f.dir);
          const result = await runBoundedHandoffScript({
            shell: boundedCase.shell,
            script,
            boundMs: boundedCase.boundMs,
            scriptCompletesWithinMs: boundedCase.subjectWorkMs,
            scriptStallsForMs: inMilliseconds(boundedCase.psTimeoutSeconds),
            fixtureDir: f.dir,
          });
          expect(readBoundedHandoffOutcome(f.dir, result, logBeforeRun)).toEqual(
            expectedBoundedHandoffOutcome(boundedCase),
          );
        },
      });
      expect(countCleanupRuns(f.dir)).toBe(
        boundedCase.cleanupPerAttempt ? boundedCase.attempts : 0,
      );
    },
  );

  test.skipIf(!existsSync('/bin/dash'))(
    'tells a parent with no start time from a process query that could not run, which exits with the same status',
    () => {
      const emptyCase = boundedHandoffCases.find(({ name }) => name === 'empty');
      if (emptyCase === undefined) {
        throw new Error(
          'the bounded cases no longer carry an empty row, so there is no row check left for this to prove',
        );
      }
      const f = fixture();
      const commands = {
        ...f.commands,
        ps: f.executable('ps', emptyCase.psBody),
        psTimeoutSeconds: emptyCase.psTimeoutSeconds,
      };
      const script = buildDesktopUninstallHandoffScript(
        {
          cliPath: f.executable('cli', `printf 'ran\\n' >> '${f.dir}/cleanup-ran'`),
          projectPaths: [],
          logPath: join(f.dir, 'cleanup.log'),
          appBundlePath: '/owned/App.app',
          parentPid: 123,
          parentStartedAt: 'original',
        },
        commands,
      );
      const result = spawnSyncBounded(emptyCase.shell, ['-c', script], {
        timeoutMs: emptyCase.boundMs,
        cwd: '/',
        env: { ...process.env, TMPDIR: join(f.dir, 'probe-root-never-created') },
      });
      expect(
        lastLoggedLine(readCleanupLog(f.dir)),
        'a query probe root that cannot be created must make the handoff fail closed for a reason other than a missing start time, as an exhausted readiness wait does, or this run is not the look-alike the empty row has to reject',
      ).toMatch(FAILED_CLOSED_FOR_ANOTHER_REASON);
      expect(
        { status: result.status, probeResidue: readQueryProbeResidue(f.dir) },
        'status and residue alone must read this run as an empty parent, or the reason assertion below would be proving nothing the status did not already prove',
      ).toEqual({ status: emptyCase.status, probeResidue: [] });
      expect(
        readBoundedHandoffOutcome(f.dir, result, ''),
        'the empty row accepted a run whose process query never ran, so a readiness wait that gave up passes that row as a parent with no start time',
      ).not.toEqual(expectedBoundedHandoffOutcome(emptyCase));
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

function distinctInstalledShells(candidates: readonly string[]) {
  const seen = new Set<string>();
  return candidates.filter((shell) => {
    if (!existsSync(shell)) return false;
    const resolved = realpathSync(shell);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

const UNINSTALL_SHELLS = distinctInstalledShells(['/bin/sh', '/bin/dash']);
const ZSH = '/bin/zsh';

type HandoffFixture = ReturnType<typeof fixture>;

function handoffInput(f: HandoffFixture) {
  return {
    cliPath: f.executable('cli', `printf 'ran\\n' >> '${f.dir}/cleanup-ran'`),
    projectPaths: [],
    logPath: join(f.dir, 'cleanup.log'),
    appBundlePath: '/owned/App.app',
    parentPid: 123,
    parentStartedAt: 'original',
  };
}

function countRecordedLines(path: string) {
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '').length;
}

const CATCHABLE_STOP_SIGNALS = ['HUP', 'INT', 'QUIT', 'TERM', 'USR1', 'USR2', 'ALRM'] as const;
const ABSORBED_STOP_WATCHDOG_SECONDS =
  (HANDOFF_STALL_OVER_BOUND * HANDOFF_LIVENESS_BOUND_MS) / 1000;
const SIGNAL_DISPOSITION_READER = '/usr/bin/perl';

function withCatchableStopSignalsIgnored(shell: string, script: string) {
  return `trap '' ${CATCHABLE_STOP_SIGNALS.join(' ')}; exec ${shellQuote(shell)} -c ${shellQuote(script)}`;
}

type AbsorbedStopCase = {
  name: string;
  psBody: (dir: string) => string;
  status: number;
  loggedOutcome: string;
  cleanupRuns: number;
};

const absorbedStopCases: AbsorbedStopCase[] = [
  {
    name: 'empty',
    psBody: () => 'exit 0',
    status: 1,
    loggedOutcome: NO_START_TIME_OUTCOME,
    cleanupRuns: 0,
  },
  {
    name: 'absent',
    psBody: () => 'exit 1',
    status: 0,
    loggedOutcome: CLEANUP_SUCCEEDED_OUTCOME,
    cleanupRuns: 1,
  },
  {
    name: 'answered but unreadable',
    psBody: (dir) =>
      `for probe in '${dir}'/ok-uninstall-ps.*; do /bin/rm -f "$probe/output"; done\nexit 1`,
    status: 1,
    loggedOutcome: expect.stringMatching(FAILED_CLOSED_FOR_ANOTHER_REASON),
    cleanupRuns: 0,
  },
];

const absorbedStopRows = UNINSTALL_SHELLS.flatMap((shell) =>
  absorbedStopCases.map((stopCase) => ({ ...stopCase, shell })),
);

describe.skipIf(process.platform === 'win32')(
  'process query stops that do not depend on a catchable signal being acted on',
  () => {
    test.skipIf(!existsSync(SIGNAL_DISPOSITION_READER)).each(UNINSTALL_SHELLS)(
      'starts %s so that no trap any of its shells sets can act on a catchable stop signal',
      (shell) => {
        const signals = CATCHABLE_STOP_SIGNALS.join(' ');
        const probe = `( trap : ${signals}; exec ${SIGNAL_DISPOSITION_READER} -e 'print join(" ", map { "$_=" . ($SIG{$_} // "DEFAULT") } @ARGV)' ${signals} )`;
        const result = spawnSyncBounded(
          '/bin/sh',
          ['-c', withCatchableStopSignalsIgnored(shell, probe)],
          { timeoutMs: HANDOFF_LIVENESS_BOUND_MS, cwd: '/' },
        );
        expect(
          result.stdout,
          `a subshell of ${shell} that traps every catchable stop signal handed its exec'd child dispositions other than IGNORE, so a trap took hold and the rows below would be exercising a watchdog that still acts on the signal it is sent`,
        ).toBe(CATCHABLE_STOP_SIGNALS.map((signal) => `${signal}=IGNORE`).join(' '));
      },
    );

    test.each(absorbedStopRows)(
      'finishes inside its bound leaving no query probe behind when the parent is $name and $shell cannot act on a catchable stop signal',
      { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
      async ({ shell, psBody, status, loggedOutcome, cleanupRuns }) => {
        const f = fixture();
        const script = buildDesktopUninstallHandoffScript(handoffInput(f), {
          ...f.commands,
          ps: f.executable('ps', psBody(f.dir)),
          psTimeoutSeconds: ABSORBED_STOP_WATCHDOG_SECONDS,
        });
        const result = await runBoundedHandoffScript({
          shell: '/bin/sh',
          script: withCatchableStopSignalsIgnored(shell, script),
          boundMs: HANDOFF_LIVENESS_BOUND_MS,
          scriptCompletesWithinMs: 0,
          scriptStallsForMs: inMilliseconds(ABSORBED_STOP_WATCHDOG_SECONDS),
          fixtureDir: f.dir,
        });
        expect(readBoundedHandoffOutcome(f.dir, result, '')).toEqual(
          expectedBoundedHandoffOutcome({ status, loggedOutcome }),
        );
        expect(countCleanupRuns(f.dir)).toBe(cleanupRuns);
      },
    );
  },
);

type SignalRecord = Readonly<Partial<Record<string, string>>>;

function parseSignalRecord(line: string): SignalRecord {
  return Object.fromEntries(
    line.split(' ').map((field) => {
      const separator = field.indexOf('=');
      return [field.slice(0, separator), field.slice(separator + 1)];
    }),
  );
}

function signalRecorder(f: HandoffFixture) {
  const recordsPath = join(f.dir, 'signals');
  const path = f.executable(
    'signal-recorder',
    `set -f
case "$1" in
  -s) signal=$2; shift 2 ;;
  -*) signal=${'$'}{1#-}; shift ;;
  *) signal='' ;;
esac
if [ "$1" = -- ]; then shift; fi
target=${'$'}{1-}
record="sender=$PPID self=$$ signal=$signal target=$target"
if [ "$#" -ne 1 ] || [ -z "$signal" ]; then
  printf '%s refused=call\\n' "$record" >> '${recordsPath}'
  exit 1
fi
case "$target" in
  ''|*[!0-9]*|0*|1)
    printf '%s refused=target\\n' "$record" >> '${recordsPath}'
    exit 1
    ;;
esac
set -- $(/bin/ps -o ppid= -o stat= -p "$target" 2>/dev/null)
record="$record parent=${'$'}{1:-gone} state=${'$'}{2:-gone}"
if [ "$signal" = 0 ]; then
  /bin/kill -s 0 "$target" 2>/dev/null
  status=$?
  printf '%s probed=%s\\n' "$record" "$status" >> '${recordsPath}'
  exit "$status"
fi
if [ "${'$'}{1:-}" = "$PPID" ] || [ "${'$'}{1:-}" = "$$" ]; then
  /bin/kill -s "$signal" "$target" 2>/dev/null
  status=$?
  printf '%s delivered=%s\\n' "$record" "$status" >> '${recordsPath}'
  exit "$status"
fi
printf '%s refused=unheld\\n' "$record" >> '${recordsPath}'
exit 1`,
  );
  return {
    path,
    read(): SignalRecord[] {
      if (!existsSync(recordsPath)) return [];
      return readFileSync(recordsPath, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map(parseSignalRecord);
    },
  };
}

function describeSignalRecord(record: SignalRecord) {
  const disposition =
    record.refused === undefined
      ? `delivered with status ${record.delivered ?? record.probed}`
      : `refused as ${record.refused}`;
  return `${record.signal} from pid ${record.sender} to pid ${record.target}, whose parent was ${record.parent ?? 'never read'}: ${disposition}`;
}

function signalsTheirSenderDidNotHold(records: readonly SignalRecord[]) {
  return records
    .filter((record) => record.signal !== '0' && record.refused !== undefined)
    .map(describeSignalRecord);
}

const RAW_SIGNAL_SENDER =
  /(?:^|[;&|!({`'"]|\b(?:then|do|else|elif|if|while|until)\b)\s*(?:(?:command|builtin|exec)\s+|\\)?(?:\S*\/)?(?:p?kill|killall)(?![\w=.-])/;

function signalsSentOutsideTheSeam(script: string) {
  return script
    .split('\n')
    .flatMap((line, index) =>
      RAW_SIGNAL_SENDER.test(line) ? [`line ${index + 1}: ${line.trim()}`] : [],
    );
}

const SEAM_SIGNAL_SEND = /"\$KILL"\s+(?:-s\s+(\w+)|-(\w+))\s+(?:--\s+)?"(\$\w+)"/g;

function seamSignalSends(line: string) {
  return Array.from(line.matchAll(SEAM_SIGNAL_SEND), (send) => ({
    at: send.index,
    signal: send[1] ?? send[2] ?? '',
    target: send[3] ?? '',
  }));
}

function probeOfTheSameChildComesFirst(line: string, target: string, at: number) {
  const probe = new RegExp(`\\bif\\s+"\\$KILL"\\s+-s\\s+0\\s+"\\$${target.slice(1)}"`, 'g');
  return Array.from(line.matchAll(probe)).some((guard) => guard.index < at);
}

function signalsNotSentAsAGuardedKill(script: string) {
  return script.split('\n').flatMap((line, index) =>
    seamSignalSends(line).flatMap(({ at, signal, target }) => {
      if (signal === '0') return [];
      if (signal !== 'KILL') return [`line ${index + 1}: ${signal} to ${target}: ${line.trim()}`];
      if (probeOfTheSameChildComesFirst(line, target, at)) return [];
      return [`line ${index + 1}: unguarded KILL to ${target}: ${line.trim()}`];
    }),
  );
}

function nonZeroSeamSignalCount(script: string) {
  return script
    .split('\n')
    .flatMap(seamSignalSends)
    .filter(({ signal }) => signal !== '0').length;
}

function withSignalSeam<T extends object>(commands: T, kill: string): T & { kill: string } {
  return { ...commands, kill };
}

function expectEverySignalRoutedThrough(recorderPath: string, script: string) {
  expect(
    signalsSentOutsideTheSeam(script),
    'the script sends these signals with a kill of its own instead of through commands.kill, so nothing can see what they target, and a released or sibling pid among them reaches the kernel unobserved',
  ).toEqual([]);
  expect(
    script.includes(recorderPath),
    `the script was built with commands.kill set to ${recorderPath} and never names it, so commands.kill is not wired into the generated script and no signal it sends can reach a sender a test injects`,
  ).toBe(true);
}

const UNHELD_SIGNAL_FAILURE =
  'a signal went to a pid its sender did not hold as an unreaped child at the moment it was sent, so on reuse it lands on an unrelated process. The recorder refused to deliver these';

async function runKeepingTheBoundFailure(
  spawn: BoundedHandoffSpawn,
): Promise<SpawnSyncReturns<string> | BoundedSpawnTimeoutError> {
  try {
    return await runBoundedHandoffScript(spawn);
  } catch (boundError) {
    if (boundError instanceof BoundedSpawnTimeoutError) return boundError;
    throw boundError;
  }
}

describe.skipIf(process.platform === 'win32')('signals the uninstall scripts send', () => {
  test('flags every way of sending a signal around the seam, and nothing adjacent to one', () => {
    const planted = [
      '    kill -KILL "$result_pid" 2>/dev/null',
      '    if ! kill -0 "$result_pid" 2>/dev/null || [ "$ready_attempts" -ge 300 ]; then',
      '    if [ -n "$watchdog" ]; then kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null; fi',
      '/bin/kill -s TERM "$pid"',
      'command kill -s KILL "$pid"',
      '\\kill -s KILL "$pid"',
      `trap 'kill -s KILL "$ps_pid"' TERM`,
      'alive=$(kill -0 "$pid" && printf yes)',
      'pkill -f ok-uninstall',
      'killall sleep',
    ];
    const adjacent = [
      '    "$KILL" -s KILL "$result_pid" 2>/dev/null',
      '    if ! "$KILL" -s 0 "$result_pid" 2>/dev/null; then',
      "KILL='/owned/signal-recorder'",
      'Your markdown content and authored skills were kept.',
      `printf 'the helper was killed\\n' >> "$LOG"`,
      'kill_count=0',
      '    wait "$sleeper" 2>/dev/null',
      'skill=1',
    ];
    expect(
      signalsSentOutsideTheSeam(planted.join('\n')),
      'a planted signal sender went unflagged, so the routing check below can pass a script that still signals around the seam',
    ).toHaveLength(planted.length);
    expect(
      signalsSentOutsideTheSeam(adjacent.join('\n')),
      'a line that sends no signal of its own was flagged, so the routing check below can fail a script whose every signal goes through the seam',
    ).toEqual([]);
  });

  test('delivers a signal only to a child its sender still holds', () => {
    const f = fixture();
    const recorder = signalRecorder(f);
    const result = spawnSyncBounded(
      '/bin/sh',
      [
        '-c',
        `KILL=${shellQuote(recorder.path)}
/bin/sleep ${STUCK_QUERY_SECONDS} &
held=$!
/bin/sleep 0 &
released=$!
wait "$released"
"$KILL" -s KILL "$released"
( "$KILL" -s TERM "$held"; : )
"$KILL" -s KILL "$held"
wait "$held"
printf '%s %s %s\\n' "$held" "$released" "$?"`,
      ],
      { timeoutMs: HANDOFF_LIVENESS_BOUND_MS, cwd: '/' },
    );
    const [held, released, heldExit] = result.stdout.trim().split(' ');
    const roleOf = (pid: string | undefined) =>
      pid === held ? 'held' : pid === released ? 'released' : `pid ${pid}`;
    expect(
      recorder.read().map((record) => ({
        sender: record.sender === String(result.pid) ? 'script' : 'subshell',
        target: roleOf(record.target),
        signal: record.signal,
        outcome:
          record.refused === undefined
            ? `delivered ${record.delivered}`
            : `refused ${record.refused}`,
      })),
      'the recorder must refuse a pid its sender already released and a sibling it never held, and deliver to the child that is still its sender’s, or the checks built on it pass stale signals or fail held ones',
    ).toEqual([
      { sender: 'script', target: 'released', signal: 'KILL', outcome: 'refused unheld' },
      { sender: 'subshell', target: 'held', signal: 'TERM', outcome: 'refused unheld' },
      { sender: 'script', target: 'held', signal: 'KILL', outcome: 'delivered 0' },
    ]);
    expect(
      heldExit,
      'the held child did not die of the one signal the recorder reports delivering, so a delivery it records may never have reached the process',
    ).toBe('137');
  });

  test.each([
    {
      name: 'handoff script',
      build: (f: HandoffFixture, kill: string) =>
        buildDesktopUninstallHandoffScript(
          handoffInput(f),
          withSignalSeam({ ...f.commands, ps: f.executable('ps', 'exit 1') }, kill),
        ),
    },
    {
      name: 'handoff script with a progress window',
      build: (f: HandoffFixture, kill: string) =>
        buildDesktopUninstallHandoffScript(
          handoffInput(f),
          withSignalSeam(
            {
              ...f.commands,
              ps: f.executable('ps', 'exit 1'),
              result: [f.executable('progress-ui', 'exit 0')],
            },
            kill,
          ),
        ),
    },
    {
      name: 'result script with a result window',
      build: (f: HandoffFixture, kill: string) =>
        buildDesktopUninstallResultScript(
          {
            appBundlePath: '/owned/App.app',
            logPath: join(f.dir, 'cleanup.log'),
            cleanup: { ok: true },
          },
          withSignalSeam({ ...f.commands, result: [f.executable('result-ui', 'exit 0')] }, kill),
        ),
    },
  ])('routes every signal the $name sends through commands.kill', ({ build }) => {
    const f = fixture();
    const recorder = signalRecorder(f);
    expectEverySignalRoutedThrough(recorder.path, build(f, recorder.path));
  });

  test('flags every non-zero signal that is not a KILL a probe of the same child guards on its line, and nothing adjacent to one', () => {
    const planted = [
      '    if [ -n "$watchdog" ]; then "$KILL" -s TERM "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null; fi',
      '    "$KILL" -s KILL "$ps_pid" 2>/dev/null',
      '    "$KILL" -s KILL "$result_pid" 2>/dev/null',
      '    "$KILL" -KILL "$watchdog" 2>/dev/null',
      '      if "$KILL" -s 0 "$other" 2>/dev/null; then "$KILL" -s KILL "$ps_pid" 2>/dev/null; fi',
    ];
    const adjacent = [
      '      if "$KILL" -s 0 "$ps_pid" 2>/dev/null; then "$KILL" -s KILL "$ps_pid" 2>/dev/null; fi',
      '  while "$KILL" -s 0 "$ps_pid" 2>/dev/null; do',
      '    if ! "$KILL" -s 0 "$result_pid" 2>/dev/null; then',
      "KILL='/owned/signal-recorder'",
    ];
    expect(
      planted.map((line) => signalsNotSentAsAGuardedKill(line).length),
      'a planted stop was not flagged exactly once: a signal its target can catch or ignore, or a KILL that no probe of the same child guards, so the check below can pass a script whose stop a freshly forked child absorbs or that lands on a pid its sender saw exit',
    ).toEqual(planted.map(() => 1));
    expect(
      signalsNotSentAsAGuardedKill(adjacent.join('\n')),
      'a probe, or a KILL a probe of the same child guards, was flagged, so the check below can fail a script whose every stop is a guarded KILL',
    ).toEqual([]);
  });

  test.each([
    {
      name: 'handoff script',
      build: (f: HandoffFixture, kill: string) =>
        buildDesktopUninstallHandoffScript(
          handoffInput(f),
          withSignalSeam({ ...f.commands, ps: f.executable('ps', 'exit 1') }, kill),
        ),
    },
    {
      name: 'handoff script with a progress window',
      build: (f: HandoffFixture, kill: string) =>
        buildDesktopUninstallHandoffScript(
          handoffInput(f),
          withSignalSeam(
            {
              ...f.commands,
              ps: f.executable('ps', 'exit 1'),
              result: [f.executable('progress-ui', 'exit 0')],
            },
            kill,
          ),
        ),
    },
    {
      name: 'result script with a result window',
      build: (f: HandoffFixture, kill: string) =>
        buildDesktopUninstallResultScript(
          {
            appBundlePath: '/owned/App.app',
            logPath: join(f.dir, 'cleanup.log'),
            cleanup: { ok: true },
          },
          withSignalSeam({ ...f.commands, result: [f.executable('result-ui', 'exit 0')] }, kill),
        ),
    },
  ])(
    'stops a child in the $name only with a KILL a probe of that child guards on its line, leaving whose child it is and how recently it was probed to the rows that run the script',
    ({ build }) => {
      const f = fixture();
      const script = build(f, signalRecorder(f).path);
      expect(
        nonZeroSeamSignalCount(script),
        'no non-zero signal in the script matched the send pattern, so a pattern that has stopped matching the script’s sends would pass the check below having checked nothing',
      ).toBeGreaterThan(0);
      expect(
        signalsNotSentAsAGuardedKill(script),
        'the script sends these non-zero signals as something other than a KILL guarded on its line by a probe of the same child, so a freshly forked child can absorb the stop or a pid its sender saw exit can be signalled, which breaks the shell side of the AGENTS.md STOP rule "Never signal a pid you did not spawn."',
      ).toEqual([]);
    },
  );

  test.each(UNINSTALL_SHELLS)(
    'stops a process query that never answers under %s signalling only processes each sender holds',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      const f = fixture();
      const recorder = signalRecorder(f);
      const script = buildDesktopUninstallHandoffScript(
        handoffInput(f),
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable('ps', `exec /bin/sleep ${STUCK_QUERY_SECONDS}`),
            psTimeoutSeconds: STUCK_QUERY_WATCHDOG_SECONDS,
          },
          recorder.path,
        ),
      );
      expectEverySignalRoutedThrough(recorder.path, script);
      const run = await runKeepingTheBoundFailure({
        shell,
        script,
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: inMilliseconds(STUCK_QUERY_WATCHDOG_SECONDS),
        scriptStallsForMs: inMilliseconds(STUCK_QUERY_SECONDS),
        fixtureDir: f.dir,
      });
      expect(signalsTheirSenderDidNotHold(recorder.read()), UNHELD_SIGNAL_FAILURE).toEqual([]);
      if (run instanceof BoundedSpawnTimeoutError) throw run;
      expect({
        status: run.status,
        probeResidue: readQueryProbeResidue(f.dir),
        failedClosed: lastLoggedLine(readCleanupLog(f.dir)).startsWith(
          'Could not verify that OpenKnowledge stopped',
        ),
      }).toEqual({ status: 1, probeResidue: [], failedClosed: true });
    },
  );

  test.each(UNINSTALL_SHELLS)(
    'abandons a progress window that exits before it is ready under %s without signalling the pid it released',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      const f = fixture();
      const recorder = signalRecorder(f);
      const script = buildDesktopUninstallHandoffScript(
        handoffInput(f),
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable('ps', 'exit 1'),
            psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
            result: [f.executable('broken-ui', 'exit 7')],
          },
          recorder.path,
        ),
      );
      expectEverySignalRoutedThrough(recorder.path, script);
      const run = await runKeepingTheBoundFailure({
        shell,
        script,
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: 0,
        scriptStallsForMs: Math.min(
          inMilliseconds(HANDOFF_WATCHDOG_SECONDS),
          UNINSTALL_PROGRESS_READY_TIMEOUT_MS,
        ),
        fixtureDir: f.dir,
      });
      expect(signalsTheirSenderDidNotHold(recorder.read()), UNHELD_SIGNAL_FAILURE).toEqual([]);
      if (run instanceof BoundedSpawnTimeoutError) throw run;
      expect({
        status: run.status,
        announcedReady: run.stdout.includes('OK_UNINSTALL_READY'),
        cleanupRuns: countCleanupRuns(f.dir),
      }).toEqual({ status: 1, announcedReady: false, cleanupRuns: 0 });
    },
  );

  test.each(UNINSTALL_SHELLS)(
    'answers an absent parent under %s signalling only processes each sender holds',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      const f = fixture();
      const recorder = signalRecorder(f);
      const script = buildDesktopUninstallHandoffScript(
        handoffInput(f),
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable('ps', 'exit 1'),
            psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
          },
          recorder.path,
        ),
      );
      expectEverySignalRoutedThrough(recorder.path, script);
      const run = await runKeepingTheBoundFailure({
        shell,
        script,
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: 0,
        scriptStallsForMs: inMilliseconds(HANDOFF_WATCHDOG_SECONDS),
        fixtureDir: f.dir,
      });
      expect(signalsTheirSenderDidNotHold(recorder.read()), UNHELD_SIGNAL_FAILURE).toEqual([]);
      if (run instanceof BoundedSpawnTimeoutError) throw run;
      expect(readBoundedHandoffOutcome(f.dir, run, '')).toEqual(
        expectedBoundedHandoffOutcome({ status: 0, loggedOutcome: CLEANUP_SUCCEEDED_OUTCOME }),
      );
    },
  );

  test.each(UNINSTALL_SHELLS)(
    'stops its own progress window through the seam when %s is interrupted',
    async (shell) => {
      const f = fixture();
      const recorder = signalRecorder(f);
      const script = buildDesktopUninstallHandoffScript(
        handoffInput(f),
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable('ps', "printf 'original'"),
            result: [
              f.executable(
                'waiting-ui',
                `profile="${'$'}{1#--user-data-dir=}"
printf '%s' "$$" > '${f.dir}/ui-pid'
touch "$profile/ready"
exec /bin/sleep ${STUCK_QUERY_SECONDS}`,
              ),
            ],
          },
          recorder.path,
        ),
      );
      expectEverySignalRoutedThrough(recorder.path, script);
      const child = spawn(shell, ['-c', script], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, TMPDIR: f.dir },
      });
      try {
        await once(child.stdout, 'data');
        const closed = once(child, 'close');
        child.kill('SIGTERM');
        await closed;
        const records = recorder.read();
        expect(signalsTheirSenderDidNotHold(records), UNHELD_SIGNAL_FAILURE).toEqual([]);
        const windowPid = readFileSync(join(f.dir, 'ui-pid'), 'utf8');
        expect(
          records.filter(
            (record) =>
              record.target === windowPid && record.signal !== '0' && record.delivered === '0',
          ),
          'the interrupted script must stop the progress window it started, and only a signal can stop that window, so a run with no delivered signal to it means the recorder is not seeing the signals this script sends',
        ).not.toEqual([]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    },
  );
});

const PROGRESS_READY_DECLARED_WAIT_MS = HANDOFF_LIVENESS_BOUND_MS / HANDOFF_BOUND_OVER_SUBJECT_WORK;
const SHORT_SLEEP_STRETCH = HANDOFF_BOUND_OVER_SUBJECT_WORK * HANDOFF_STALL_OVER_BOUND;
const COUNTED_PROGRESS_WAIT_STALL_MS = PROGRESS_READY_DECLARED_WAIT_MS * SHORT_SLEEP_STRETCH;
const PROGRESS_WINDOW_GAVE_UP = /^The uninstall progress window .+; no cleanup was started\.$/;

describe.skipIf(process.platform === 'win32')('progress window readiness wait', () => {
  test('gives up on a progress window that never becomes ready inside the declared wait, however long each poll takes', {
    timeout: HANDOFF_EXECUTION_TIMEOUT_MS,
  }, async () => {
    vi.resetModules();
    vi.doMock('../../src/main/desktop-uninstall-result.ts', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../src/main/desktop-uninstall-result.ts')>()),
      UNINSTALL_PROGRESS_READY_TIMEOUT_MS: PROGRESS_READY_DECLARED_WAIT_MS,
    }));
    try {
      const { buildDesktopUninstallHandoffScript: buildWithDeclaredWait } = await import(
        '../../src/main/desktop-uninstall-handoff.ts'
      );
      const f = fixture();
      const sleeps = join(f.dir, 'sleeps');
      const script = buildWithDeclaredWait(handoffInput(f), {
        ...f.commands,
        ps: f.executable('ps', 'exit 1'),
        psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
        sleep: f.executable(
          'contended-sleep',
          `printf '%s\\n' "$1" >> '${sleeps}'
exec /bin/sleep "$(/usr/bin/awk -v requested="$1" -v wait=${PROGRESS_READY_DECLARED_WAIT_MS / 1000} -v stretch=${SHORT_SLEEP_STRETCH} 'BEGIN { print ((requested < wait) ? requested * stretch : requested) }')"`,
        ),
        result: [
          f.executable(
            'never-ready-ui',
            `printf '%s' "${'$'}{1#--user-data-dir=}" > '${f.dir}/profile-path'
exec /bin/sleep ${COUNTED_PROGRESS_WAIT_STALL_MS / 1000}`,
          ),
        ],
      });
      const outcome = await runBoundedHandoffScript({
        shell: '/bin/sh',
        script,
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: PROGRESS_READY_DECLARED_WAIT_MS,
        scriptStallsForMs: COUNTED_PROGRESS_WAIT_STALL_MS,
        fixtureDir: f.dir,
      });
      expect(
        countRecordedLines(sleeps),
        'the readiness wait never slept through commands.sleep, so this run never stretched a single poll and says nothing about how the wait is bounded',
      ).toBeGreaterThan(0);
      expect({
        status: outcome.status,
        announcedReady: outcome.stdout.includes('OK_UNINSTALL_READY'),
        loggedOutcome: lastLoggedLine(readCleanupLog(f.dir)),
      }).toEqual({
        status: 1,
        announcedReady: false,
        loggedOutcome: expect.stringMatching(PROGRESS_WINDOW_GAVE_UP),
      });
      expect(existsSync(readFileSync(join(f.dir, 'profile-path'), 'utf8'))).toBe(false);
      expect(existsSync(f.events)).toBe(false);
    } finally {
      vi.doUnmock('../../src/main/desktop-uninstall-result.ts');
      vi.resetModules();
    }
  });

  test.each(UNINSTALL_SHELLS)(
    'says it waited the declared time, in whole seconds, for a progress window that never becomes ready, however long each poll takes, under %s',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      vi.resetModules();
      vi.doMock('../../src/main/desktop-uninstall-result.ts', async (importOriginal) => ({
        ...(await importOriginal<typeof import('../../src/main/desktop-uninstall-result.ts')>()),
        UNINSTALL_PROGRESS_READY_TIMEOUT_MS: PROGRESS_READY_DECLARED_WAIT_MS,
      }));
      try {
        const { buildDesktopUninstallHandoffScript: buildWithDeclaredWait } = await import(
          '../../src/main/desktop-uninstall-handoff.ts'
        );
        const declaredWaitSeconds = Math.ceil(PROGRESS_READY_DECLARED_WAIT_MS / 1000);
        const f = fixture();
        const recorder = signalRecorder(f);
        const sleeps = join(f.dir, 'sleeps');
        const script = buildWithDeclaredWait(
          handoffInput(f),
          withSignalSeam(
            {
              ...f.commands,
              ps: f.executable('ps', 'exit 1'),
              psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
              sleep: contendedSleep(f, sleeps, PROGRESS_READY_DECLARED_WAIT_MS),
              result: [
                f.executable(
                  'never-ready-ui',
                  `exec /bin/sleep ${COUNTED_PROGRESS_WAIT_STALL_MS / 1000}`,
                ),
              ],
            },
            recorder.path,
          ),
        );
        expectEverySignalRoutedThrough(recorder.path, script);
        const run = await runKeepingTheBoundFailure({
          shell,
          script,
          boundMs: HANDOFF_LIVENESS_BOUND_MS,
          scriptCompletesWithinMs: PROGRESS_READY_DECLARED_WAIT_MS,
          scriptStallsForMs: COUNTED_PROGRESS_WAIT_STALL_MS,
          fixtureDir: f.dir,
        });
        expect(signalsTheirSenderDidNotHold(recorder.read()), UNHELD_SIGNAL_FAILURE).toEqual([]);
        if (run instanceof BoundedSpawnTimeoutError) throw run;
        expect(
          countRecordedLines(sleeps),
          'the readiness wait never slept through commands.sleep, so this run never stretched a single poll and says nothing about the wait the logged reason reports',
        ).toBeGreaterThan(0);
        expect(
          readProgressGiveUp(f.dir, run),
          `a progress window that never became ready must be logged as not ready within the ${declaredWaitSeconds}s the wait was declared for, rounded up to whole seconds, however long each poll took, or a window too slow to start reads the same as one that crashed or could not be waited for`,
        ).toEqual({
          status: 1,
          announcedReady: false,
          cleanupRuns: 0,
          loggedOutcome: progressWindowNotReadyWithin(declaredWaitSeconds),
        });
      } finally {
        vi.doUnmock('../../src/main/desktop-uninstall-result.ts');
        vi.resetModules();
      }
    },
  );

  test.each(UNINSTALL_SHELLS)(
    'says a progress window did not become ready within the declared time only once that time has passed, under %s',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      vi.resetModules();
      vi.doMock('../../src/main/desktop-uninstall-result.ts', async (importOriginal) => ({
        ...(await importOriginal<typeof import('../../src/main/desktop-uninstall-result.ts')>()),
        UNINSTALL_PROGRESS_READY_TIMEOUT_MS: PROGRESS_READY_DECLARED_WAIT_MS,
      }));
      try {
        const { buildDesktopUninstallHandoffScript: buildWithDeclaredWait } = await import(
          '../../src/main/desktop-uninstall-handoff.ts'
        );
        const declaredWaitSeconds = Math.ceil(PROGRESS_READY_DECLARED_WAIT_MS / 1000);
        const f = fixture();
        const recorder = signalRecorder(f);
        const sleeps = join(f.dir, 'sleeps');
        const script = buildWithDeclaredWait(
          handoffInput(f),
          withSignalSeam(
            {
              ...f.commands,
              ps: f.executable('ps', 'exit 1'),
              psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
              sleep: contendedSleep(f, sleeps, PROGRESS_READY_DECLARED_WAIT_MS),
              result: [
                f.executable(
                  'never-ready-ui',
                  `exec /bin/sleep ${COUNTED_PROGRESS_WAIT_STALL_MS / 1000}`,
                ),
              ],
            },
            recorder.path,
          ),
        );
        expectEverySignalRoutedThrough(recorder.path, script);
        const startedAt = Date.now();
        const run = await runKeepingTheBoundFailure({
          shell,
          script,
          boundMs: HANDOFF_LIVENESS_BOUND_MS,
          scriptCompletesWithinMs: PROGRESS_READY_DECLARED_WAIT_MS,
          scriptStallsForMs: COUNTED_PROGRESS_WAIT_STALL_MS,
          fixtureDir: f.dir,
        });
        const elapsedMs = Date.now() - startedAt;
        expect(signalsTheirSenderDidNotHold(recorder.read()), UNHELD_SIGNAL_FAILURE).toEqual([]);
        if (run instanceof BoundedSpawnTimeoutError) throw run;
        expect(
          countRecordedLines(sleeps),
          'the readiness wait never slept through commands.sleep, so this run never polled the window the way the wait it reports is measured',
        ).toBeGreaterThan(0);
        expect(
          readProgressGiveUp(f.dir, run),
          `a progress window that never became ready must be logged as not ready within the ${declaredWaitSeconds}s the wait was declared for, or this run reports no wait for its elapsed time to be held to`,
        ).toEqual({
          status: 1,
          announcedReady: false,
          cleanupRuns: 0,
          loggedOutcome: progressWindowNotReadyWithin(declaredWaitSeconds),
        });
        expect(
          elapsedMs,
          `the handoff logged that its progress window did not become ready within ${declaredWaitSeconds} seconds, yet the whole run took ${elapsedMs}ms from just before it was spawned, so it gave up before that wait had passed and the reason it logged is false. ${inMilliseconds(declaredWaitSeconds)}ms is not a performance figure but that reported wait in milliseconds, the constant this test mocks into the product rounded up to whole seconds, and host load only ever lengthens a run, so no machine is fast enough to take a run that really waited below it`,
        ).toBeGreaterThanOrEqual(inMilliseconds(declaredWaitSeconds));
      } finally {
        vi.doUnmock('../../src/main/desktop-uninstall-result.ts');
        vi.resetModules();
      }
    },
  );

  test.each(UNINSTALL_SHELLS)(
    'says a progress window did not become ready within the declared time only once the clock it reads has counted more whole seconds than that, under %s',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      vi.resetModules();
      vi.doMock('../../src/main/desktop-uninstall-result.ts', async (importOriginal) => ({
        ...(await importOriginal<typeof import('../../src/main/desktop-uninstall-result.ts')>()),
        UNINSTALL_PROGRESS_READY_TIMEOUT_MS: PROGRESS_READY_DECLARED_WAIT_MS,
      }));
      try {
        const { buildDesktopUninstallHandoffScript: buildWithDeclaredWait } = await import(
          '../../src/main/desktop-uninstall-handoff.ts'
        );
        const declaredWaitSeconds = Math.ceil(PROGRESS_READY_DECLARED_WAIT_MS / 1000);
        const oneSecondMs = inMilliseconds(1);
        const f = fixture();
        const recorder = signalRecorder(f);
        const sleeps = join(f.dir, 'sleeps');
        const script = buildWithDeclaredWait(
          handoffInput(f),
          withSignalSeam(
            {
              ...f.commands,
              ps: f.executable('ps', 'exit 1'),
              psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
              sleep: f.executable(
                'recorded-sleep',
                `printf '%s\\n' "$1" >> '${sleeps}'
exec /bin/sleep "$1"`,
              ),
              result: [
                f.executable(
                  'never-ready-ui',
                  `exec /bin/sleep ${COUNTED_PROGRESS_WAIT_STALL_MS / 1000}`,
                ),
              ],
            },
            recorder.path,
          ),
        );
        expectEverySignalRoutedThrough(recorder.path, script);
        const waitingFromSecond = Math.floor(Date.now() / oneSecondMs);
        while (Math.floor(Date.now() / oneSecondMs) === waitingFromSecond) {
          await delay(oneSecondMs - (Date.now() % oneSecondMs));
        }
        const startedAt = Date.now();
        const run = await runKeepingTheBoundFailure({
          shell,
          script,
          boundMs: HANDOFF_LIVENESS_BOUND_MS,
          scriptCompletesWithinMs: PROGRESS_READY_DECLARED_WAIT_MS,
          scriptStallsForMs: COUNTED_PROGRESS_WAIT_STALL_MS,
          fixtureDir: f.dir,
        });
        const finishedAt = Date.now();
        expect(signalsTheirSenderDidNotHold(recorder.read()), UNHELD_SIGNAL_FAILURE).toEqual([]);
        if (run instanceof BoundedSpawnTimeoutError) throw run;
        expect(
          countRecordedLines(sleeps),
          'the readiness wait never slept through commands.sleep, so it never polled the window with the real, exactly requested sleeps this test gives it, and the whole second its give-up lands in was not read under that polling',
        ).toBeGreaterThan(0);
        expect(
          readProgressGiveUp(f.dir, run),
          `a progress window that never became ready must be logged as not ready within the ${declaredWaitSeconds}s the wait was declared for, or this run reports no wait for the clock it read to be held to`,
        ).toEqual({
          status: 1,
          announcedReady: false,
          cleanupRuns: 0,
          loggedOutcome: progressWindowNotReadyWithin(declaredWaitSeconds),
        });
        const spawnedInSecond = Math.floor(startedAt / oneSecondMs);
        const endedInSecond = Math.floor(finishedAt / oneSecondMs);
        expect(
          endedInSecond - spawnedInSecond,
          `the handoff logged that its progress window did not become ready within ${declaredWaitSeconds} seconds, yet the wall clock counted only ${endedInSecond - spawnedInSecond} whole seconds from the second the handoff was spawned in to the second it ended in (spawned ${startedAt % oneSecondMs}ms into second ${spawnedInSecond}, ended ${finishedAt % oneSecondMs}ms into second ${endedInSecond}). The script reads that same clock in whole seconds once its window has started, so a wait that gives up only when the clock reads later than that start plus ${declaredWaitSeconds} ends more than ${declaredWaitSeconds} whole seconds after the second of the spawn; ending here means it gave up while its clock still read inside the declared wait, which can be before that wait has passed, so the reason it logged can be false. ${declaredWaitSeconds} is not a performance figure but that declared wait, the constant this test mocks into the product rounded up to whole seconds, counted in the whole seconds of the clock the script itself reads, and host load only moves the end later, so no machine is fast enough to take a run that really waited under it: this asserts only that the logged "within ${declaredWaitSeconds} seconds" is true on the clock the script counts it by`,
        ).toBeGreaterThan(declaredWaitSeconds);
      } finally {
        vi.doUnmock('../../src/main/desktop-uninstall-result.ts');
        vi.resetModules();
      }
    },
  );

  test.each(UNINSTALL_SHELLS)(
    'stops polling a progress window that never becomes ready once the clock it reads has counted past the declared time, under %s',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      vi.resetModules();
      vi.doMock('../../src/main/desktop-uninstall-result.ts', async (importOriginal) => ({
        ...(await importOriginal<typeof import('../../src/main/desktop-uninstall-result.ts')>()),
        UNINSTALL_PROGRESS_READY_TIMEOUT_MS: PROGRESS_READY_DECLARED_WAIT_MS,
      }));
      try {
        const { buildDesktopUninstallHandoffScript: buildWithDeclaredWait } = await import(
          '../../src/main/desktop-uninstall-handoff.ts'
        );
        const declaredWaitSeconds = Math.ceil(PROGRESS_READY_DECLARED_WAIT_MS / 1000);
        const oneSecondMs = inMilliseconds(1);
        const f = fixture();
        const recorder = signalRecorder(f);
        const sleeps = join(f.dir, 'sleeps');
        const script = buildWithDeclaredWait(
          handoffInput(f),
          withSignalSeam(
            {
              ...f.commands,
              ps: f.executable('ps', 'exit 1'),
              psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
              sleep: f.executable(
                'dated-sleep',
                `printf '%s %s\\n' "$(/bin/date +%s)" "$1" >> '${sleeps}'
exec /bin/sleep "$1"`,
              ),
              result: [
                f.executable(
                  'never-ready-ui',
                  `exec /bin/sleep ${COUNTED_PROGRESS_WAIT_STALL_MS / 1000}`,
                ),
              ],
            },
            recorder.path,
          ),
        );
        expectEverySignalRoutedThrough(recorder.path, script);
        const waitingFromSecond = Math.floor(Date.now() / oneSecondMs);
        while (Math.floor(Date.now() / oneSecondMs) === waitingFromSecond) {
          await delay(oneSecondMs - (Date.now() % oneSecondMs));
        }
        const run = await runKeepingTheBoundFailure({
          shell,
          script,
          boundMs: HANDOFF_LIVENESS_BOUND_MS,
          scriptCompletesWithinMs: PROGRESS_READY_DECLARED_WAIT_MS,
          scriptStallsForMs: COUNTED_PROGRESS_WAIT_STALL_MS,
          fixtureDir: f.dir,
        });
        expect(signalsTheirSenderDidNotHold(recorder.read()), UNHELD_SIGNAL_FAILURE).toEqual([]);
        if (run instanceof BoundedSpawnTimeoutError) throw run;
        expect(
          countRecordedLines(sleeps),
          'the readiness wait never slept through commands.sleep, so no poll read the clock the script reads, and there is no poll to hold to the declared wait',
        ).toBeGreaterThan(0);
        expect(
          readProgressGiveUp(f.dir, run),
          `a progress window that never became ready must be logged as not ready within the ${declaredWaitSeconds}s the wait was declared for, or this run reports no wait for its polls to be held to`,
        ).toEqual({
          status: 1,
          announcedReady: false,
          cleanupRuns: 0,
          loggedOutcome: progressWindowNotReadyWithin(declaredWaitSeconds),
        });
        const polls = readFileSync(sleeps, 'utf8')
          .split('\n')
          .filter((line) => line !== '');
        expect(
          polls.filter((poll) => !/^\d+ /.test(poll)),
          'each poll records the whole second /bin/date reads just before it sleeps, and these records carry none, so the fixture could not read the clock the script reads and these polls cannot be placed against the declared wait',
        ).toEqual([]);
        const polledSeconds = polls.map((poll) => Number(poll.split(' ')[0]));
        const [firstPolledSecond] = polledSeconds;
        const secondsPastFirstPoll = polledSeconds.map((second) => second - firstPolledSecond);
        const polledPastTheWait = secondsPastFirstPoll
          .slice(0, -1)
          .filter((seconds) => seconds > declaredWaitSeconds);
        expect(
          polledPastTheWait,
          `the handoff kept polling a progress window that never became ready after the clock it reads had counted past the declared wait: ${polledPastTheWait.length} of its ${polls.length} polls, not counting the last, were taken more than ${declaredWaitSeconds} whole seconds after the first poll's second (whole seconds after the first poll's second, poll by poll: ${secondsPastFirstPoll.join(' ')}). Each poll reads the clock after the script has read it for that poll and before the script reads it again, and the first poll's second is no earlier than the second the wait started counting from, so a poll taken past the first poll's second plus ${declaredWaitSeconds} puts the script's next read past its deadline, where it must give up: only the last poll can lie past it, and polling on means the wait read a clock past its deadline and kept waiting, so it lasts longer than it was declared to. ${declaredWaitSeconds} is not a performance figure but that declared wait, the constant this test mocks into the product rounded up to whole seconds, and this measures no elapsed time and bounds nothing by host speed: it only orders whole-second readings of the clock the script reads, an order host load cannot change. Load can only lower the number of polls or move the first one later, which can let a late give-up through but never fails a wait that gives up on its first read past its deadline`,
        ).toEqual([]);
      } finally {
        vi.doUnmock('../../src/main/desktop-uninstall-result.ts');
        vi.resetModules();
      }
    },
  );
});

const CLEANUP_FAILED_OUTCOME = 'Cleanup result: failed';
const PROCESS_QUERY_WAIT_FAILED = 'Could not wait for the process query to answer.';
const PROCESS_QUERY_INTERRUPTED = 'The process query was interrupted.';
const PROGRESS_WINDOW_WAIT_FAILED =
  'The uninstall progress window could not be waited for; no cleanup was started.';
const PROGRESS_WINDOW_UNTIMED =
  'The uninstall progress window could not be timed; no cleanup was started.';
const QUERY_DECLARED_WAIT_MS = HANDOFF_LIVENESS_BOUND_MS / HANDOFF_BOUND_OVER_SUBJECT_WORK;
const COUNTED_QUERY_WAIT_STALL_MS = QUERY_DECLARED_WAIT_MS * SHORT_SLEEP_STRETCH;
const SIBLING_PROBE_WAIT_MS = HANDOFF_LIVENESS_BOUND_MS / HANDOFF_BOUND_OVER_SUBJECT_WORK;
const RECORDED_IDENTITY_POLL_MS = PROBE_SETTLE_POLL_MS;
const RECORDED_PID = /^[1-9]\d*$/;
const NOT_SETTLED = Symbol('not settled inside its bound');

function processQueryTimedOut(timeoutSeconds: number) {
  return `The process query did not answer within ${timeoutSeconds} seconds.`;
}

function progressWindowExitedBeforeReady(exitStatus: number) {
  return new RegExp(
    `^The uninstall progress window .*exited before it was ready \\(exit ${exitStatus}\\).*; no cleanup was started\\.$`,
  );
}

function progressWindowNotReadyWithin(declaredWaitSeconds: number) {
  return `The uninstall progress window did not become ready within ${declaredWaitSeconds} seconds; no cleanup was started.`;
}

function lastLoggedLines(logText: string, count: number) {
  return logText.trimEnd().split('\n').slice(-count);
}

function gaveUpThenFailedClosed(reason: string) {
  return [reason, CLEANUP_FAILED_OUTCOME, expect.stringMatching(FAILED_CLOSED_FOR_ANOTHER_REASON)];
}

type RecordedIdentity = { pid: string; parent: string };

function recordsItsOwnIdentity(path: string) {
  return `printf '%s %s\\n' "$$" "$PPID" > '${path}'`;
}

function readRecordedIdentity(path: string): RecordedIdentity {
  const [pid = '', parent = ''] = (existsSync(path) ? readFileSync(path, 'utf8') : '')
    .trim()
    .split(' ');
  return { pid, parent };
}

async function awaitRecordedIdentity(path: string, boundMs: number) {
  const deadline = Date.now() + boundMs;
  let identity = readRecordedIdentity(path);
  while (!(RECORDED_PID.test(identity.pid) && RECORDED_PID.test(identity.parent))) {
    if (Date.now() >= deadline) {
      throw new Error(
        `${path} held no pid and parent pid ${boundMs}ms after the script was started, so the window never started or never got as far as recording itself, and there is nothing running for this test to interrupt the script around`,
      );
    }
    await delay(RECORDED_IDENTITY_POLL_MS);
    identity = readRecordedIdentity(path);
  }
  return identity;
}

function sleepThatFailsOnceRecorded(f: HandoffFixture, identityPath: string, failuresPath: string) {
  return f.executable(
    'sleep-failing-once-recorded',
    `if [ -s '${identityPath}' ]; then
  printf '%s\\n' "$1" >> '${failuresPath}'
  exit 1
fi
exec /bin/sleep "$1"`,
  );
}

function clockFailingAtRead(f: HandoffFixture, readsPath: string, failingRead: number) {
  return f.executable(
    'clock-failing-at-read',
    `printf '%s\\n' "$*" >> '${readsPath}'
reads=0
while IFS= read -r line; do reads=$((reads + 1)); done < '${readsPath}'
[ "$reads" -ne ${failingRead} ] || exit 1
exec /bin/date "$@"`,
  );
}

function signalsItsOwnParent(signal: string) {
  return `case "$PPID" in ''|*[!0-9]*|0*|1) exit 3 ;; esac
set -- $(/bin/ps -o ppid= -p "$$" 2>/dev/null)
[ "${'$'}{1-}" = "$PPID" ] || exit 3
kill -s ${signal} "$PPID"`;
}

type SiblingProbeWatch = {
  signalRecords: string;
  identityPath: string;
  probedSiblingPath: string;
};

function killsItsOwnParentOnceItProbesALiveSibling({
  signalRecords,
  identityPath,
  probedSiblingPath,
}: SiblingProbeWatch) {
  return `${recordsItsOwnIdentity(identityPath)}
live_sibling_probed() {
  [ -f '${signalRecords}' ] || return 1
  while IFS= read -r record; do
    case "$record" in
      "sender=$PPID "*" signal=0 target=$$ "*) ;;
      "sender=$PPID "*" signal=0 target="*" parent=$PPID "*" probed=0")
        record=${'$'}{record#* target=}
        printf '%s' "${'$'}{record%% *}"
        return 0
        ;;
    esac
  done < '${signalRecords}'
  return 1
}
polls=0
until sibling=$(live_sibling_probed); do
  polls=$((polls + 1))
  [ "$polls" -le ${Math.floor(SIBLING_PROBE_WAIT_MS / RECORDED_IDENTITY_POLL_MS)} ] || exit 1
  /bin/sleep ${RECORDED_IDENTITY_POLL_MS / 1000}
done
printf '%s\\n' "$sibling" > '${probedSiblingPath}'
${signalsItsOwnParent('KILL')}`;
}

function answersAbsentOnceItsParentProbesALiveSibling({
  signalRecords,
  identityPath,
  probedSiblingPath,
}: SiblingProbeWatch) {
  return `${recordsItsOwnIdentity(identityPath)}
live_sibling_probed() {
  [ -f '${signalRecords}' ] || return 1
  while IFS= read -r record; do
    case "$record" in
      "sender=$PPID "*" signal=0 target=$$ "*) ;;
      "sender=$PPID "*" signal=0 target="*" parent=$PPID "*" probed=0")
        record=${'$'}{record#* target=}
        printf '%s' "${'$'}{record%% *}"
        return 0
        ;;
    esac
  done < '${signalRecords}'
  return 1
}
polls=0
until sibling=$(live_sibling_probed); do
  polls=$((polls + 1))
  [ "$polls" -le ${Math.floor(SIBLING_PROBE_WAIT_MS / RECORDED_IDENTITY_POLL_MS)} ] || exit 1
  /bin/sleep ${RECORDED_IDENTITY_POLL_MS / 1000}
done
printf '%s\\n' "$sibling" > '${probedSiblingPath}'
exit 1`;
}

function contendedSleep(f: HandoffFixture, sleepsPath: string, declaredWaitMs: number) {
  return f.executable(
    'contended-sleep',
    `printf '%s\\n' "$1" >> '${sleepsPath}'
exec /bin/sleep "$(/usr/bin/awk -v requested="$1" -v wait=${declaredWaitMs / 1000} -v stretch=${SHORT_SLEEP_STRETCH} 'BEGIN { print ((requested < wait) ? requested * stretch : requested) }')"`,
  );
}

function killsDeliveredByItsParent(
  records: readonly SignalRecord[],
  { pid, parent }: RecordedIdentity,
) {
  return records.filter(
    (record) =>
      record.signal === 'KILL' &&
      record.target === pid &&
      record.sender === parent &&
      record.delivered === '0',
  );
}

function listedInProcessTable(pid: string) {
  if (!RECORDED_PID.test(pid)) {
    throw new Error(
      `${JSON.stringify(pid)} is not a pid, so no read of the process table can say whether it is gone`,
    );
  }
  return (
    spawnSyncBounded('/bin/ps', ['-o', 'pid=', '-p', pid], {
      timeoutMs: DEFAULT_BOUNDED_SPAWN_TIMEOUT_MS,
    }).stdout.trim() !== ''
  );
}

async function settledInsideBound<T>(pending: Promise<T>, boundMs: number) {
  const expiry = new AbortController();
  try {
    return await Promise.race([pending, delay(boundMs, NOT_SETTLED, { signal: expiry.signal })]);
  } finally {
    expiry.abort();
  }
}

function readQueryGiveUp(dir: string, run: SpawnSyncReturns<string>) {
  return {
    status: run.status,
    probeResidue: readQueryProbeResidue(dir),
    loggedGiveUp: lastLoggedLines(readCleanupLog(dir), 3),
  };
}

function readProgressGiveUp(dir: string, run: SpawnSyncReturns<string>) {
  return {
    status: run.status,
    announcedReady: run.stdout.includes('OK_UNINSTALL_READY'),
    cleanupRuns: countCleanupRuns(dir),
    loggedOutcome: lastLoggedLine(readCleanupLog(dir)),
  };
}

describe.skipIf(process.platform === 'win32')(
  'whether a process is still in the process table',
  () => {
    test('lists a child the test still holds, and not once the test has seen it exit', async () => {
      const child = spawn('/bin/sleep', [String(STUCK_QUERY_SECONDS)], { stdio: 'ignore' });
      try {
        const pid = String(child.pid);
        expect(
          listedInProcessTable(pid),
          `the process table read did not list pid ${pid}, a child this test started and still holds, so a window pid it reads as unlisted proves nothing about whether that window is gone`,
        ).toBe(true);
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
        expect(
          listedInProcessTable(pid),
          `the process table read still lists pid ${pid} after this test saw that child exit and be reaped, so a window it reads as listed may already be gone`,
        ).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    });
  },
);

describe.skipIf(process.platform === 'win32')('how the process query gives up', () => {
  test.each(UNINSTALL_SHELLS)(
    'says a process query that never answers ran out of its timeout, ahead of failing closed, under %s',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      const f = fixture();
      const recorder = signalRecorder(f);
      const script = buildDesktopUninstallHandoffScript(
        handoffInput(f),
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable('ps', `exec /bin/sleep ${STUCK_QUERY_SECONDS}`),
            psTimeoutSeconds: STUCK_QUERY_WATCHDOG_SECONDS,
          },
          recorder.path,
        ),
      );
      expectEverySignalRoutedThrough(recorder.path, script);
      const run = await runKeepingTheBoundFailure({
        shell,
        script,
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: inMilliseconds(STUCK_QUERY_WATCHDOG_SECONDS),
        scriptStallsForMs: inMilliseconds(STUCK_QUERY_SECONDS),
        fixtureDir: f.dir,
      });
      expect(signalsTheirSenderDidNotHold(recorder.read()), UNHELD_SIGNAL_FAILURE).toEqual([]);
      if (run instanceof BoundedSpawnTimeoutError) throw run;
      expect(
        readQueryGiveUp(f.dir, run),
        `a process query that never answered must be logged as having run out of its ${STUCK_QUERY_WATCHDOG_SECONDS}s timeout, ahead of the lines that fail the handoff closed, or a query that timed out reads in the log exactly like one that could not run at all`,
      ).toEqual({
        status: 1,
        probeResidue: [],
        loggedGiveUp: gaveUpThenFailedClosed(processQueryTimedOut(STUCK_QUERY_WATCHDOG_SECONDS)),
      });
    },
  );

  test.each(UNINSTALL_SHELLS)(
    'stops a process query it can no longer wait on under %s, killing the query it started and saying why',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      const f = fixture();
      const recorder = signalRecorder(f);
      const queryIdentity = join(f.dir, 'query-identity');
      const failedSleeps = join(f.dir, 'failed-sleeps');
      const script = buildDesktopUninstallHandoffScript(
        handoffInput(f),
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable(
              'ps',
              `${recordsItsOwnIdentity(queryIdentity)}\nexec /bin/sleep ${STUCK_QUERY_SECONDS}`,
            ),
            psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
            sleep: sleepThatFailsOnceRecorded(f, queryIdentity, failedSleeps),
          },
          recorder.path,
        ),
      );
      expectEverySignalRoutedThrough(recorder.path, script);
      const run = await runKeepingTheBoundFailure({
        shell,
        script,
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: 0,
        scriptStallsForMs: inMilliseconds(HANDOFF_WATCHDOG_SECONDS),
        fixtureDir: f.dir,
      });
      const records = recorder.read();
      expect(signalsTheirSenderDidNotHold(records), UNHELD_SIGNAL_FAILURE).toEqual([]);
      if (run instanceof BoundedSpawnTimeoutError) throw run;
      expect(
        countRecordedLines(failedSleeps),
        'no sleep through commands.sleep failed while the process query was running, so this run never reached the early exit it is here to pin',
      ).toBeGreaterThan(0);
      expect(
        readQueryGiveUp(f.dir, run),
        'a process query whose poll sleep failed must be logged as one that could not be waited for, ahead of the lines that fail the handoff closed, and must leave no probe behind',
      ).toEqual({
        status: 1,
        probeResidue: [],
        loggedGiveUp: gaveUpThenFailedClosed(PROCESS_QUERY_WAIT_FAILED),
      });
      expect(
        killsDeliveredByItsParent(records, readRecordedIdentity(queryIdentity)),
        'the process query was still running when the wait for it failed, and only a signal can stop it, so a run with no KILL delivered to it by the subshell that started it left it running or had it stopped by a process that does not hold it',
      ).not.toEqual([]);
    },
  );

  test.each(UNINSTALL_SHELLS)(
    'sends no KILL to a process query it has already reaped when the wait for it then fails, under %s',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      const f = fixture();
      const recorder = signalRecorder(f);
      const queryIdentity = join(f.dir, 'query-identity');
      const sleepStarted = join(f.dir, 'sleep-started');
      const queryState = join(f.dir, 'query-state');
      const failedSleeps = join(f.dir, 'failed-sleeps');
      const recordedIdentityPolls = Math.floor(SIBLING_PROBE_WAIT_MS / RECORDED_IDENTITY_POLL_MS);
      const script = buildDesktopUninstallHandoffScript(
        handoffInput(f),
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable(
              'ps',
              `${recordsItsOwnIdentity(queryIdentity)}
polls=0
until [ -f '${sleepStarted}' ]; do
  polls=$((polls + 1))
  [ "$polls" -le ${recordedIdentityPolls} ] || exit 3
  /bin/sleep ${RECORDED_IDENTITY_POLL_MS / 1000}
done
exit 1`,
            ),
            psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
            sleep: f.executable(
              'sleep-failing-once-the-query-is-gone',
              `if [ -s '${queryIdentity}' ]; then
  : > '${sleepStarted}'
  read -r query rest < '${queryIdentity}'
  state=unreadable
  case "$query" in
    ''|*[!0-9]*|0*) ;;
    *)
      state=gone
      polls=0
      while [ -n "$(/bin/ps -o pid= -p "$query" 2>/dev/null)" ]; do
        polls=$((polls + 1))
        if [ "$polls" -gt ${recordedIdentityPolls} ]; then
          state=listed
          break
        fi
        /bin/sleep ${RECORDED_IDENTITY_POLL_MS / 1000}
      done
      ;;
  esac
  printf '%s\\n' "$state" >> '${queryState}'
  printf '%s\\n' "$1" >> '${failedSleeps}'
  exit 1
fi
exec /bin/sleep "$1"`,
            ),
          },
          recorder.path,
        ),
      );
      expectEverySignalRoutedThrough(recorder.path, script);
      const run = await runKeepingTheBoundFailure({
        shell,
        script,
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: SIBLING_PROBE_WAIT_MS,
        scriptStallsForMs: inMilliseconds(HANDOFF_WATCHDOG_SECONDS),
        fixtureDir: f.dir,
      });
      const records = recorder.read();
      expect(signalsTheirSenderDidNotHold(records), UNHELD_SIGNAL_FAILURE).toEqual([]);
      if (run instanceof BoundedSpawnTimeoutError) throw run;
      expect(
        countRecordedLines(failedSleeps),
        'no sleep through commands.sleep failed while the process query was running, so this run never reached the early exit whose stop it is here to pin',
      ).toBeGreaterThan(0);
      expect(
        readTextOrDescribeWhyNot(queryState).trim(),
        'the poll sleep fails only once the process query it waits on has exited and left the process table, and it records whether it saw that: anything but gone means the stop below met a query that was still running, or one this run could not identify, so the run says nothing about how the stop treats a query that has already exited',
      ).toBe('gone');
      expect(
        readQueryGiveUp(f.dir, run),
        'a process query whose poll sleep failed after the query had exited must still be logged as one that could not be waited for, ahead of the lines that fail the handoff closed, and must leave no probe behind',
      ).toEqual({
        status: 1,
        probeResidue: [],
        loggedGiveUp: gaveUpThenFailedClosed(PROCESS_QUERY_WAIT_FAILED),
      });
      const query = readRecordedIdentity(queryIdentity);
      expect(
        records
          .filter((record) => record.signal === 'KILL' && record.target === query.pid)
          .map(describeSignalRecord),
        `the process query, pid ${query.pid}, had exited and been reaped by the subshell that started it before the wait for it failed, so that subshell no longer held its pid when it stopped the query, and a KILL to that pid lands on whatever process the kernel hands it to next. The stop must see that the query is gone and leave its pid alone`,
      ).toEqual([]);
    },
  );

  test.each(UNINSTALL_SHELLS)(
    'says the process query was interrupted when its own subshell is sent TERM under %s',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      const f = fixture();
      const recorder = signalRecorder(f);
      const queryIdentity = join(f.dir, 'query-identity');
      const script = buildDesktopUninstallHandoffScript(
        handoffInput(f),
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable(
              'ps',
              `${recordsItsOwnIdentity(queryIdentity)}
${signalsItsOwnParent('TERM')}
exec /bin/sleep ${STUCK_QUERY_SECONDS}`,
            ),
            psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
          },
          recorder.path,
        ),
      );
      expectEverySignalRoutedThrough(recorder.path, script);
      const run = await runKeepingTheBoundFailure({
        shell,
        script,
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: 0,
        scriptStallsForMs: inMilliseconds(HANDOFF_WATCHDOG_SECONDS),
        fixtureDir: f.dir,
      });
      const records = recorder.read();
      expect(signalsTheirSenderDidNotHold(records), UNHELD_SIGNAL_FAILURE).toEqual([]);
      if (run instanceof BoundedSpawnTimeoutError) throw run;
      expect(
        readQueryGiveUp(f.dir, run),
        'a process query whose subshell was sent TERM must be logged as interrupted, ahead of the lines that fail the handoff closed, and must leave no probe behind',
      ).toEqual({
        status: 1,
        probeResidue: [],
        loggedGiveUp: gaveUpThenFailedClosed(PROCESS_QUERY_INTERRUPTED),
      });
      expect(
        killsDeliveredByItsParent(records, readRecordedIdentity(queryIdentity)),
        'the process query outlived the TERM its subshell was sent, and only a signal can stop it, so a run with no KILL delivered to it by that subshell left it running or had it stopped by a process that does not hold it',
      ).not.toEqual([]);
    },
  );

  test.each(UNINSTALL_SHELLS)(
    'gives up on a process query that never answers inside its declared timeout under %s, however long each poll takes',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      const f = fixture();
      const recorder = signalRecorder(f);
      const sleeps = join(f.dir, 'sleeps');
      const script = buildDesktopUninstallHandoffScript(
        handoffInput(f),
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable('ps', `exec /bin/sleep ${COUNTED_QUERY_WAIT_STALL_MS / 1000}`),
            psTimeoutSeconds: QUERY_DECLARED_WAIT_MS / 1000,
            sleep: contendedSleep(f, sleeps, QUERY_DECLARED_WAIT_MS),
          },
          recorder.path,
        ),
      );
      expectEverySignalRoutedThrough(recorder.path, script);
      const run = await runKeepingTheBoundFailure({
        shell,
        script,
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: QUERY_DECLARED_WAIT_MS,
        scriptStallsForMs: COUNTED_QUERY_WAIT_STALL_MS,
        fixtureDir: f.dir,
      });
      expect(signalsTheirSenderDidNotHold(recorder.read()), UNHELD_SIGNAL_FAILURE).toEqual([]);
      if (run instanceof BoundedSpawnTimeoutError) throw run;
      expect(
        countRecordedLines(sleeps),
        'the process query never slept through commands.sleep, so this run never stretched a single poll and says nothing about how the wait is bounded',
      ).toBeGreaterThan(0);
      expect(
        readQueryGiveUp(f.dir, run),
        `a process query that never answered must give up on its ${QUERY_DECLARED_WAIT_MS / 1000}s timeout and say so, whatever each poll costs, or a query bounded by how many polls it makes stretches with the host`,
      ).toEqual({
        status: 1,
        probeResidue: [],
        loggedGiveUp: gaveUpThenFailedClosed(processQueryTimedOut(QUERY_DECLARED_WAIT_MS / 1000)),
      });
    },
  );

  test.each(UNINSTALL_SHELLS)(
    'stops polling a process query that never answers at the first poll that finds its timer has run out, under %s',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      const f = fixture();
      const recorder = signalRecorder(f);
      const sleeps = join(f.dir, 'sleeps');
      const queryIdentity = join(f.dir, 'query-identity');
      const script = buildDesktopUninstallHandoffScript(
        handoffInput(f),
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable(
              'ps',
              `${recordsItsOwnIdentity(queryIdentity)}\nexec /bin/sleep ${COUNTED_QUERY_WAIT_STALL_MS / 1000}`,
            ),
            psTimeoutSeconds: QUERY_DECLARED_WAIT_MS / 1000,
            sleep: contendedSleep(f, sleeps, QUERY_DECLARED_WAIT_MS),
          },
          recorder.path,
        ),
      );
      expectEverySignalRoutedThrough(recorder.path, script);
      const run = await runKeepingTheBoundFailure({
        shell,
        script,
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: QUERY_DECLARED_WAIT_MS,
        scriptStallsForMs: COUNTED_QUERY_WAIT_STALL_MS,
        fixtureDir: f.dir,
      });
      const records = recorder.read();
      expect(signalsTheirSenderDidNotHold(records), UNHELD_SIGNAL_FAILURE).toEqual([]);
      if (run instanceof BoundedSpawnTimeoutError) throw run;
      const polls = countRecordedLines(sleeps);
      expect(
        polls,
        'the process query never slept through commands.sleep, so this run has no poll to hold to the probes that found its timer still running',
      ).toBeGreaterThan(0);
      expect(
        readQueryGiveUp(f.dir, run),
        `a process query that never answered must give up on its ${QUERY_DECLARED_WAIT_MS / 1000}s timeout and say so, or the polls this run counts were not ended by that timeout`,
      ).toEqual({
        status: 1,
        probeResidue: [],
        loggedGiveUp: gaveUpThenFailedClosed(processQueryTimedOut(QUERY_DECLARED_WAIT_MS / 1000)),
      });
      const query = readRecordedIdentity(queryIdentity);
      expect(
        RECORDED_PID.test(query.pid) && RECORDED_PID.test(query.parent),
        `the process query recorded ${JSON.stringify(query)} as its pid and its parent's, so this run cannot tell the probes its subshell sent from anyone else's, or the query from the other child that subshell probes`,
      ).toBe(true);
      const probesFindingAnotherChildRunning = records.filter(
        (record) =>
          record.signal === '0' &&
          record.sender === query.parent &&
          record.target !== query.pid &&
          record.probed === '0',
      ).length;
      expect(
        polls,
        `the process query subshell slept ${polls} times through commands.sleep but found a child of its own other than the query running only ${probesFindingAnotherChildRunning} times, so it went on polling after it had found the timer it started gone. Each poll probes the query, then the timer, and sleeps only if both still run, so every sleep follows a probe that found the timer running, and the poll that finds the timer gone gives up before it sleeps: at most one sleep more than those probes, for a wait that sleeps before it probes. A probe that finds a timer which has run out but is not yet reaped still running is followed by a sleep, so it keeps the two counts level. Polling on past a timer that has run out means the ${QUERY_DECLARED_WAIT_MS / 1000}s timeout no longer bounds the wait, which then lasts as long as the extra polls cost on this host. This measures no elapsed time and bounds nothing by host speed: it compares two counts of events the run recorded, and load changes only how many polls there are, never the order of a probe and the sleep that follows it`,
      ).toBeLessThanOrEqual(probesFindingAnotherChildRunning + 1);
    },
  );

  test.each(UNINSTALL_SHELLS)(
    'fails closed inside its bound when the process query subshell is killed while the timer it started still runs, under %s',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      const f = fixture();
      const recorder = signalRecorder(f);
      const queryIdentity = join(f.dir, 'query-identity');
      const probedSibling = join(f.dir, 'probed-sibling');
      const script = buildDesktopUninstallHandoffScript(
        handoffInput(f),
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable(
              'ps',
              killsItsOwnParentOnceItProbesALiveSibling({
                signalRecords: join(f.dir, 'signals'),
                identityPath: queryIdentity,
                probedSiblingPath: probedSibling,
              }),
            ),
            psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
          },
          recorder.path,
        ),
      );
      expectEverySignalRoutedThrough(recorder.path, script);
      expect(
        inMilliseconds(HANDOFF_WATCHDOG_SECONDS),
        `the timer the killed query subshell leaves running parks for ${inMilliseconds(HANDOFF_WATCHDOG_SECONDS)}ms, which must be at least ${HANDOFF_STALL_OVER_BOUND}x the ${HANDOFF_LIVENESS_BOUND_MS}ms bound, or closing inside the bound is no proof the handoff never waited on that timer`,
      ).toBeGreaterThanOrEqual(HANDOFF_STALL_OVER_BOUND * HANDOFF_LIVENESS_BOUND_MS);
      expect(
        HANDOFF_LIVENESS_BOUND_MS,
        `a ${HANDOFF_LIVENESS_BOUND_MS}ms bound must be at least ${HANDOFF_BOUND_OVER_SUBJECT_WORK}x the ${SIBLING_PROBE_WAIT_MS}ms the query may wait to see its subshell probe the timer, or the bound preempts that wait instead of backstopping the handoff`,
      ).toBeGreaterThanOrEqual(HANDOFF_BOUND_OVER_SUBJECT_WORK * SIBLING_PROBE_WAIT_MS);
      const child = spawn(shell, ['-c', script], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, TMPDIR: f.dir },
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      try {
        const settled = await settledInsideBound(once(child, 'close'), HANDOFF_LIVENESS_BOUND_MS);
        const timer = readTextOrDescribeWhyNot(probedSibling).trim();
        const timerListedAtClose = RECORDED_PID.test(timer) && listedInProcessTable(timer);
        const exited = child.exitCode ?? child.signalCode;
        const stateAtBound =
          exited === null ? 'had not exited' : `had exited (${exited}) with its stderr still open`;
        expect(
          settled,
          `${HANDOFF_LIVENESS_BOUND_MS}ms after it started, with its process query subshell killed, the handoff ${stateAtBound}, so something that subshell started, such as the query's timer, holds a pipe the handoff waits on or was given.\nstderr so far: ${stderr}`,
        ).not.toBe(NOT_SETTLED);
        const records = recorder.read();
        expect(signalsTheirSenderDidNotHold(records), UNHELD_SIGNAL_FAILURE).toEqual([]);
        const query = readRecordedIdentity(queryIdentity);
        expect(
          records.filter(
            (record) =>
              record.signal === '0' &&
              record.sender === query.parent &&
              record.target === timer &&
              record.target !== query.pid &&
              record.parent === query.parent &&
              record.probed === '0',
          ),
          `the process query subshell was not seen probing a live child of its own besides the query (${timer}) before the query killed it, so no timer outlived that subshell in this run and closing inside the bound says nothing about whether the handoff waits on one`,
        ).not.toEqual([]);
        expect(
          timerListedAtClose,
          `the query's timer, pid ${timer}, was no longer running when the handoff closed, so it did not outlive the killed subshell and this run cannot tell a handoff free of that timer from one that waited it out`,
        ).toBe(true);
        expect(
          {
            status: child.exitCode,
            cleanupRuns: countCleanupRuns(f.dir),
            loggedOutcome: lastLoggedLine(readCleanupLog(f.dir)),
          },
          'a handoff whose process query subshell was killed has no answer about whether OpenKnowledge stopped, so it must fail closed without cleanup, for a reason other than a missing start time',
        ).toEqual({
          status: 1,
          cleanupRuns: 0,
          loggedOutcome: expect.stringMatching(FAILED_CLOSED_FOR_ANOTHER_REASON),
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        child.stderr.destroy();
      }
    },
  );

  test.skipIf(!existsSync(ZSH))(
    'fails closed without cleanup and removes its probe directory when the process query cannot write its output file, under /bin/zsh run as sh',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async () => {
      const f = fixture();
      const recorder = signalRecorder(f);
      const input = handoffInput(f);
      const zshAsSh = f.executable('zsh-as-sh', `exec ${ZSH} --emulate sh "$@"`);
      const temporaryDirectory = temporaryDirectoryWithRoomForADirectoryButNotItsFile(
        f,
        QUERY_PROBE_TEMPLATE,
        QUERY_PROBE_OUTPUT,
      );
      const script = buildDesktopUninstallHandoffScript(
        input,
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable('ps', `printf '%s\\n' ${shellQuote(input.parentStartedAt)}`),
            psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
          },
          recorder.path,
        ),
      );
      expectEverySignalRoutedThrough(recorder.path, script);
      expect(
        spawnSyncBounded(zshAsSh, ['-c', 'emulate'], {
          timeoutMs: DEFAULT_BOUNDED_SPAWN_TIMEOUT_MS,
        }).stdout.trim(),
        `${zshAsSh} must start zsh in its sh emulation, as macOS does when /bin/sh is zsh, or this run exercises zsh’s own mode, where a failed write through a special built-in does not end the shell`,
      ).toBe('sh');
      expect(
        tryADirectoryAndItsFile(temporaryDirectory.path, QUERY_PROBE_TEMPLATE, QUERY_PROBE_OUTPUT),
        `this row needs a temporary directory with room under the ${temporaryDirectory.pathMax}-byte path limit this host reports for the process query’s probe directory but not for the output file written into it, and ${temporaryDirectory.path} is not one, so the run below would fail somewhere other than that write`,
      ).toEqual({ directory: 'created', file: 'ENAMETOOLONG' });
      const run = await runKeepingTheBoundFailure({
        shell: '/bin/sh',
        script: withTemporaryDirectory(zshAsSh, temporaryDirectory.path, script),
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: 0,
        scriptStallsForMs: inMilliseconds(HANDOFF_WATCHDOG_SECONDS),
        fixtureDir: f.dir,
      });
      expect(signalsTheirSenderDidNotHold(recorder.read()), UNHELD_SIGNAL_FAILURE).toEqual([]);
      if (run instanceof BoundedSpawnTimeoutError) throw run;
      expect(
        reportsAFailedWriteOfItsFile(
          run.stderr,
          temporaryDirectory.path,
          QUERY_PROBE_TEMPLATE,
          QUERY_PROBE_OUTPUT,
        ),
        `the shell reported no failed write of the output file into a probe directory it had created in ${temporaryDirectory.path}, so this run never reached the write it is here to fail.\nstderr: ${run.stderr.trim()}`,
      ).toBe(true);
      expect(
        {
          status: run.status,
          cleanupRuns: countCleanupRuns(f.dir),
          loggedOutcome: lastLoggedLine(readCleanupLog(f.dir)),
          probeResidue: readQueryProbeResidue(temporaryDirectory.path),
        },
        'OpenKnowledge is still running here and the process query could not write the file its answer goes to, so the handoff must fail closed on the query’s exit 2, start no cleanup and remove its probe directory: zsh run as sh, which macOS can make /bin/sh, ends a subshell whose write through a special built-in fails with status 1, no output and no EXIT trap, and the attempts loop reads that as OpenKnowledge having exited',
      ).toEqual({
        status: 1,
        cleanupRuns: 0,
        loggedOutcome: QUERY_GAVE_UP_OUTCOME,
        probeResidue: [],
      });
    },
  );
});

describe.skipIf(process.platform === 'win32')('the timer a process query starts', () => {
  test.each(UNINSTALL_SHELLS)(
    'is killed by the query subshell that started it and is gone when the handoff closes, once the query answers that the parent is absent, under %s',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      const f = fixture();
      const recorder = signalRecorder(f);
      const queryIdentity = join(f.dir, 'query-identity');
      const probedSibling = join(f.dir, 'probed-sibling');
      const script = buildDesktopUninstallHandoffScript(
        handoffInput(f),
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable(
              'ps',
              answersAbsentOnceItsParentProbesALiveSibling({
                signalRecords: join(f.dir, 'signals'),
                identityPath: queryIdentity,
                probedSiblingPath: probedSibling,
              }),
            ),
            psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
          },
          recorder.path,
        ),
      );
      expectEverySignalRoutedThrough(recorder.path, script);
      const run = await runKeepingTheBoundFailure({
        shell,
        script,
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: SIBLING_PROBE_WAIT_MS,
        scriptStallsForMs: inMilliseconds(HANDOFF_WATCHDOG_SECONDS),
        fixtureDir: f.dir,
      });
      const timer = readTextOrDescribeWhyNot(probedSibling).trim();
      const timerListedAtClose = RECORDED_PID.test(timer) && listedInProcessTable(timer);
      const records = recorder.read();
      expect(signalsTheirSenderDidNotHold(records), UNHELD_SIGNAL_FAILURE).toEqual([]);
      if (run instanceof BoundedSpawnTimeoutError) throw run;
      expect(readBoundedHandoffOutcome(f.dir, run, '')).toEqual(
        expectedBoundedHandoffOutcome({ status: 0, loggedOutcome: CLEANUP_SUCCEEDED_OUTCOME }),
      );
      const query = readRecordedIdentity(queryIdentity);
      expect(
        records.filter(
          (record) =>
            record.signal === '0' &&
            record.sender === query.parent &&
            record.target === timer &&
            record.target !== query.pid &&
            record.parent === query.parent &&
            record.probed === '0',
        ),
        `the process query subshell was not seen probing a live child of its own besides the query (${timer}) while the query ran, so no timer was known to be running when the query answered, and the checks below cannot tell a query that stops its timer from one that leaves it running`,
      ).not.toEqual([]);
      expect(
        timerListedAtClose,
        `the query's timer, pid ${timer}, was still in the process table when the handoff closed, so the query subshell answered and exited leaving the timer it started running out the rest of its ${HANDOFF_WATCHDOG_SECONDS}s timeout`,
      ).toBe(false);
      expect(
        killsDeliveredByItsParent(records, { pid: timer, parent: query.parent }),
        'the query’s timer was still running when the query answered and is gone now, and a run with no KILL delivered to it by the query subshell that started it stopped it with a signal it could have caught or ignored, or from a process that does not hold it',
      ).not.toEqual([]);
    },
  );
});

const UNREADABLE_CLOCK_READS = [
  { read: 'the deadline read', failingRead: 1 },
  { read: 'a read inside the wait', failingRead: 2 },
] as const;

const unreadableClockRows = UNINSTALL_SHELLS.flatMap((shell) =>
  UNREADABLE_CLOCK_READS.map((clockRead) => ({ ...clockRead, shell })),
);

const PROGRESS_WINDOW_NOT_STARTED =
  'The uninstall progress window could not be started; no cleanup was started.';
const RESULT_PROFILE_TEMPLATE = 'ok-uninstall-result.XXXXXX';
const RESULT_PROFILE_PREFIX = RESULT_PROFILE_TEMPLATE.replace(/X+$/, '');
const RESULT_WINDOW_TOKEN = 'watched';
const QUERY_PROBE_TEMPLATE = 'ok-uninstall-ps.XXXXXX';
const QUERY_PROBE_OUTPUT = 'output';
const RESULT_WINDOW_UNSTARTED_STATUS = 1;
const KILLED_WINDOW_EXIT_STATUS = 137;
const WINDOW_WATCH_FAILED = 'Could not keep watching the uninstall window; it was stopped.';
const SUCCESS_DIALOG_TITLE = 'OpenKnowledge files were removed';

function resultWindowFellBack(exitStatus: number) {
  return `Could not show the completion window (exit ${exitStatus}); using the system dialog.`;
}

function withTemporaryDirectory(shell: string, temporaryDirectory: string, script: string) {
  return `TMPDIR=${shellQuote(temporaryDirectory)}; export TMPDIR; exec ${shellQuote(shell)} -c ${shellQuote(script)}`;
}

function readHostPathLimit(limit: 'PATH_MAX' | 'NAME_MAX', path: string) {
  const reported = spawnSyncBounded('/usr/bin/getconf', [limit, path], {
    timeoutMs: DEFAULT_BOUNDED_SPAWN_TIMEOUT_MS,
  });
  const value = Number(reported.stdout.trim());
  if (reported.status !== 0 || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `getconf ${limit} ${path} exited ${String(reported.status)} reporting ${JSON.stringify(reported.stdout.trim())}, so this host gives no ${limit} to size a path against.\nstderr: ${reported.stderr.trim()}`,
    );
  }
  return value;
}

function directoryPathOfLength(root: string, length: number, longestName: number) {
  let path = root;
  while (path.length < length) {
    const room = length - path.length - 1;
    const name = room <= longestName ? room : Math.min(longestName, room - 2);
    if (name < 1) break;
    path = join(path, 'p'.repeat(name));
  }
  if (path.length !== length) {
    throw new Error(`no directory under ${root} has a path exactly ${length} characters long`);
  }
  return path;
}

function temporaryDirectoryWithRoomForADirectoryButNotItsFile(
  f: HandoffFixture,
  directoryTemplate: string,
  fileName: string,
) {
  const root = realpathSync(f.dir);
  const pathMax = readHostPathLimit('PATH_MAX', root);
  const directoryLength = pathMax - Math.ceil(`/${fileName}`.length / 2);
  const path = directoryPathOfLength(
    root,
    directoryLength - `/${directoryTemplate}`.length,
    readHostPathLimit('NAME_MAX', root),
  );
  mkdirSync(path, { recursive: true });
  return { path, pathMax };
}

function describeWriteFailure(writeError: unknown) {
  return writeError instanceof Error && 'code' in writeError
    ? String(writeError.code)
    : String(writeError);
}

function tryADirectoryAndItsFile(
  temporaryDirectory: string,
  directoryTemplate: string,
  fileName: string,
) {
  const made = spawnSyncBounded(
    '/usr/bin/mktemp',
    ['-d', join(temporaryDirectory, directoryTemplate)],
    { timeoutMs: DEFAULT_BOUNDED_SPAWN_TIMEOUT_MS },
  );
  const directory = made.stdout.trim();
  if (made.status !== 0 || !directory.startsWith(`${temporaryDirectory}/`)) {
    return {
      directory: `not created: mktemp exited ${String(made.status)}: ${made.stderr.trim()}`,
      file: 'not tried',
    };
  }
  try {
    writeFileSync(join(directory, fileName), '');
    return { directory: 'created', file: 'written' };
  } catch (writeError) {
    return { directory: 'created', file: describeWriteFailure(writeError) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function reportsAFailedWriteOfItsFile(
  stderr: string,
  temporaryDirectory: string,
  directoryTemplate: string,
  fileName: string,
) {
  const fileAfterDirectoryName = new RegExp(`^[^/\\s]+/${fileName}\\b`);
  return stderr
    .split(join(temporaryDirectory, directoryTemplate.replace(/X+$/, '')))
    .slice(1)
    .some((rest) => fileAfterDirectoryName.test(rest));
}

function resultProfilesIn(temporaryDirectory: string) {
  return readdirSync(temporaryDirectory).filter((name) => name.startsWith(RESULT_PROFILE_PREFIX));
}

describe.skipIf(process.platform === 'win32')('how the progress window gives up', () => {
  test.each(UNINSTALL_SHELLS)(
    'says the progress window exited before it was ready, with the status it exited with, under %s',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      const BROKEN_WINDOW_EXIT_STATUS = 7;
      const f = fixture();
      const recorder = signalRecorder(f);
      const script = buildDesktopUninstallHandoffScript(
        handoffInput(f),
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable('ps', 'exit 1'),
            psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
            result: [f.executable('broken-ui', `exit ${BROKEN_WINDOW_EXIT_STATUS}`)],
          },
          recorder.path,
        ),
      );
      expectEverySignalRoutedThrough(recorder.path, script);
      const run = await runKeepingTheBoundFailure({
        shell,
        script,
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: 0,
        scriptStallsForMs: Math.min(
          inMilliseconds(HANDOFF_WATCHDOG_SECONDS),
          UNINSTALL_PROGRESS_READY_TIMEOUT_MS,
        ),
        fixtureDir: f.dir,
      });
      expect(signalsTheirSenderDidNotHold(recorder.read()), UNHELD_SIGNAL_FAILURE).toEqual([]);
      if (run instanceof BoundedSpawnTimeoutError) throw run;
      expect(
        readProgressGiveUp(f.dir, run),
        `a progress window that exited ${BROKEN_WINDOW_EXIT_STATUS} before it was ready must be logged as having exited before it was ready, with that status, or a window that crashed reads the same as one that was too slow`,
      ).toEqual({
        status: 1,
        announcedReady: false,
        cleanupRuns: 0,
        loggedOutcome: expect.stringMatching(
          progressWindowExitedBeforeReady(BROKEN_WINDOW_EXIT_STATUS),
        ),
      });
    },
  );

  test.each(unreadableClockRows)(
    'says the progress window could not be timed when the clock fails at $read, under $shell',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async ({ read, failingRead, shell }) => {
      const f = fixture();
      const recorder = signalRecorder(f);
      const clockReads = join(f.dir, 'clock-reads');
      const script = buildDesktopUninstallHandoffScript(
        handoffInput(f),
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable('ps', 'exit 1'),
            date: clockFailingAtRead(f, clockReads, failingRead),
            result: [f.executable('never-ready-ui', `exec /bin/sleep ${STUCK_QUERY_SECONDS}`)],
          },
          recorder.path,
        ),
      );
      const run = await runKeepingTheBoundFailure({
        shell,
        script,
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: 0,
        scriptStallsForMs: Math.min(
          inMilliseconds(STUCK_QUERY_SECONDS),
          UNINSTALL_PROGRESS_READY_TIMEOUT_MS,
        ),
        fixtureDir: f.dir,
      });
      expect(signalsTheirSenderDidNotHold(recorder.read()), UNHELD_SIGNAL_FAILURE).toEqual([]);
      if (run instanceof BoundedSpawnTimeoutError) throw run;
      expect(
        countRecordedLines(clockReads),
        `the script read the clock through commands.date fewer than the ${failingRead} times this row fails it at, so this run never reached the give-up it is here to pin`,
      ).toBeGreaterThanOrEqual(failingRead);
      expect(
        readProgressGiveUp(f.dir, run),
        `a readiness wait whose clock failed at ${read} must be logged as a progress window that could not be timed, and must start no cleanup, or a clock that failed reads the same as a window too slow to become ready`,
      ).toEqual({
        status: 1,
        announcedReady: false,
        cleanupRuns: 0,
        loggedOutcome: PROGRESS_WINDOW_UNTIMED,
      });
    },
  );

  test.each(UNINSTALL_SHELLS)(
    'stops a progress window that never becomes ready through its supervisor when the wait for it fails under %s',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      const f = fixture();
      const recorder = signalRecorder(f);
      const windowIdentity = join(f.dir, 'window-identity');
      const profilePath = join(f.dir, 'profile-path');
      const failedSleeps = join(f.dir, 'failed-sleeps');
      const script = buildDesktopUninstallHandoffScript(
        handoffInput(f),
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable('ps', 'exit 1'),
            psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
            sleep: sleepThatFailsOnceRecorded(f, windowIdentity, failedSleeps),
            result: [
              f.executable(
                'never-ready-ui',
                `printf '%s' "${'$'}{1#--user-data-dir=}" > '${profilePath}'
${recordsItsOwnIdentity(windowIdentity)}
exec /bin/sleep ${STUCK_QUERY_SECONDS}`,
              ),
            ],
          },
          recorder.path,
        ),
      );
      expectEverySignalRoutedThrough(recorder.path, script);
      const run = await runKeepingTheBoundFailure({
        shell,
        script,
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: 0,
        scriptStallsForMs: Math.min(
          inMilliseconds(STUCK_QUERY_SECONDS),
          UNINSTALL_PROGRESS_READY_TIMEOUT_MS,
        ),
        fixtureDir: f.dir,
      });
      const records = recorder.read();
      expect(signalsTheirSenderDidNotHold(records), UNHELD_SIGNAL_FAILURE).toEqual([]);
      if (run instanceof BoundedSpawnTimeoutError) throw run;
      expect(
        countRecordedLines(failedSleeps),
        'no sleep through commands.sleep failed while the progress window was running, so this run never reached the give-up it is here to pin',
      ).toBeGreaterThan(0);
      expect(
        readProgressGiveUp(f.dir, run),
        'a readiness wait whose poll sleep failed must be logged as a progress window that could not be waited for, and must start no cleanup',
      ).toEqual({
        status: 1,
        announcedReady: false,
        cleanupRuns: 0,
        loggedOutcome: PROGRESS_WINDOW_WAIT_FAILED,
      });
      const window = readRecordedIdentity(windowIdentity);
      expect(
        window.parent,
        'the progress window is a direct child of the handoff script, which stops observing it for as long as the cleanup and its dialogs take, so a signal the script sends it can land on a pid it released long before',
      ).not.toBe(String(run.pid));
      expect(
        listedInProcessTable(window.pid),
        `the progress window, pid ${window.pid}, is still in the process table after the handoff script exited, so the script left a window it started running`,
      ).toBe(false);
      expect(
        killsDeliveredByItsParent(records, window),
        'the progress window was still running when the wait for it failed and is gone now, and a run with no KILL delivered to it by the supervisor that started it stopped it with a signal it could have caught or from a process that does not hold it',
      ).not.toEqual([]);
      expect(
        existsSync(readFileSync(profilePath, 'utf8')),
        'the progress window’s profile directory is still there after the handoff script exited',
      ).toBe(false);
    },
  );

  test.each(UNINSTALL_SHELLS)(
    'stops a progress window that never becomes ready through its supervisor when the supervisor’s watch sleep fails, and logs why ahead of saying the window exited before it was ready, under %s',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      const f = fixture();
      const recorder = signalRecorder(f);
      const windowIdentity = join(f.dir, 'window-identity');
      const profilePath = join(f.dir, 'profile-path');
      const failedWatchSleeps = join(f.dir, 'failed-watch-sleeps');
      const script = buildDesktopUninstallHandoffScript(
        handoffInput(f),
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable('ps', 'exit 1'),
            psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
            watchSleep: sleepThatFailsOnceRecorded(f, windowIdentity, failedWatchSleeps),
            result: [
              f.executable(
                'never-ready-ui',
                `printf '%s' "${'$'}{1#--user-data-dir=}" > '${profilePath}'
${recordsItsOwnIdentity(windowIdentity)}
exec /bin/sleep ${STUCK_QUERY_SECONDS}`,
              ),
            ],
          },
          recorder.path,
        ),
      );
      expectEverySignalRoutedThrough(recorder.path, script);
      const run = await runKeepingTheBoundFailure({
        shell,
        script,
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: 0,
        scriptStallsForMs: Math.min(
          inMilliseconds(STUCK_QUERY_SECONDS),
          UNINSTALL_PROGRESS_READY_TIMEOUT_MS,
        ),
        fixtureDir: f.dir,
      });
      const records = recorder.read();
      expect(signalsTheirSenderDidNotHold(records), UNHELD_SIGNAL_FAILURE).toEqual([]);
      expect(
        countRecordedLines(failedWatchSleeps),
        'no watch sleep through commands.watchSleep failed while the progress window was running, so the supervisor never reached the give-up this run is here to pin',
      ).toBeGreaterThan(0);
      if (run instanceof BoundedSpawnTimeoutError) throw run;
      expect(
        readProgressGiveUp(f.dir, run),
        `a supervisor whose watch sleep failed stops the window it watches with a KILL, so the readiness wait must log that the window exited before it was ready, with the status ${KILLED_WINDOW_EXIT_STATUS} that KILL leaves, and must start no cleanup`,
      ).toEqual({
        status: 1,
        announcedReady: false,
        cleanupRuns: 0,
        loggedOutcome: expect.stringMatching(
          progressWindowExitedBeforeReady(KILLED_WINDOW_EXIT_STATUS),
        ),
      });
      expect(
        lastLoggedLines(readCleanupLog(f.dir), 2),
        `a window that crashed or was force-quit also exits ${KILLED_WINDOW_EXIT_STATUS}, so the supervisor must log that it stopped the window because it could not keep watching it, ahead of the readiness wait’s line, or the log sends triage to a window that was healthy`,
      ).toEqual([
        WINDOW_WATCH_FAILED,
        expect.stringMatching(progressWindowExitedBeforeReady(KILLED_WINDOW_EXIT_STATUS)),
      ]);
      const window = readRecordedIdentity(windowIdentity);
      expect(
        window.parent,
        'the progress window is a direct child of the handoff script, so there is no supervisor whose watch sleep this run can fail',
      ).not.toBe(String(run.pid));
      expect(
        listedInProcessTable(window.pid),
        `the progress window, pid ${window.pid}, is still in the process table after the handoff script exited, so a supervisor that stopped watching it left it running`,
      ).toBe(false);
      expect(
        killsDeliveredByItsParent(records, window),
        'the progress window was still running when its supervisor’s watch sleep failed and is gone now, and a run with no KILL delivered to it by that supervisor stopped it with a signal it could have caught or from a process that does not hold it',
      ).not.toEqual([]);
      expect(
        existsSync(readFileSync(profilePath, 'utf8')),
        'the progress window’s profile directory is still there after the handoff script exited',
      ).toBe(false);
    },
  );

  test.each(UNINSTALL_SHELLS)(
    'stops a progress window that never becomes ready when its supervisor’s shell leaves from inside its watch, as a shell that cannot fork the watch sleep does, and logs why ahead of saying the window exited before it was ready, under %s',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      const f = fixture();
      const recorder = signalRecorder(f);
      const script = buildDesktopUninstallHandoffScript(
        handoffInput(f),
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable('ps', 'exit 1'),
            psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
            watchSleep: 'exit',
            result: [f.executable('never-ready-ui', `exec /bin/sleep ${STUCK_QUERY_SECONDS}`)],
          },
          recorder.path,
        ),
      );
      expectEverySignalRoutedThrough(recorder.path, script);
      const run = await runKeepingTheBoundFailure({
        shell,
        script,
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: 0,
        scriptStallsForMs: Math.min(
          inMilliseconds(STUCK_QUERY_SECONDS),
          UNINSTALL_PROGRESS_READY_TIMEOUT_MS,
        ),
        fixtureDir: f.dir,
      });
      const records = recorder.read();
      expect(signalsTheirSenderDidNotHold(records), UNHELD_SIGNAL_FAILURE).toEqual([]);
      if (run instanceof BoundedSpawnTimeoutError) throw run;
      const [watch] = records.filter(
        (record) =>
          record.signal === '0' &&
          record.sender === record.parent &&
          record.sender !== String(run.pid),
      );
      const window = { pid: watch?.target ?? '', parent: watch?.sender ?? '' };
      expect(
        RECORDED_PID.test(window.pid) && RECORDED_PID.test(window.parent),
        'commands.watchSleep is the shell’s own exit, so the supervisor’s shell leaves from inside its watch, the way dash and bash leave a subshell that cannot fork its watch sleep. No probe of the progress window by a supervisor between it and the handoff script reached commands.kill before that, so this run never had a supervisor watching the window and cannot say which process to look for',
      ).toBe(true);
      expect(
        readProgressGiveUp(f.dir, run),
        `a supervisor whose shell leaves from inside its watch must still stop the window it watches with a KILL, so the readiness wait must log that the window exited before it was ready, with the status ${KILLED_WINDOW_EXIT_STATUS} that KILL leaves, and must start no cleanup`,
      ).toEqual({
        status: 1,
        announcedReady: false,
        cleanupRuns: 0,
        loggedOutcome: expect.stringMatching(
          progressWindowExitedBeforeReady(KILLED_WINDOW_EXIT_STATUS),
        ),
      });
      expect(
        lastLoggedLines(readCleanupLog(f.dir), 2),
        'a supervisor whose shell leaves from inside its watch must log that it stopped the window because it could not keep watching it, ahead of the readiness wait’s line, or nothing in the log says why the window exited',
      ).toEqual([
        WINDOW_WATCH_FAILED,
        expect.stringMatching(progressWindowExitedBeforeReady(KILLED_WINDOW_EXIT_STATUS)),
      ]);
      expect(
        listedInProcessTable(window.pid),
        `the progress window, pid ${window.pid}, is still in the process table after the handoff script exited, so a supervisor whose shell left from inside its watch left it running with nothing watching it`,
      ).toBe(false);
      expect(
        killsDeliveredByItsParent(records, window),
        'the progress window was still running when its supervisor’s shell left from inside its watch and is gone now, and a run with no KILL delivered to it by that supervisor stopped it with a signal it could have caught or from a process that does not hold it',
      ).not.toEqual([]);
    },
  );

  test.each(UNINSTALL_SHELLS)(
    'stops a progress window that never becomes ready at its supervisor’s first watch after the cleanup takes its token, under %s',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      const f = fixture();
      const recorder = signalRecorder(f);
      const windowIdentity = join(f.dir, 'window-identity');
      const profilePath = join(f.dir, 'profile-path');
      const failedSleeps = join(f.dir, 'failed-sleeps');
      const script = buildDesktopUninstallHandoffScript(
        handoffInput(f),
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable('ps', 'exit 1'),
            psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
            sleep: sleepThatFailsOnceRecorded(f, windowIdentity, failedSleeps),
            result: [
              f.executable(
                'token-watching-ui',
                `profile="${'$'}{1#--user-data-dir=}"
printf '%s' "$profile" > '${profilePath}'
${recordsItsOwnIdentity(windowIdentity)}
polls=0
while [ -f "$profile/watched" ]; do
  polls=$((polls + 1))
  [ "$polls" -le ${inMilliseconds(STUCK_QUERY_SECONDS) / RECORDED_IDENTITY_POLL_MS} ] || exit 1
  /bin/sleep ${RECORDED_IDENTITY_POLL_MS / 1000}
done
'${recorder.path}' -s 0 "$$"
exec /bin/sleep ${STUCK_QUERY_SECONDS}`,
              ),
            ],
          },
          recorder.path,
        ),
      );
      expectEverySignalRoutedThrough(recorder.path, script);
      const run = await runKeepingTheBoundFailure({
        shell,
        script,
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: 0,
        scriptStallsForMs: Math.min(
          inMilliseconds(STUCK_QUERY_SECONDS),
          UNINSTALL_PROGRESS_READY_TIMEOUT_MS,
        ),
        fixtureDir: f.dir,
      });
      const records = recorder.read();
      expect(signalsTheirSenderDidNotHold(records), UNHELD_SIGNAL_FAILURE).toEqual([]);
      if (run instanceof BoundedSpawnTimeoutError) throw run;
      expect(
        countRecordedLines(failedSleeps),
        'no sleep through commands.sleep failed while the progress window was running, so this run never reached the give-up whose cleanup it is here to pin',
      ).toBeGreaterThan(0);
      expect(
        readProgressGiveUp(f.dir, run),
        'a readiness wait whose poll sleep failed must be logged as a progress window that could not be waited for, and must start no cleanup',
      ).toEqual({
        status: 1,
        announcedReady: false,
        cleanupRuns: 0,
        loggedOutcome: PROGRESS_WINDOW_WAIT_FAILED,
      });
      const window = readRecordedIdentity(windowIdentity);
      expect(
        window.parent,
        'the progress window is a direct child of the handoff script, so there is no supervisor watching it and nothing whose watch this run can time',
      ).not.toBe(String(run.pid));
      expect(
        listedInProcessTable(window.pid),
        `the progress window, pid ${window.pid}, is still in the process table after the handoff script exited, so the script left a window it started running`,
      ).toBe(false);
      expect(
        killsDeliveredByItsParent(records, window),
        'the progress window was still running when the cleanup took its token and is gone now, and a run with no KILL delivered to it by the supervisor that started it stopped it with a signal it could have caught or from a process that does not hold it',
      ).not.toEqual([]);
      expect(
        existsSync(readFileSync(profilePath, 'utf8')),
        'the progress window’s profile directory is still there after the handoff script exited',
      ).toBe(false);
      const sawTheTokenGoneAt = records.findIndex(
        (record) =>
          record.signal === '0' && record.sender === window.pid && record.target === window.pid,
      );
      const watchesAfterTheTokenWent = (
        sawTheTokenGoneAt === -1 ? [] : records.slice(sawTheTokenGoneAt + 1)
      ).filter(
        (record) =>
          record.signal === '0' && record.sender === window.parent && record.target === window.pid,
      );
      expect(
        watchesAfterTheTokenWent.length,
        `the supervisor probed its progress window ${watchesAfterTheTokenWent.length} times after the window had seen the cleanup take the token that keeps the supervisor watching (${watchesAfterTheTokenWent.map(describeSignalRecord).join('; ')}), so it went on watching a window it had been told to stop. It checks the token before each probe of its window and again only after a watch sleep, so once the token is gone it makes at most one more probe of its window, one whose check came before the token went and whose record landed after the window saw it go, and then the probe that guards its KILL: two at most. Each probe past those is one more watch period the cleanup waits on the supervisor before the handoff can exit. This measures no elapsed time: it counts probes the recorder saw after one it saw, an order host load cannot change, and a window stopped before it could see the token go leaves nothing to count, which can let a slow stop through but never fails a prompt one`,
      ).toBeLessThanOrEqual(2);
    },
  );

  test.each(UNINSTALL_SHELLS)(
    'closes its readiness pipe inside its bound when the handoff shell is killed while the progress window supervisor it started still runs, under %s',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      const f = fixture();
      const recorder = signalRecorder(f);
      const windowIdentity = join(f.dir, 'window-identity');
      const script = buildDesktopUninstallHandoffScript(
        handoffInput(f),
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable('ps', 'exit 1'),
            psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
            sleep: f.executable(
              'sleep-killing-its-shell-once-recorded',
              `if [ -s '${windowIdentity}' ]; then
${signalsItsOwnParent('KILL')}
exit 0
fi
exec /bin/sleep "$1"`,
            ),
            result: [
              f.executable(
                'recorded-ui',
                `${recordsItsOwnIdentity(windowIdentity)}
exec /bin/sleep ${STUCK_QUERY_SECONDS}`,
              ),
            ],
          },
          recorder.path,
        ),
      );
      expectEverySignalRoutedThrough(recorder.path, script);
      expect(
        inMilliseconds(STUCK_QUERY_SECONDS),
        `the progress window the killed handoff leaves its supervisor watching parks for ${inMilliseconds(STUCK_QUERY_SECONDS)}ms, which must be at least ${HANDOFF_STALL_OVER_BOUND}x the ${HANDOFF_LIVENESS_BOUND_MS}ms bound, or closing inside the bound is no proof the readiness pipe never waited on that supervisor`,
      ).toBeGreaterThanOrEqual(HANDOFF_STALL_OVER_BOUND * HANDOFF_LIVENESS_BOUND_MS);
      const child = spawn(shell, ['-c', script], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, TMPDIR: f.dir },
      });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      try {
        const settled = await settledInsideBound(once(child, 'close'), HANDOFF_LIVENESS_BOUND_MS);
        const window = readRecordedIdentity(windowIdentity);
        const supervisorListedAtClose =
          RECORDED_PID.test(window.parent) && listedInProcessTable(window.parent);
        const exited = child.exitCode ?? child.signalCode;
        const stateAtBound =
          exited === null ? 'had not exited' : `had exited (${exited}) with its stdout still open`;
        expect(
          settled,
          `${HANDOFF_LIVENESS_BOUND_MS}ms after it started, with the handoff shell killed during its readiness wait, the handoff ${stateAtBound}, so something that shell started, such as the supervisor of its progress window, holds the pipe the handoff reports readiness on, and whoever waits on that pipe to learn the helper died waits on that supervisor instead.\nstdout so far: ${stdout}`,
        ).not.toBe(NOT_SETTLED);
        const records = recorder.read();
        expect(signalsTheirSenderDidNotHold(records), UNHELD_SIGNAL_FAILURE).toEqual([]);
        expect(
          child.signalCode,
          'the handoff shell did not die of the KILL its poll-sleep fixture sends it once the progress window has recorded itself, so this run never left the supervisor running without the shell that started it',
        ).toBe('SIGKILL');
        expect(
          window.parent,
          'the progress window is a direct child of the handoff shell, so there is no supervisor to outlive that shell and this run says nothing about one',
        ).not.toBe(String(child.pid));
        expect(
          supervisorListedAtClose,
          `the supervisor of the progress window, pid ${window.parent}, was no longer running when the readiness pipe closed, so it did not outlive the killed shell and this run cannot tell a supervisor detached from that pipe from one that holds it`,
        ).toBe(true);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        for (const name of readdirSync(f.dir)) {
          if (name.startsWith('ok-uninstall-result.')) {
            rmSync(join(f.dir, name, 'watched'), { force: true });
          }
        }
        const supervisor = readRecordedIdentity(windowIdentity).parent;
        const quietBy = Date.now() + HANDOFF_LIVENESS_BOUND_MS;
        while (
          RECORDED_PID.test(supervisor) &&
          supervisor !== String(child.pid) &&
          Date.now() < quietBy &&
          listedInProcessTable(supervisor)
        ) {
          await delay(RECORDED_IDENTITY_POLL_MS);
        }
        child.stdout.destroy();
      }
    },
  );

  test.each(UNINSTALL_SHELLS)(
    'says the progress window could not be started, and starts no cleanup, when its profile cannot be created, under %s',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      const f = fixture();
      const recorder = signalRecorder(f);
      const windowIdentity = join(f.dir, 'window-identity');
      const temporaryDirectory = join(f.dir, 'temporary-directory-never-created');
      const script = buildDesktopUninstallHandoffScript(
        handoffInput(f),
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable('ps', 'exit 1'),
            psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
            result: [
              f.executable(
                'recorded-ui',
                `${recordsItsOwnIdentity(windowIdentity)}
exec /bin/sleep ${STUCK_QUERY_SECONDS}`,
              ),
            ],
          },
          recorder.path,
        ),
      );
      expectEverySignalRoutedThrough(recorder.path, script);
      expect(
        existsSync(temporaryDirectory),
        `this row needs a temporary directory no profile can be created in, and ${temporaryDirectory} exists, so the run below would create one`,
      ).toBe(false);
      const run = await runKeepingTheBoundFailure({
        shell: '/bin/sh',
        script: withTemporaryDirectory(shell, temporaryDirectory, script),
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: 0,
        scriptStallsForMs: Math.min(
          inMilliseconds(STUCK_QUERY_SECONDS),
          UNINSTALL_PROGRESS_READY_TIMEOUT_MS,
        ),
        fixtureDir: f.dir,
      });
      expect(signalsTheirSenderDidNotHold(recorder.read()), UNHELD_SIGNAL_FAILURE).toEqual([]);
      if (run instanceof BoundedSpawnTimeoutError) throw run;
      expect(
        { ...readProgressGiveUp(f.dir, run), windowStarted: existsSync(windowIdentity) },
        'a progress window whose profile could not be created must be logged as a progress window that could not be started, and must start neither the window nor any cleanup, or a handoff that gave up before it could show its progress leaves no reason why',
      ).toEqual({
        status: 1,
        announcedReady: false,
        cleanupRuns: 0,
        loggedOutcome: PROGRESS_WINDOW_NOT_STARTED,
        windowStarted: false,
      });
    },
  );

  test.each(UNINSTALL_SHELLS)(
    'says the progress window could not be started, and starts no cleanup, when the token that keeps its supervisor watching cannot be written, under %s',
    { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
    async (shell) => {
      const f = fixture();
      const recorder = signalRecorder(f);
      const windowIdentity = join(f.dir, 'window-identity');
      const temporaryDirectory = temporaryDirectoryWithRoomForADirectoryButNotItsFile(
        f,
        RESULT_PROFILE_TEMPLATE,
        RESULT_WINDOW_TOKEN,
      );
      const script = buildDesktopUninstallHandoffScript(
        handoffInput(f),
        withSignalSeam(
          {
            ...f.commands,
            ps: f.executable('ps', 'exit 1'),
            psTimeoutSeconds: HANDOFF_WATCHDOG_SECONDS,
            result: [
              f.executable(
                'recorded-ui',
                `${recordsItsOwnIdentity(windowIdentity)}
exec /bin/sleep ${STUCK_QUERY_SECONDS}`,
              ),
            ],
          },
          recorder.path,
        ),
      );
      expectEverySignalRoutedThrough(recorder.path, script);
      expect(
        tryADirectoryAndItsFile(
          temporaryDirectory.path,
          RESULT_PROFILE_TEMPLATE,
          RESULT_WINDOW_TOKEN,
        ),
        `this row needs a temporary directory with room under the ${temporaryDirectory.pathMax}-byte path limit this host reports for a profile but not for the token written into it, and ${temporaryDirectory.path} is not one, so the run below would fail somewhere other than the token write`,
      ).toEqual({ directory: 'created', file: 'ENAMETOOLONG' });
      const run = await runKeepingTheBoundFailure({
        shell: '/bin/sh',
        script: withTemporaryDirectory(shell, temporaryDirectory.path, script),
        boundMs: HANDOFF_LIVENESS_BOUND_MS,
        scriptCompletesWithinMs: 0,
        scriptStallsForMs: Math.min(
          inMilliseconds(STUCK_QUERY_SECONDS),
          UNINSTALL_PROGRESS_READY_TIMEOUT_MS,
        ),
        fixtureDir: f.dir,
      });
      expect(signalsTheirSenderDidNotHold(recorder.read()), UNHELD_SIGNAL_FAILURE).toEqual([]);
      if (run instanceof BoundedSpawnTimeoutError) throw run;
      expect(
        reportsAFailedWriteOfItsFile(
          run.stderr,
          temporaryDirectory.path,
          RESULT_PROFILE_TEMPLATE,
          RESULT_WINDOW_TOKEN,
        ),
        `the shell reported no failed write of the token into a profile it had created in ${temporaryDirectory.path}, so this run never reached the token write it is here to fail.\nstderr: ${run.stderr.trim()}`,
      ).toBe(true);
      expect(
        {
          ...readProgressGiveUp(f.dir, run),
          windowStarted: existsSync(windowIdentity),
          profilesLeft: resultProfilesIn(temporaryDirectory.path),
        },
        'a progress window whose token could not be written must be logged as a progress window that could not be started, the handoff must then exit 1 having started neither the window nor any cleanup, and the profile it created must be gone: a shell that exits on the failed write itself gives up with no reason logged and a status the handoff never uses',
      ).toEqual({
        status: 1,
        announcedReady: false,
        cleanupRuns: 0,
        loggedOutcome: PROGRESS_WINDOW_NOT_STARTED,
        windowStarted: false,
        profilesLeft: [],
      });
    },
  );
});

const RESULT_WINDOW_CHOICES = [
  { exitStatus: 0, reveals: 'nothing' },
  { exitStatus: 10, reveals: 'the cleanup log' },
  { exitStatus: 11, reveals: 'the app bundle' },
] as const;

const resultWindowChoiceRows = UNINSTALL_SHELLS.flatMap((shell) =>
  RESULT_WINDOW_CHOICES.map(({ exitStatus, reveals }) => [exitStatus, shell, reveals] as const),
);

describe.skipIf(process.platform === 'win32')(
  'result windows the result script starts itself',
  () => {
    test.each(resultWindowChoiceRows)(
      'characterization: the result script acts on the choice its own result window reports by exiting %i under %s',
      (exitStatus, shell, reveals) => {
        const f = fixture();
        const recorder = signalRecorder(f);
        const logPath = join(f.dir, 'cleanup.log');
        const appBundlePath = join(f.dir, 'OpenKnowledge.app');
        const profilePath = join(f.dir, 'profile-path');
        const windowModes = join(f.dir, 'window-modes');
        const script = buildDesktopUninstallResultScript(
          { appBundlePath, logPath, cleanup: { ok: true } },
          withSignalSeam(
            {
              ...f.commands,
              open: f.executable('finder', `printf 'reveal:%s\\n' "$2" >> '${f.events}'`),
              result: [
                f.executable(
                  'result-ui',
                  `printf '%s' "${'$'}{1#--user-data-dir=}" > '${profilePath}'
printf '%s\\n' "$2" >> '${windowModes}'
exit ${exitStatus}`,
                ),
              ],
            },
            recorder.path,
          ),
        );
        const result = spawnSyncBounded(shell, ['-c', script], {
          timeoutMs: HANDOFF_LIVENESS_BOUND_MS,
          cwd: '/',
          env: { ...process.env, TMPDIR: f.dir },
        });
        expect(signalsTheirSenderDidNotHold(recorder.read()), UNHELD_SIGNAL_FAILURE).toEqual([]);
        expect(
          {
            status: result.status,
            windowModes: readTextOrDescribeWhyNot(windowModes).trim().split('\n'),
            events: existsSync(f.events) ? readFileSync(f.events, 'utf8').trim().split('\n') : [],
            logged: readCleanupLog(f.dir).trimEnd().split('\n'),
            profileLeftBehind: existsSync(readFileSync(profilePath, 'utf8')),
          },
          `the result script started its own result window, which exited ${exitStatus}. Today that makes the script reveal ${reveals}, show no fallback dialog, log nothing past the outcome and remove the window's profile. This pins behaviour the result script already has: the window's exit status is the only channel that carries the user's choice back from the result window, so it has to survive any change to how the script starts, watches or stops that window, and the pin retires only if that choice comes back by some other channel`,
        ).toEqual({
          status: 0,
          windowModes: ['--ok-uninstall-result'],
          events:
            reveals === 'the cleanup log'
              ? [`reveal:${logPath}`]
              : reveals === 'the app bundle'
                ? [`reveal:${appBundlePath}`]
                : [],
          logged: [CLEANUP_SUCCEEDED_OUTCOME],
          profileLeftBehind: false,
        });
      },
    );

    test.each(UNINSTALL_SHELLS)(
      'stops its own result window through its supervisor when the result script is interrupted under %s',
      { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
      async (shell) => {
        const f = fixture();
        const recorder = signalRecorder(f);
        const windowIdentity = join(f.dir, 'window-identity');
        const profilePath = join(f.dir, 'profile-path');
        const script = buildDesktopUninstallResultScript(
          {
            appBundlePath: '/owned/App.app',
            logPath: join(f.dir, 'cleanup.log'),
            cleanup: { ok: true },
          },
          withSignalSeam(
            {
              ...f.commands,
              result: [
                f.executable(
                  'waiting-result-ui',
                  `printf '%s' "${'$'}{1#--user-data-dir=}" > '${profilePath}'
${recordsItsOwnIdentity(windowIdentity)}
exec /bin/sleep ${STUCK_QUERY_SECONDS}`,
                ),
              ],
            },
            recorder.path,
          ),
        );
        expectEverySignalRoutedThrough(recorder.path, script);
        expect(
          inMilliseconds(STUCK_QUERY_SECONDS),
          `the result window this interrupts parks for ${inMilliseconds(STUCK_QUERY_SECONDS)}ms, which must be at least ${HANDOFF_STALL_OVER_BOUND}x the ${HANDOFF_LIVENESS_BOUND_MS}ms bound, or closing inside the bound is no proof the window was stopped`,
        ).toBeGreaterThanOrEqual(HANDOFF_STALL_OVER_BOUND * HANDOFF_LIVENESS_BOUND_MS);
        const child = spawn(shell, ['-c', script], {
          stdio: 'ignore',
          env: { ...process.env, TMPDIR: f.dir },
        });
        try {
          const window = await awaitRecordedIdentity(windowIdentity, HANDOFF_LIVENESS_BOUND_MS);
          const closed = once(child, 'close');
          child.kill('SIGTERM');
          expect(
            await settledInsideBound(closed, HANDOFF_LIVENESS_BOUND_MS),
            `the interrupted result script was still running ${HANDOFF_LIVENESS_BOUND_MS}ms after it was sent TERM, so the window it waits on was never stopped`,
          ).not.toBe(NOT_SETTLED);
          const records = recorder.read();
          expect(signalsTheirSenderDidNotHold(records), UNHELD_SIGNAL_FAILURE).toEqual([]);
          expect(
            window.parent,
            'the result window is a direct child of the result script, so the script signals a pid it does not observe while it waits for the user',
          ).not.toBe(String(child.pid));
          expect(
            listedInProcessTable(window.pid),
            `the result window, pid ${window.pid}, is still in the process table after the interrupted result script exited, so the script left a window it started running`,
          ).toBe(false);
          expect(
            killsDeliveredByItsParent(records, window),
            'the result window was still running when the script was interrupted and is gone now, and a run with no KILL delivered to it by the supervisor that started it stopped it with a signal it could have caught or from a process that does not hold it',
          ).not.toEqual([]);
          expect(
            existsSync(readFileSync(profilePath, 'utf8')),
            'the result window’s profile directory is still there after the interrupted result script exited',
          ).toBe(false);
          expect(
            existsSync(f.events),
            'an interrupted result script went on to show a dialog or reveal a file',
          ).toBe(false);
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
      },
    );

    test.each(UNINSTALL_SHELLS)(
      'falls back to the system dialog when the token that keeps its result window’s supervisor watching cannot be written, under %s',
      { timeout: HANDOFF_EXECUTION_TIMEOUT_MS },
      async (shell) => {
        const f = fixture();
        const recorder = signalRecorder(f);
        const windowIdentity = join(f.dir, 'window-identity');
        const temporaryDirectory = temporaryDirectoryWithRoomForADirectoryButNotItsFile(
          f,
          RESULT_PROFILE_TEMPLATE,
          RESULT_WINDOW_TOKEN,
        );
        const script = buildDesktopUninstallResultScript(
          {
            appBundlePath: '/owned/App.app',
            logPath: join(f.dir, 'cleanup.log'),
            cleanup: { ok: true },
          },
          withSignalSeam(
            {
              ...f.commands,
              result: [
                f.executable(
                  'recorded-result-ui',
                  `${recordsItsOwnIdentity(windowIdentity)}
exec /bin/sleep ${STUCK_QUERY_SECONDS}`,
                ),
              ],
            },
            recorder.path,
          ),
        );
        expectEverySignalRoutedThrough(recorder.path, script);
        expect(
          tryADirectoryAndItsFile(
            temporaryDirectory.path,
            RESULT_PROFILE_TEMPLATE,
            RESULT_WINDOW_TOKEN,
          ),
          `this row needs a temporary directory with room under the ${temporaryDirectory.pathMax}-byte path limit this host reports for a profile but not for the token written into it, and ${temporaryDirectory.path} is not one, so the run below would fail somewhere other than the token write`,
        ).toEqual({ directory: 'created', file: 'ENAMETOOLONG' });
        const run = await runKeepingTheBoundFailure({
          shell: '/bin/sh',
          script: withTemporaryDirectory(shell, temporaryDirectory.path, script),
          boundMs: HANDOFF_LIVENESS_BOUND_MS,
          scriptCompletesWithinMs: 0,
          scriptStallsForMs: inMilliseconds(STUCK_QUERY_SECONDS),
          fixtureDir: f.dir,
        });
        expect(signalsTheirSenderDidNotHold(recorder.read()), UNHELD_SIGNAL_FAILURE).toEqual([]);
        if (run instanceof BoundedSpawnTimeoutError) throw run;
        expect(
          reportsAFailedWriteOfItsFile(
            run.stderr,
            temporaryDirectory.path,
            RESULT_PROFILE_TEMPLATE,
            RESULT_WINDOW_TOKEN,
          ),
          `the shell reported no failed write of the token into a profile it had created in ${temporaryDirectory.path}, so this run never reached the token write it is here to fail.\nstderr: ${run.stderr.trim()}`,
        ).toBe(true);
        expect(
          {
            status: run.status,
            logged: readCleanupLog(f.dir).trimEnd().split('\n'),
            systemDialogShown: readTextOrDescribeWhyNot(f.events).includes(SUCCESS_DIALOG_TITLE),
            windowStarted: existsSync(windowIdentity),
            profilesLeft: resultProfilesIn(temporaryDirectory.path),
          },
          `a result window whose token could not be written was never started, so the result script must log that it could not show the completion window (exit ${RESULT_WINDOW_UNSTARTED_STATUS}), show the outcome in the system dialog instead, remove the profile it created and exit 0: a shell that exits on the failed write itself shows the user no outcome at all`,
        ).toEqual({
          status: 0,
          logged: [CLEANUP_SUCCEEDED_OUTCOME, resultWindowFellBack(RESULT_WINDOW_UNSTARTED_STATUS)],
          systemDialogShown: true,
          windowStarted: false,
          profilesLeft: [],
        });
      },
    );
  },
);
