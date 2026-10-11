import type { Extensions } from '@tiptap/core';
import { sharedExtensions } from '@/editor/extensions/shared';
import { DiffJsxComponent } from './diff-jsx-block';

const DROP_NAMES = new Set([
  'slashCommand',
  'blockDragHandle',
  'blockMover',
  'tableInsertControls',
  'trailingAffordance',
  'fileHandler',
  'gfmAutolink',
  'inlineLinkInputRule',
  'keyboardNav',
  'tiptapFindReplace',
  'selectionState',
  'sourceDirtyObserver',
  'tabFocusTrap',
]);

export const diffExtensions: Extensions = sharedExtensions
  .filter((ext) => !DROP_NAMES.has(ext.name))
  .map((ext) => (ext.name === 'jsxComponent' ? DiffJsxComponent : ext));
