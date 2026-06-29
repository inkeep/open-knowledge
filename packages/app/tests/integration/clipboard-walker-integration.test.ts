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
