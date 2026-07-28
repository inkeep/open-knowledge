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
  'data-[align-trigger=true]:animate-none',
] as const;

const POPPER_COLLISION_OFFSETS = [
  'data-[side=bottom]:translate-y-1',
  'data-[side=left]:-translate-x-1',
  'data-[side=right]:translate-x-1',
  'data-[side=top]:-translate-y-1',
] as const;

const SNAPPY_TOKENS = [
  'transition-[opacity,scale]',
  'ease-(--ease-out-strong)',
  'starting:opacity-0',
  'starting:scale-95',
  'data-closed:duration-0',
  'FORKED FROM radix-nova',
] as const;

async function renderSelectContent() {
  const { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } = await import(
    './select'
  );

  await act(async () => {
    render(
      <Select open={true} value="one">
        <SelectTrigger>
          <SelectValue placeholder="Choose" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="one">One</SelectItem>
        </SelectContent>
      </Select>,
    );
    await Promise.resolve();
  });
}

describe('Select runtime class contracts', () => {
  afterEach(() => cleanup());

  test('exports the full Select API surface', async () => {
    const mod = await import('./select');
    for (const name of [
      'Select',
      'SelectContent',
      'SelectGroup',
      'SelectItem',
      'SelectLabel',
      'SelectScrollDownButton',
      'SelectScrollUpButton',
      'SelectSeparator',
      'SelectTrigger',
      'SelectValue',
    ]) {
      expect(typeof (mod as Record<string, unknown>)[name]).toBe('function');
    }
  });

  test('content carries keyframe motion, reduced-motion opt-in, and trigger-origin pivot', async () => {
    await renderSelectContent();

    const content = document.querySelector('[data-slot="select-content"]');
    expect(content).toBeTruthy();
    expect(content?.getAttribute('data-ok-layer-spawned')).toBe('');
    const className = content?.getAttribute('class') ?? '';

    expectVisualClassTokens(className, [
      ...UPSTREAM_MOTION_TOKENS,
      'origin-(--radix-select-content-transform-origin)',
      ...A11Y_OPT_IN,
    ]);
  });

  test('position=popper preserves the collision-offset runtime classes', async () => {
    await renderSelectContent();

    const className =
      document.querySelector('[data-slot="select-content"]')?.getAttribute('class') ?? '';
    expectVisualClassTokens(className, POPPER_COLLISION_OFFSETS);
  });

  test('snappy transition tier and long-form state drift do not return', async () => {
    await renderSelectContent();

    const className =
      document.querySelector('[data-slot="select-content"]')?.getAttribute('class') ?? '';

    expectVisualClassTokensAbsent(className, SNAPPY_TOKENS);
    expect(className).not.toMatch(/data-\[state=(?:open|closed)\]:(?:animate|fade|zoom|slide)/);
  });
});
