import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const dialogLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('./desktop-logger.ts', () => ({ getLogger: () => dialogLog }));

import {
  promptForExistingFolder,
  promptForExistingMarkdownFile,
  resolvePickedPathForIndex,
} from './dialog-helpers.ts';

const ORIGINAL_SMOKE = process.env.OK_DESKTOP_E2E_SMOKE;
const ORIGINAL_PICKED = process.env.OK_DESKTOP_TEST_PICKED_PATH;

function pickerReturning(result: { canceled: boolean; filePaths: string[] }) {
  return { showOpenDialog: vi.fn(async () => result), showErrorBox: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

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
    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ['/picked'] }));
    const result = await promptForExistingFolder({ showOpenDialog, showErrorBox: vi.fn() });
    expect(result).toBe('/picked');
    expect(showOpenDialog).toHaveBeenCalledWith({
      properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
    });
  });

  test('a cancel returns null silently', async () => {
    const picker = pickerReturning({ canceled: true, filePaths: [] });
    expect(await promptForExistingFolder(picker)).toBe(null);
    expect(picker.showErrorBox).not.toHaveBeenCalled();
    expect(dialogLog.warn).not.toHaveBeenCalled();
    expect(dialogLog.info).toHaveBeenCalledWith(
      { outcome: 'canceled', target: 'folder' },
      expect.any(String),
    );
  });

  test.each([
    { label: 'no paths', filePaths: [], shape: 'none' },
    { label: 'an empty path', filePaths: [''], shape: 'empty' },
    { label: 'a relative path', filePaths: ['notes'], shape: 'relative' },
  ])('a non-cancel close with $label shows an error and logs it', async ({ filePaths, shape }) => {
    const picker = pickerReturning({ canceled: false, filePaths });
    expect(await promptForExistingFolder(picker)).toBe(null);
    expect(picker.showErrorBox).toHaveBeenCalledTimes(1);
    expect(picker.showErrorBox.mock.calls[0]?.[0]).toContain('open that folder');
    expect(dialogLog.warn).toHaveBeenCalledWith(
      { outcome: 'no-selection', target: 'folder', shape, count: filePaths.length },
      expect.any(String),
    );
  });

  test('a picker that throws is logged and rethrown', async () => {
    const failure = new Error('portal unavailable');
    const picker = {
      showOpenDialog: vi.fn(async () => {
        throw failure;
      }),
      showErrorBox: vi.fn(),
    };
    await expect(promptForExistingFolder(picker)).rejects.toBe(failure);
    expect(dialogLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed' }),
      expect.any(String),
    );
  });

  test('test seam returns env path when both gates set, never calls OS picker', async () => {
    process.env.OK_DESKTOP_E2E_SMOKE = '1';
    process.env.OK_DESKTOP_TEST_PICKED_PATH = '/tmp/seam';
    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ['/never/used'] }));
    expect(await promptForExistingFolder({ showOpenDialog, showErrorBox: vi.fn() })).toBe(
      '/tmp/seam',
    );
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  test('test seam ignored when OK_DESKTOP_E2E_SMOKE missing — production safety', async () => {
    process.env.OK_DESKTOP_TEST_PICKED_PATH = '/tmp/should-not-fire';
    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ['/real/pick'] }));
    expect(await promptForExistingFolder({ showOpenDialog, showErrorBox: vi.fn() })).toBe(
      '/real/pick',
    );
    expect(showOpenDialog).toHaveBeenCalled();
  });

  test('test seam ignored when OK_DESKTOP_TEST_PICKED_PATH empty', async () => {
    process.env.OK_DESKTOP_E2E_SMOKE = '1';
    process.env.OK_DESKTOP_TEST_PICKED_PATH = '';
    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ['/real/pick'] }));
    expect(await promptForExistingFolder({ showOpenDialog, showErrorBox: vi.fn() })).toBe(
      '/real/pick',
    );
    expect(showOpenDialog).toHaveBeenCalled();
  });

  test('defaultPath threads through to showOpenDialog', async () => {
    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ['/picked'] }));
    await promptForExistingFolder(
      { showOpenDialog, showErrorBox: vi.fn() },
      { defaultPath: '/project/root' },
    );
    expect(showOpenDialog).toHaveBeenCalledWith({
      properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
      defaultPath: '/project/root',
    });
  });

  test('omits defaultPath when not provided', async () => {
    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ['/picked'] }));
    await promptForExistingFolder({ showOpenDialog, showErrorBox: vi.fn() });
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

describe('promptForExistingMarkdownFile', () => {
  beforeEach(() => {
    delete process.env.OK_DESKTOP_E2E_SMOKE;
    delete process.env.OK_DESKTOP_TEST_PICKED_PATH;
  });

  test('OS picker uses openFile + a md/mdx filter', async () => {
    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ['/notes/x.md'] }));
    const result = await promptForExistingMarkdownFile({ showOpenDialog, showErrorBox: vi.fn() });
    expect(result).toBe('/notes/x.md');
    expect(showOpenDialog).toHaveBeenCalledWith({
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'mdx'] }],
    });
  });

  test('a cancel returns null silently', async () => {
    const picker = pickerReturning({ canceled: true, filePaths: [] });
    expect(await promptForExistingMarkdownFile(picker)).toBe(null);
    expect(picker.showErrorBox).not.toHaveBeenCalled();
    expect(dialogLog.info).toHaveBeenCalledWith(
      { outcome: 'canceled', target: 'file' },
      expect.any(String),
    );
  });

  test.each([
    { label: 'no paths', filePaths: [], shape: 'none' },
    { label: 'an empty path', filePaths: [''], shape: 'empty' },
    { label: 'a relative path', filePaths: ['notes.md'], shape: 'relative' },
  ])('a non-cancel close with $label shows an error', async ({ filePaths, shape }) => {
    const picker = pickerReturning({ canceled: false, filePaths });
    expect(await promptForExistingMarkdownFile(picker)).toBe(null);
    expect(picker.showErrorBox).toHaveBeenCalledTimes(1);
    expect(picker.showErrorBox.mock.calls[0]?.[0]).toContain('open that file');
    expect(dialogLog.warn).toHaveBeenCalledWith(
      { outcome: 'no-selection', target: 'file', shape, count: filePaths.length },
      expect.any(String),
    );
  });

  test('test seam returns env path when both gates set, never calls OS picker', async () => {
    process.env.OK_DESKTOP_E2E_SMOKE = '1';
    process.env.OK_DESKTOP_TEST_PICKED_PATH = '/tmp/seam.md';
    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ['/never/used.md'] }));
    expect(await promptForExistingMarkdownFile({ showOpenDialog, showErrorBox: vi.fn() })).toBe(
      '/tmp/seam.md',
    );
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  test('defaultPath threads through to showOpenDialog', async () => {
    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ['/notes/x.md'] }));
    await promptForExistingMarkdownFile(
      { showOpenDialog, showErrorBox: vi.fn() },
      { defaultPath: '/notes' },
    );
    expect(showOpenDialog).toHaveBeenCalledWith({
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'mdx'] }],
      defaultPath: '/notes',
    });
  });
});
