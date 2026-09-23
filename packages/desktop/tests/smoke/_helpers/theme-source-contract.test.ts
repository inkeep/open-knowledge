import { Console } from 'node:console';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../src/main/desktop-logger.ts', () => ({
  getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { applyThemeSource, emitThemeSourceRecord } from '../../../src/main/theme-handler.ts';
import type { OkThemeSource } from '../../../src/shared/bridge-contract.ts';
import { observeThemeSourcePushes } from './theme-source-pushes.ts';

let restoreConsoleWarn = () => {};

afterEach(() => {
  restoreConsoleWarn();
  restoreConsoleWarn = () => {};
});

function wiredMainProcess(initialThemeSource: OkThemeSource = 'system') {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const mainProcessConsole = new Console({ stdout, stderr });
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    mainProcessConsole.warn(...args);
  });
  restoreConsoleWarn = () => {
    spy.mockRestore();
  };
  let themeSource = initialThemeSource;
  return {
    app: { process: () => ({ stdout, stderr }) },
    deps: {
      getThemeSource: () => themeSource,
      setThemeSource: (source: OkThemeSource) => {
        themeSource = source;
      },
      emit: emitThemeSourceRecord,
    },
  };
}

describe('theme source push producer/observer contract', () => {
  test('the observer recovers the window id the producer was handed', () => {
    const { app, deps } = wiredMainProcess();
    const pushedBy = observeThemeSourcePushes(app);

    applyThemeSource(deps, 'dark', 11);

    expect([...pushedBy]).toEqual([11]);
  });

  test('the observer separates two windows pushing the same source', () => {
    const { app, deps } = wiredMainProcess();
    const pushedBy = observeThemeSourcePushes(app);

    applyThemeSource(deps, 'light', 11);
    applyThemeSource(deps, 'light', 12);

    expect([...pushedBy]).toEqual([11, 12]);
  });

  test('a push the producer refuses to apply is not observed', () => {
    const { app, deps } = wiredMainProcess();
    const pushedBy = observeThemeSourcePushes(app);

    applyThemeSource(deps, 'dark', 11);
    applyThemeSource(deps, 'rainbow' as unknown as OkThemeSource, 12);

    expect([...pushedBy]).toEqual([11]);
  });

  test('a sender with no window is not observed as a window push', () => {
    const { app, deps } = wiredMainProcess();
    const pushedBy = observeThemeSourcePushes(app);

    applyThemeSource(deps, 'dark', 11);
    applyThemeSource(deps, 'light', null);

    expect([...pushedBy]).toEqual([11]);
  });
});
