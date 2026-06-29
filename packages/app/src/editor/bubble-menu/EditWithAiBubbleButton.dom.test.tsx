import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Schema } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';
import type { ReactNode } from 'react';
import { subscribeToOpenAskAiComposer } from '@/components/ask-ai-composer-events';
import { setEditorDocName } from '../extensions/doc-context.ts';

mock.module('sonner', () => ({ toast: { error: () => {}, success: () => {} } }));

const { EditWithAiBubbleButton } = await import('./EditWithAiBubbleButton');

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
});

function makeEditor(docName: string, text: string): Editor {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text(text)])]);
  const editor = {
    state: {
      schema,
      selection: { content: () => doc.slice(0, doc.content.size) },
    },
  } as unknown as Editor;
  setEditorDocName(editor, docName);
  return editor;
}

function setPlatform(platform: string): void {
  Object.defineProperty(globalThis.navigator, 'platform', {
    value: platform,
    configurable: true,
  });
}

function setUserAgent(userAgent: string): void {
  Object.defineProperty(globalThis.navigator, 'userAgent', {
    value: userAgent,
    configurable: true,
  });
}

const PLAIN_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537.36';
const EMBEDDED_UA = `${PLAIN_UA} Cursor/1.2.3`;

let openRequests = 0;
let unsubscribe: (() => void) | null = null;

function renderButton({
  editor,
  shortcutEnabled = true,
  before,
}: {
  editor: Editor;
  shortcutEnabled?: boolean;
  before?: ReactNode;
}) {
  return render(
    <>
      {before}
      <EditWithAiBubbleButton editor={editor} shortcutEnabled={shortcutEnabled} />
    </>,
  );
}

function dispatchEditWithAiShortcut(target: EventTarget): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'I',
      code: 'KeyI',
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

beforeEach(() => {
  openRequests = 0;
  unsubscribe = subscribeToOpenAskAiComposer(() => {
    openRequests += 1;
  });
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  cleanup();
  setUserAgent(PLAIN_UA);
});

describe('EditWithAiBubbleButton', () => {
  test('renders the Ask AI trigger on a macOS host', () => {
    setPlatform('MacIntel');
    const editor = makeEditor('specs/foo/SPEC', 'A passage.');
    renderButton({ editor });

    const button = screen.getByTestId('edit-with-ai-bubble-button');
    expect(button).toBeTruthy();
    expect(button.textContent).toContain('Ask AI');
  });

  test('does not render anything on a non-macOS host', () => {
    setPlatform('Linux x86_64');
    const editor = makeEditor('specs/foo/SPEC', 'A passage.');
    const { container } = renderButton({ editor });

    expect(screen.queryByTestId('edit-with-ai-bubble-button')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  test('does not render anything when embedded inside an agent host', () => {
    setPlatform('MacIntel');
    setUserAgent(EMBEDDED_UA);
    const editor = makeEditor('specs/foo/SPEC', 'A passage.');
    const { container } = renderButton({ editor });

    expect(screen.queryByTestId('edit-with-ai-bubble-button')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  test('clicking the trigger requests the Ask AI composer open+focus', async () => {
    setPlatform('MacIntel');
    const user = userEvent.setup();
    const editor = makeEditor('specs/foo/SPEC', 'A passage.');
    renderButton({ editor });

    await user.click(screen.getByTestId('edit-with-ai-bubble-button'));

    expect(openRequests).toBe(1);
  });

  test('Cmd+Shift+I requests the Ask AI composer open+focus', async () => {
    setPlatform('MacIntel');
    const editor = makeEditor('specs/foo/SPEC', 'A passage.');
    renderButton({ editor });

    await act(async () => {
      dispatchEditWithAiShortcut(window);
    });

    expect(openRequests).toBe(1);
  });

  test('Cmd+Shift+I does nothing when embedded inside an agent host', async () => {
    setPlatform('MacIntel');
    setUserAgent(EMBEDDED_UA);
    const editor = makeEditor('specs/foo/SPEC', 'A passage.');
    renderButton({ editor });

    await act(async () => {
      dispatchEditWithAiShortcut(window);
    });

    expect(openRequests).toBe(0);
  });

  test('Cmd+Shift+I ignores inactive mounted editors', async () => {
    setPlatform('MacIntel');
    const editor = makeEditor('specs/foo/SPEC', 'A passage.');
    renderButton({ editor, shortcutEnabled: false });

    await act(async () => {
      dispatchEditWithAiShortcut(window);
    });

    expect(openRequests).toBe(0);
  });

  test('Cmd+Shift+I ignores native text inputs', async () => {
    setPlatform('MacIntel');
    const editor = makeEditor('specs/foo/SPEC', 'A passage.');
    renderButton({ editor, before: <input data-testid="native-input" /> });

    await act(async () => {
      dispatchEditWithAiShortcut(screen.getByTestId('native-input'));
    });

    expect(openRequests).toBe(0);
  });
});
