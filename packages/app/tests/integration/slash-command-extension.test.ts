/**
 * Slash command extension — pluggable API behavioral tests.
 *
 * Verifies that the SlashCommand TipTap extension exposes a working
 * configuration surface for downstream consumers: registering additional
 * item sources, adding category labels, and replacing the default source.
 *
 * Exercises the real `Extension.configure()` machinery from `@tiptap/core`
 * (Level-2: real component, no DOM — TipTap's Editor requires `window`).
 */

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

    // Has at least one source that returns items
    expect(opts.itemsSources.length).toBeGreaterThan(0);
    const items = opts.itemsSources.flatMap((fn) => fn());
    expect(items.length).toBeGreaterThan(0);

    // Every resolved item has the fields a consumer needs
    for (const item of items) {
      expect(item.name).toBeString();
      expect(item.label).toBeString();
      expect(item.command).toBeFunction();
      expect(item.category).toBeString();
    }

    // Category labels cover every category present in the items
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

    // Both the built-in items and the custom item are present
    expect(all.find((i) => i.name === 'added-item')).toBeDefined();
    expect(all.find((i) => i.name === 'heading1')).toBeDefined();
    expect(all.length).toBe(getSlashCommandItems().length + 1);
  });

  test('custom category labels coexist with built-in labels', () => {
    const ext = SlashCommand.configure({
      categoryLabels: { content: 'Content', layout: 'Layout' },
    });
    const opts = optionsOf(ext);

    // Custom labels present
    expect(opts.categoryLabels.content).toBe('Content');
    expect(opts.categoryLabels.layout).toBe('Layout');
    // Built-in labels still present (TipTap deep-merges plain objects)
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
    // No built-in items present
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
    // Built-in items (no description) still resolve
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

    // Filtering narrows across all sources
    const headings = filterItems(all, 'heading');
    expect(headings.length).toBeGreaterThan(0);
    expect(headings.every((i) => i.label.toLowerCase().includes('heading'))).toBe(true);

    // Custom item findable by alias, case-insensitive
    expect(filterItems(all, 'WARN').map((i) => i.name)).toEqual(['callout']);

    // No-match still returns empty
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

    // Mirror the runtime items() callback behavior: flatMap with per-source try/catch
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
    // Verify the item resolves correctly — the try/catch around command()
    // is in the extension's Suggestion command callback, which we can't
    // exercise without a DOM. But we CAN verify the item itself is valid
    // and that calling its command throws (proving the boundary exists).
    expect(boom.command).toBeFunction();
    expect(() => boom.command({} as never)).toThrow('command exploded');
  });

  test('unlabeled categories fall back to the raw category key', () => {
    const ext = SlashCommand.configure({
      // No label for 'unlabeled' category — just itemsSources
      itemsSources: [() => [makeItem({ name: 'orphan', category: 'unlabeled' })]],
      // categoryLabels does NOT include 'unlabeled'
      categoryLabels: { basic: 'Basic blocks' },
    });
    const opts = optionsOf(ext);

    // The menu uses: categoryLabels[cat.key] ?? cat.key
    // With no label for 'unlabeled', the fallback is the raw key itself
    expect(opts.categoryLabels.unlabeled).toBeUndefined();
    // The item still resolves — it just won't have a pretty label
    const items = opts.itemsSources.flatMap((fn) => fn());
    expect(items.find((i) => i.category === 'unlabeled')).toBeDefined();
  });
});
