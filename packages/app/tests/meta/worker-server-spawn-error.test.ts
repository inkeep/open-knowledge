import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FAILED_SPAWN_COMMANDS,
  type FailedSpawnMode,
  observeWorkerSpawnError,
} from '../foundation/worker-lifetime/observe-worker-spawn-error.test-helper.ts';

async function nativeFailure(mode: FailedSpawnMode) {
  const result = await observeWorkerSpawnError(mode, 'native');
  const { error, afterError, exits, close } = result.observation.contract;
  expect(error).toEqual({
    name: 'Error',
    message: 'spawn pnpm ENOENT',
    errno: expect.any(Number),
    code: 'ENOENT',
    syscall: 'spawn pnpm',
    path: 'pnpm',
    spawnargs: [...FAILED_SPAWN_COMMANDS[mode]],
  });
  expect(error.errno).toBeLessThan(0);
  expect(afterError).toEqual({ exitCode: error.errno, signalCode: null });
  expect(exits).toEqual([]);
  expect(close).toEqual({ code: error.errno, signal: null });
  expect(result.cleanup.before.some((row) => row.birth.found)).toBe(true);
  expect(result.cleanup.liveSurvivors).toEqual([]);
  expect(result.cleanup.workDirAbsent).toBe(true);
  expect(Object.values(result.observation.resources).every((path) => !existsSync(path))).toBe(true);
  return result.observation.contract;
}

describe('worker server failed native spawn', () => {
  for (const mode of ['dev-server', 'prebuilt'] as const) {
    it(`${mode}: the exported caller preserves native error fields, failure status and terminal events`, async () => {
      const expected = await nativeFailure(mode);
      const actual = await observeWorkerSpawnError(mode, 'exported');
      expect(actual.observation.contract.error.code).toBe('ENOENT');
      expect(actual.cleanup.before.some((row) => row.birth.found)).toBe(true);
      expect(actual.cleanup.liveSurvivors).toEqual([]);
      expect(actual.cleanup.workDirAbsent).toBe(true);
      expect(Object.values(actual.observation.resources).every((path) => !existsSync(path))).toBe(
        true,
      );
      expect(actual.observation.contract).toEqual(expected);
    }, 50_000);

    it(`${mode}: the native reference reports a failed spawn without an exit event`, async () => {
      await nativeFailure(mode);
    }, 50_000);
  }
});
