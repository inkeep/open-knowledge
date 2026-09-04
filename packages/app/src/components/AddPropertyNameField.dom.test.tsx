import type { FrontmatterType } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { type AddPropertyFieldSuggestion, AddPropertyNameField } from './AddPropertyNameField';

const FIELDS: AddPropertyFieldSuggestion[] = [
  { name: 'status', type: 'text', required: true, description: 'Lifecycle stage' },
  { name: 'tags', type: 'list', required: false },
  { name: 'reviewedAt', type: 'date', required: false },
];

function Harness({
  suggestions = FIELDS,
  autoFocus = false,
  onPick = () => {},
  onCommit = () => {},
  onCancel = () => {},
}: {
  suggestions?: readonly AddPropertyFieldSuggestion[];
  autoFocus?: boolean;
  onPick?: (s: AddPropertyFieldSuggestion) => void;
  onCommit?: () => void;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <AddPropertyNameField
      rowId="row-1"
      value={value}
      suggestions={suggestions}
      inputRef={inputRef}
      autoFocus={autoFocus}
      error={false}
      onChange={setValue}
      onPick={(suggestion) => {
        setValue(suggestion.name);
        onPick(suggestion);
      }}
      onCommit={onCommit}
      onCancel={onCancel}
    />
  );
}

function input(): HTMLInputElement {
  return screen.getByTestId('add-property-name-input');
}

function options(): HTMLElement[] {
  return screen.queryAllByTestId('add-property-field-suggestion');
}

afterEach(() => cleanup());

describe('AddPropertyNameField — schema field picker', () => {
  test('a row that mounts focused shows the list without a keystroke', async () => {
    render(<Harness autoFocus />);
    await waitFor(() => expect(options()).toHaveLength(3));
  });

  test('a row that mounts focused with no schema opens nothing', async () => {
    render(<Harness autoFocus suggestions={[]} />);
    expect(options()).toHaveLength(0);
  });

  test('focusing offers every declared field', async () => {
    render(<Harness />);
    await userEvent.click(input());
    await waitFor(() => expect(options()).toHaveLength(3));
    expect(options().map((el) => el.getAttribute('data-key'))).toEqual([
      'status',
      'tags',
      'reviewedAt',
    ]);
  });

  test('typing narrows the list case-insensitively', async () => {
    render(<Harness />);
    await userEvent.click(input());
    await userEvent.type(input(), 'TAG');
    await waitFor(() => expect(options()).toHaveLength(1));
    expect(options()[0]?.getAttribute('data-key')).toBe('tags');
  });

  test('picking supplies the name and the schema type together', async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    await userEvent.click(input());
    await waitFor(() => expect(options().length).toBeGreaterThan(0));

    const tags = options().find((el) => el.getAttribute('data-key') === 'tags');
    if (!tags) throw new Error('no `tags` option');
    await userEvent.click(tags);

    expect(onPick).toHaveBeenCalledTimes(1);
    const picked = onPick.mock.calls[0]?.[0] as AddPropertyFieldSuggestion;
    expect(picked.name).toBe('tags');
    expect(picked.type satisfies FrontmatterType).toBe('list');
    expect(input().value).toBe('tags');
  });

  test('picking closes the list', async () => {
    render(<Harness />);
    await userEvent.click(input());
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    await userEvent.click(options()[0] as HTMLElement);
    await waitFor(() => expect(options()).toHaveLength(0));
  });

  test('arrow keys move the highlight and Enter takes it', async () => {
    const onPick = vi.fn();
    const onCommit = vi.fn();
    render(<Harness onPick={onPick} onCommit={onCommit} />);
    await userEvent.click(input());
    await waitFor(() => expect(options().length).toBeGreaterThan(0));

    await userEvent.keyboard('{ArrowDown}{Enter}');

    expect(onPick).toHaveBeenCalledTimes(1);
    expect((onPick.mock.calls[0]?.[0] as AddPropertyFieldSuggestion).name).toBe('status');
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('ArrowDown then ArrowDown reaches the second option', async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    await userEvent.click(input());
    await waitFor(() => expect(options().length).toBeGreaterThan(0));

    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect((onPick.mock.calls[0]?.[0] as AddPropertyFieldSuggestion).name).toBe('tags');
  });

  test('ArrowUp enters the list at the last option', async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    await userEvent.click(input());
    await waitFor(() => expect(options().length).toBeGreaterThan(0));

    await userEvent.keyboard('{ArrowUp}{Enter}');

    expect((onPick.mock.calls[0]?.[0] as AddPropertyFieldSuggestion).name).toBe('reviewedAt');
  });

  test('typing after arrowing into the list drops back out of it', async () => {
    const onCommit = vi.fn();
    const onPick = vi.fn();
    render(<Harness onCommit={onCommit} onPick={onPick} />);
    await userEvent.click(input());
    await waitFor(() => expect(options().length).toBeGreaterThan(0));

    await userEvent.keyboard('{ArrowDown}');
    await userEvent.type(input(), 'stat');
    await userEvent.keyboard('{Enter}');

    expect(onPick).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(input().value).toBe('stat');
  });

  test('arrow navigation scrolls the highlighted option into view', async () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    try {
      render(<Harness />);
      await userEvent.click(input());
      await waitFor(() => expect(options().length).toBeGreaterThan(0));
      scrollIntoView.mockClear();

      await userEvent.keyboard('{ArrowDown}');

      expect(scrollIntoView).toHaveBeenCalled();
    } finally {
      scrollIntoView.mockRestore();
    }
  });

  test('Enter commits a free-typed name the schema does not declare', async () => {
    const onCommit = vi.fn();
    const onPick = vi.fn();
    render(<Harness onCommit={onCommit} onPick={onPick} />);
    await userEvent.click(input());
    await userEvent.type(input(), 'notInSchema');
    await userEvent.keyboard('{Enter}');

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  test('Enter commits a name that merely contains a declared field name', async () => {
    const onCommit = vi.fn();
    const onPick = vi.fn();
    render(<Harness onCommit={onCommit} onPick={onPick} />);
    await userEvent.click(input());
    await userEvent.type(input(), 'tag');
    await waitFor(() => expect(options()).toHaveLength(1));

    await userEvent.keyboard('{Enter}');

    expect(onPick).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(input().value).toBe('tag');
    await waitFor(() => expect(options()).toHaveLength(0));
  });

  test('Enter keeps the typed casing of a name a field declares differently', async () => {
    const onCommit = vi.fn();
    const onPick = vi.fn();
    render(<Harness onCommit={onCommit} onPick={onPick} />);
    await userEvent.click(input());
    await userEvent.type(input(), 'STATUS');
    await waitFor(() => expect(options()).toHaveLength(1));

    await userEvent.keyboard('{Enter}');

    expect(onPick).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(input().value).toBe('STATUS');
  });

  test('Enter on an exactly-typed field name commits rather than re-picking it', async () => {
    const onCommit = vi.fn();
    const onPick = vi.fn();
    render(<Harness onCommit={onCommit} onPick={onPick} />);
    await userEvent.click(input());
    await userEvent.type(input(), 'tags');
    await userEvent.keyboard('{Enter}');

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  test('an arrow key stays native when an exact name has closed the list', async () => {
    render(<Harness />);
    await userEvent.click(input());
    await userEvent.type(input(), 'tags');
    await waitFor(() => expect(options()).toHaveLength(0));

    expect(fireEvent.keyDown(input(), { key: 'ArrowDown' })).toBe(true);
    expect(fireEvent.keyDown(input(), { key: 'ArrowUp' })).toBe(true);
    expect(options()).toHaveLength(0);
  });

  test('Escape closes the list before it abandons the row', async () => {
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} />);
    await userEvent.click(input());
    await waitFor(() => expect(options().length).toBeGreaterThan(0));

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(options()).toHaveLength(0));
    expect(onCancel).not.toHaveBeenCalled();

    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('the input keeps focus while the list is open', async () => {
    render(<Harness />);
    await userEvent.click(input());
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    expect(document.activeElement).toBe(input());
  });

  test('with no declared fields it is a plain text input', async () => {
    render(<Harness suggestions={[]} />);
    await userEvent.click(input());
    await userEvent.type(input(), 'anything');
    expect(options()).toHaveLength(0);
    expect(input().getAttribute('role')).toBeNull();
    expect(input().getAttribute('aria-expanded')).toBeNull();
    expect(input().value).toBe('anything');
  });

  test('the open list is announced as a combobox popup', async () => {
    render(<Harness />);
    await userEvent.click(input());
    await waitFor(() => expect(options().length).toBeGreaterThan(0));

    expect(input().getAttribute('role')).toBe('combobox');
    expect(input().getAttribute('aria-expanded')).toBe('true');
    expect(input().getAttribute('aria-autocomplete')).toBe('list');
    const listboxId = input().getAttribute('aria-controls');
    expect(listboxId).toBeTruthy();
    expect(document.getElementById(listboxId ?? '')?.getAttribute('role')).toBe('listbox');
    expect(input().getAttribute('aria-activedescendant')).toBeNull();
    expect(options().some((el) => el.getAttribute('aria-selected') === 'true')).toBe(false);

    await userEvent.keyboard('{ArrowDown}');

    const activeId = input().getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    expect(document.getElementById(activeId ?? '')?.getAttribute('aria-selected')).toBe('true');
  });

  test('hovering an option makes it the one Enter takes', async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    await userEvent.click(input());
    await waitFor(() => expect(options().length).toBeGreaterThan(0));

    const tags = options().find((el) => el.getAttribute('data-key') === 'tags');
    if (!tags) throw new Error('no `tags` option');
    await userEvent.hover(tags);
    await userEvent.keyboard('{Enter}');

    expect((onPick.mock.calls[0]?.[0] as AddPropertyFieldSuggestion).name).toBe('tags');
  });

  test('a required field is marked in the list', async () => {
    render(<Harness />);
    await userEvent.click(input());
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    const status = options().find((el) => el.getAttribute('data-key') === 'status');
    expect(status?.textContent).toContain('required');
    expect(status?.textContent).toContain('Lifecycle stage');
  });
});
