import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactNode } from 'react';
import type { OkPackId, OkSeedListPacksResult, OkSeedPackInfo } from '@/lib/desktop-bridge-types';

let listPacksImpl: () => Promise<OkSeedListPacksResult> = async () => ({
  ok: true,
  packs: [],
});
const listPacksCalls: string[] = [];

mock.module('@lingui/core/macro', () => ({
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace('#', String(count)),
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((out, part, index) => `${out}${part}${values[index] ?? ''}`, ''),
}));

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((out, part, index) => `${out}${part}${values[index] ?? ''}`, ''),
  }),
}));

mock.module('@/lib/seed-client', () => ({
  seedClient: () => ({
    listPacks: () => {
      listPacksCalls.push('listPacks');
      return listPacksImpl();
    },
  }),
}));

const packIds: OkPackId[] = [
  'knowledge-base',
  'software-lifecycle',
  'plain-notes',
  'worldbuilding',
  'writing-pipeline',
  'gbrain',
];

function makePack(id: OkPackId, index: number): OkSeedPackInfo {
  return {
    id,
    name: `Pack ${index + 1}`,
    description: `Starter pack ${index + 1}`,
    folders: [{ path: `folder-${index + 1}`, summary: 'Folder' }],
    entryCounts: { files: index, folders: index + 1 },
  };
}

const allPacks = packIds.map(makePack);

async function renderPackCardGrid(
  props: Partial<ComponentProps<typeof import('./PackCardGrid')['PackCardGrid']>> = {},
) {
  const { PackCardGrid } = await import('./PackCardGrid');
  const selected: OkPackId[] = [];
  render(<PackCardGrid onPackSelect={(packId) => selected.push(packId)} {...props} />);
  return { selected };
}

describe('PackCardGrid runtime behavior', () => {
  afterEach(() => {
    cleanup();
    listPacksCalls.length = 0;
    listPacksImpl = async () => ({ ok: true, packs: [] });
  });

  test('exports the component', async () => {
    const mod = await import('./PackCardGrid');
    expect(typeof mod.PackCardGrid).toBe('function');
  });

  test('renders caller-provided packs as keyboard-accessible cards and skips internal fetch', async () => {
    const { selected } = await renderPackCardGrid({ packs: allPacks });

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(allPacks.length);
    expect(listPacksCalls).toEqual([]);
    for (const [index, button] of buttons.entries()) {
      expect(button.textContent).toContain(allPacks[index].name);
      expect(button.textContent).toContain(allPacks[index].description);
      expect(button.querySelector('svg')).not.toBeNull();
    }

    await userEvent.click(buttons[0]);
    expect(selected).toEqual(['knowledge-base']);
  });

  test('omits the blank-file card when onCreateBlankFile is not provided', async () => {
    await renderPackCardGrid({ packs: allPacks });

    expect(screen.getAllByRole('button')).toHaveLength(allPacks.length);
    expect(screen.queryByText(/create a new file/)).toBeNull();
  });

  test('renders a create-a-new-file footer button and fires the callback on click', async () => {
    const onCreateBlankFile = mock(() => {});
    await renderPackCardGrid({ packs: allPacks, onCreateBlankFile });

    const buttons = screen.getAllByRole('button');
    // One footer button after every pack card (no Show more without collapsedPackIds).
    expect(buttons).toHaveLength(allPacks.length + 1);
    const footerButton = buttons.at(-1);
    expect(footerButton?.textContent).toContain('create a new file');

    await userEvent.click(footerButton as HTMLElement);
    expect(onCreateBlankFile).toHaveBeenCalledTimes(1);
  });

  test('parks collapsedPackIds behind a Show more toggle and appends them when expanded', async () => {
    // Hide plain-notes (Pack 3) and gbrain (Pack 6); the other four stay visible.
    await renderPackCardGrid({ packs: allPacks, collapsedPackIds: ['plain-notes', 'gbrain'] });

    // Collapsed: the two hidden packs are absent; a Show more toggle is present.
    expect(screen.queryByText('Pack 3')).toBeNull();
    expect(screen.queryByText('Pack 6')).toBeNull();
    const toggle = screen.getByRole('button', { name: /Show 2 more/ });

    await userEvent.click(toggle);

    // Expanded: hidden packs render appended after the visible set (registry
    // order preserved within each group), and the toggle flips to Show less.
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual([
      'Pack 1',
      'Pack 2',
      'Pack 4',
      'Pack 5',
      'Pack 3',
      'Pack 6',
    ]);
    const collapseToggle = screen.getByRole('button', { name: /Show less/ });

    await userEvent.click(collapseToggle);
    expect(screen.queryByText('Pack 3')).toBeNull();
    expect(screen.getByRole('button', { name: /Show 2 more/ })).not.toBeNull();
  });

  test('renders the loading skeleton when caller-owned packs are still null', async () => {
    await renderPackCardGrid({ packs: null });

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.getAttribute('aria-label')).toBe('Loading starter packs');
    expect(status.querySelectorAll('[class*="animate-pulse"]').length).toBeGreaterThanOrEqual(6);
    expect(listPacksCalls).toEqual([]);
  });

  test('renders an empty state for an empty pack list', async () => {
    await renderPackCardGrid({ packs: [] });

    expect(screen.getByRole('status').textContent).toContain('No starter packs available.');
  });

  test('self-fetches packs when caller omits the packs prop', async () => {
    listPacksImpl = async () => ({ ok: true, packs: [allPacks[0]] });

    await act(async () => {
      await renderPackCardGrid();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole('button').textContent).toContain('Pack 1');
    });
    expect(listPacksCalls).toEqual(['listPacks']);
  });

  test('surfaces self-fetch failures as an alert', async () => {
    listPacksImpl = async () => ({
      ok: false,
      error: { kind: 'internal', message: 'registry unavailable' },
    });

    await act(async () => {
      await renderPackCardGrid();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('registry unavailable');
    });
  });
});
