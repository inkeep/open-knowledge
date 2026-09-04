import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ComposerSlashMenu } from './ComposerSlashMenu';
import type { SlashCommandItem } from './composer-slash-command';

afterEach(cleanup);

const COMMANDS: SlashCommandItem[] = [
  { name: 'review', description: 'Review the current diff' },
  { name: 'create_plan', description: 'Draft an implementation plan' },
];

describe('ComposerSlashMenu — rows', () => {
  test('renders each command as /name plus its description', () => {
    render(
      <ComposerSlashMenu
        items={COMMANDS}
        query=""
        selectedIndex={0}
        onSelect={() => {}}
        commandsKnown
      />,
    );
    const review = screen.getByTestId('composer-slash-option-review');
    expect(review.textContent).toContain('/review');
    expect(review.textContent).toContain('Review the current diff');
    expect(screen.getByTestId('composer-slash-option-create_plan').textContent).toContain(
      '/create_plan',
    );
  });

  test('the selected row carries aria-selected and the active marker', () => {
    render(
      <ComposerSlashMenu
        items={COMMANDS}
        query=""
        selectedIndex={1}
        onSelect={() => {}}
        commandsKnown
      />,
    );
    expect(screen.getByTestId('composer-slash-option-review').getAttribute('aria-selected')).toBe(
      'false',
    );
    const active = screen.getByTestId('composer-slash-option-create_plan');
    expect(active.getAttribute('aria-selected')).toBe('true');
    expect(active.dataset.active).toBe('true');
  });

  test('mousedown selects (so the editor never loses focus first)', () => {
    const onSelect = vi.fn((_item: SlashCommandItem) => {});
    render(
      <ComposerSlashMenu
        items={COMMANDS}
        query=""
        selectedIndex={0}
        onSelect={onSelect}
        commandsKnown
      />,
    );
    fireEvent.mouseDown(screen.getByTestId('composer-slash-option-create_plan'));
    expect(onSelect).toHaveBeenCalledWith(COMMANDS[1]);
  });
});

describe('ComposerSlashMenu — the three empty states', () => {
  test('null corpus: neutral "not yet announced" copy, never "doesn\'t offer"', () => {
    render(
      <ComposerSlashMenu
        items={[]}
        query=""
        selectedIndex={0}
        onSelect={() => {}}
        commandsKnown={false}
      />,
    );
    const menu = screen.getByTestId('composer-slash-menu');
    expect(menu.textContent).toContain("hasn't announced");
    expect(menu.textContent).not.toContain("doesn't offer");
  });

  test('advertised-empty corpus: honest "doesn\'t offer slash commands"', () => {
    render(
      <ComposerSlashMenu items={[]} query="" selectedIndex={0} onSelect={() => {}} commandsKnown />,
    );
    expect(screen.getByTestId('composer-slash-menu').textContent).toContain(
      "doesn't offer slash commands",
    );
  });

  test('a query with no match reads as "no match", not as no support', () => {
    render(
      <ComposerSlashMenu
        items={[]}
        query="zzz"
        selectedIndex={0}
        onSelect={() => {}}
        commandsKnown
      />,
    );
    const menu = screen.getByTestId('composer-slash-menu');
    expect(menu.textContent).toContain('No matching commands');
    expect(menu.textContent).not.toContain("doesn't offer");
  });
});
