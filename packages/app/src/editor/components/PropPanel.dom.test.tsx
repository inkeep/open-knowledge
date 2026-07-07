/**
 * DOM tests for `PropPanel`'s keyboard contract — Enter on a single-line
 * string input dismisses the popover via the owner-supplied `onDismiss`.
 *
 * Pins the rename gesture: a user opens a Tab's
 * properties popover, types a new label, presses Enter, and expects the
 * popover to acknowledge "I'm done" by closing. PropPanel auto-saves on
 * every keystroke (the `onChange` path), so Enter is a pure
 * acknowledgment — but without this wiring it was a silent no-op.
 *
 * Bun's `renderToString` path (used in `PropPanel.test.tsx`) emits static
 * markup with no functional event handlers, so the keydown-→-onDismiss
 * wiring requires a real DOM. Hence `.dom.test.tsx`.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { ALLOWED_IMAGE_MIME_TYPES, type PropDef } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { JsxComponentDescriptor } from '../registry/types.ts';

// Radix Popover focus-trap reaches for these jsdom-missing pieces (the
// SrcAutocomplete branch in PropPanel mounts a Popover when accept-bearing
// string props get the asset suggestion dropdown).
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

// Stub PageListContext so PropPanel's SrcAutocomplete branch renders
// without firing the real `/api/pages` fetch on mount. Mirrors the same
// shape SrcAutocomplete.dom.test.tsx uses.
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
    // The Tab descriptor's `label` is exactly this shape: required
    // string, no `accept` allowlist → renders as the plain `<Input>`
    // branch. Pressing Enter inside it should hand control back to the
    // owner so the popover closes.
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
    // PropPanel ships from multiple surfaces (editor + standalone
    // preview cards). Standalone preview doesn't own a popover, so it
    // omits `onDismiss`. The handler must guard the optional callback.
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
    // Both render-blocks for `<PropControl>` (common tier above the
    // Advanced collapsible + the map inside `<CollapsibleContent>`) must
    // forward `onDismiss`. Missing the advanced-tier forwarding silently
    // breaks Enter for every string prop marked `advanced: true` (e.g.
    // `<Tab id>`). Mirror the common-tier guard above so regressions
    // can't slip back in.
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
    // Force the Advanced collapsible open so its children mount into the
    // DOM and the advanced `<Input>` becomes addressable.
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
    // Tab, Escape, ArrowDown, character keys, etc. should not reach
    // onDismiss. Otherwise typing a label would close the popover after
    // one keystroke.
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
    // Pins Enter parity on the cssLength variant — same single-line
    // contract as the plain Input branch. Without this, Embed sizing
    // props are an exception to the form-submit contract the rest of
    // PropPanel honors.
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
    // Pins Enter parity on the number variant — same single-line
    // contract. Without this, a user typing an Image width/height
    // pixel value would press Enter and have nothing happen.
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
    // PropPanel forwards `onDismiss` to `SrcAutocomplete` via the
    // `onSubmit` prop. Both pieces have their own unit-level tests, but
    // the WIRING between them is the line that connects PropPanel's
    // dismiss contract to media-prop inputs (img.src, video.src,
    // audio.src). If a future iteration drops `onSubmit={onDismiss}`
    // from the call site, the individual unit tests still pass while
    // the contract silently breaks; this test fails loud instead.
    // Empty asset list keeps the suggestion dropdown closed so Enter
    // takes the `onSubmit` branch (highlighted-suggestion-pick wins
    // over dismiss when the popover is open with items).
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
