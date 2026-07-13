import { describe, expect, test } from 'bun:test';
import type { Editor } from '@tiptap/core';
import { autonomousFragmentEditAllowed } from './autonomous-fragment-edit.ts';
import { setEditorSourceMode } from './editor-mode-context.ts';

/**
 * The single enforcement boundary the autonomous structural dispatchers route
 * through (JsxComponentView auto-convert + retries, RawMdxFallbackCMView
 * blur-commit). Keyed on the Editor instance via the same WeakMap the
 * source-mode signal uses, so a bare object stands in for an editor.
 */
function fakeEditor(): Editor {
  return {} as Editor;
}

describe('autonomousFragmentEditAllowed', () => {
  test('allows autonomous structural edits in WYSIWYG mode (default)', () => {
    // Default-false source mode = visible WYSIWYG = the authoritative surface.
    expect(autonomousFragmentEditAllowed(fakeEditor())).toBe(true);
  });

  test('blocks autonomous structural edits when the editor is source-mode-hidden', () => {
    const editor = fakeEditor();
    setEditorSourceMode(editor, true);
    expect(autonomousFragmentEditAllowed(editor)).toBe(false);
  });

  test('re-allows when the editor flips back to WYSIWYG', () => {
    const editor = fakeEditor();
    setEditorSourceMode(editor, true);
    expect(autonomousFragmentEditAllowed(editor)).toBe(false);
    setEditorSourceMode(editor, false);
    expect(autonomousFragmentEditAllowed(editor)).toBe(true);
  });

  test('tracks each editor independently (per-instance signal)', () => {
    const hidden = fakeEditor();
    const visible = fakeEditor();
    setEditorSourceMode(hidden, true);
    expect(autonomousFragmentEditAllowed(hidden)).toBe(false);
    expect(autonomousFragmentEditAllowed(visible)).toBe(true);
  });
});
