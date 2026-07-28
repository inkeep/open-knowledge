import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

async function renderContextMenu() {
  const {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
  } = await import('./context-menu');

  render(
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button type="button">Target</button>
      </ContextMenuTrigger>
      <ContextMenuContent forceMount={true}>
        <ContextMenuItem>Open</ContextMenuItem>
        <ContextMenuSub open={true}>
          <ContextMenuSubTrigger>More</ContextMenuSubTrigger>
          <ContextMenuSubContent forceMount={true}>
            <ContextMenuItem>Nested</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>,
  );

  await act(async () => {
    fireEvent.contextMenu(screen.getByText('Target'));
    await Promise.resolve();
  });
}

describe('ContextMenu runtime class contracts', () => {
  afterEach(() => cleanup());

  test('exports the full ContextMenu API surface', async () => {
    const mod = await import('./context-menu');
    for (const name of [
      'ContextMenu',
      'ContextMenuCheckboxItem',
      'ContextMenuContent',
      'ContextMenuGroup',
      'ContextMenuItem',
      'ContextMenuLabel',
      'ContextMenuPortal',
      'ContextMenuRadioGroup',
      'ContextMenuRadioItem',
      'ContextMenuSeparator',
      'ContextMenuShortcut',
      'ContextMenuSub',
      'ContextMenuSubContent',
      'ContextMenuSubTrigger',
      'ContextMenuTrigger',
    ]) {
      expect(typeof (mod as Record<string, unknown>)[name]).toBe('function');
    }
  });

  test.each([
    'context-menu-content',
    'context-menu-sub-content',
  ] as const)('%s carries keyframe motion and reduced-motion opt-in at runtime', async (slot) => {
    await renderContextMenu();

    const surface = document.querySelector(`[data-slot="${slot}"]`);
    expect(surface).toBeTruthy();
    const className = surface?.getAttribute('class') ?? '';

    expectVisualClassTokens(className, [
      ...UPSTREAM_MOTION_TOKENS,
      'origin-(--radix-context-menu-content-transform-origin)',
      ...A11Y_OPT_IN,
    ]);
  });

  test('subtrigger keeps its open-state highlight classes at runtime', async () => {
    await renderContextMenu();

    const trigger = document.querySelector('[data-slot="context-menu-sub-trigger"]');
    expectVisualClassTokens(trigger?.getAttribute('class'), [
      'data-open:bg-accent',
      'data-open:text-accent-foreground',
    ]);
  });

  test('snappy transition tier and long-form state drift do not return', async () => {
    await renderContextMenu();

    const surfaces = [
      ...document.querySelectorAll(
        '[data-slot="context-menu-content"], [data-slot="context-menu-sub-content"], [data-slot="context-menu-sub-trigger"]',
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
