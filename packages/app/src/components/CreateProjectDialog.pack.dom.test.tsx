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

// The create-new dialog's pack half: the same configurator the in-project seed
// dialog shows (root chooser + live preview), planned against a project that
// does not exist yet. Everything here is about what the user sees before
// clicking Create and what that click sends.

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

// When set, `plan()` fails with this error kind. `invalid-root` is what the
// real handler answers for a rootDir the planner rejects (`../x`, `/x`);
// `internal` stands in for a preview that could not be computed at all.
let planFailure: { kind: 'invalid-root' | 'internal'; message: string } | null = null;
// When set, `plan()` rejects instead of resolving — the IPC bridge itself
// failing, which is a structurally different path from a resolved `ok: false`.
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
}

/** Radix renders the radio as a button; the label wraps a whole Field, so the
 *  id is the stable handle. */
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
    // `knowledge-base` declares `defaultSubfolder: 'brain'`; the pack still
    // previews (and seeds) at the project root until the user says otherwise.
    expect(planCalls[0]?.rootDir).toBeUndefined();
    expect(planCalls[0]?.packId).toBe('knowledge-base');
    // The editor-detection probe is a round-trip: the first preview goes out
    // before it lands, and the re-plan once it does is what reports the pack's
    // skills as installable.
    await waitFor(() => {
      expect(planCalls.at(-1)?.preview).toEqual({ skillsInstallable: true });
    });

    await screen.findByText('external-sources/');

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

    // The pack's `defaultSubfolder` pre-filled the input, so the re-plan uses it.
    await waitFor(() => {
      expect(planCalls.at(-1)?.rootDir).toBe('brain');
    });
    await screen.findByText('external-sources/');

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
    // A subfolder the planner rejects ('../x', '/x') is non-empty, so the
    // empty-name guard lets it through. With no preview gate the user can
    // submit: runCreateNew's best-effort catch swallows the SeedRootDirError
    // and the project opens with no pack and no error shown.
    const { bridge, createNewCalls } = makeBridge();
    planFailure = {
      kind: 'invalid-root',
      message: 'rootDir must be relative to the project directory, got: ../x',
    };
    await renderDialog(bridge, 'knowledge-base');

    await userEvent.type(screen.getByTestId('create-name'), 'Wiki');
    await screen.findByTestId('create-pack-preview-error');

    // Bounded absence check: everything else that gates Create (the cascade
    // probe, the name) settles well inside this window, so if the preview gate
    // is missing the button flips to enabled here.
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
    // The counterpart to the rejected-rootDir case: an internal or transport
    // failure is not something the user can fix by editing the form, and the
    // pack is secondary to creating the project — so Create must stay live
    // rather than stranding them on a permanently disabled button.
    const { bridge, createNewCalls } = makeBridge();
    planFailure = { kind: 'internal', message: 'Failed to fetch' };
    await renderDialog(bridge, 'knowledge-base');

    await screen.findByTestId('create-pack-preview-error');
    await submit('Wiki');

    await waitFor(() => {
      expect(createNewCalls).toHaveLength(1);
    });
    expect(createNewCalls[0]?.packId).toBe('knowledge-base');
  });

  test('a rejected preview request also leaves the project creatable', async () => {
    // The sibling of the case above, and a structurally separate branch: this
    // is the IPC bridge rejecting rather than the handler answering `ok:false`.
    // Both must stay non-blocking, and they can diverge independently.
    const { bridge, createNewCalls } = makeBridge();
    planRejection = new Error("Error invoking remote method 'ok:seed:plan': read ECONNRESET");
    await renderDialog(bridge, 'knowledge-base');

    const alert = await screen.findByTestId('create-pack-preview-error');
    // The raw transport string is a console concern, not something to put in
    // front of someone who can still create their project.
    expect(alert.textContent).not.toContain('ECONNRESET');

    await submit('Wiki');
    await waitFor(() => {
      expect(createNewCalls).toHaveLength(1);
    });
  });

  test('reopening the dialog restores the pack default subfolder', async () => {
    // Closing goes through NavigatorApp's onOpenChange, which clears both the
    // pending pack and the pack list; reopening re-supplies the same array
    // instance. A subfolder typed into a cancelled attempt must not survive
    // that round trip and reach createNew unnoticed.
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

    clickRadio('create-seed-root-subfolder');
    expect((await screen.findByLabelText('Subfolder name')).getAttribute('value')).toBe('brain');
  });

  test('an empty subfolder name blocks Create and says why', async () => {
    // Distinct from the rejected-rootDir case: an empty name never reaches the
    // planner, so the guard has to be local to the form.
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
    // The project becomes the repo, not the folder being created, so "project
    // root" would read as the repo's top level. Main anchors the pack at the
    // new folder; the dialog has to say so.
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
    // Without the association the radios are announced with no group context —
    // "project root" and "in a subfolder" on their own say nothing about what
    // is being placed.
    const { bridge } = makeBridge();
    await renderDialog(bridge, 'knowledge-base');
    expect(screen.getByRole('radiogroup', { name: /Where should it live/ })).not.toBeNull();
  });

  test('picking a pack moves focus into the form', async () => {
    // The clicked card unmounts with the grid, so without an explicit move
    // focus lands on the body and a keyboard user loses their place.
    const { bridge } = makeBridge();
    await renderDialog(bridge, 'knowledge-base');
    fireEvent.click(screen.getByTestId('create-change-pack'));

    await userEvent.click(screen.getByRole('button', { name: /Plain notes/ }));

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('create-name'));
    });
  });

  test('Change pack swaps the configured pack without leaving the dialog', async () => {
    const { bridge, createNewCalls } = makeBridge();
    await renderDialog(bridge, 'knowledge-base');
    await waitFor(() => {
      expect(planCalls.length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByTestId('create-change-pack'));
    // The grid replaces the form; no Create until a pack is picked again.
    expect(screen.queryByTestId('create-submit')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /Plain notes/ }));

    await waitFor(() => {
      expect(planCalls.at(-1)?.packId).toBe('plain-notes');
    });
    await screen.findByText('daily/');

    await submit('Notes');
    await waitFor(() => {
      expect(createNewCalls).toHaveLength(1);
    });
    expect(createNewCalls[0]?.packId).toBe('plain-notes');
  });
});
