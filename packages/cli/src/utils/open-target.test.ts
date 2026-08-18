import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { openTarget } from './open-target.ts';

interface SpawnCapture {
  command?: string;
  args?: readonly string[];
  options?: SpawnOptions;
}

function makeSpawn(
  capture: SpawnCapture,
  signal: { type: 'spawn' } | { type: 'error'; error: NodeJS.ErrnoException },
) {
  return ((command: string, args: readonly string[], options: SpawnOptions) => {
    capture.command = command;
    capture.args = args;
    capture.options = options;

    const child = new EventEmitter() as ChildProcess;
    child.unref = vi.fn(() => child);
    queueMicrotask(() =>
      child.emit(signal.type, signal.type === 'error' ? signal.error : undefined),
    );
    return child;
  }) as typeof import('node:child_process').spawn;
}

describe('openTarget', () => {
  test('macOS dispatches through LaunchServices', async () => {
    const capture: SpawnCapture = {};
    const target = 'openknowledge://open?project=%2FUsers%2Fme%2Fnotes&doc=specs%2Flaunch';

    const outcome = await openTarget(target, {
      platform: 'darwin',
      spawn: makeSpawn(capture, { type: 'spawn' }),
    });

    expect(outcome).toEqual({ ok: true });
    expect(capture.command).toBe('/usr/bin/open');
    expect(capture.args).toEqual([target]);
  });

  test('Windows opens the complete URL without cmd.exe parsing ampersands', async () => {
    const capture: SpawnCapture = {};
    const target = 'openknowledge://open?project=C%3A%5CUsers%5Cme%5Cnotes&doc=specs%2Flaunch';

    const outcome = await openTarget(target, {
      platform: 'win32',
      spawn: makeSpawn(capture, { type: 'spawn' }),
    });

    expect(outcome).toEqual({ ok: true });
    expect(capture.command).toBe('rundll32.exe');
    expect(capture.args).toEqual(['url.dll,FileProtocolHandler', target]);
    expect(capture.options?.shell).toBe(false);
  });

  test('Windows preserves browser URL fragments through Explorer', async () => {
    const capture: SpawnCapture = {};
    const target = 'http://localhost:5173/#/specs/launch?mode=source&line=12';

    const outcome = await openTarget(target, {
      platform: 'win32',
      spawn: makeSpawn(capture, { type: 'spawn' }),
    });

    expect(outcome).toEqual({ ok: true });
    expect(capture.command).toBe('explorer.exe');
    expect(capture.args).toEqual([target]);
    expect(capture.options?.shell).toBe(false);
  });

  test('Linux dispatches through xdg-open', async () => {
    const capture: SpawnCapture = {};
    const target = 'https://localhost:5173/#/specs/foo';

    const outcome = await openTarget(target, {
      platform: 'linux',
      spawn: makeSpawn(capture, { type: 'spawn' }),
    });

    expect(outcome).toEqual({ ok: true });
    expect(capture.command).toBe('xdg-open');
    expect(capture.args).toEqual([target]);
  });

  test('launcher spawn failures return a non-success outcome', async () => {
    const error = Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' });

    const outcome = await openTarget('https://localhost:5173', {
      platform: 'linux',
      spawn: makeSpawn({}, { type: 'error', error }),
    });

    expect(outcome).toEqual({ ok: false, reason: 'not-installed' });
  });
});
