/**
 * Integration: walker invocation handle from `createClipboardHtmlSerializer`.
 *
 * The walker's actual DOM behavior (real `view.nodeDOM`, real CSS resolution,
 * real cloneNode + getComputedStyle) needs Playwright. bun-test does
 * not ship `document` / `DOMParser` / `getComputedStyle`, so the markdown
 * fall-through path can't run here either.
 *
 * What we verify:
 *   - The factory returns a `{ serializer, setView }` handle (wiring
 *     contract — TiptapEditor `onCreate` calls `setView(editor.view)` so the
 *     walker can read live DOM after PM mounts).
 *   - The serializer satisfies PM's `clipboardSerializer?: DOMSerializer`
 *     interface (has `serializeFragment`).
 */

import { describe, expect, mock, test } from 'bun:test';
import { createClipboardHtmlSerializer } from '../../src/editor/clipboard/serialize.ts';

function fakeMdManager() {
  return {
    serialize: mock(() => '# heading\n'),
    parse: mock(() => ({ type: 'doc', content: [] })),
  };
}

describe('createClipboardHtmlSerializer — handle shape (US-007)', () => {
  test('returns a handle with `serializer` and `setView`', () => {
    // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
    const handle = createClipboardHtmlSerializer({ mdManager: fakeMdManager() as any });
    expect(handle.serializer).toBeDefined();
    expect(typeof handle.setView).toBe('function');
    // PM's clipboardSerializer contract: serializeFragment is the only method
    // PM actually invokes.
    expect(typeof handle.serializer.serializeFragment).toBe('function');
  });

  test('setView accepts an EditorView and is idempotent', () => {
    // biome-ignore lint/suspicious/noExplicitAny: narrow fake md manager
    const handle = createClipboardHtmlSerializer({ mdManager: fakeMdManager() as any });
    // biome-ignore lint/suspicious/noExplicitAny: only the type identity matters
    const fakeView = { state: { selection: { from: 0, to: 0 } } } as any;
    expect(() => handle.setView(fakeView)).not.toThrow();
    expect(() => handle.setView(fakeView)).not.toThrow();
  });
});
