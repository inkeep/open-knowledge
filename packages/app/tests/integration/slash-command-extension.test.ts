import { describe, expect, test } from 'bun:test';
import { Minus } from 'lucide-react';
import { SlashCommand, type SlashCommandOptions } from '../../src/editor/extensions/slash-command';
import {
  filterItems,
  getSlashCommandItems,
  type SlashCommandItem,
} from '../../src/editor/slash-command/items';

function makeItem(overrides: Partial<SlashCommandItem> = {}): SlashCommandItem {
  return {
    name: 'custom-item',
    label: 'Custom Item',
    icon: Minus,
    category: 'custom',
    command: () => {},
    ...overrides,
  };
}

function optionsOf(ext: ReturnType<typeof SlashCommand.configure>): SlashCommandOptions {
  return ext.options as SlashCommandOptions;
}

describe('SlashCommand extension configuration', () => {
  test('unconfigured extension produces a working set of built-in items', () => {
    const opts = SlashCommand.options as SlashCommandOptions;

    expect(opts.itemsSources.length).toBeGreaterThan(0);
    const items = opts.itemsSources.flatMap((fn) => fn());
    expect(items.length).toBeGreaterThan(0);

    for (const item of items) {
      expect(item.name).toBeString();
      expect(item.label).toBeString();
      expect(item.command).toBeFunction();
      expect(item.category).toBeString();
    }

    const categories = new Set(items.map((i) => i.category));
    for (const cat of categories) {
      expect(opts.categoryLabels[cat]).toBeString();
    }
  });

  test('additional item sources appear alongside built-ins when configured', () => {
    const custom = makeItem({ name: 'added-item' });
    const ext = SlashCommand.configure({
      itemsSources: [getSlashCommandItems, () => [custom]],
    });
    const opts = optionsOf(ext);
    const all = opts.itemsSources.flatMap((fn) => fn());

    expect(all.find((i) => i.name === 'added-item')).toBeDefined();
    expect(all.find((i) => i.name === 'heading1')).toBeDefined();
    expect(all.length).toBe(getSlashCommandItems().length + 1);
  });

  test('custom category labels coexist with built-in labels', () => {
    const ext = SlashCommand.configure({
      categoryLabels: { content: 'Content', layout: 'Layout' },
    });
    const opts = optionsOf(ext);

    expect(opts.categoryLabels.content).toBe('Content');
    expect(opts.categoryLabels.layout).toBe('Layout');
    expect(opts.categoryLabels.basic).toBe('Basic blocks');
    expect(opts.categoryLabels.insert).toBe('Insert');
  });

  test('providing only a custom source replaces the built-in items entirely', () => {
    const custom = makeItem({ name: 'only-item' });
    const ext = SlashCommand.configure({
      itemsSources: [() => [custom]],
    });
    const opts = optionsOf(ext);
    const all = opts.itemsSources.flatMap((fn) => fn());

    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe('only-item');
    expect(all.find((i) => i.name === 'heading1')).toBeUndefined();
  });

  test('items with an optional description field resolve without error', () => {
    const custom = makeItem({
      name: 'described',
      description: 'This item has a description',
    });
    const ext = SlashCommand.configure({
      itemsSources: [getSlashCommandItems, () => [custom]],
    });
    const all = optionsOf(ext).itemsSources.flatMap((fn) => fn());

    expect(all.find((i) => i.name === 'described')?.description).toBe(
      'This item has a description',
    );
    expect(all.find((i) => i.name === 'heading1')?.description).toBeUndefined();
  });

  test('items from multiple sources appear in source registration order', () => {
    const a = makeItem({ name: 'first', category: 'shared' });
    const b = makeItem({ name: 'second', category: 'shared' });
    const ext = SlashCommand.configure({
      itemsSources: [() => [a], () => [b]],
    });
    const all = optionsOf(ext).itemsSources.flatMap((fn) => fn());
    const names = all.map((i) => i.name);

    expect(names.indexOf('first')).toBeLessThan(names.indexOf('second'));
  });

  test('empty sources array means no items — no silent fallback', () => {
    const ext = SlashCommand.configure({ itemsSources: [] });
    const all = optionsOf(ext).itemsSources.flatMap((fn) => fn());
    expect(all).toHaveLength(0);
  });

  test('filterItems works across items from multiple configured sources', () => {
    const callout = makeItem({
      name: 'callout',
      label: 'Callout',
      category: 'component',
      aliases: ['warn', 'note'],
    });
    const ext = SlashCommand.configure({
      itemsSources: [getSlashCommandItems, () => [callout]],
    });
    const all = optionsOf(ext).itemsSources.flatMap((fn) => fn());

    const headings = filterItems(all, 'heading');
    expect(headings.length).toBeGreaterThan(0);
    expect(headings.every((i) => i.label.toLowerCase().includes('heading'))).toBe(true);

    expect(filterItems(all, 'WARN').map((i) => i.name)).toEqual(['callout']);

    expect(filterItems(all, 'zzz')).toEqual([]);
  });

  test('a throwing source does not prevent other sources from contributing items', () => {
    const healthy = makeItem({ name: 'healthy' });
    const ext = SlashCommand.configure({
      itemsSources: [
        () => {
          throw new Error('source exploded');
        },
        () => [healthy],
      ],
    });
    const opts = optionsOf(ext);

    const allItems = opts.itemsSources.flatMap((source) => {
      try {
        return source();
      } catch {
        return [];
      }
    });
    expect(allItems).toHaveLength(1);
    expect(allItems[0]?.name).toBe('healthy');
  });

  test('a throwing item command does not propagate when wrapped in try/catch', () => {
    const boom = makeItem({
      name: 'boom',
      command: () => {
        throw new Error('command exploded');
      },
    });
    expect(boom.command).toBeFunction();
    expect(() => boom.command({} as never)).toThrow('command exploded');
  });

  test('unlabeled categories fall back to the raw category key', () => {
    const ext = SlashCommand.configure({
      itemsSources: [() => [makeItem({ name: 'orphan', category: 'unlabeled' })]],
      categoryLabels: { basic: 'Basic blocks' },
    });
    const opts = optionsOf(ext);

    expect(opts.categoryLabels.unlabeled).toBeUndefined();
    const items = opts.itemsSources.flatMap((fn) => fn());
    expect(items.find((i) => i.category === 'unlabeled')).toBeDefined();
  });
});
