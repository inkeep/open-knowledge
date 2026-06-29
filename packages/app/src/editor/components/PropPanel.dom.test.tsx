import { afterEach, describe, expect, mock, test } from 'bun:test';
import { ALLOWED_IMAGE_MIME_TYPES, type PropDef } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { JsxComponentDescriptor } from '../registry/types.ts';

type GlobalShims = typeof globalThis & {
  ResizeObserver?: unknown;
};
const g = globalThis as GlobalShims;
if (g.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  g.ResizeObserver = NoopResizeObserver;
}
const ElementProto = Element.prototype as Element & {
  hasPointerCapture?: () => boolean;
  releasePointerCapture?: () => void;
  scrollIntoView?: () => void;
};
ElementProto.hasPointerCapture ??= () => false;
ElementProto.releasePointerCapture ??= () => {};
ElementProto.scrollIntoView ??= () => {};

const stubAssetPaths = new Set<string>();
const stubPageListValue = {
  pages: new Set<string>(),
  pagesBySlug: new Map<string, string>(),
  pagesByBasename: new Map<string, string>(),
  pageTitles: new Map<string, string>(),
  pageMeta: new Map<string, unknown>(),
  folderPaths: new Set<string>(),
  assetPaths: stubAssetPaths,
  loading: false,
  error: null,
  refetch: () => {},
  addPage: () => {},
};
mock.module('@/components/PageListContext', () => ({
  usePageList: () => stubPageListValue,
  useOptionalPageList: () => stubPageListValue,
}));

const { PropPanel } = await import('./PropPanel');

afterEach(() => {
  cleanup();
});

function NoopComponent() {
  return null;
}

function makeDescriptor(props: PropDef[]): JsxComponentDescriptor {
  return {
    name: 'TestDescriptor',
    surface: 'canonical',
    displayName: 'TestDescriptor',
    hasChildren: false,
    props,
    serialize: () => ({ type: 'paragraph', children: [] }),
    Component: NoopComponent,
    reactNodePropNames: new Set(),
  };
}

describe('PropPanel — Enter on a single-line string input dismisses', () => {
  test('Enter on a plain string Input (no autocomplete) calls onDismiss', () => {
    const onDismiss = mock(() => {});
    const d = makeDescriptor([
      { name: 'label', type: 'string', required: true, autoFocus: true, defaultValue: 'Tab' },
    ]);
    const { container } = render(
      <PropPanel
        descriptor={d}
        values={{ label: 'Tab 1' }}
        onChange={() => {}}
        onDismiss={onDismiss}
      />,
    );
    const input = container.querySelector('input#prop-label') as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('Enter on a string Input WITHOUT an onDismiss is harmless (no throw, no-op)', () => {
    const d = makeDescriptor([
      { name: 'label', type: 'string', required: true, autoFocus: true, defaultValue: 'Tab' },
    ]);
    const { container } = render(
      <PropPanel descriptor={d} values={{ label: 'Tab 1' }} onChange={() => {}} />,
    );
    const input = container.querySelector('input#prop-label') as HTMLInputElement;
    expect(() => fireEvent.keyDown(input, { key: 'Enter' })).not.toThrow();
  });

  test('Enter on an advanced-tier string Input also calls onDismiss (parity with common tier)', () => {
    const onDismiss = mock(() => {});
    const d = makeDescriptor([
      { name: 'label', type: 'string', required: true, defaultValue: 'Tab' },
      { name: 'id', type: 'string', required: false, advanced: true },
    ]);
    const { container } = render(
      <PropPanel
        descriptor={d}
        values={{ label: 'Tab 1', id: 'tab-1' }}
        onChange={() => {}}
        onDismiss={onDismiss}
      />,
    );
    const advancedTrigger = container.querySelector(
      '[data-prop-panel-advanced-trigger]',
    ) as HTMLButtonElement;
    fireEvent.click(advancedTrigger);
    const advancedInput = container.querySelector('input#prop-id') as HTMLInputElement;
    expect(advancedInput).not.toBeNull();
    fireEvent.keyDown(advancedInput, { key: 'Enter' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('Non-Enter keys do NOT dismiss (only Enter triggers the close gesture)', () => {
    const onDismiss = mock(() => {});
    const d = makeDescriptor([
      { name: 'label', type: 'string', required: true, autoFocus: true, defaultValue: 'Tab' },
    ]);
    const { container } = render(
      <PropPanel
        descriptor={d}
        values={{ label: 'Tab 1' }}
        onChange={() => {}}
        onDismiss={onDismiss}
      />,
    );
    const input = container.querySelector('input#prop-label') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'a' });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.keyDown(input, { key: 'Tab' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test('Enter on a cssLengthInput string dismisses (Embed.width / Embed.height)', () => {
    const onDismiss = mock(() => {});
    const d = makeDescriptor([
      { name: 'width', type: 'string', required: false, cssLengthInput: true },
    ]);
    const { container } = render(
      <PropPanel descriptor={d} values={{}} onChange={() => {}} onDismiss={onDismiss} />,
    );
    const input = container.querySelector('[data-prop-css-length-input]') as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('Enter on a number Input dismisses', () => {
    const onDismiss = mock(() => {});
    const d = makeDescriptor([{ name: 'width', type: 'number', required: false }]);
    const { container } = render(
      <PropPanel descriptor={d} values={{}} onChange={() => {}} onDismiss={onDismiss} />,
    );
    const input = container.querySelector('input#prop-width') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.type).toBe('number');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('Enter on the accept-bearing SrcAutocomplete branch dismisses (PropPanel-level wiring)', () => {
    stubAssetPaths.clear();
    const onDismiss = mock(() => {});
    const d = makeDescriptor([
      {
        name: 'src',
        type: 'string',
        required: true,
        autoFocus: true,
        defaultValue: '',
        accept: ALLOWED_IMAGE_MIME_TYPES,
      },
    ]);
    const { container } = render(
      <PropPanel descriptor={d} values={{}} onChange={() => {}} onDismiss={onDismiss} />,
    );
    const input = container.querySelector('input#prop-src') as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
