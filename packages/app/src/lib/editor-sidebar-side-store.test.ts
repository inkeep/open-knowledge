import { describe, expect, test } from 'vitest';
import {
  createEditorSidebarSideStore,
  documentPanelSide,
  type EditorSidebarSideStorage,
  FILE_SIDEBAR_SIDE_KEY,
  physicalSide,
  swapEditorSidebars,
} from './editor-sidebar-side-store.ts';

function memoryStorage(initial: Record<string, string> = {}): EditorSidebarSideStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function storeOver(storage: EditorSidebarSideStorage) {
  return createEditorSidebarSideStore(FILE_SIDEBAR_SIDE_KEY, 'start', () => storage);
}

describe('editor sidebar sides', () => {
  test('the file sidebar starts at the start edge and the document panel at the end', () => {
    const side = storeOver(memoryStorage()).getSnapshot();
    expect(side).toBe('start');
    expect(documentPanelSide(side)).toBe('end');
  });

  test('swapping puts the file sidebar at the end and saves it, and swapping again puts it back', () => {
    const storage = memoryStorage();
    const store = storeOver(storage);
    swapEditorSidebars(store);
    expect(store.getSnapshot()).toBe('end');
    expect(storage.data.get(FILE_SIDEBAR_SIDE_KEY)).toBe('end');
    expect(storeOver(storage).getSnapshot()).toBe('end');
    swapEditorSidebars(store);
    expect(store.getSnapshot()).toBe('start');
  });

  test.each(['', 'left', 'END'])(
    'a stored value %j that is not a side reads as the start',
    (value) => {
      expect(storeOver(memoryStorage({ [FILE_SIDEBAR_SIDE_KEY]: value })).getSnapshot()).toBe(
        'start',
      );
    },
  );

  test('storage that throws starts at the start edge, and a swap still takes effect for the session', () => {
    const throwing: EditorSidebarSideStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const store = storeOver(throwing);
    expect(store.getSnapshot()).toBe('start');
    swapEditorSidebars(store);
    expect(store.getSnapshot()).toBe('end');
    swapEditorSidebars(store);
    expect(store.getSnapshot()).toBe('start');
  });

  test.each([
    ['start', 'ltr', 'left'],
    ['end', 'ltr', 'right'],
    ['start', 'rtl', 'right'],
    ['end', 'rtl', 'left'],
  ] as const)('a sidebar at the %s of a %s document sits on the %s', (side, direction, edge) => {
    expect(physicalSide(side, direction)).toBe(edge);
  });

  test('a change saved by another window is picked up on reload and announced to subscribers', () => {
    const storage = memoryStorage();
    const store = storeOver(storage);
    expect(store.getSnapshot()).toBe('start');
    let announced = 0;
    const stop = store.subscribe(() => {
      announced += 1;
    });
    storage.data.set(FILE_SIDEBAR_SIDE_KEY, 'end');
    expect(store.getSnapshot()).toBe('start');
    store.syncFromStorage();
    expect(store.getSnapshot()).toBe('end');
    expect(announced).toBe(1);
    stop();
  });
});
