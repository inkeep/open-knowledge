import type { Editor } from '@tiptap/core';
import { toast } from 'sonner';
import { afterEach, expect, test, vi } from 'vitest';
import { setEditorSingleFileMode } from '../extensions/editor-mode-context.ts';
import { admitAssetUpload, uploadAndInsert } from './index.ts';

afterEach(() => vi.restoreAllMocks());

test('single-file paste/drop admission refuses before editor mutation or upload', async () => {
  const editor = {} as Editor;
  setEditorSingleFileMode(editor, true);
  const notify = vi.spyOn(toast, 'error').mockImplementation(() => 'notice');
  const fetch = vi.spyOn(globalThis, 'fetch');
  expect(admitAssetUpload(editor)).toBe(false);
  await uploadAndInsert(new File(['image'], 'photo.png'), editor, 0);
  expect(fetch).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledTimes(2);
});

test('project editors retain upload admission after leaving single-file mode', () => {
  const editor = {} as Editor;
  expect(admitAssetUpload(editor)).toBe(true);
  setEditorSingleFileMode(editor, true);
  setEditorSingleFileMode(editor, false);
  expect(admitAssetUpload(editor)).toBe(true);
});
