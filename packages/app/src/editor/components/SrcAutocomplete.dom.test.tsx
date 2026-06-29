
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ALLOWED_IMAGE_MIME_TYPES } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

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

const { SrcAutocomplete } = await import('./SrcAutocomplete');

beforeEach(() => {
  stubAssetPaths.clear();
});

afterEach(() => {
  cleanup();
});

function getOptions(): HTMLButtonElement[] {
  return screen.queryAllByTestId('src-autocomplete-option') as HTMLButtonElement[];
}

describe('SrcAutocomplete — open behavior', () => {
  test('focus on an empty input with matching assets → popover opens with up to 8 source-order items', () => {
    for (let i = 0; i < 10; i++) stubAssetPaths.add(`assets/photo-${i}.png`);

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

    const options = getOptions();
    expect(options).toHaveLength(8);
    expect(options[0]?.textContent).toContain('photo-0.png');
    expect(options[7]?.textContent).toContain('photo-7.png');
  });

  test('focus with zero matching assets → popover stays closed (no chrome flash)', () => {
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
    fireEvent.focus(input);

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
    fireEvent.focus(input);

    const labels = getOptions().map((b) => b.textContent ?? '');
    expect(labels.some((t) => t.includes('photo.png'))).toBe(true);
    expect(labels.some((t) => t.includes('clip.mp4'))).toBe(false);
  });
});

describe('SrcAutocomplete — selection contract', () => {
  test('clicking a suggestion emits onChange with leading-slash server-absolute path', () => {
    stubAssetPaths.add('assets/photo.png');
    const onChange = mock((_v: string) => {});

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

    const option = getOptions()[0];
    if (!option) throw new Error('expected an option to render');
    fireEvent.mouseDown(option);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('/assets/photo.png');
  });

  test('typing then Enter on the highlighted item emits onChange with the path', () => {
    stubAssetPaths.add('assets/photo.png');
    stubAssetPaths.add('assets/banner.png');
    const onChange = mock((_v: string) => {});

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
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('/assets/banner.png');
  });
});

describe('SrcAutocomplete — keyboard handling', () => {
  test('Escape closes the popover (subsequent focus reopens it)', () => {
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
    expect(getOptions().length).toBe(1);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(getOptions().length).toBe(0);
  });

  test('Enter with no matching suggestions does NOT call onChange (no phantom selection)', () => {
    const onChange = mock((_v: string) => {});

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
    const onSubmit = mock(() => {});
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
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('Enter with a highlighted suggestion picks the suggestion, NOT onSubmit', () => {
    stubAssetPaths.add('assets/photo.png');
    const onChange = mock((_v: string) => {});
    const onSubmit = mock(() => {});
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
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('/assets/photo.png');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('SrcAutocomplete — popover width tracks the trigger', () => {
  test('PopoverContent uses the Tailwind v4 implicit-var width syntax (`w-(...)`, not `w-[...]`)', () => {
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

    const option = screen.getAllByTestId('src-autocomplete-option')[0];
    expect(option).toBeDefined();
    const content = option?.closest('[data-slot="popover-content"]') as HTMLElement | null;
    expect(content).not.toBeNull();
    const classes = content?.className ?? '';
    expect(classes).toContain('w-(--radix-popover-trigger-width)');
    expect(classes).not.toContain('w-[--radix-popover-trigger-width]');
  });
});
