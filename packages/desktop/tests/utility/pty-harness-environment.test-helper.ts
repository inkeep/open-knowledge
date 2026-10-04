import { EventEmitter } from 'node:events';
import { readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { vi } from 'vitest';
import type { PtyProcessLike, SpawnPty } from '../../src/utility/pty-host.ts';

export interface ControlledHarnessOptions {
  firstScenario: 'fast' | 'slow';
  platform?: 'win32' | 'linux';
  lifecycle?: {
    launchAtMs: number;
    exitAfterKillMs: number | null;
    outputAfterKill?: boolean;
    replacementOutputAfterCreateMs?: number | null;
    replacementExitAfterCreateMs?: number;
    firstKillDeliveryMs?: number;
    replacementCreateAdvanceMs?: number;
  };
  phase?:
    | 'launch-after-grant'
    | 'first-input-after-grant'
    | 'arithmetic-after-grant'
    | 'cwd-after-grant'
    | 'environment-after-grant'
    | 'silent-contained'
    | 'attach-only'
    | 'stale-launch'
    | 'echo-only'
    | 'input-window'
    | 'delayed-input-write'
    | 'delayed-exit'
    | 'continuous-wrong-output'
    | 'posix-late-quiet'
    | 'posix-unstable-quiet';
  launchReadiness?: 'advancing' | 'stuck' | 'dead';
  budgetOverride?: string;
  silentAt?: 'initial-input' | 'environment-input' | 'launch-token' | 'command-output';
  queryMode?: 'delayed-invalid';
}

export interface ControlledHarnessResult {
  exitCode: Parameters<typeof process.exit>[0];
  lines: string[];
  events: Array<{ shell: number; event: string; at: number; trace?: Record<string, unknown> }>;
  traceEvents: Record<string, unknown>[];
  delayedQuery?: { traceBeforeDelivery: string; linesBeforeDelivery: string };
}

export async function runControlledHarness(
  options: ControlledHarnessOptions,
): Promise<ControlledHarnessResult> {
  const result: ControlledHarnessResult = {
    exitCode: undefined,
    lines: [],
    events: [],
    traceEvents: [],
  };
  const dirs: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (platformDescriptor === undefined) throw new Error('process.platform is unavailable');
  const systemRoot = 'C:\\Windows';
  const platform = options.platform ?? 'win32';
  const lifecycle =
    options.lifecycle ??
    (options.phase === 'delayed-exit' ? { launchAtMs: 44_000, exitAfterKillMs: 1_800 } : undefined);
  let shellCount = 0;
  const delayedQuery = { release: undefined as (() => void) | undefined };
  const record = (shell: number, event: string, trace?: Record<string, unknown>): void => {
    result.events.push({
      shell,
      event,
      at: performance.now(),
      ...(trace === undefined ? {} : { trace }),
    });
  };
  const spawn: SpawnPty = (file, args, spawnOptions): PtyProcessLike => {
    if (file.includes('no-such-shell-xyz')) throw new Error('file not found');
    const shell = ++shellCount;
    const launch = spawnOptions.env.OK_HARNESS_LAUNCH_TOKEN !== undefined;
    const spawnedAt = performance.now();
    let dataListener: (data: string) => void = () => undefined;
    let exitListener: Parameters<PtyProcessLike['onExit']>[0] = () => undefined;
    let closed = false;
    let killRequested = false;
    const ownedTimers = new Set<ReturnType<typeof setTimeout>>();
    const later = (delay: number, action: () => void): void => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        ownedTimers.delete(timer);
        if (!closed) action();
      }, delay);
      timers.add(timer);
      ownedTimers.add(timer);
    };
    const emit = (data: string): void => {
      if (shell === 4 && killRequested && lifecycle?.outputAfterKill === false) return;
      record(shell, 'output');
      dataListener(data);
    };
    const at = (target: number, action: () => void): void => {
      later(Math.max(1, target - (performance.now() - spawnedAt)), action);
    };
    const progressingUntil = (last: number, cadence: number, message: string): void => {
      for (let when = cadence; when <= last; when += cadence) {
        at(when, () => emit(message));
      }
    };
    const exit = (code: number): void => {
      closed = true;
      for (const timer of ownedTimers) {
        clearTimeout(timer);
        timers.delete(timer);
      }
      ownedTimers.clear();
      record(shell, `exit:${code}`);
      exitListener({ exitCode: code });
    };
    record(shell, 'spawn');
    if (shell === 5 && lifecycle?.replacementCreateAdvanceMs !== undefined) {
      vi.advanceTimersByTime(lifecycle.replacementCreateAdvanceMs);
      record(shell, 'creation-delivery-complete');
    }
    if (
      platform === 'win32' &&
      !(shell === 5 && lifecycle?.replacementOutputAfterCreateMs !== undefined)
    ) {
      later(1, () => emit('\u001b[1t\u001b[c\u001b[?1004h\u001b[?9001h'));
    }
    if (shell === 5 && lifecycle?.replacementOutputAfterCreateMs != null) {
      later(lifecycle.replacementOutputAfterCreateMs, () => {
        record(shell, 'replacement-first-data');
        emit('PowerShell\r\nPS C:\\project> ');
      });
    }
    if (shell === 5 && lifecycle?.replacementExitAfterCreateMs !== undefined) {
      later(lifecycle.replacementExitAfterCreateMs, () => exit(1));
    }
    if (launch) {
      if (!Array.isArray(args) || !args.includes('-EncodedCommand')) {
        throw new Error('structured launch did not provide an encoded command');
      }
      if (options.phase === 'attach-only') {
        progressingUntil(84_000, 500, '\u001b[?1004h');
      } else {
        for (const when of [1_000, 8_000, 15_000, 22_000]) {
          later(when, () => {
            record(shell, 'launch-startup-output');
            emit('PowerShell startup\r\n');
          });
        }
        if (options.phase === 'launch-after-grant') {
          for (const when of [24_000, 25_000]) at(when, () => emit('PowerShell startup\r\n'));
        }
        if (lifecycle !== undefined) {
          for (let when = 29_000; when < lifecycle.launchAtMs; when += 7_000) {
            at(when, () => emit('PowerShell startup\r\n'));
          }
        }
        const launchAt = lifecycle?.launchAtMs ?? 23_000;
        if (options.silentAt !== 'launch-token') {
          at(options.phase === 'launch-after-grant' ? 26_000 : launchAt, () => {
            record(shell, 'launch-token');
            emit(`${spawnOptions.env.OK_HARNESS_LAUNCH_TOKEN}\r\nPS C:\\project> `);
          });
        }
      }
    } else {
      if (platform === 'linux' && shell === 1 && options.phase === 'posix-late-quiet') {
        progressingUntil(14_400, 800, 'starting shell\r\n');
        at(15_200, () => emit('$ '));
      } else if (platform === 'linux' && shell === 1 && options.phase === 'posix-unstable-quiet') {
        at(1_000, () => emit('$ '));
        progressingUntil(29_000, 800, 'working\r\n');
      } else {
        if (!(shell === 5 && lifecycle?.replacementOutputAfterCreateMs !== undefined)) {
          later(1_000, () => emit(platform === 'win32' ? 'PowerShell\r\nPS C:\\project> ' : '$ '));
        }
      }
    }
    return {
      pid: 4_000 + shell,
      onData(listener) {
        dataListener = listener;
      },
      onExit(listener) {
        exitListener = listener;
      },
      write(data) {
        record(shell, 'input');
        const command = data.trim();
        const arithmetic =
          platform === 'win32'
            ? /^Write-Output "([^"]*)_\$\(\((\d+)\*(\d+)\)\)_([^"]*)"$/u.exec(command)
            : /^echo (.*)_\$\(\((\d+)\*(\d+)\)\)_(.*)$/u.exec(command);
        if (arithmetic !== null) {
          const output = `${arithmetic[1]}_${Number(arithmetic[2]) * Number(arithmetic[3])}_${arithmetic[4]}\r\n`;
          if (
            (shell === 1 && options.silentAt === 'initial-input') ||
            (shell === 2 && options.silentAt === 'environment-input')
          ) {
            record(shell, 'unanswered-readiness-input');
            return;
          }
          if (shell === 1 && arithmetic[1] === 'HARNESS') {
            record(shell, 'command-input');
            if (options.silentAt === 'command-output') return;
          }
          if (launch && arithmetic[1]?.startsWith('OK_INPUT_READY_')) {
            const readiness = options.launchReadiness ?? 'advancing';
            if (readiness === 'dead') {
              later(500, () => exit(1));
            } else if (readiness === 'advancing') {
              if (options.phase === 'echo-only') {
                later(500, () => emit(`${command}\r\n`));
              } else if (options.phase === 'input-window') {
                later(18_000, () => emit(output));
              } else if (options.phase === 'delayed-input-write') {
                vi.advanceTimersByTime(10_000);
                later(8_000, () => emit(output));
              } else if (options.phase === 'continuous-wrong-output') {
                progressingUntil(84_000, 500, 'working\r\n');
              } else if (options.phase === 'stale-launch') {
                later(500, () => emit('PS C:\\project> '));
              } else {
                later(500, () => emit('PS C:\\project> '));
                later(1_500, () => emit('evaluating\r\n'));
                later(2_500, () => emit('result\r\n'));
                later(3_000, () => {
                  record(shell, 'evaluated-reply');
                  emit(output);
                });
              }
            }
          } else if (
            shell === 1 &&
            options.firstScenario === 'slow' &&
            arithmetic[1]?.startsWith('OK_INPUT_READY_')
          ) {
            const readyAt = 31_000;
            for (const at of [6_000, 12_000, 18_000, 24_000, 30_000]) {
              later(at - (performance.now() - spawnedAt), () => emit('loading profile\r\n'));
            }
            later(Math.max(1, readyAt - (performance.now() - spawnedAt)), () => emit(output));
          } else if (
            shell === 1 &&
            options.phase === 'first-input-after-grant' &&
            arithmetic[1]?.startsWith('OK_INPUT_READY_')
          ) {
            progressingUntil(43_000, 7_000, 'loading profile\r\n');
            at(44_000, () => {
              record(shell, 'evaluated-reply');
              emit(output);
            });
          } else if (
            shell === 1 &&
            options.phase === 'silent-contained' &&
            arithmetic[1]?.startsWith('OK_INPUT_READY_')
          ) {
            later(18_000, () => {
              record(shell, 'evaluated-reply');
              emit(output);
            });
          } else if (
            shell === 1 &&
            options.phase === 'arithmetic-after-grant' &&
            arithmetic[1] === 'HARNESS'
          ) {
            progressingUntil(43_000, 7_000, 'calculating\r\n');
            at(44_000, () => {
              record(shell, 'arithmetic-output');
              emit(output);
            });
          } else {
            later(shell === 2 ? 3_000 : 1, () => emit(output));
          }
          return;
        }
        const environment =
          platform === 'win32'
            ? /^Write-Output "([^=]+)=\[\$env:([A-Z_]+)\]"$/u.exec(command)
            : /^echo "([^=]+)=\[\$([A-Z_]+)\]"$/u.exec(command);
        if (environment !== null) {
          const name = environment[2];
          if (name === undefined) throw new Error('environment command has no variable');
          if (shell === 2 && options.phase === 'environment-after-grant') {
            progressingUntil(42_000, 7_000, 'checking environment\r\n');
            at(43_000, () => {
              record(shell, 'environment-output');
              emit(`${environment[1]}=[${spawnOptions.env[name] ?? ''}]\r\n`);
            });
          } else {
            later(1, () => emit(`${environment[1]}=[${spawnOptions.env[name] ?? ''}]\r\n`));
          }
          return;
        }
        if (
          command.startsWith('Write-Output "CWD_PROOF=') ||
          command.startsWith("printf 'CWD_PROOF=%s\\n'")
        ) {
          const proof = readFileSync(join(spawnOptions.cwd, '.ok-pty-cwd-proof'), 'utf8');
          if (shell === 1 && options.phase === 'cwd-after-grant') {
            progressingUntil(43_000, 7_000, 'reading project\r\n');
            at(44_000, () => {
              record(shell, 'cwd-output');
              emit(`CWD_PROOF=${proof}\r\n`);
            });
          } else {
            later(1, () => emit(`CWD_PROOF=${proof}\r\n`));
          }
          return;
        }
        throw new Error(`unsupported controlled shell input: ${command}`);
      },
      resize() {},
      kill() {
        record(shell, 'kill-request');
        if (shell !== 4 || lifecycle === undefined) return exit(1);
        if (killRequested) return;
        killRequested = true;
        if (lifecycle.outputAfterKill) {
          for (let when = 500; when <= 30_000; when += 500) {
            later(when, () => emit('terminating\r\n'));
          }
        }
        if (lifecycle.exitAfterKillMs !== null) {
          later(lifecycle.exitAfterKillMs, () => exit(1));
        }
        if (lifecycle.firstKillDeliveryMs !== undefined) {
          vi.advanceTimersByTime(lifecycle.firstKillDeliveryMs);
        }
      },
      pause() {},
      resume() {},
    };
  };

  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  vi.stubEnv('SystemRoot', systemRoot);
  if (platform === 'linux') vi.stubEnv('SHELL', '/bin/sh');
  vi.stubEnv('OK_PTY_HARNESS_BUDGET_MS', options.budgetOverride);
  vi.doMock('node:module', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:module')>();
    return {
      ...original,
      createRequire: (url: string | URL) => {
        const realRequire = original.createRequire(url);
        return Object.assign(
          (name: string) => {
            if (name !== 'node-pty') {
              throw new Error(`unsupported controlled module: ${name}`);
            }
            return { spawn };
          },
          { resolve: realRequire.resolve },
        );
      },
    };
  });
  vi.doMock('node:child_process', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:child_process')>();
    return {
      ...original,
      execFileSync: (file: string) => {
        if (!file.endsWith('\\where.exe')) {
          throw new Error('controlled harness cannot execute a native subprocess');
        }
        return 'C:\\Program Files\\PowerShell\\7\\pwsh.exe\r\n';
      },
      spawn: () => {
        record(0, 'query-start');
        if (options.queryMode !== 'delayed-invalid') {
          throw new Error('controlled harness cannot spawn a native subprocess');
        }
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const child = Object.assign(new EventEmitter(), {
          pid: 93_421,
          stdout,
          stderr,
          stdin: new PassThrough(),
          kill() {
            record(0, 'query-termination-request');
            return true;
          },
        });
        delayedQuery.release = () => {
          record(0, 'late-query-output');
          stdout.end('{"extra":"private shell text"');
          stderr.end('private fixture stderr');
          child.emit('close', 1, null);
        };
        return child;
      },
    };
  });
  vi.doMock('node:fs', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:fs')>();
    return {
      ...original,
      chmodSync: (path: Parameters<typeof original.chmodSync>[0]) => {
        if (basename(String(path)) !== 'spawn-helper') {
          throw new Error('controlled harness cannot chmod a native file');
        }
        record(0, 'helper-chmod-doubled');
      },
      existsSync: (path: Parameters<typeof original.existsSync>[0]) =>
        path === '/bin/sh' ||
        /(?:powershell|pwsh)\.exe$/iu.test(String(path)) ||
        original.existsSync(path),
      mkdtempSync: (prefix: string) => {
        const dir = original.mkdtempSync(prefix);
        dirs.push(dir);
        return dir;
      },
    };
  });
  const log = vi.spyOn(console, 'log').mockImplementation((line: string) => {
    result.lines.push(line);
    if (line.startsWith('PTY_HOST ')) {
      const start = line.indexOf('{');
      if (start >= 0) {
        const trace = JSON.parse(line.slice(start)) as Record<string, unknown>;
        result.traceEvents.push(trace);
        record(0, `trace:${String(trace.stage)}`, trace);
      }
    }
  });
  const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    result.exitCode = code;
    vi.clearAllTimers();
    return undefined as never;
  });
  const signal = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('controlled harness cannot send a native signal');
  });
  try {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
    await import('./pty-host.real-io-harness.ts');
    await vi.runAllTimersAsync();
    if (options.queryMode === 'delayed-invalid' && delayedQuery.release !== undefined) {
      const traceBeforeDelivery = JSON.stringify(result.traceEvents);
      const linesBeforeDelivery = JSON.stringify(result.lines);
      delayedQuery.release();
      await vi.runAllTimersAsync();
      result.delayedQuery = { traceBeforeDelivery, linesBeforeDelivery };
    }
    return result;
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor);
    for (const timer of timers) clearTimeout(timer);
    vi.clearAllTimers();
    vi.useRealTimers();
    log.mockRestore();
    exit.mockRestore();
    signal.mockRestore();
    vi.unstubAllEnvs();
    vi.doUnmock('node:module');
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs');
    vi.resetModules();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
}
