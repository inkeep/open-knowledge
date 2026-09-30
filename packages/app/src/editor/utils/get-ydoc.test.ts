import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mountAppEditor, mountProjectionEditor } from '../editor-rig.test-helper';
import { installDomGlobals } from '../walk-currency-test-harness';
import { getYDoc } from './get-ydoc';

let restoreDomGlobals: (() => void) | null = null;

beforeAll(() => {
  restoreDomGlobals = installDomGlobals();
});

afterAll(() => {
  restoreDomGlobals?.();
  restoreDomGlobals = null;
});

describe('getYDoc', () => {
  test('returns the document backing an editor bound to the projection', () => {
    const rig = mountProjectionEditor('seed\n', []);
    try {
      expect(getYDoc(rig.editor)).toBe(rig.ydoc);
      expect(getYDoc(rig.editor)?.getText('source').toString()).toBe('seed\n');
    } finally {
      rig.destroy();
    }
  });

  test('resolves through the mounted binding, not an extension that no longer exists', () => {
    const rig = mountProjectionEditor('seed\n', []);
    try {
      const names = rig.editor.extensionManager.extensions.map((e) => e.name);
      expect(names).not.toContain('collaboration');
      expect(names).toContain('okProjectionBinding');
      expect(getYDoc(rig.editor)).toBeDefined();
    } finally {
      rig.destroy();
    }
  });

  test('an editor with no binding has no document, and says so rather than throwing', () => {
    const editor = mountAppEditor();
    try {
      expect(getYDoc(editor)).toBeUndefined();
    } finally {
      editor.destroy();
    }
  });

  test('a destroyed editor has no document', () => {
    const rig = mountProjectionEditor('seed\n', []);
    rig.destroy();
    expect(getYDoc(rig.editor)).toBeUndefined();
  });
});
