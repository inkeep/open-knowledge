import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { isMacOS } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { act } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  _resetPendingLinkEditForTest,
  consumePendingLinkEdit,
} from '../extensions/link-edit-autoopen';
import { markIdentityKey } from '../extensions/mark-identity';
import { emitOpenLinkEditPopover } from './link-edit-popover-events';

mock.module('@/components/PageListContext', () => ({
  usePageList: () => ({
    folderPaths: new Set(['guides']),
    loading: false,
    pages: new Set(['guides/install']),
  }),
}));

const { LinkEditPopover } = await import('./LinkEditPopover');

const nativeRequestAnimationFrame = globalThis.requestAnimationFrame;
if (typeof globalThis.requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = ((callback) => {
    callback(0);
    return 0;
  }) as typeof globalThis.requestAnimationFrame;
}

function makeEditor({
  active = true,
  href = 'https://example.com',
  onSetLink,
  onUnsetLink,
  selectionEmpty = true,
  selectionFrom = 1,
  selectionTo = 1,
  viewFocused = true,
}: {
  active?: boolean;
  href?: string;
  onSetLink?: (attrs: { href: string }) => void;
  onUnsetLink?: () => void;
  selectionEmpty?: boolean;
  selectionFrom?: number;
  selectionTo?: number;
  viewFocused?: boolean;
} = {}): Editor {
  const chain = {
    focus: () => chain,
    run: () => true,
    setLink: (attrs: { href: string }) => {
      onSetLink?.(attrs);
      return chain;
    },
    unsetLink: () => {
      onUnsetLink?.();
      return chain;
    },
  };

  return {
    state: {
      selection: { empty: selectionEmpty, from: selectionFrom, to: selectionTo },
      doc: { textBetween: () => (selectionEmpty ? '' : 'docs') },
    },
    view: { hasFocus: () => viewFocused },
    // The claim reads the non-throwing `editorView` field (never the `view`
    // throwing proxy); mirror the real Editor by exposing both.
    editorView: { hasFocus: () => viewFocused },
    getAttributes: mock((name: string) => (name === 'link' ? { href } : {})),
    isActive: mock((name: string) => name === 'link' && active),
    on: mock(() => {}),
    off: mock(() => {}),
    chain: () => chain,
  } as unknown as Editor;
}

function renderPopover(editor: Editor, opts: { shortcutEnabled?: boolean } = {}) {
  return render(
    <TooltipProvider>
      <LinkEditPopover editor={editor} shortcutEnabled={opts.shortcutEnabled} />
    </TooltipProvider>,
  );
}

function cmdKEvent(init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: 'k',
    bubbles: true,
    cancelable: true,
    ...(isMacOS() ? { metaKey: true } : { ctrlKey: true }),
    ...init,
  });
}

function stubClipboardRead(impl: () => Promise<string>) {
  const readText = mock(impl);
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText },
  });
  return {
    readText,
    restore: () => {
      if (original) {
        Object.defineProperty(navigator, 'clipboard', original);
      } else {
        Reflect.deleteProperty(navigator, 'clipboard');
      }
    },
  };
}

afterEach(() => {
  cleanup();
  if (nativeRequestAnimationFrame) {
    globalThis.requestAnimationFrame = nativeRequestAnimationFrame;
  }
});

describe('LinkEditPopover', () => {
  test('prefills the current URL when editing an active collapsed link', () => {
    renderPopover(makeEditor({ href: 'https://example.com/docs' }));

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Insert link' }));

    expect((screen.getByRole('combobox', { name: 'Link URL' }) as HTMLInputElement).value).toBe(
      'https://example.com/docs',
    );
  });

  test('starts empty for a non-collapsed selection even when the link mark is active', () => {
    renderPopover(makeEditor({ href: 'https://example.com/docs', selectionEmpty: false }));

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Insert link' }));

    expect((screen.getByRole('combobox', { name: 'Link URL' }) as HTMLInputElement).value).toBe('');
  });

  test('applies a trimmed URL with Enter and dismisses the input', () => {
    const setLink = mock((_attrs: { href: string }) => {});
    const unsetLink = mock(() => {});
    renderPopover(makeEditor({ active: false, onSetLink: setLink, onUnsetLink: unsetLink }));

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Insert link' }));
    const input = screen.getByRole('combobox', { name: 'Link URL' });
    fireEvent.change(input, { target: { value: '  https://example.com/new  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(setLink).toHaveBeenCalledWith({ href: 'https://example.com/new' });
    expect(unsetLink).not.toHaveBeenCalled();
    expect(screen.queryByRole('combobox', { name: 'Link URL' })).toBeNull();
  });

  test('submitting an empty active collapsed link unsets it', async () => {
    const setLink = mock((_attrs: { href: string }) => {});
    const unsetLink = mock(() => {});
    renderPopover(
      makeEditor({
        href: '',
        onSetLink: setLink,
        onUnsetLink: unsetLink,
      }),
    );

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Insert link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply link' }));

    expect(setLink).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(unsetLink).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.queryByRole('combobox', { name: 'Link URL' })).toBeNull();
    });
  });

  test('empty inactive input is a no-op and still dismisses', async () => {
    const setLink = mock((_attrs: { href: string }) => {});
    const unsetLink = mock(() => {});
    renderPopover(makeEditor({ active: false, onSetLink: setLink, onUnsetLink: unsetLink }));

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Insert link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply link' }));

    expect(setLink).not.toHaveBeenCalled();
    expect(unsetLink).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole('combobox', { name: 'Link URL' })).toBeNull();
    });
  });
});

describe('LinkEditPopover ⌘K dual-role claim', () => {
  test('claims ⌘K and opens the URL input when the focused editor has a text selection', async () => {
    renderPopover(makeEditor({ selectionEmpty: false, selectionFrom: 1, selectionTo: 5 }), {
      shortcutEnabled: true,
    });

    const event = cmdKEvent();
    fireEvent(window, event);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Link URL' })).toBeTruthy();
    });
  });

  test('claims in the capture phase, starving window-bubble consumers like the palette', () => {
    // The command palette's opener is a window-bubble keydown listener. A
    // claimed ⌘K must never reach one — even one registered before this
    // component mounted. Dispatch below window so the phases separate.
    let bubbleFired = false;
    const bubbleListener = () => {
      bubbleFired = true;
    };
    window.addEventListener('keydown', bubbleListener);
    try {
      renderPopover(makeEditor({ selectionEmpty: false, selectionFrom: 1, selectionTo: 5 }), {
        shortcutEnabled: true,
      });

      const event = cmdKEvent();
      fireEvent(document.body, event);

      expect(event.defaultPrevented).toBe(true);
      expect(bubbleFired).toBe(false);
    } finally {
      window.removeEventListener('keydown', bubbleListener);
    }
  });

  test('leaves ⌘K for the palette when the editor is not focused', () => {
    renderPopover(
      makeEditor({ selectionEmpty: false, selectionFrom: 1, selectionTo: 5, viewFocused: false }),
      { shortcutEnabled: true },
    );

    const event = cmdKEvent();
    fireEvent(window, event);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole('combobox', { name: 'Link URL' })).toBeNull();
  });

  test('stays inert for pooled editors without shortcutEnabled', () => {
    renderPopover(makeEditor({ selectionEmpty: false, selectionFrom: 1, selectionTo: 5 }));

    const event = cmdKEvent();
    fireEvent(window, event);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole('combobox', { name: 'Link URL' })).toBeNull();
  });

  test('does not claim ⌘⇧K', () => {
    renderPopover(makeEditor({ selectionEmpty: false, selectionFrom: 1, selectionTo: 5 }), {
      shortcutEnabled: true,
    });

    const event = cmdKEvent({ shiftKey: true });
    fireEvent(window, event);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole('combobox', { name: 'Link URL' })).toBeNull();
  });

  test('routes a caret inside a tracked link to the chip edit spine, not the popover', () => {
    // Real mark-identity state needs a live PM view; stub the plugin state so
    // the caret resolves to a stable id (same idiom as component-items tests).
    const getStateSpy = spyOn(markIdentityKey, 'getState').mockReturnValue({
      byId: new Map([
        [
          'm7',
          { id: 'm7', markType: 'link', from: 1, to: 5, attrs: { href: 'https://example.com' } },
        ],
      ]),
      counter: 7,
    } as never);

    // Capture rAF without invoking it: the deferred getInteractionLayer →
    // setActiveNode needs a live editor view, out of scope for this unit.
    let rafScheduled = false;
    const originalRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (() => {
      rafScheduled = true;
      return 0;
    }) as typeof globalThis.requestAnimationFrame;

    try {
      renderPopover(makeEditor({ selectionEmpty: true, selectionFrom: 3 }), {
        shortcutEnabled: true,
      });

      const event = cmdKEvent();
      fireEvent(window, event);

      expect(event.defaultPrevented).toBe(true);
      expect(consumePendingLinkEdit('m7')).toBe(true);
      expect(rafScheduled).toBe(true);
      expect(screen.queryByRole('combobox', { name: 'Link URL' })).toBeNull();
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
      getStateSpy.mockRestore();
      _resetPendingLinkEditForTest();
    }
  });

  test('opens the URL input when the programmatic-open seam fires for the active editor', async () => {
    renderPopover(makeEditor(), { shortcutEnabled: true });

    act(() => {
      emitOpenLinkEditPopover();
    });

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Link URL' })).toBeTruthy();
    });
  });

  test('ignores the programmatic-open seam when not the active editor instance', () => {
    renderPopover(makeEditor());

    act(() => {
      emitOpenLinkEditPopover();
    });

    expect(screen.queryByRole('combobox', { name: 'Link URL' })).toBeNull();
  });
});

describe('LinkEditPopover clipboard pre-fill', () => {
  test('pre-fills an allowlisted-scheme clipboard URL, selected, when the Link button opens an empty input', async () => {
    const clip = stubClipboardRead(() => Promise.resolve('https://inkeep.com/docs'));
    try {
      renderPopover(makeEditor({ active: false }));

      fireEvent.mouseDown(screen.getByRole('button', { name: 'Insert link' }));

      const input = screen.getByRole('combobox', { name: 'Link URL' }) as HTMLInputElement;
      await waitFor(() => {
        expect(input.value).toBe('https://inkeep.com/docs');
      });
      await waitFor(() => {
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe('https://inkeep.com/docs'.length);
      });
    } finally {
      clip.restore();
    }
  });

  test('pre-fills when the ⌘K claim opens the popover for a text selection', async () => {
    const clip = stubClipboardRead(() => Promise.resolve('https://inkeep.com/'));
    try {
      renderPopover(makeEditor({ selectionEmpty: false, selectionFrom: 1, selectionTo: 5 }), {
        shortcutEnabled: true,
      });

      fireEvent(window, cmdKEvent());

      await waitFor(() => {
        expect((screen.getByRole('combobox', { name: 'Link URL' }) as HTMLInputElement).value).toBe(
          'https://inkeep.com/',
        );
      });
    } finally {
      clip.restore();
    }
  });

  test('leaves the input empty when the clipboard holds prose, with no error surfaced', async () => {
    let resolveRead!: (value: string) => void;
    const clip = stubClipboardRead(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );
    try {
      renderPopover(makeEditor({ active: false }));
      fireEvent.mouseDown(screen.getByRole('button', { name: 'Insert link' }));
      const input = screen.getByRole('combobox', { name: 'Link URL' }) as HTMLInputElement;

      await act(async () => {
        resolveRead('meeting notes for tuesday');
        await Promise.resolve();
      });

      expect(input.value).toBe('');
    } finally {
      clip.restore();
    }
  });

  test('degrades silently to an empty, functional input when the clipboard read is denied', async () => {
    let rejectRead!: (reason: unknown) => void;
    const clip = stubClipboardRead(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectRead = reject;
        }),
    );
    try {
      renderPopover(makeEditor({ active: false }));
      fireEvent.mouseDown(screen.getByRole('button', { name: 'Insert link' }));
      const input = screen.getByRole('combobox', { name: 'Link URL' }) as HTMLInputElement;

      await act(async () => {
        rejectRead(new DOMException('Read permission denied.', 'NotAllowedError'));
        await Promise.resolve();
      });

      expect(input.value).toBe('');
      fireEvent.change(input, { target: { value: 'https://typed.example/' } });
      expect(input.value).toBe('https://typed.example/');
    } finally {
      clip.restore();
    }
  });

  test('does not read the clipboard when opening on an existing link', async () => {
    const clip = stubClipboardRead(() => Promise.resolve('https://clipboard.example/'));
    try {
      renderPopover(makeEditor({ href: 'https://example.com/docs' }));
      fireEvent.mouseDown(screen.getByRole('button', { name: 'Insert link' }));
      const input = screen.getByRole('combobox', { name: 'Link URL' }) as HTMLInputElement;
      expect(input.value).toBe('https://example.com/docs');

      await act(async () => {
        await Promise.resolve();
      });

      // The read itself is user-visible on the web (a clipboard permission
      // prompt), so not-reading on an edit-open is the observable contract —
      // alongside the existing href surviving untouched.
      expect(clip.readText).not.toHaveBeenCalled();
      expect(input.value).toBe('https://example.com/docs');
    } finally {
      clip.restore();
    }
  });

  test('a value the user typed before the clipboard resolved wins', async () => {
    let resolveRead!: (value: string) => void;
    const clip = stubClipboardRead(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );
    try {
      renderPopover(makeEditor({ active: false }));
      fireEvent.mouseDown(screen.getByRole('button', { name: 'Insert link' }));
      const input = screen.getByRole('combobox', { name: 'Link URL' }) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'guides/install' } });

      await act(async () => {
        resolveRead('https://late.example/');
        await Promise.resolve();
      });

      expect(input.value).toBe('guides/install');
    } finally {
      clip.restore();
    }
  });
});
