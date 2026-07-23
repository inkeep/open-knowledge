import { cleanup, render } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

const A11Y_OPT_IN = [
  'motion-reduce:data-open:animate-none',
  'motion-reduce:data-closed:animate-none',
  'motion-reduce:duration-0',
] as const;

const UPSTREAM_MOTION_TOKENS = [
  'duration-100',
  'data-open:animate-in',
  'data-open:fade-in-0',
  'data-open:zoom-in-95',
  'data-closed:animate-out',
  'data-closed:fade-out-0',
  'data-closed:zoom-out-95',
  'data-[side=bottom]:slide-in-from-top-2',
  'data-[side=left]:slide-in-from-right-2',
  'data-[side=right]:slide-in-from-left-2',
  'data-[side=top]:slide-in-from-bottom-2',
] as const;

const SNAPPY_TOKENS = [
  'transition-[opacity,scale]',
  'ease-(--ease-out-strong)',
  'starting:opacity-0',
  'starting:scale-95',
  'data-closed:duration-0',
  'FORKED FROM radix-nova',
] as const;

async function renderDropdownMenu() {
  const {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
  } = await import('./dropdown-menu');

  await act(async () => {
    render(
      <DropdownMenu open={true}>
        <DropdownMenuTrigger>Target</DropdownMenuTrigger>
        <DropdownMenuContent forceMount={true}>
          <DropdownMenuItem>Open</DropdownMenuItem>
          <DropdownMenuSub open={true}>
            <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent forceMount={true}>
              <DropdownMenuItem>Nested</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await Promise.resolve();
  });
}

describe('DropdownMenu runtime class contracts', () => {
  afterEach(() => cleanup());

  test('exports the full DropdownMenu API surface', async () => {
    const mod = await import('./dropdown-menu');
    for (const name of [
      'DropdownMenu',
      'DropdownMenuCheckboxItem',
      'DropdownMenuContent',
      'DropdownMenuGroup',
      'DropdownMenuItem',
      'DropdownMenuLabel',
      'DropdownMenuPortal',
      'DropdownMenuRadioGroup',
      'DropdownMenuRadioItem',
      'DropdownMenuSeparator',
      'DropdownMenuShortcut',
      'DropdownMenuSub',
      'DropdownMenuSubContent',
      'DropdownMenuSubTrigger',
      'DropdownMenuTrigger',
    ]) {
      expect(typeof (mod as Record<string, unknown>)[name]).toBe('function');
    }
  });

  test.each([
    'dropdown-menu-content',
    'dropdown-menu-sub-content',
  ] as const)('%s carries keyframe motion and reduced-motion opt-in at runtime', async (slot) => {
    await renderDropdownMenu();

    const surface = document.querySelector(`[data-slot="${slot}"]`);
    expect(surface).toBeTruthy();
    const className = surface?.getAttribute('class') ?? '';

    expectVisualClassTokens(className, [
      ...UPSTREAM_MOTION_TOKENS,
      'origin-(--radix-dropdown-menu-content-transform-origin)',
      ...A11Y_OPT_IN,
    ]);
  });

  test('content keeps its closed-state overflow clip and subtrigger highlight classes', async () => {
    await renderDropdownMenu();

    const content = document.querySelector('[data-slot="dropdown-menu-content"]');
    expectVisualClassTokens(content?.getAttribute('class'), [
      'data-[state=closed]:overflow-hidden',
    ]);

    const trigger = document.querySelector('[data-slot="dropdown-menu-sub-trigger"]');
    expectVisualClassTokens(trigger?.getAttribute('class'), [
      'data-open:bg-accent',
      'data-open:text-accent-foreground',
    ]);
  });

  test('snappy transition tier and long-form state drift do not return', async () => {
    await renderDropdownMenu();

    const surfaces = [
      ...document.querySelectorAll(
        '[data-slot="dropdown-menu-content"], [data-slot="dropdown-menu-sub-content"], [data-slot="dropdown-menu-sub-trigger"]',
      ),
    ]
      .map((el) => el.getAttribute('class') ?? '')
      .join(' ');

    expectVisualClassTokensAbsent(surfaces, SNAPPY_TOKENS);
    expect(surfaces).not.toMatch(
      /data-\[state=(?:open|closed)\]:(?:animate|fade|zoom|slide|bg|text)/,
    );
  });
});
