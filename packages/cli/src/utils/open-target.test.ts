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
  test('macOS with a verified bundle path names it directly, not scheme resolution', async () => {
    // Scheme resolution is exactly what a stale Launch Services binding
    // hijacks (a dev-mode instance that never unregistered — see desktop's
    // url-scheme.ts). `-a <path>` sidesteps scheme resolution entirely — see
    // open-target.ts's darwin branch for the in-repo precedent this leans on.
    const capture: SpawnCapture = {};
    const target = 'openknowledge://open?project=%2FUsers%2Fme%2Fnotes&doc=specs%2Flaunch';
    const desktopBundlePath = '/Applications/OpenKnowledge.app';

    const outcome = await openTarget(target, {
      platform: 'darwin',
      desktopBundlePath,
      spawn: makeSpawn(capture, { type: 'spawn' }),
    });

    expect(outcome).toEqual({ ok: true });
    expect(capture.command).toBe('/usr/bin/open');
    expect(capture.args).toEqual(['-a', desktopBundlePath, target]);
  });

  test('macOS falls back to plain scheme resolution when no bundle path is given', async () => {
    // An ungated caller (no confirmed bundle path) degrades to plain scheme
    // resolution rather than a broken dispatch. It never routes through
    // bundle-ID (`-b`) resolution — a different Launch Services index this
    // dispatch has no reason to trust more than scheme resolution — but that
    // is a statement about this dispatch, not about every `-b` caller in the
    // package (desktop-dispatch.ts's bare launch, no target argument, is
    // unaffected either way).
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

  test('macOS dispatches non-openknowledge URLs (browser fallback) through plain LaunchServices even with a bundle path', async () => {
    const capture: SpawnCapture = {};
    const target = 'http://localhost:5173/#/specs/launch';

    const outcome = await openTarget(target, {
      platform: 'darwin',
      desktopBundlePath: '/Applications/OpenKnowledge.app',
      spawn: makeSpawn(capture, { type: 'spawn' }),
    });

    expect(outcome).toEqual({ ok: true });
    expect(capture.command).toBe('/usr/bin/open');
    expect(capture.args).toEqual([target]);
  });

  test('Windows ignores a desktopBundlePath — the option is darwin-only', async () => {
    const capture: SpawnCapture = {};
    const target = 'openknowledge://open?project=C%3A%5CUsers%5Cme%5Cnotes&doc=specs%2Flaunch';

    const outcome = await openTarget(target, {
      platform: 'win32',
      desktopBundlePath: '/Applications/OpenKnowledge.app',
      spawn: makeSpawn(capture, { type: 'spawn' }),
    });

    expect(outcome).toEqual({ ok: true });
    expect(capture.command).toBe('rundll32.exe');
    expect(capture.args).toEqual(['url.dll,FileProtocolHandler', target]);
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

  test('Linux ignores a desktopBundlePath — the option is darwin-only', async () => {
    const capture: SpawnCapture = {};
    const target = 'openknowledge://open?project=%2FUsers%2Fme%2Fnotes&doc=specs%2Flaunch';

    const outcome = await openTarget(target, {
      platform: 'linux',
      desktopBundlePath: '/Applications/OpenKnowledge.app',
      spawn: makeSpawn(capture, { type: 'spawn' }),
    });

    expect(outcome).toEqual({ ok: true });
    expect(capture.command).toBe('xdg-open');
    expect(capture.args).toEqual([target]);
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
