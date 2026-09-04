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
    expect(props.handleDrop).toBe(fakeClipboard.drop);
  });

  test('wires copy/cut ONLY to the comment-carriage intercept; dragstart stays PM-native', () => {
    const props = buildWysiwygEditorProps();
    const handleDOMEvents = props.handleDOMEvents ?? {};

    expect(typeof handleDOMEvents.copy).toBe('function');
    expect(typeof handleDOMEvents.cut).toBe('function');
    expect(handleDOMEvents).not.toHaveProperty('dragstart');
    expect(handleDOMEvents).not.toHaveProperty('paste');
  });
});
