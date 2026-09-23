import { i18n } from '@lingui/core';
import { cleanup, render, screen, within } from '@testing-library/react';
import { FileText, Sparkles } from 'lucide-react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { getComponentItems } from './component-items';
import type { SlashCommandItem } from './items';
import { SlashCommandMenu } from './SlashCommandMenu';

i18n.load('en', {});
i18n.activate('en');

afterEach(cleanup);

function item(overrides: Partial<SlashCommandItem> & { name: string }): SlashCommandItem {
  return {
    label: overrides.name,
    icon: Sparkles,
    category: 'skills',
    command: () => {},
    ...overrides,
  };
}

function show(items: SlashCommandItem[]) {
  render(
    <SlashCommandMenu
      items={items}
      selectedIndex={0}
      onSelect={vi.fn()}
      onHoverIndex={vi.fn()}
      categoryLabels={{ skills: 'Skills', components: 'Components', basic: 'Basic blocks' }}
    />,
  );
}

describe('SlashCommandMenu second line', () => {
  test('a skill shows what it does under its name', () => {
    show([item({ name: 'bug-triage', description: 'Triage an Open Knowledge ticket.' })]);

    const row = screen.getByRole('option');
    expect(within(row).getByText('bug-triage')).toBeTruthy();
    expect(within(row).getByText('Triage an Open Knowledge ticket.')).toBeTruthy();
  });

  test('a non-skill row keeps its registry description out of the menu', () => {
    show([
      item({
        name: 'HtmlAlignBlock',
        category: 'components',
        icon: FileText,
        description: 'GitHub-style `<div align>` wrapper.',
      }),
    ]);

    const row = screen.getByRole('option');
    expect(within(row).getByText('HtmlAlignBlock')).toBeTruthy();
    expect(row.textContent).toBe('HtmlAlignBlock');
  });

  test('no real component row prints its registry description, however it is built', () => {
    const built = getComponentItems();
    expect(built.length).toBeGreaterThan(0);
    expect(built.some((i) => i.description !== undefined)).toBe(true);

    show(built);

    const labels = new Set(built.map((i) => i.label));
    const printedMore = screen
      .getAllByRole('option')
      .map((row) => row.textContent ?? '')
      .filter((text) => !labels.has(text));

    expect(printedMore).toEqual([]);
  });

  test('the blurb on screen is the blurb announced', () => {
    show([item({ name: 'bug-triage', description: 'Triage an Open Knowledge ticket.' })]);

    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe('bug-triage. Triage an Open Knowledge ticket.');
  });

  test('an item with no description of its own stays a single line', () => {
    show([item({ name: 'Heading 1', category: 'basic' })]);

    const row = screen.getByRole('option');
    expect(row.textContent).toBe('Heading 1');
  });
});
