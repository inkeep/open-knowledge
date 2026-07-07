/**
 * Folder-picker helper tests — covers the OS dialog wiring AND the E2E test
 * seam (`OK_DESKTOP_TEST_PICKED_PATH`). The seam is double-gated by
 * `OK_DESKTOP_E2E_SMOKE=1` so a stray env var on a developer's shell can't
 * bypass the real picker.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { promptForExistingFolder, resolvePickedPathForIndex } from './dialog-helpers.ts';

const ORIGINAL_SMOKE = process.env.OK_DESKTOP_E2E_SMOKE;
const ORIGINAL_PICKED = process.env.OK_DESKTOP_TEST_PICKED_PATH;

afterEach(() => {
  if (ORIGINAL_SMOKE === undefined) delete process.env.OK_DESKTOP_E2E_SMOKE;
  else process.env.OK_DESKTOP_E2E_SMOKE = ORIGINAL_SMOKE;
  if (ORIGINAL_PICKED === undefined) delete process.env.OK_DESKTOP_TEST_PICKED_PATH;
  else process.env.OK_DESKTOP_TEST_PICKED_PATH = ORIGINAL_PICKED;
});

describe('promptForExistingFolder', () => {
  beforeEach(() => {
    delete process.env.OK_DESKTOP_E2E_SMOKE;
    delete process.env.OK_DESKTOP_TEST_PICKED_PATH;
  });

  test('OS picker uses openDirectory + createDirectory + showHiddenFiles (macOS: New Folder button + dot-dirs visible for `.claude/worktrees`)', async () => {
    const showOpenDialog = mock(async () => ({ canceled: false, filePaths: ['/picked'] }));
    const result = await promptForExistingFolder({ showOpenDialog });
    expect(result).toBe('/picked');
    expect(showOpenDialog).toHaveBeenCalledWith({
      properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
    });
  });

  test('OS picker returns null on cancel', async () => {
    const showOpenDialog = mock(async () => ({ canceled: true, filePaths: [] }));
    expect(await promptForExistingFolder({ showOpenDialog })).toBe(null);
  });

  test('OS picker returns null on empty filePaths', async () => {
    const showOpenDialog = mock(async () => ({ canceled: false, filePaths: [] }));
    expect(await promptForExistingFolder({ showOpenDialog })).toBe(null);
  });

  test('test seam returns env path when both gates set, never calls OS picker', async () => {
    process.env.OK_DESKTOP_E2E_SMOKE = '1';
    process.env.OK_DESKTOP_TEST_PICKED_PATH = '/tmp/seam';
    const showOpenDialog = mock(async () => ({ canceled: false, filePaths: ['/never/used'] }));
    expect(await promptForExistingFolder({ showOpenDialog })).toBe('/tmp/seam');
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  test('test seam ignored when OK_DESKTOP_E2E_SMOKE missing — production safety', async () => {
    process.env.OK_DESKTOP_TEST_PICKED_PATH = '/tmp/should-not-fire';
    const showOpenDialog = mock(async () => ({ canceled: false, filePaths: ['/real/pick'] }));
    expect(await promptForExistingFolder({ showOpenDialog })).toBe('/real/pick');
    expect(showOpenDialog).toHaveBeenCalled();
  });

  test('test seam ignored when OK_DESKTOP_TEST_PICKED_PATH empty', async () => {
    process.env.OK_DESKTOP_E2E_SMOKE = '1';
    process.env.OK_DESKTOP_TEST_PICKED_PATH = '';
    const showOpenDialog = mock(async () => ({ canceled: false, filePaths: ['/real/pick'] }));
    expect(await promptForExistingFolder({ showOpenDialog })).toBe('/real/pick');
    expect(showOpenDialog).toHaveBeenCalled();
  });

  test('defaultPath threads through to showOpenDialog', async () => {
    const showOpenDialog = mock(async () => ({ canceled: false, filePaths: ['/picked'] }));
    await promptForExistingFolder({ showOpenDialog }, { defaultPath: '/project/root' });
    expect(showOpenDialog).toHaveBeenCalledWith({
      properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
      defaultPath: '/project/root',
    });
  });

  test('omits defaultPath when not provided', async () => {
    const showOpenDialog = mock(async () => ({ canceled: false, filePaths: ['/picked'] }));
    await promptForExistingFolder({ showOpenDialog });
    expect(showOpenDialog).toHaveBeenCalledWith({
      properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
    });
  });
});

describe('resolvePickedPathForIndex', () => {
  test('single path (no delimiter) is returned for every index', () => {
    expect(resolvePickedPathForIndex('/only/target', 0)).toBe('/only/target');
    expect(resolvePickedPathForIndex('/only/target', 1)).toBe('/only/target');
    expect(resolvePickedPathForIndex('/only/target', 99)).toBe('/only/target');
  });

  test('sequence: index N yields entry N', () => {
    const spec = '/a\x1f/b\x1f/c';
    expect(resolvePickedPathForIndex(spec, 0)).toBe('/a');
    expect(resolvePickedPathForIndex(spec, 1)).toBe('/b');
    expect(resolvePickedPathForIndex(spec, 2)).toBe('/c');
  });

  test('exhausted sequence: last entry sticks (no real-picker fallthrough)', () => {
    const spec = '/a\x1f/b';
    expect(resolvePickedPathForIndex(spec, 2)).toBe('/b');
    expect(resolvePickedPathForIndex(spec, 99)).toBe('/b');
  });

  test('empty segments are dropped (interior, leading, trailing)', () => {
    expect(resolvePickedPathForIndex('/a\x1f\x1f/b', 0)).toBe('/a');
    expect(resolvePickedPathForIndex('/a\x1f\x1f/b', 1)).toBe('/b');
    expect(resolvePickedPathForIndex('\x1f/a\x1f/b\x1f', 0)).toBe('/a');
    expect(resolvePickedPathForIndex('\x1f/a\x1f/b\x1f', 1)).toBe('/b');
  });

  test('spec yielding no usable entries returns null at any index', () => {
    expect(resolvePickedPathForIndex('', 0)).toBeNull();
    expect(resolvePickedPathForIndex('\x1f', 0)).toBeNull();
    expect(resolvePickedPathForIndex('\x1f\x1f', 5)).toBeNull();
  });

  test('a space-only segment is a valid path and is preserved (length filter, not trim)', () => {
    expect(resolvePickedPathForIndex(' \x1f/real', 0)).toBe(' ');
    expect(resolvePickedPathForIndex(' \x1f/real', 1)).toBe('/real');
  });
});
