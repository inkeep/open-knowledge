import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type {
  OkDesktopBridge,
  OkPackId,
  OkScaffoldPlan,
  OkSeedPackInfo,
} from '@/lib/desktop-bridge-types';

interface PlanCall {
  packId?: OkPackId;
  rootDir?: string;
  preview?: { skillsInstallable: boolean };
}

const planCalls: PlanCall[] = [];

const plans: Record<string, OkScaffoldPlan> = {
  'knowledge-base': {
    created: [
      { kind: 'folder', path: 'external-sources' },
      { kind: 'file', path: 'external-sources/.ok/templates/clip.md' },
      { kind: 'file', path: 'log.md' },
    ],
    skipped: [],
    warnings: [],
    packSkills: [{ name: 'open-knowledge-pack-knowledge-base', pending: true }],
  },
  'plain-notes': {
    created: [
      { kind: 'folder', path: 'daily' },
      { kind: 'file', path: 'daily/.ok/templates/daily.md' },
    ],
    skipped: [],
    warnings: [],
  },
};

let planFailure: { kind: 'invalid-root' | 'internal'; message: string } | null = null;
let planRejection: Error | null = null;

vi.doMock('@/lib/seed-client', () => ({
  seedClient: () => ({
    plan: async (options: PlanCall) => {
      planCalls.push(options);
      if (planRejection !== null) throw planRejection;
      if (planFailure !== null) {
        return { ok: false as const, error: planFailure };
      }
      const rootDir = options.rootDir;
      const base = plans[options.packId ?? 'knowledge-base'] ?? plans['knowledge-base'];
      if (base === undefined) throw new Error('missing fixture plan');
      if (rootDir === undefined) return { ok: true as const, plan: base };
      return {
        ok: true as const,
        plan: {
          ...base,
          created: base.created.map((entry) => ({ ...entry, path: `${rootDir}/${entry.path}` })),
        },
      };
    },
    apply: async () => ({ ok: true as const, result: { applied: 0, errors: [], durationMs: 1 } }),
    listPacks: async () => ({ ok: true as const, packs: PACKS }),
  }),
}));

vi.doMock('sonner', () => ({
  toast: { error: () => {}, success: () => {}, warning: () => {}, message: () => {} },
}));

const PACKS: OkSeedPackInfo[] = [
  {
    id: 'knowledge-base',
    name: 'Knowledge base',
    description: 'Structured folders for a team wiki.',
    defaultSubfolder: 'brain',
    folders: [{ path: 'external-sources', summary: 'Things you saved.' }],
    entryCounts: { files: 2, folders: 1 },
  },
  {
    id: 'plain-notes',
    name: 'Plain notes',
    description: 'A single flat folder for quick notes.',
    folders: [{ path: 'daily', summary: 'Daily journal.' }],
    entryCounts: { files: 1, folders: 1 },
  },
];

const PARENT = '/Users/test/Projects';

type CreateNewCall = { packId?: string; rootDir?: string; editors: string[] };

function makeBridge(detectedEditorIds: string[] = ['claude']) {
  const createNewCalls: CreateNewCall[] = [];
  const bridge = {
    fs: {
      defaultProjectsRoot: vi.fn(() => Promise.resolve(PARENT)),
      findEnclosingProjectRoot: vi.fn(() => Promise.resolve(null)),
      findEnclosingGitRoot: vi.fn(() => Promise.resolve(null)),
      folderState: vi.fn(() => Promise.resolve('free')),
      removeGitFolder: vi.fn(() => Promise.resolve()),
    },
    dialog: { openFolder: vi.fn(() => Promise.resolve(null)) },
    integrations: {
      status: vi.fn(() =>
        Promise.resolve({
          available: true,
          editors: [],
          path: { shellDetected: false, rcFilesToTouch: [], installed: false },
          skills: [],
          detectedEditorIds,
        }),
      ),
    },
    project: {
      createNew: vi.fn((args: CreateNewCall) => {
        createNewCalls.push(args);
        return Promise.resolve();
      }),
      recordCreateNewBannerShown: vi.fn(() => Promise.resolve()),
      open: vi.fn(() => Promise.resolve()),
    },
  } as unknown as OkDesktopBridge;
  return { bridge, createNewCalls };
}

async function renderDialog(bridge: OkDesktopBridge, initialPackId?: OkPackId) {
  const { CreateProjectDialog } = await import('./CreateProjectDialog');
  render(
    <TooltipProvider>
      <CreateProjectDialog
        open
        onOpenChange={() => {}}
        bridge={bridge}
        initialPackId={initialPackId}
        packs={PACKS}
      />
    </TooltipProvider>,
  );
  await screen.findByTestId('create-project-dialog');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  if (initialPackId !== undefined) {
    fireEvent.click(await screen.findByTestId('create-review-continue'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderDialogAtReview(bridge: OkDesktopBridge, initialPackId: OkPackId) {
  const { CreateProjectDialog } = await import('./CreateProjectDialog');
  render(
    <TooltipProvider>
      <CreateProjectDialog
        open
        onOpenChange={() => {}}
        bridge={bridge}
        initialPackId={initialPackId}
        packs={PACKS}
      />
    </TooltipProvider>,
  );
  await screen.findByTestId('create-review-body');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function clickRadio(id: string) {
  const radio = document.getElementById(id);
  if (radio === null) throw new Error(`no radio ${id}`);
  fireEvent.click(radio);
}

async function submit(name: string) {
  await userEvent.type(screen.getByTestId('create-name'), name);
  await waitFor(() => {
    expect((screen.getByTestId('create-submit') as HTMLButtonElement).disabled).toBe(false);
  });
  fireEvent.click(screen.getByTestId('create-submit'));
}

describe('CreateProjectDialog starter-pack configurator', () => {
  afterEach(() => {
    cleanup();
    planCalls.length = 0;
    planFailure = null;
    planRejection = null;
  });

  test('no pack selected renders no pack UI and no preview request', async () => {
    const { bridge } = makeBridge();
    await renderDialog(bridge);
    expect(screen.queryByTestId('create-pack-section')).toBeNull();
    expect(planCalls).toEqual([]);
  });

  test('previews the pack at the project root, not its default subfolder', async () => {
    const { bridge, createNewCalls } = makeBridge();
    await renderDialog(bridge, 'knowledge-base');

    await waitFor(() => {
      expect(planCalls.length).toBeGreaterThan(0);
    });
    expect(planCalls[0]?.rootDir).toBeUndefined();
    expect(planCalls[0]?.packId).toBe('knowledge-base');
    await waitFor(() => {
      expect(planCalls.at(-1)?.preview).toEqual({ skillsInstallable: true });
    });

    await submit('Wiki');
    await waitFor(() => {
      expect(createNewCalls).toHaveLength(1);
    });
    expect(createNewCalls[0]?.packId).toBe('knowledge-base');
    expect(createNewCalls[0]?.rootDir).toBeUndefined();
  });

  test('choosing a subfolder re-previews there and threads rootDir into createNew', async () => {
    const { bridge, createNewCalls } = makeBridge();
    await renderDialog(bridge, 'knowledge-base');
    await waitFor(() => {
      expect(planCalls.length).toBeGreaterThan(0);
    });

    clickRadio('create-seed-root-subfolder');

    await waitFor(() => {
      expect(planCalls.at(-1)?.rootDir).toBe('brain');
    });

    await submit('Wiki');
    await waitFor(() => {
      expect(createNewCalls).toHaveLength(1);
    });
    expect(createNewCalls[0]?.rootDir).toBe('brain');
  });

  test('reports skills as uninstallable when no editor is selected', async () => {
    const { bridge } = makeBridge([]);
    await renderDialog(bridge, 'knowledge-base');
    await waitFor(() => {
      expect(planCalls.length).toBeGreaterThan(0);
    });
    expect(planCalls.at(-1)?.preview).toEqual({ skillsInstallable: false });
  });

  test('Create stays disabled while the pack preview is in an error state', async () => {
    const { bridge, createNewCalls } = makeBridge();
    planFailure = {
      kind: 'invalid-root',
      message: 'rootDir must be relative to the project directory, got: ../x',
    };
    await renderDialog(bridge, 'knowledge-base');

    await userEvent.type(screen.getByTestId('create-name'), 'Wiki');
    await screen.findByTestId('create-pack-preview-error');

    await expect(
      waitFor(
        () => {
          expect((screen.getByTestId('create-submit') as HTMLButtonElement).disabled).toBe(false);
        },
        { timeout: 1500 },
      ),
    ).rejects.toThrow();

    fireEvent.click(screen.getByTestId('create-submit'));
    expect(createNewCalls).toHaveLength(0);
  });

  test('a preview that cannot be computed at all still lets the project be created', async () => {
    const { bridge, createNewCalls } = makeBridge();
    planFailure = { kind: 'internal', message: 'Failed to fetch' };
    await renderDialogAtReview(bridge, 'knowledge-base');

    await screen.findByTestId('create-pack-preview-error');
    fireEvent.click(screen.getByTestId('create-review-continue'));
    await submit('Wiki');

    await waitFor(() => {
      expect(createNewCalls).toHaveLength(1);
    });
    expect(createNewCalls[0]?.packId).toBe('knowledge-base');
  });

  test('a rejected preview request also leaves the project creatable', async () => {
    const { bridge, createNewCalls } = makeBridge();
    planRejection = new Error("Error invoking remote method 'ok:seed:plan': read ECONNRESET");
    await renderDialogAtReview(bridge, 'knowledge-base');

    const alert = await screen.findByTestId('create-pack-preview-error');
    expect(alert.textContent).not.toContain('ECONNRESET');

    fireEvent.click(screen.getByTestId('create-review-continue'));
    await submit('Wiki');
    await waitFor(() => {
      expect(createNewCalls).toHaveLength(1);
    });
  });

  test('reopening the dialog restores the pack default subfolder', async () => {
    const { bridge } = makeBridge();
    const { CreateProjectDialog } = await import('./CreateProjectDialog');
    const props = { onOpenChange: () => {}, bridge };
    const { rerender } = render(
      <TooltipProvider>
        <CreateProjectDialog open initialPackId="knowledge-base" packs={PACKS} {...props} />
      </TooltipProvider>,
    );
    await screen.findByTestId('create-project-dialog');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(await screen.findByTestId('create-review-continue'));

    clickRadio('create-seed-root-subfolder');
    const field = await screen.findByLabelText('Subfolder name');
    await userEvent.clear(field);
    await userEvent.type(field, 'custom-name');

    rerender(
      <TooltipProvider>
        <CreateProjectDialog open={false} initialPackId={undefined} packs={undefined} {...props} />
      </TooltipProvider>,
    );
    rerender(
      <TooltipProvider>
        <CreateProjectDialog open initialPackId="knowledge-base" packs={PACKS} {...props} />
      </TooltipProvider>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(await screen.findByTestId('create-review-continue'));

    clickRadio('create-seed-root-subfolder');
    expect((await screen.findByLabelText('Subfolder name')).getAttribute('value')).toBe('brain');
  });

  test('an empty subfolder name blocks Create and says why', async () => {
    const { bridge, createNewCalls } = makeBridge();
    await renderDialog(bridge, 'knowledge-base');

    clickRadio('create-seed-root-subfolder');
    await userEvent.clear(await screen.findByLabelText('Subfolder name'));
    await userEvent.type(screen.getByTestId('create-name'), 'Wiki');

    await screen.findByTestId('create-pack-preview-error');
    await expect(
      waitFor(
        () => {
          expect((screen.getByTestId('create-submit') as HTMLButtonElement).disabled).toBe(false);
        },
        { timeout: 1500 },
      ),
    ).rejects.toThrow();

    fireEvent.click(screen.getByTestId('create-submit'));
    expect(createNewCalls).toHaveLength(0);
  });

  test('says where the pack lands when the project is an enclosing git repo', async () => {
    const { bridge } = makeBridge();
    (bridge.fs.findEnclosingGitRoot as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      gitRoot: '/Users/test/code/acme',
    });
    await renderDialog(bridge, 'knowledge-base');

    expect(screen.queryByTestId('create-pack-promoted-note')).toBeNull();
    await userEvent.type(screen.getByTestId('create-name'), 'Team Wiki');

    const note = await screen.findByTestId('create-pack-promoted-note');
    expect(note.textContent).toContain('Team Wiki');
  });

  test('the root chooser is announced with its own heading', async () => {
    const { bridge } = makeBridge();
    await renderDialog(bridge, 'knowledge-base');
    expect(screen.getByRole('radiogroup', { name: /Where should it live/ })).not.toBeNull();
  });

  test('picking a pack moves focus onto the review screen', async () => {
    const { bridge } = makeBridge();
    await renderDialog(bridge, 'knowledge-base');
    fireEvent.click(screen.getByTestId('create-change-pack'));

    await userEvent.click(screen.getByRole('button', { name: /Plain notes/ }));

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('create-review-continue'));
    });
  });

  test('continuing from review moves focus into the form', async () => {
    const { bridge } = makeBridge();
    await renderDialogAtReview(bridge, 'knowledge-base');

    fireEvent.click(screen.getByTestId('create-review-continue'));

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('create-name'));
    });
  });

  test('opening on review focuses the primary action, not Change pack', async () => {
    const { bridge } = makeBridge();
    await renderDialogAtReview(bridge, 'knowledge-base');

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('create-review-continue'));
    });
    expect(document.activeElement).not.toBe(screen.getByTestId('create-change-pack'));
  });

  test('Change pack moves focus into the grid it opens', async () => {
    const { bridge } = makeBridge();
    await renderDialog(bridge, 'knowledge-base');

    fireEvent.click(screen.getByTestId('create-change-pack'));

    await waitFor(() => {
      const cards = document.querySelectorAll('[data-slot="pack-card"]');
      expect(cards.length).toBeGreaterThan(0);
      expect(document.activeElement).toBe(cards[0]);
    });
  });

  test('each step announces itself to assistive tech', async () => {
    const { bridge } = makeBridge();
    await renderDialogAtReview(bridge, 'knowledge-base');

    expect(screen.getByTestId('create-step-announcer').textContent).toContain('Reviewing');

    fireEvent.click(screen.getByTestId('create-review-continue'));
    await waitFor(() => {
      expect(screen.getByTestId('create-step-announcer').textContent).toContain('Project details');
    });
  });

  test('a typed project name survives a trip out to the grid and back', async () => {
    const { bridge } = makeBridge();
    await renderDialog(bridge, 'knowledge-base');

    await userEvent.type(screen.getByTestId('create-name'), 'Team Wiki');
    fireEvent.click(screen.getByTestId('create-change-pack'));
    await userEvent.click(await screen.findByRole('button', { name: /Plain notes/ }));
    fireEvent.click(await screen.findByTestId('create-review-continue'));

    expect((await screen.findByTestId('create-name')).getAttribute('value')).toBe('Team Wiki');
  });

  test('an unresolved pack id opens the grid rather than a half-built review', async () => {
    const { bridge } = makeBridge();
    const { CreateProjectDialog } = await import('./CreateProjectDialog');
    render(
      <TooltipProvider>
        <CreateProjectDialog
          open
          onOpenChange={() => {}}
          bridge={bridge}
          initialPackId={'no-such-pack' as OkPackId}
          packs={PACKS}
        />
      </TooltipProvider>,
    );
    await screen.findByTestId('create-project-dialog');

    await screen.findByRole('button', { name: /Plain notes/ });
    expect(screen.queryByTestId('create-review-continue')).toBeNull();
  });

  test('switching packs from the grid does not strand review on a subfolder error', async () => {
    const { bridge } = makeBridge();
    await renderDialog(bridge, 'knowledge-base');

    clickRadio('create-seed-root-subfolder');
    await waitFor(() => {
      expect(planCalls.at(-1)?.rootDir).toBe('brain');
    });

    fireEvent.click(screen.getByTestId('create-change-pack'));
    await userEvent.click(await screen.findByRole('button', { name: /Plain notes/ }));

    await screen.findByTestId('create-review-body');
    expect(screen.queryByTestId('create-pack-preview-error')).toBeNull();
    await screen.findByText('daily/');
  });

  test('re-picking the same pack from the grid keeps the subfolder choice', async () => {
    const { bridge } = makeBridge();
    await renderDialog(bridge, 'knowledge-base');

    clickRadio('create-seed-root-subfolder');
    await waitFor(() => {
      expect(planCalls.at(-1)?.rootDir).toBe('brain');
    });

    fireEvent.click(screen.getByTestId('create-change-pack'));
    await userEvent.click(await screen.findByRole('button', { name: /Knowledge base/ }));

    await screen.findByTestId('create-review-body');
    fireEvent.click(screen.getByTestId('create-review-continue'));
    await screen.findByTestId('create-project-form');

    expect(
      document.getElementById('create-seed-root-subfolder')?.getAttribute('aria-checked'),
    ).toBe('true');
    await waitFor(() => {
      expect(planCalls.at(-1)?.rootDir).toBe('brain');
    });
  });

  test('the grid has no route back to review — only Cancel, which closes', async () => {
    const onOpenChange = vi.fn(() => {});
    const { bridge } = makeBridge();
    const { CreateProjectDialog } = await import('./CreateProjectDialog');
    render(
      <TooltipProvider>
        <CreateProjectDialog
          open
          onOpenChange={onOpenChange}
          bridge={bridge}
          initialPackId="knowledge-base"
          packs={PACKS}
        />
      </TooltipProvider>,
    );
    await screen.findByTestId('create-review-body');

    expect(screen.queryByTestId('create-cancel')).toBeNull();
    fireEvent.click(screen.getByTestId('create-change-pack'));

    await screen.findByRole('button', { name: /Plain notes/ });
    expect(screen.queryByTestId('create-change-pack')).toBeNull();

    fireEvent.click(screen.getByTestId('create-cancel'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('the configure screen names the skills the AI-tools box decides', async () => {
    const { bridge } = makeBridge();
    await renderDialog(bridge, 'knowledge-base');

    const note = await screen.findByTestId('create-pack-skills-note');
    expect(note.textContent).toContain('1 skill');
    expect(note.textContent).toContain('installs');

    await userEvent.click(screen.getByRole('checkbox'));

    await waitFor(() => {
      const after = screen.getByTestId('create-pack-skills-note');
      expect(after.textContent).toContain('1 skill');
      expect(after.textContent).toContain("won't be installed");
    });
  });

  test('the manifest renders on review and not on the configure screen', async () => {
    const { bridge } = makeBridge();
    await renderDialogAtReview(bridge, 'knowledge-base');

    await screen.findByText('external-sources/');

    fireEvent.click(screen.getByTestId('create-review-continue'));
    await screen.findByTestId('create-name');
    expect(screen.queryByText('external-sources/')).toBeNull();
  });

  test('Change pack swaps the configured pack without leaving the dialog', async () => {
    const { bridge, createNewCalls } = makeBridge();
    await renderDialog(bridge, 'knowledge-base');
    await waitFor(() => {
      expect(planCalls.length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByTestId('create-change-pack'));
    expect(screen.queryByTestId('create-submit')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /Plain notes/ }));

    await waitFor(() => {
      expect(planCalls.at(-1)?.packId).toBe('plain-notes');
    });
    await screen.findByText('daily/');

    fireEvent.click(screen.getByTestId('create-review-continue'));
    await submit('Notes');
    await waitFor(() => {
      expect(createNewCalls).toHaveLength(1);
    });
    expect(createNewCalls[0]?.packId).toBe('plain-notes');
  });
});
