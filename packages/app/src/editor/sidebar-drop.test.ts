import { describe, expect, test, vi } from 'vitest';
import {
  OK_SIDEBAR_DRAG_MIME,
  type SidebarDragPayload,
  serializeSidebarDragPayload,
} from '@/lib/sidebar-drag';
import {
  createSidebarAwareHandleDrop,
  openSidebarDropPayload,
  type SidebarOpenTarget,
} from './sidebar-drop';

type EditorHandleDrop = ReturnType<typeof createSidebarAwareHandleDrop>;
type DropView = Parameters<EditorHandleDrop>[0];
type DropEvent = Parameters<EditorHandleDrop>[1];

function dataTransfer(data: Record<string, string>): Pick<DataTransfer, 'types' | 'getData'> {
  return {
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? '',
  };
}

function dropEvent(data: Record<string, string>): {
  event: DropEvent;
  preventDefault: ReturnType<typeof vi.fn>;
} {
  const preventDefault = vi.fn(() => {});
  return {
    event: {
      dataTransfer: dataTransfer(data),
      preventDefault,
    } as unknown as DropEvent,
    preventDefault,
  };
}

describe('createSidebarAwareHandleDrop', () => {
  test('claims sidebar drags before generic clipboard drop handling', () => {
    const payload: SidebarDragPayload = { v: 1, kind: 'doc', docName: 'notes/Intro', size: null };
    const clipboardDrop = vi.fn((_view: DropView, _event: DragEvent) => false);
    const onSidebarDrop = vi.fn((_payload: SidebarDragPayload) => {});
    const handleDrop = createSidebarAwareHandleDrop(clipboardDrop, onSidebarDrop);
    const { event, preventDefault } = dropEvent({
      [OK_SIDEBAR_DRAG_MIME]: serializeSidebarDragPayload(payload),
      'text/plain': 'notes/Intro.md',
    });

    expect(handleDrop({} as DropView, event)).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onSidebarDrop).toHaveBeenCalledWith(payload);
    expect(clipboardDrop).not.toHaveBeenCalled();
  });

  test('falls through to clipboard drop for non-sidebar drags', () => {
    const view = {} as DropView;
    const clipboardDrop = vi.fn((_view: DropView, _event: DragEvent) => false);
    const onSidebarDrop = vi.fn((_payload: SidebarDragPayload) => {});
    const handleDrop = createSidebarAwareHandleDrop(clipboardDrop, onSidebarDrop);
    const { event, preventDefault } = dropEvent({ 'text/plain': 'notes/Intro.md' });

    expect(handleDrop(view, event)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onSidebarDrop).not.toHaveBeenCalled();
    expect(clipboardDrop).toHaveBeenCalledWith(view, event);
  });
});

describe('openSidebarDropPayload', () => {
  test('opens sidebar payloads as appended tabs and replaces the hash directly', () => {
    const restoreWindow = installFakeWindow({
      hash: '#/old',
      pathname: '/app',
      search: '?workspace=ok',
    });
    const openTarget = vi.fn(
      (_target: Parameters<SidebarOpenTarget>[0], _options: Parameters<SidebarOpenTarget>[1]) => {},
    );
    try {
      openSidebarDropPayload({ v: 1, kind: 'doc', docName: 'notes/Intro', size: null }, openTarget);
    } finally {
      restoreWindow();
    }

    expect(openTarget).toHaveBeenCalledWith(
      { kind: 'doc', target: 'notes/Intro', docName: 'notes/Intro' },
      { tabBehavior: 'append' },
    );
    expect(fakeReplaceState).toHaveBeenCalledWith(null, '', '/app?workspace=ok#/notes/Intro');
  });
});

let fakeReplaceState = vi.fn((_state: unknown, _unused: string, _url: string) => {});

function installFakeWindow(location: {
  hash: string;
  pathname: string;
  search: string;
}): () => void {
  fakeReplaceState = vi.fn((_state: unknown, _unused: string, _url: string) => {});
  const global = globalThis as { window?: unknown };
  const previous = global.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location,
      history: {
        replaceState: fakeReplaceState,
      },
    },
  });
  return () => {
    if (previous === undefined) {
      delete global.window;
      return;
    }
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous });
  };
}
