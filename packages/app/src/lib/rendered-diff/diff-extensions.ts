import { JsxComponent as CoreJsxComponent } from '@inkeep/open-knowledge-core';
import type { Extensions } from '@tiptap/core';
import { sharedExtensions } from '@/editor/extensions/shared';

const DROP_NAMES = new Set([
  'slashCommand',
  'blockDragHandle',
  'blockMover',
  'tableInsertControls',
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
  .map((ext) => (ext.name === 'jsxComponent' ? CoreJsxComponent : ext));
