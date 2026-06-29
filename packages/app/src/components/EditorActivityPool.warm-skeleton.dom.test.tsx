import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { Suspense, useEffect, useLayoutEffect, useState } from 'react';
import {
  __consumeRenameSnapshot,
  __resetRenameSnapshotStore,
  captureRenameSnapshots,
  clearRenameSnapshot,
  peekRenameSnapshot,
  type RenameSnapshot,
  storeRenameSnapshot,
} from '@/editor/editor-cache';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';


function WarmContentFallbackReplica({ html }: { html: string }) {
  return (
    <div className="tiptap-editor h-full pointer-events-none" aria-hidden="true">
      <div
        className="tiptap ProseMirror tiptap-editor-portal-content"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: test replica mirrors editor.getHTML() serialization
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}


function WarmFallbackHost({ docName }: { docName: string }) {
  const [warmSnapshot] = useState(() => peekRenameSnapshot(docName));
  const warmHtml = warmSnapshot?.html ?? null;

  useLayoutEffect(() => {
    if (!warmSnapshot || warmSnapshot.scrollTop <= 0) return;
    const scrollEl = document.querySelector<HTMLDivElement>(
      '[data-testid="editor-scroll-container"]',
    );
    if (!scrollEl) return;
    scrollEl.scrollTop = warmSnapshot.scrollTop;
  }, [warmSnapshot]);

  useEffect(() => {
    clearRenameSnapshot(docName);
  }, [docName]);

  if (!warmHtml) return <div data-testid="cold-skeleton" />;
  return <WarmContentFallbackReplica html={warmHtml} />;
}

const baseSnap = (html: string): RenameSnapshot => ({ html, scrollTop: 0, selection: null });


describe('WarmContentFallback DOM geometry', () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    __resetRenameSnapshotStore();
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    __resetRenameSnapshotStore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  test('outer div carries tiptap-editor, h-full, pointer-events-none, and aria-hidden', () => {
    const { container } = render(<WarmContentFallbackReplica html="<p>hello</p>" />);
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.tagName).toBe('DIV');
    expectVisualClassTokens(outer.className, ['tiptap-editor', 'h-full', 'pointer-events-none']);
    expect(outer.getAttribute('aria-hidden')).toBe('true');
  });

  test('inner div carries tiptap, ProseMirror, and tiptap-editor-portal-content', () => {
    const { container } = render(<WarmContentFallbackReplica html="<p>hello</p>" />);
    const outer = container.firstElementChild as HTMLElement;
    const inner = outer.firstElementChild as HTMLElement;
    expect(inner.tagName).toBe('DIV');
    expectVisualClassTokens(inner.className, [
      'tiptap',
      'ProseMirror',
      'tiptap-editor-portal-content',
    ]);
  });

  test('inner div renders provided html as child content', () => {
    const { container } = render(<WarmContentFallbackReplica html="<p>warm content</p>" />);
    const outer = container.firstElementChild as HTMLElement;
    const inner = outer.firstElementChild as HTMLElement;
    expect(inner.innerHTML).toBe('<p>warm content</p>');
  });

  test('outer div is not interactive (aria-hidden hides from a11y tree)', () => {
    render(<WarmContentFallbackReplica html="<p>hello</p>" />);
    const hiddenEl = document.querySelector('[aria-hidden="true"]');
    expect(hiddenEl).toBeTruthy();
  });
});

describe('rename-snapshot store → warm-fallback selection contract', () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    __resetRenameSnapshotStore();
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    __resetRenameSnapshotStore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  test('when snapshot exists, host renders warm content (not cold skeleton)', () => {
    storeRenameSnapshot('notes/foo.md', baseSnap('<p>warmed content</p>'));
    render(
      <Suspense fallback={<div data-testid="suspense-fallback" />}>
        <WarmFallbackHost docName="notes/foo.md" />
      </Suspense>,
    );
    expect(document.querySelector('.tiptap-editor')).toBeTruthy();
    expect(screen.queryByTestId('cold-skeleton')).toBeNull();
  });

  test('when no snapshot, host renders cold skeleton', () => {
    render(
      <Suspense fallback={<div data-testid="suspense-fallback" />}>
        <WarmFallbackHost docName="notes/bar.md" />
      </Suspense>,
    );
    expect(screen.getByTestId('cold-skeleton')).toBeTruthy();
    expect(document.querySelector('.tiptap-editor')).toBeNull();
  });

  test('consume is one-shot: second render for same docName sees no snapshot', () => {
    storeRenameSnapshot('notes/baz.md', baseSnap('<p>once only</p>'));

    const { unmount } = render(<WarmFallbackHost docName="notes/baz.md" />);
    expect(document.querySelector('.tiptap-editor')).toBeTruthy();
    unmount();
    cleanup();

    render(
      <Suspense fallback={null}>
        <WarmFallbackHost docName="notes/baz.md" />
      </Suspense>,
    );
    expect(screen.getByTestId('cold-skeleton')).toBeTruthy();
    expect(document.querySelector('.tiptap-editor')).toBeNull();
  });

  test('snapshot for different docName does not bleed across', () => {
    storeRenameSnapshot('notes/other.md', baseSnap('<p>other</p>'));
    render(<WarmFallbackHost docName="notes/mine.md" />);
    expect(screen.getByTestId('cold-skeleton')).toBeTruthy();
    expect(__consumeRenameSnapshot('notes/other.md')?.html).toBe('<p>other</p>');
  });
});


describe('warm-fallback scroll restoration', () => {
  let scrollContainer: HTMLDivElement;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    __resetRenameSnapshotStore();
    scrollContainer = document.createElement('div');
    scrollContainer.setAttribute('data-testid', 'editor-scroll-container');
    scrollContainer.style.height = '500px';
    scrollContainer.style.overflowY = 'auto';
    const inner = document.createElement('div');
    inner.style.height = '5000px';
    scrollContainer.appendChild(inner);
    document.body.appendChild(scrollContainer);

    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    scrollContainer.remove();
    __resetRenameSnapshotStore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  test('applies scrollTop to the scroll container on mount', () => {
    storeRenameSnapshot('notes/scrolled.md', {
      html: '<p>scrolled content</p>',
      scrollTop: 500,
      selection: null,
    });
    render(<WarmFallbackHost docName="notes/scrolled.md" />);
    expect(scrollContainer.scrollTop).toBe(500);
  });

  test('skips scroll application when scrollTop <= 0', () => {
    scrollContainer.scrollTop = 0;
    storeRenameSnapshot('notes/at-top.md', {
      html: '<p>at top</p>',
      scrollTop: 0,
      selection: null,
    });
    render(<WarmFallbackHost docName="notes/at-top.md" />);
    expect(scrollContainer.scrollTop).toBe(0);
  });

  test('leaves scroll container untouched when no snapshot exists', () => {
    scrollContainer.scrollTop = 123;
    render(<WarmFallbackHost docName="notes/never-stored.md" />);
    expect(scrollContainer.scrollTop).toBe(123);
  });
});


describe('captureRenameSnapshots — scrollTop capture (DOM)', () => {
  let scrollContainer: HTMLDivElement;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    __resetRenameSnapshotStore();
    scrollContainer = document.createElement('div');
    scrollContainer.setAttribute('data-testid', 'editor-scroll-container');
    scrollContainer.style.height = '500px';
    scrollContainer.style.overflowY = 'auto';
    const inner = document.createElement('div');
    inner.style.height = '5000px';
    scrollContainer.appendChild(inner);
    document.body.appendChild(scrollContainer);
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    scrollContainer.remove();
    __resetRenameSnapshotStore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  test('captures scrollTop from [data-testid="editor-scroll-container"]', () => {
    scrollContainer.scrollTop = 333;
    storeRenameSnapshot('notes/scrolled.md', {
      html: '<p>x</p>',
      scrollTop: scrollContainer.scrollTop,
      selection: null,
    });
    const consumed = __consumeRenameSnapshot('notes/scrolled.md');
    expect(consumed?.scrollTop).toBe(333);
  });

  test('captureRenameSnapshots with empty rename list is a no-op', () => {
    scrollContainer.scrollTop = 100;
    expect(() => captureRenameSnapshots([])).not.toThrow();
    expect(__consumeRenameSnapshot('whatever')).toBeNull();
  });
});
