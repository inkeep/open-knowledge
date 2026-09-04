import { afterEach, describe, expect, test } from 'vitest';
import { _resetPendingAutoOpenForTest, consumeAutoOpen } from './component-items';
import {
  filterItems,
  getSlashCommandItems,
  type SlashCommandContext,
  type SlashCommandItem,
} from './items';

describe('filterItems', () => {
  test('empty query returns all provided items', () => {
    const items = getSlashCommandItems();
    expect(filterItems(items, '')).toEqual(items);
  });

  test('matches items by label substring', () => {
    const result = filterItems(getSlashCommandItems(), 'heading');
    expect(result.every((i) => i.label.toLowerCase().includes('heading'))).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  test('matches items by name', () => {
    const result = filterItems(getSlashCommandItems(), 'bulletList');
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('bulletList');
  });

  test('matches items by alias', () => {
    const result = filterItems(getSlashCommandItems(), 'h1');
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('heading1');
  });

  test('partial queries narrow results progressively', () => {
    const broad = filterItems(getSlashCommandItems(), 'h');
    const narrow = filterItems(getSlashCommandItems(), 'heading');
    expect(narrow.length).toBeLessThanOrEqual(broad.length);
    expect(narrow.length).toBeGreaterThan(0);
  });

  test('query matching is case-insensitive', () => {
    const items = getSlashCommandItems();
    const lower = filterItems(items, 'heading');
    const upper = filterItems(items, 'HEADING');
    expect(upper).toEqual(lower);
  });

  test('alias matching is case-insensitive on both sides', () => {
    const items: SlashCommandItem[] = [
      {
        name: 'test',
        label: 'Test',
        icon: () => null,
        category: 'basic',
        command: () => {},
        aliases: ['MyAlias'],
      },
    ];
    expect(filterItems(items, 'myalias')).toHaveLength(1);
    expect(filterItems(items, 'MYALIAS')).toHaveLength(1);
  });

  test('no match returns empty array', () => {
    expect(filterItems(getSlashCommandItems(), 'zzzznonexistent')).toEqual([]);
  });

  test('items without aliases are still matchable by name and label', () => {
    const items: SlashCommandItem[] = [
      {
        name: 'noalias',
        label: 'No Alias Item',
        icon: () => null,
        category: 'basic',
        command: () => {},
      },
    ];
    expect(filterItems(items, 'noalias')).toHaveLength(1);
    expect(filterItems(items, 'No Alias')).toHaveLength(1);
    expect(filterItems(items, 'xyz')).toHaveLength(0);
  });
});

describe('built-in slash command items', () => {
  test('every item has a name, label, icon, category, and command', () => {
    for (const item of getSlashCommandItems()) {
      expect(typeof item.name).toBe('string');
      expect(typeof item.label).toBe('string');
      expect(item.icon).toBeDefined();
      expect(typeof item.category).toBe('string');
      expect(typeof item.command).toBe('function');
    }
  });

  test('no two items share the same name', () => {
    const names = getSlashCommandItems().map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('every item is findable by its own name via filterItems', () => {
    const items = getSlashCommandItems();
    for (const item of items) {
      const found = filterItems(items, item.name);
      expect(found.some((i) => i.name === item.name)).toBe(true);
    }
  });

  test('legacy file-upload "image" slash item is removed', () => {
    const items = getSlashCommandItems();
    expect(items.some((i) => i.name === 'image')).toBe(false);
    expect(items.some((i) => i.aliases?.includes('img'))).toBe(false);
  });
});

describe('Inline Math item composes into the slash-command transaction', () => {
  afterEach(() => {
    _resetPendingAutoOpenForTest();
  });

  function inlineMathItem(): SlashCommandItem {
    const item = getSlashCommandItems().find((i) => i.name === 'inlineMath');
    if (!item) throw new Error('Inline Math slash item missing');
    return item;
  }

  function makeContext(caret: number): {
    ctx: SlashCommandContext;
    getInsertedFormula: () => string | undefined;
    getSelectedPositions: () => number[];
    drainDeferred: () => void;
  } {
    let insertedFormula: string | undefined;
    const selectedPositions: number[] = [];
    const deferred: Array<() => void> = [];
    const chain = {
      insertMathInline: (formula: string) => {
        insertedFormula = formula;
        return chain;
      },
      run: () => true,
    };
    const ctx = {
      chain: () => chain,
      state: { selection: { from: caret } },
      editor: {
        commands: {
          setNodeSelection: (pos: number) => {
            selectedPositions.push(pos);
            return true;
          },
        },
      },
      afterCommit: (fn: () => void) => deferred.push(fn),
    } as unknown as SlashCommandContext;
    return {
      ctx,
      getInsertedFormula: () => insertedFormula,
      getSelectedPositions: () => selectedPositions,
      drainDeferred: () => {
        for (const fn of deferred) fn();
      },
    };
  }

  test('the insert lands on the passed chain and the selection move waits for the commit', () => {
    const caret = 12;
    const { ctx, getInsertedFormula, getSelectedPositions, drainDeferred } = makeContext(caret);

    const rafQueue: FrameRequestCallback[] = [];
    const originalRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((fn: FrameRequestCallback) => {
      rafQueue.push(fn);
      return rafQueue.length;
    }) as typeof globalThis.requestAnimationFrame;

    try {
      inlineMathItem().command(ctx);

      expect(getInsertedFormula()).toBe('');
      expect(rafQueue).toHaveLength(0);
      expect(consumeAutoOpen(caret)).toBe(false);

      drainDeferred();

      expect(consumeAutoOpen(caret)).toBe(true);
      expect(rafQueue).toHaveLength(1);
      rafQueue[0]?.(0);
      expect(getSelectedPositions()).toEqual([caret]);
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
    }
  });
});

describe('emoji item', () => {
  const emojiItem = () => {
    const item = getSlashCommandItems().find((i) => i.name === 'emoji');
    if (!item) throw new Error('emoji item missing');
    return item;
  };

  test('lives in the insert category and is reachable via the ":" alias', () => {
    expect(emojiItem().category).toBe('insert');
    const result = filterItems(getSlashCommandItems(), ':');
    expect(result.some((i) => i.name === 'emoji')).toBe(true);
  });

  test('contributes no chain steps and defers the picker open to afterCommit', () => {
    const deferred: Array<() => void> = [];
    let dispatched = 0;
    const ctx = {
      chain: () => {
        throw new Error('emoji item must not touch the chain');
      },
      state: {} as never,
      editor: {} as never,
      afterCommit: (fn: () => void) => deferred.push(fn),
    } as unknown as SlashCommandContext;

    const g = globalThis as { document?: unknown };
    const originalDocument = g.document;
    g.document = {
      dispatchEvent: () => {
        dispatched += 1;
        return true;
      },
    };
    try {
      emojiItem().command(ctx);
      expect(dispatched).toBe(0);
      expect(deferred).toHaveLength(1);
      for (const fn of deferred) fn();
      expect(dispatched).toBe(1);
    } finally {
      if (originalDocument === undefined) delete g.document;
      else g.document = originalDocument;
    }
  });
});
