import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

mock.module('@lingui/react/macro', () => ({
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
});
