/**
 * RTL mount test: the property-delta block shown above the prose diff in both
 * diff panes.
 *
 * The load-bearing contracts are that change kind survives without color (a
 * screen reader and a monochrome display must both distinguish added from
 * removed), that a complex value routes to the shared preview widget rather
 * than stringifying to `[object Object]`, and that an unparseable region says
 * so instead of rendering as "no changes".
 *
 * Invocation: `pnpm run test:dom` from `packages/app/`.
 */

import type { FrontmatterDelta, PropertyChange } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

const { PropertyDiffBlock } = await import('./PropertyDiffBlock');

function delta(changes: PropertyChange[]): FrontmatterDelta {
  return { changes, unparseable: null };
}

function rows(): HTMLElement[] {
  return screen.queryAllByTestId('property-diff-row');
}

afterEach(() => {
  cleanup();
});

describe('PropertyDiffBlock', () => {
  test('renders nothing when there are no changes', () => {
    const { container } = render(<PropertyDiffBlock delta={delta([])} />);
    expect(container.firstChild).toBeNull();
  });

  test('renders one row per change, keyed by property name', () => {
    render(
      <PropertyDiffBlock
        delta={delta([
          { key: 'status', kind: 'changed', before: 'draft', after: 'ready' },
          { key: 'reviewer', kind: 'added', after: 'shagun' },
          { key: 'due', kind: 'removed', before: '2026-08-01' },
        ])}
      />,
    );
    expect(rows()).toHaveLength(3);
    expect(rows().map((row) => row.getAttribute('data-key'))).toEqual([
      'status',
      'reviewer',
      'due',
    ]);
  });

  test('shows both sides of a changed scalar', () => {
    render(
      <PropertyDiffBlock
        delta={delta([{ key: 'status', kind: 'changed', before: 'draft', after: 'ready' }])}
      />,
    );
    expect(screen.getByText('draft')).toBeTruthy();
    expect(screen.getByText('ready')).toBeTruthy();
  });

  // Color alone would leave the kind unreadable to a screen reader and to anyone
  // who cannot distinguish the hues.
  test('conveys change kind as text, not only as color', () => {
    render(
      <PropertyDiffBlock
        delta={delta([
          { key: 'reviewer', kind: 'added', after: 'shagun' },
          { key: 'due', kind: 'removed', before: '2026-08-01' },
          { key: 'status', kind: 'changed', before: 'draft', after: 'ready' },
        ])}
      />,
    );
    expect(screen.getByText('Added')).toBeTruthy();
    expect(screen.getByText('Removed')).toBeTruthy();
    expect(screen.getByText('Changed')).toBeTruthy();
  });

  test('marks every row as a change-stepper anchor', () => {
    const { container } = render(
      <PropertyDiffBlock
        delta={delta([
          { key: 'status', kind: 'changed', before: 'draft', after: 'ready' },
          { key: 'reviewer', kind: 'added', after: 'shagun' },
        ])}
      />,
    );
    expect(container.querySelectorAll('[data-property-change]')).toHaveLength(2);
  });

  test('renders a list value as its entries, not as [object Object]', () => {
    render(
      <PropertyDiffBlock
        delta={delta([{ key: 'tags', kind: 'added', after: ['alpha', 'beta'] }])}
      />,
    );
    expect(screen.getByText('alpha, beta')).toBeTruthy();
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  });

  test('routes a nested object through the shared complex-value preview', () => {
    render(
      <PropertyDiffBlock
        delta={delta([
          {
            key: 'meta',
            kind: 'changed',
            before: { owner: 'shagun', tier: '1' },
            after: { owner: 'shagun', tier: '2' },
          },
        ])}
      />,
    );
    expect(rows()).toHaveLength(1);
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
    expect(screen.getByTestId('property-diff-change-pair')).toBeTruthy();
  });

  test('truncates a very long value but keeps the full text reachable', () => {
    const long = 'x'.repeat(500);
    render(<PropertyDiffBlock delta={delta([{ key: 'note', kind: 'added', after: long }])} />);
    const value = screen.getByTestId('property-diff-value');
    expect(value.textContent?.length).toBeLessThan(long.length);
    expect(value.getAttribute('title')).toBe(long);
  });

  test('summarizes changes past the render cap instead of listing all of them', () => {
    const many: PropertyChange[] = Array.from({ length: 60 }, (_, i) => ({
      key: `key${i}`,
      kind: 'added',
      after: String(i),
    }));
    render(<PropertyDiffBlock delta={delta(many)} />);
    expect(rows()).toHaveLength(50);
    expect(screen.getByText('10 more property changes not shown')).toBeTruthy();
  });

  // Silence here would be indistinguishable from "nothing changed" on exactly
  // the version worth inspecting.
  test('says so when the region could not be parsed, and shows both raw sides', () => {
    render(
      <PropertyDiffBlock
        delta={{
          changes: [],
          unparseable: { before: '---\nstatus: draft\n---\n', after: '---\nstatus: [oops\n---\n' },
        }}
      />,
    );
    expect(screen.getByTestId('property-diff-unparseable')).toBeTruthy();
    expect(screen.getByText(/could not be compared/)).toBeTruthy();
    expect(screen.getByText(/status: draft/)).toBeTruthy();
    expect(screen.getByText(/status: \[oops/)).toBeTruthy();
  });
});
