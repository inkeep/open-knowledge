import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { OkScaffoldPlan, OkSeedPackInfo } from '@/lib/desktop-bridge-types';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

vi.doMock('@lingui/core/macro', () => ({
  ...actualLinguiMacro,
  t: renderLinguiTemplate,
  msg: renderLinguiTemplate,
  plural: (value: number, options: { one: string; other: string }) =>
    (value === 1 ? options.one : options.other).replace('#', String(value)),
}));

function pack(folders: Array<{ path: string; summary: string }>): OkSeedPackInfo {
  return {
    id: 'knowledge-base',
    name: 'Knowledge base',
    description: 'Trusted articles.',
    folders,
    entryCounts: { files: 0, folders: folders.length },
  };
}

async function renderList(plan: OkScaffoldPlan, selectedPack: OkSeedPackInfo) {
  const { CreatedItemsList } = await import('./CreatedItemsList');
  // Folder rows with templates render a tooltip trigger, which needs the
  // TooltipProvider the app installs at its root (main.tsx).
  render(
    <TooltipProvider>
      <CreatedItemsList plan={plan} selectedPack={selectedPack} />
    </TooltipProvider>,
  );
}

/** The folder-count summary span renders as `<n> <label>` (e.g. "3 folders"). */
function folderCountText(): string | null | undefined {
  const label = screen.queryByText(/^folders?$/);
  return label?.parentElement?.textContent;
}

describe('CreatedItemsList — cards + count derivation', () => {
  afterEach(cleanup);

  test('subfolder mode: the parent folder gets no card and the count matches the cards', async () => {
    // Subfolder scaffold into `brain/`: the plan creates the parent folder plus
    // each pack folder nested under it. The parent is a real folder entry with
    // no card, so the count must track the 3 cards, not the 4 created folders.
    const plan: OkScaffoldPlan = {
      created: [
        { kind: 'folder', path: 'brain' },
        { kind: 'folder', path: 'brain/external-sources' },
        { kind: 'folder', path: 'brain/research' },
        { kind: 'folder', path: 'brain/articles' },
        { kind: 'file', path: 'brain/external-sources/.ok/templates/clip.md' },
      ],
      skipped: [],
      warnings: [],
    };
    await renderList(
      plan,
      pack([
        { path: 'external-sources', summary: 'Sources.' },
        { path: 'research', summary: 'Research.' },
        { path: 'articles', summary: 'Articles.' },
      ]),
    );

    expect(screen.getByText('external-sources/')).toBeTruthy();
    // The parent subfolder is created but is not one of the pack's folders, so
    // it must not appear as a card.
    expect(screen.queryByText('brain/')).toBeNull();
    // Count reflects the 3 cards, not the 4 created folder entries.
    expect(folderCountText()).toBe('3 folders');
  });

  test('a fully-present folder (not in created) is dropped from cards and the count', async () => {
    const plan: OkScaffoldPlan = {
      created: [
        { kind: 'folder', path: 'notes' },
        { kind: 'file', path: 'notes/.ok/templates/note.md' },
      ],
      skipped: [],
      warnings: [],
    };
    // `daily` ships in the pack but isn't in `created` (already present) → no card.
    await renderList(
      plan,
      pack([
        { path: 'notes', summary: 'Notes.' },
        { path: 'daily', summary: 'Daily.' },
      ]),
    );

    expect(screen.getByText('notes/')).toBeTruthy();
    expect(screen.queryByText('daily/')).toBeNull();
    expect(folderCountText()).toBe('1 folder');
  });

  test('template-only reinstall (no folder entry) still shows the folder card', async () => {
    // Re-scaffold where the folder already exists: only its templates are in
    // `created`. `describeFolderCards` keys off the template path, so the card
    // still renders.
    const plan: OkScaffoldPlan = {
      created: [{ kind: 'file', path: 'notes/.ok/templates/note.md' }],
      skipped: [],
      warnings: [],
    };
    await renderList(plan, pack([{ path: 'notes', summary: 'Notes.' }]));

    expect(screen.getByText('notes/')).toBeTruthy();
    expect(folderCountText()).toBe('1 folder');
  });

  test('template files under .ok/ do not render as file cards', async () => {
    // `describeFileCards` filters out `.ok/` paths so template files never
    // surface as user-facing file cards — only the root file does.
    const plan: OkScaffoldPlan = {
      created: [
        { kind: 'folder', path: 'notes' },
        { kind: 'file', path: 'notes/.ok/templates/note.md' },
        { kind: 'file', path: 'log.md' },
      ],
      skipped: [],
      warnings: [],
    };
    await renderList(plan, pack([{ path: 'notes', summary: 'Notes.' }]));

    expect(screen.getByText('log.md')).toBeTruthy();
    expect(screen.queryByText('note.md')).toBeNull();
  });
});

describe('CreatedItemsList — required plugins', () => {
  /**
   * The disclosure these rows exist for. A user who turned a plugin off and
   * then seeds a pack that requires it gets it back on; this is where they are
   * told so. Asserting the row is present is the whole point — a silent
   * re-enable is the failure mode.
   */
  test('a pending required plugin renders with its label and an undo pointer', async () => {
    const plan: OkScaffoldPlan = {
      created: [],
      skipped: [],
      warnings: [],
      requiredPlugins: [{ id: 'okf', pending: true }],
    };
    await renderList(plan, pack([]));

    // Named by its settings label, not its raw id, so it matches the toggle the
    // user will go looking for.
    expect(screen.getByText('OKF')).toBeTruthy();
    // And the row says the choice remains theirs.
    expect(screen.getByText(/turn it off any time in settings/i)).toBeTruthy();
  });

  test('an already-enabled required plugin renders no row', async () => {
    // Nothing changed for it, so there is nothing to explain — showing it would
    // be noise under a "what gets created" heading.
    const plan: OkScaffoldPlan = {
      created: [{ kind: 'file', path: 'log.md' }],
      skipped: [],
      warnings: [],
      requiredPlugins: [{ id: 'okf', pending: false }],
    };
    await renderList(plan, pack([]));

    expect(screen.queryByText('OKF')).toBeNull();
  });
});
