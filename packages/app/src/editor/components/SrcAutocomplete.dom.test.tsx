/**
 * DOM tests for `SrcAutocomplete` — the PropPanel src-input enhancement
 * that surfaces matching workspace assets as a popover dropdown under
 * the input. These tests lock the behavior contract that two
 * regressions would silently break:
 *
 *   1. Click-to-open + render-on-empty-query — clicking into the input
 *      reveals the asset list immediately, while autofocus alone must
 *      not open the popover.
 *   2. Selection emits the server-absolute path (leading slash) so the
 *      committed prop matches `PropUploadButton`'s URL shape and round-
 *      trips through `validateMediaUrl`. Emitting a bare relative path
 *      would 404 under hash routing for any asset outside content root.
 *
 * Behavior is observed through the DOM (queries on rendered items +
 * input value via `onChange` spy). The asset list is injected by
 * stubbing `usePageList` — this keeps the test free of the `/api/...`
 * fetch the real `PageListProvider` triggers on mount.
 *
 * Radix Popover renders its content via a portal — `screen.*` queries
 * still find it because they query `document.body`. The pointer / focus
 * shims at the top of the file are required for Radix's focus-trap
 * machinery to mount inside jsdom (same gap `ShareBranchSwitchDialog.dom.test.tsx`
 * shims around).
 */

import { ALLOWED_IMAGE_MIME_TYPES } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Radix Popover focus-trap reaches for these jsdom-missing pieces.
type GlobalShims = typeof globalThis & {
  ResizeObserver?: unknown;
  DOMRect?: unknown;
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
// jsdom's Element doesn't implement these — Radix's PopperContent calls
// hasPointerCapture during focus mgmt and silently no-ops a render when
// the lookup throws.
const ElementProto = Element.prototype as Element & {
  hasPointerCapture?: () => boolean;
  releasePointerCapture?: () => void;
  scrollIntoView?: () => void;
};
ElementProto.hasPointerCapture ??= () => false;
ElementProto.releasePointerCapture ??= () => {};
ElementProto.scrollIntoView ??= () => {};

// Stub the PageListContext hooks so the component renders without
// spinning up the real PageListProvider (which would hit `/api/pages`
// + `/api/documents` on mount). The SUT now uses `useOptionalPageList`
// (gracefully falls back to no suggestions); the stub still hands back
// a populated context so the suggestion tests have data to assert on.
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
vi.doMock('@/components/PageListContext', () => ({
  usePageList: () => stubPageListValue,
  useOptionalPageList: () => stubPageListValue,
}));

// Importing the SUT after the mock so the module resolves to the stub.
const { SrcAutocomplete } = await import('./SrcAutocomplete');

beforeEach(() => {
  // Reset between tests — the Set is shared across mocks (closure-captured
  // above), so clearing it is enough to scope per test.
  stubAssetPaths.clear();
});

afterEach(() => {
  cleanup();
});

function getOptions(): HTMLButtonElement[] {
  return screen.queryAllByTestId('src-autocomplete-option') as HTMLButtonElement[];
}

describe('SrcAutocomplete — open behavior', () => {
  test('autofocus keeps the popover closed; clicking opens up to 8 source-order items', () => {
    // 10 assets — verify cap at 8.
    for (let i = 0; i < 10; i++) stubAssetPaths.add(`assets/photo-${i}.png`);

    render(
      <SrcAutocomplete
        id="prop-src"
        value=""
        onChange={() => {}}
        accept={ALLOWED_IMAGE_MIME_TYPES}
        autoFocus
      />,
    );

    const input = document.getElementById('prop-src') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(getOptions()).toHaveLength(0);

    fireEvent.click(input);

    const options = getOptions();
    expect(options).toHaveLength(8);
    // Source-order: assets added in order; first 8 visible.
    expect(options[0]?.textContent).toContain('photo-0.png');
    expect(options[7]?.textContent).toContain('photo-7.png');
  });

  test('click with zero matching assets → popover stays closed (no chrome flash)', () => {
    // No image assets in stub — accept is image-only.
    stubAssetPaths.add('docs/handbook.pdf');

    render(
      <SrcAutocomplete
        id="prop-src"
        value=""
        onChange={() => {}}
        accept={ALLOWED_IMAGE_MIME_TYPES}
      />,
    );

    const input = document.getElementById('prop-src') as HTMLInputElement;
    fireEvent.click(input);

    expect(getOptions()).toHaveLength(0);
  });

  test('descriptor accept filters assets before display (image accept → no mp4 in list)', () => {
    stubAssetPaths.add('assets/photo.png');
    stubAssetPaths.add('assets/clip.mp4');

    render(
      <SrcAutocomplete
        id="prop-src"
        value=""
        onChange={() => {}}
        accept={ALLOWED_IMAGE_MIME_TYPES}
      />,
    );

    const input = document.getElementById('prop-src') as HTMLInputElement;
    fireEvent.click(input);

    const labels = getOptions().map((b) => b.textContent ?? '');
    expect(labels.some((t) => t.includes('photo.png'))).toBe(true);
    expect(labels.some((t) => t.includes('clip.mp4'))).toBe(false);
  });
});

describe('SrcAutocomplete — selection contract', () => {
  test('clicking a suggestion emits onChange with leading-slash server-absolute path', () => {
    stubAssetPaths.add('assets/photo.png');
    const onChange = vi.fn((_v: string) => {});

    render(
      <SrcAutocomplete
        id="prop-src"
        value=""
        onChange={onChange}
        accept={ALLOWED_IMAGE_MIME_TYPES}
      />,
    );

    const input = document.getElementById('prop-src') as HTMLInputElement;
    fireEvent.click(input);

    const option = getOptions()[0];
    if (!option) throw new Error('expected an option to render');
    // mousedown handler (not click) — keeps focus on input.
    fireEvent.mouseDown(option);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('/assets/photo.png');
  });

  test('typing then Enter on the highlighted item emits onChange with the path', () => {
    stubAssetPaths.add('assets/photo.png');
    stubAssetPaths.add('assets/banner.png');
    const onChange = vi.fn((_v: string) => {});

    render(
      <SrcAutocomplete
        id="prop-src"
        value=""
        onChange={onChange}
        accept={ALLOWED_IMAGE_MIME_TYPES}
      />,
    );

    const input = document.getElementById('prop-src') as HTMLInputElement;
    fireEvent.focus(input);
    // ArrowDown to move to second item, then Enter.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledTimes(1);
    // ArrowDown opens the source-order list and moves highlight 0 → 1;
    // Enter selects index 1 which is banner.png.
    expect(onChange).toHaveBeenCalledWith('/assets/banner.png');
  });
});

describe('SrcAutocomplete — keyboard handling', () => {
  test('Escape closes the popover (subsequent click reopens it)', () => {
    stubAssetPaths.add('assets/photo.png');

    render(
      <SrcAutocomplete
        id="prop-src"
        value=""
        onChange={() => {}}
        accept={ALLOWED_IMAGE_MIME_TYPES}
      />,
    );

    const input = document.getElementById('prop-src') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.click(input);
    expect(getOptions().length).toBe(1);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(getOptions().length).toBe(0);

    fireEvent.click(input);
    expect(getOptions().length).toBe(1);
  });

  test('Enter with no matching suggestions does NOT call onChange (no phantom selection)', () => {
    // No assets — popover stays closed; Enter must not invoke selectSuggestion.
    const onChange = vi.fn((_v: string) => {});

    render(
      <SrcAutocomplete
        id="prop-src"
        value=""
        onChange={onChange}
        accept={ALLOWED_IMAGE_MIME_TYPES}
      />,
    );

    const input = document.getElementById('prop-src') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  test('Enter with no highlighted suggestion calls onSubmit (Tab rename Enter-commits-and-closes)', () => {
    // PropPanel passes its `onDismiss` here so Enter is the form-submit
    // signal when there's no autocomplete pick to confirm. Without this
    // wiring, Enter is a silent no-op for any user who typed a fresh
    // value and pressed Enter expecting "I'm done" acknowledgment —
    // the rename gesture.
    const onSubmit = vi.fn(() => {});
    render(
      <SrcAutocomplete
        id="prop-src"
        value=""
        onChange={() => {}}
        onSubmit={onSubmit}
        accept={ALLOWED_IMAGE_MIME_TYPES}
      />,
    );
    const input = document.getElementById('prop-src') as HTMLInputElement;
    fireEvent.click(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('Enter with a highlighted suggestion picks the suggestion, NOT onSubmit', () => {
    // Suggestion-pick branch must still take priority — the user is
    // confirming the autocomplete pill they highlighted, not asking
    // the popover to close.
    stubAssetPaths.add('assets/photo.png');
    const onChange = vi.fn((_v: string) => {});
    const onSubmit = vi.fn(() => {});
    render(
      <SrcAutocomplete
        id="prop-src"
        value=""
        onChange={onChange}
        onSubmit={onSubmit}
        accept={ALLOWED_IMAGE_MIME_TYPES}
      />,
    );
    const input = document.getElementById('prop-src') as HTMLInputElement;
    fireEvent.click(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('/assets/photo.png');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('SrcAutocomplete — popover width tracks the trigger', () => {
  test('PopoverContent uses the Tailwind v4 implicit-var width syntax (`w-(...)`, not `w-[...]`)', () => {
    // The popover trigger-width binding regressed silently when this
    // project moved to Tailwind v4. Tailwind v3 treated
    // `w-[--var-name]` as the implicit-`var()` shorthand; Tailwind v4
    // requires the parenthesized form `w-(--var-name)` for that
    // semantics. The square-bracket form in v4 emits literal
    // `width: --radix-popover-trigger-width` — invalid CSS, silently
    // ignored, and the popover auto-sizes to its longest suggestion.
    // In a real workspace that meant ~550px-wide dropdowns spilling
    // outside the parent PropPanel popover and visually swallowing the
    // upload affordance. The contract under test:
    //   - className contains `w-(--radix-popover-trigger-width)`
    //   - className does NOT contain `w-[--radix-popover-trigger-width]`
    // Asserting on the class string (rather than computed width) keeps
    // the test independent of jsdom's layout engine, which doesn't run
    // Tailwind preflight in the first place.
    stubAssetPaths.add('assets/photo.png');
    render(
      <SrcAutocomplete
        id="prop-src"
        value=""
        onChange={() => {}}
        accept={ALLOWED_IMAGE_MIME_TYPES}
      />,
    );
    const input = document.getElementById('prop-src') as HTMLInputElement;
    fireEvent.click(input);

    // PopoverContent is the closest [data-slot="popover-content"] ancestor of
    // any rendered suggestion option. shadcn/Radix forwards className to
    // that node. Reach in via the option's test-id rather than ARIA role —
    // Radix's listbox lives inside a portal that jsdom's accessible-name
    // computation doesn't traverse the same way Chrome does.
    const option = screen.getAllByTestId('src-autocomplete-option')[0];
    expect(option).toBeDefined();
    const content = option?.closest('[data-slot="popover-content"]') as HTMLElement | null;
    expect(content).not.toBeNull();
    const classes = content?.className ?? '';
    expect(classes).toContain('w-(--radix-popover-trigger-width)');
    expect(classes).not.toContain('w-[--radix-popover-trigger-width]');
  });
});
