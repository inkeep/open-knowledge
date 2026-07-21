import { describe, expect, test } from 'vitest';
import { buildPatternDConstructorOptions } from '../TiptapEditor';
import { buildSeededPatternDProvider, fakeClipboard } from '../walk-currency-test-harness';

type WysiwygEditorProps = NonNullable<
  ReturnType<typeof buildPatternDConstructorOptions>['editorProps']
> & {
  handleDOMEvents?: Record<string, unknown>;
};

function buildWysiwygEditorProps(): WysiwygEditorProps {
  const { provider, cleanup } = buildSeededPatternDProvider('wysiwyg-stop-rule');
  try {
    return buildPatternDConstructorOptions({
      provider,
      clipboard: fakeClipboard,
      ctorStart: 0,
    }).editorProps as WysiwygEditorProps;
  } finally {
    cleanup();
  }
}

describe('WYSIWYG STOP rule — ProseMirror clipboard hooks', () => {
  test('wires the ProseMirror clipboard serializer hooks', () => {
    const props = buildWysiwygEditorProps();

    expect(typeof props.clipboardTextSerializer).toBe('function');
    expect(props.clipboardSerializer).toBe(fakeClipboard.html.serializer);
  });

  test('wires copy/cut ONLY to the comment-carriage intercept; dragstart stays PM-native', () => {
    // Narrowed STOP rule (precedent #19(b)): PM's clipboard hooks remain the
    // payload producers, and dragstart must stay PM-native so `view.dragging`
    // keeps the internal DnD fast path. The single sanctioned DOM-level
    // exception is the copy/cut comment-carriage intercept (handle-copy.ts):
    // PM's hook API exposes no clipboardData, so the private OK flavor that
    // lets comments travel OK→OK cannot exist via hooks alone. The intercept
    // DELEGATES payload production to view.serializeForClipboard (PM hooks
    // included) and declines every slice without clipboard-omitted content.
    const props = buildWysiwygEditorProps();
    const handleDOMEvents = props.handleDOMEvents ?? {};

    expect(typeof handleDOMEvents.copy).toBe('function');
    expect(typeof handleDOMEvents.cut).toBe('function');
    expect(handleDOMEvents).not.toHaveProperty('dragstart');
    expect(handleDOMEvents).not.toHaveProperty('paste');
  });
});
