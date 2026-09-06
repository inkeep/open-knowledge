import { useLingui as useLinguiRuntime } from '@lingui/react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import * as linguiShim from '../../tests/lingui-macro-shim';

const boardProps: Record<string, unknown>[] = [];

vi.doMock('@excalidraw/excalidraw', () => ({
  CaptureUpdateAction: { NEVER: 'never' },
  Excalidraw: (props: Record<string, unknown>) => {
    boardProps.push(props);
    return <div data-testid="excalidraw-stub" />;
  },
  restoreElements: (elements: unknown) => (elements as unknown[] | undefined) ?? [],
  restoreAppState: () => ({}),
  serializeAsJSON: () => '{}',
  getNonDeletedElements: (elements: unknown) => elements,
}));

vi.doMock('./MermaidDocEditor', () => ({ replaceYText: vi.fn() }));

vi.doMock('@lingui/react/macro', () => ({
  ...linguiShim,
  useLingui: () => ({ ...useLinguiRuntime(), t: linguiShim.t }),
}));

async function renderBoard(locale: string) {
  const { ExcalidrawDocEditor } = await import('./ExcalidrawDocEditor.tsx');
  const { I18nProvider } = await import('@lingui/react');
  const { i18n } = await import('@lingui/core');
  i18n.activate(locale);
  const doc = new Y.Doc();
  render(
    <I18nProvider i18n={i18n}>
      <ExcalidrawDocEditor provider={{ document: doc } as never} />
    </I18nProvider>,
  );
  return i18n;
}

function latestLangCode() {
  return boardProps.at(-1)?.langCode;
}

describe('the Excalidraw board editor', () => {
  beforeEach(() => {
    boardProps.length = 0;
  });

  afterEach(cleanup);

  test('hands the board the language the reader is already using', async () => {
    await renderBoard('zh-Hans');

    expect(latestLangCode()).toBe('zh-CN');
  });

  test('hands the board English when the reader has no board translation', async () => {
    await renderBoard('ur');

    expect(latestLangCode()).toBe('en');
  });

  test('follows a language switch made while the board is already open', async () => {
    const i18n = await renderBoard('en');
    expect(latestLangCode()).toBe('en');

    act(() => {
      i18n.activate('zh-Hans');
    });

    expect(latestLangCode()).toBe('zh-CN');
  });
});
