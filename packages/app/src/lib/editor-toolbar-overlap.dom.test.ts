import { afterEach, describe, expect, test } from 'vitest';
import { editorToolbarOverlapPx } from './editor-toolbar-overlap';

afterEach(() => {
  Reflect.deleteProperty(window, 'okDesktop');
});

describe('editorToolbarOverlapPx', () => {
  test('reclaims the overlay band only when its controls moved into the note titlebar', () => {
    expect(editorToolbarOverlapPx()).toBe(56);

    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      value: { config: { mode: 'note' } },
    });

    expect(editorToolbarOverlapPx()).toBe(0);
  });
});
