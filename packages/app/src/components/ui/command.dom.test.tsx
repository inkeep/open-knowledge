import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

describe('CommandDialog runtime contracts', () => {
  afterEach(() => cleanup());

  test('exports the full Command API surface', async () => {
    const mod = await import('./command');
    for (const name of [
      'Command',
      'CommandDialog',
      'CommandEmpty',
      'CommandGroup',
      'CommandInput',
      'CommandItem',
      'CommandList',
      'CommandSeparator',
      'CommandShortcut',
    ]) {
      expect(typeof (mod as Record<string, unknown>)[name]).toBe('function');
    }
  });

  test('top-anchors the dialog content at runtime', async () => {
    const { CommandDialog, CommandInput, CommandList } = await import('./command');

    render(
      <CommandDialog open={true} showCloseButton={false}>
        <CommandInput placeholder="Search" />
        <CommandList />
      </CommandDialog>,
    );

    const content = document.querySelector('[data-slot="dialog-content"]');
    expect(content).toBeTruthy();
    const className = content?.getAttribute('class') ?? '';
    expectVisualClassTokens(className, ['top-[12vh]', 'translate-y-0', 'overflow-hidden', 'p-0']);
    expectVisualClassTokensAbsent(className, ['top-1/2', '-translate-y-1/2']);
  });

  test('does not expose a returned snappy placement tier on runtime surfaces', async () => {
    const { CommandDialog, CommandInput, CommandList } = await import('./command');

    render(
      <CommandDialog open={true} showCloseButton={false}>
        <CommandInput placeholder="Search" />
        <CommandList />
      </CommandDialog>,
    );

    const surfaces = [
      ...document.querySelectorAll('[data-slot="dialog-content"], [data-slot="command"]'),
    ]
      .map((el) => el.getAttribute('class') ?? '')
      .join(' ');

    for (const token of ['transition-[opacity,scale]', 'placement-', 'data-placement']) {
      expect(surfaces).not.toContain(token);
    }
  });

  async function renderTwoItemCommand(vimBindings?: boolean) {
    const { Command, CommandInput, CommandItem, CommandList } = await import('./command');
    render(
      <Command {...(vimBindings === undefined ? {} : { vimBindings })}>
        <CommandInput placeholder="Search" />
        <CommandList>
          <CommandItem value="alpha">alpha</CommandItem>
          <CommandItem value="beta">beta</CommandItem>
        </CommandList>
      </Command>,
    );
    const input = document.querySelector('[data-slot="command-input"]') as HTMLElement;
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    return input;
  }

  const selectedValue = () =>
    document.querySelector('[data-slot="command-item"][data-selected="true"]')?.textContent;
  const selectedItemId = () =>
    document.querySelector('[data-slot="command-item"][data-selected="true"]')?.id;

  test('cmdk moves the selection on Ctrl+P when vim bindings are left at their default', async () => {
    const input = await renderTwoItemCommand();
    expect(selectedValue()).toBe('beta');

    fireEvent.keyDown(input, { key: 'p', ctrlKey: true });

    expect(selectedValue()).toBe('alpha');
  });

  test('opting out of vim bindings leaves the selection untouched on Ctrl+P', async () => {
    const input = await renderTwoItemCommand(false);
    expect(selectedValue()).toBe('beta');

    fireEvent.keyDown(input, { key: 'p', ctrlKey: true });

    expect(selectedValue()).toBe('beta');
  });

  async function renderDeferredFilterCommand(
    rows: readonly string[],
    onRun: (row: string) => void,
  ) {
    const { Command, CommandGroup, CommandInput, CommandItem, CommandList } = await import(
      './command'
    );
    const { useDeferredValue, useState } = await import('react');
    function DeferredFilterCommand() {
      const [query, setQuery] = useState('');
      const deferredQuery = useDeferredValue(query).toLowerCase();
      return (
        <Command shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder="Search" />
          <CommandList>
            <CommandGroup heading="Commands">
              {rows
                .filter((row) => row.toLowerCase().includes(deferredQuery))
                .map((row) => (
                  <CommandItem key={row} value={row} onSelect={() => onRun(row)}>
                    {row}
                  </CommandItem>
                ))}
            </CommandGroup>
          </CommandList>
        </Command>
      );
    }
    render(<DeferredFilterCommand />);
    return document.querySelector('[data-slot="command-input"]') as HTMLInputElement;
  }

  test('a query that hides the selected row and its neighbours selects the first remaining row, and Enter runs it', async () => {
    const onRun = vi.fn();
    const input = await renderDeferredFilterCommand(
      ['New file', 'New folder', 'Report a bug', 'Settings', 'Report history'],
      onRun,
    );
    expect(selectedValue()).toBe('New file');

    await act(async () => {
      fireEvent.change(input, { target: { value: 'report' } });
    });

    expect(selectedValue()).toBe('Report a bug');
    expect(input.getAttribute('aria-activedescendant')).toBe(selectedItemId());
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRun).toHaveBeenCalledExactlyOnceWith('Report a bug');
  });

  test('a query that moves a better row above the surviving selection selects the new top row, and Enter runs it', async () => {
    const { Command, CommandInput, CommandItem, CommandList, useSelectFirstItemOn } = await import(
      './command'
    );
    const { useDeferredValue, useRef, useState } = await import('react');
    const onRun = vi.fn();
    const rows = [
      { label: 'Open graph', keywords: 'show' },
      { label: 'Show hidden files', keywords: '' },
    ];
    function RankedCommand() {
      const [query, setQuery] = useState('');
      const deferredQuery = useDeferredValue(query).toLowerCase();
      const ranked = rows
        .filter((row) => `${row.label} ${row.keywords}`.toLowerCase().includes(deferredQuery))
        .map((row) => ({ row, rank: row.label.toLowerCase().includes(deferredQuery) ? 0 : 1 }))
        .sort((a, b) => a.rank - b.rank);
      const listRef = useRef<HTMLDivElement>(null);
      useSelectFirstItemOn(listRef, deferredQuery);
      return (
        <Command shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder="Search" />
          <CommandList ref={listRef}>
            {ranked.map(({ row }) => (
              <CommandItem key={row.label} value={row.label} onSelect={() => onRun(row.label)}>
                {row.label}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      );
    }
    render(<RankedCommand />);
    const input = document.querySelector('[data-slot="command-input"]') as HTMLInputElement;
    expect(selectedValue()).toBe('Open graph');

    await act(async () => {
      fireEvent.change(input, { target: { value: 'show' } });
    });

    expect(selectedValue()).toBe('Show hidden files');
    expect(input.getAttribute('aria-activedescendant')).toBe(selectedItemId());
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRun).toHaveBeenCalledExactlyOnceWith('Show hidden files');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(selectedValue()).toBe('Open graph');
  });

  test('removing rows around a selected row that survives leaves the selection where it was', async () => {
    const { Command, CommandInput, CommandItem, CommandList } = await import('./command');
    function RowList({ rows }: { rows: readonly string[] }) {
      return (
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search" />
          <CommandList>
            {rows.map((row) => (
              <CommandItem key={row} value={row}>
                {row}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      );
    }
    const { rerender } = render(<RowList rows={['alpha', 'beta', 'gamma', 'delta']} />);
    const input = document.querySelector('[data-slot="command-input"]') as HTMLElement;
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(selectedValue()).toBe('beta');

    await act(async () => {
      rerender(<RowList rows={['alpha', 'beta']} />);
    });

    expect(selectedValue()).toBe('beta');
    expect(input.getAttribute('aria-activedescendant')).toBe(selectedItemId());
  });
});
