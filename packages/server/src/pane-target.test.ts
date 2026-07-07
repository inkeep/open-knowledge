import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  armPaneTarget,
  clearArmedPaneTarget,
  PANE_TARGET_TTL_MS,
  readArmedPaneTarget,
} from './pane-target';

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-pane-target-'));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('pane-target store', () => {
  test('arm then read within TTL returns the route', () => {
    armPaneTarget(tmpDir, '#/specs/foo/SPEC', 1_000);
    expect(readArmedPaneTarget(tmpDir, 1_000 + 5_000)).toBe('#/specs/foo/SPEC');
  });

  test('an arm older than the TTL is ignored (no stale hijack)', () => {
    armPaneTarget(tmpDir, '#/specs/foo/SPEC', 1_000);
    expect(readArmedPaneTarget(tmpDir, 1_000 + PANE_TARGET_TTL_MS + 1)).toBeNull();
  });

  test('no arm → null', () => {
    expect(readArmedPaneTarget(tmpDir, 1_000)).toBeNull();
  });

  test('last arm wins', () => {
    armPaneTarget(tmpDir, '#/a', 1_000);
    armPaneTarget(tmpDir, '#/b/', 1_100);
    expect(readArmedPaneTarget(tmpDir, 1_200)).toBe('#/b/');
  });

  test('a malformed route (not `#/`) is rejected at the write boundary', () => {
    expect(armPaneTarget(tmpDir, 'https://evil.example', 1_000)).toBe(false);
    expect(readArmedPaneTarget(tmpDir, 1_000)).toBeNull();
    // A valid arm still works afterward (the rejection wrote nothing).
    expect(armPaneTarget(tmpDir, '#/ok', 1_000)).toBe(true);
    expect(readArmedPaneTarget(tmpDir, 1_000)).toBe('#/ok');
  });

  test('clear consumes the armed target (no re-navigate within TTL)', () => {
    armPaneTarget(tmpDir, '#/specs/foo/SPEC', 1_000);
    clearArmedPaneTarget(tmpDir);
    // Within the TTL, but the target is gone — a reload must not re-navigate.
    expect(readArmedPaneTarget(tmpDir, 1_000 + 5_000)).toBeNull();
  });

  test('clear with no arm is a no-op (does not throw)', () => {
    expect(() => clearArmedPaneTarget(tmpDir)).not.toThrow();
  });
});
