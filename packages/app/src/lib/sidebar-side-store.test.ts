import { describe, expect, test } from 'vitest';
import {
  CHAT_HISTORY_SIDE_KEY,
  createSidebarSideStore,
  documentPanelSide,
  FILE_SIDEBAR_SIDE_KEY,
  moveChatHistory,
  physicalSide,
  type SidebarSideStorage,
  swapEditorSidebars,
} from './sidebar-side-store.ts';

function memoryStorage(initial: Record<string, string> = {}): SidebarSideStorage & {
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

function fileSidebarOver(storage: SidebarSideStorage) {
  return createSidebarSideStore(FILE_SIDEBAR_SIDE_KEY, 'start', () => storage);
}

function chatHistoryOver(storage: SidebarSideStorage) {
  return createSidebarSideStore(CHAT_HISTORY_SIDE_KEY, 'end', () => storage);
}

describe('editor sidebar sides', () => {
  test('the file sidebar starts at the start edge and the document panel at the end', () => {
    const side = fileSidebarOver(memoryStorage()).getSnapshot();
    expect(side).toBe('start');
    expect(documentPanelSide(side)).toBe('end');
  });

  test('swapping puts the file sidebar at the end and saves it, and swapping again puts it back', () => {
    const storage = memoryStorage();
    const store = fileSidebarOver(storage);
    swapEditorSidebars(store);
    expect(store.getSnapshot()).toBe('end');
    expect(storage.data.get(FILE_SIDEBAR_SIDE_KEY)).toBe('end');
    expect(fileSidebarOver(storage).getSnapshot()).toBe('end');
    swapEditorSidebars(store);
    expect(store.getSnapshot()).toBe('start');
  });

  test.each(['', 'left', 'END'])(
    'a stored value %j that is not a side reads as the start',
    (value) => {
      expect(fileSidebarOver(memoryStorage({ [FILE_SIDEBAR_SIDE_KEY]: value })).getSnapshot()).toBe(
        'start',
      );
    },
  );

  test('storage that throws starts at the start edge, and a swap still takes effect for the session', () => {
    const throwing: SidebarSideStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const store = fileSidebarOver(throwing);
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
    const store = fileSidebarOver(storage);
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

describe('chat history side', () => {
  test('chat history starts at the end edge and keeps the side it is moved to, apart from the file sidebar', () => {
    const storage = memoryStorage();
    const history = chatHistoryOver(storage);
    const files = fileSidebarOver(storage);
    expect(history.getSnapshot()).toBe('end');
    moveChatHistory('left', 'ltr', history);
    expect(storage.data.get(CHAT_HISTORY_SIDE_KEY)).toBe('start');
    expect(chatHistoryOver(storage).getSnapshot()).toBe('start');
    expect(files.getSnapshot()).toBe('start');
    swapEditorSidebars(files);
    expect(history.getSnapshot()).toBe('start');
  });

  test.each(['', 'left', 'START'])(
    'a stored chat history value %j that is not a side reads as the end',
    (value) => {
      expect(chatHistoryOver(memoryStorage({ [CHAT_HISTORY_SIDE_KEY]: value })).getSnapshot()).toBe(
        'end',
      );
    },
  );

  test.each([
    ['left', 'ltr', 'start'],
    ['right', 'ltr', 'end'],
    ['left', 'rtl', 'end'],
    ['right', 'rtl', 'start'],
  ] as const)(
    'moving chat history to the %s of a %s document puts it at the %s edge',
    (physical, direction, side) => {
      const history = chatHistoryOver(memoryStorage());
      moveChatHistory(physical, direction, history);
      expect(history.getSnapshot()).toBe(side);
      expect(physicalSide(side, direction)).toBe(physical);
    },
  );
});
