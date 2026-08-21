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
  // A caller-supplied pack now lands on the review screen, which is a gate in
  // front of the form. These tests are about the form, so step through it. The
  // review screen has its own tests below.
  if (initialPackId !== undefined) {
    fireEvent.click(await screen.findByTestId('create-review-continue'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Renders with a pack and stops on the review screen, for tests about review
 *  itself rather than the form behind it. */
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
    await renderDialogAtReview(bridge, 'knowledge-base');

    // The error annotates the manifest, so it surfaces on the review screen.
    await screen.findByTestId('create-pack-preview-error');
    fireEvent.click(screen.getByTestId('create-review-continue'));
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
    await renderDialogAtReview(bridge, 'knowledge-base');

    const alert = await screen.findByTestId('create-pack-preview-error');
    // The raw transport string is a console concern, not something to put in
    // front of someone who can still create their project.
    expect(alert.textContent).not.toContain('ECONNRESET');

    fireEvent.click(screen.getByTestId('create-review-continue'));
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

  test('picking a pack moves focus onto the review screen', async () => {
    // The clicked card unmounts with the grid, so without an explicit move
    // focus lands on the body and a keyboard user loses their place. Picking
    // now advances to review, so its continue button is the target.
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
    // The launcher-chip path opens straight on review. Each screen mounts its
    // own body, so a focus target belonging to another screen is null here and
    // the call silently no-ops — leaving the browser to take the first tabbable
    // node, which is Change pack: the control that discards the chosen pack.
    const { bridge } = makeBridge();
    await renderDialogAtReview(bridge, 'knowledge-base');

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('create-review-continue'));
    });
    expect(document.activeElement).not.toBe(screen.getByTestId('create-change-pack'));
  });

  test('Change pack moves focus into the grid it opens', async () => {
    // Same hazard in the other direction: the button unmounts with its own
    // step, so without a handoff focus falls to the document body.
    const { bridge } = makeBridge();
    await renderDialog(bridge, 'knowledge-base');

    fireEvent.click(screen.getByTestId('create-change-pack'));

    // Assert WHICH element took focus, not merely that something did — a
    // `!== document.body` check passes for any stray tabbable node.
    await waitFor(() => {
      const cards = document.querySelectorAll('[data-slot="pack-card"]');
      expect(cards.length).toBeGreaterThan(0);
      expect(document.activeElement).toBe(cards[0]);
    });
  });

  test('each step announces itself to assistive tech', async () => {
    // The dialog stays mounted across steps, so Radix's one-shot announcement
    // on open does not cover the transitions.
    const { bridge } = makeBridge();
    await renderDialogAtReview(bridge, 'knowledge-base');

    expect(screen.getByTestId('create-step-announcer').textContent).toContain('Reviewing');

    fireEvent.click(screen.getByTestId('create-review-continue'));
    await waitFor(() => {
      expect(screen.getByTestId('create-step-announcer').textContent).toContain('Project details');
    });
  });

  test('a typed project name survives a trip out to the grid and back', async () => {
    // Change pack is not destructive: only closing the dialog resets the form.
    // Re-picking from the grid returns to the form with the name still there.
    const { bridge } = makeBridge();
    await renderDialog(bridge, 'knowledge-base');

    await userEvent.type(screen.getByTestId('create-name'), 'Team Wiki');
    fireEvent.click(screen.getByTestId('create-change-pack'));
    await userEvent.click(await screen.findByRole('button', { name: /Plain notes/ }));
    fireEvent.click(await screen.findByTestId('create-review-continue'));

    expect((await screen.findByTestId('create-name')).getAttribute('value')).toBe('Team Wiki');
  });

  test('an unresolved pack id opens the grid rather than a half-built review', async () => {
    // The review body needs a resolved pack; the footer only reads the step. An
    // id that matches nothing would pair the configure form with review's
    // buttons, so the step derivation checks the id resolves, not just exists.
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
    // `rootChoice` is a form choice, not a pack property, so it survives a pack
    // switch — but `subfolder` is re-defaulted from the incoming pack. Switch
    // from a pack that declares a default to one that does not, while "In a
    // subfolder" is selected, and the subfolder goes empty: the preview turns
    // into a BLOCKING error and review renders that instead of the manifest,
    // with no field on screen to fix it.
    const { bridge } = makeBridge();
    await renderDialog(bridge, 'knowledge-base');

    clickRadio('create-seed-root-subfolder');
    await waitFor(() => {
      expect(planCalls.at(-1)?.rootDir).toBe('brain');
    });

    fireEvent.click(screen.getByTestId('create-change-pack'));
    await userEvent.click(await screen.findByRole('button', { name: /Plain notes/ }));

    // Review must show what the pack adds, not a form error it cannot resolve.
    await screen.findByTestId('create-review-body');
    expect(screen.queryByTestId('create-pack-preview-error')).toBeNull();
    await screen.findByText('daily/');
  });

  test('re-picking the same pack from the grid keeps the subfolder choice', async () => {
    // The cross-pack switch above resets `rootChoice` because the incoming
    // pack re-defaults `subfolder`, which can leave it empty and blocking.
    // Re-picking the pack already selected re-defaults nothing, so the reset
    // has nothing to protect against and only destroys the user's choice —
    // "Change pack" is supposed to be non-destructive.
    const { bridge } = makeBridge();
    await renderDialog(bridge, 'knowledge-base');

    clickRadio('create-seed-root-subfolder');
    await waitFor(() => {
      expect(planCalls.at(-1)?.rootDir).toBe('brain');
    });

    fireEvent.click(screen.getByTestId('create-change-pack'));
    await userEvent.click(await screen.findByRole('button', { name: /Knowledge base/ }));

    // Back through review to the form the choice was made on.
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
    // A prior revision gave review and the grid a Back apiece pointing at each
    // other, so a chip user bounced between two screens with no way out. One
    // named action ("Change pack") with one destination (the grid), and the
    // grid's only secondary closes outright.
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

    // Review offers Change pack, and no Cancel of its own.
    expect(screen.queryByTestId('create-cancel')).toBeNull();
    fireEvent.click(screen.getByTestId('create-change-pack'));

    // On the grid: no Change pack (already there), and Cancel closes rather
    // than returning to review.
    await screen.findByRole('button', { name: /Plain notes/ });
    expect(screen.queryByTestId('create-change-pack')).toBeNull();

    fireEvent.click(screen.getByTestId('create-cancel'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('the configure screen names the skills the AI-tools box decides', async () => {
    // The review screen already counted these skills; the box that decides
    // whether they install is a screen later. Unticking has to visibly cancel
    // them rather than silently subtracting from a number already read.
    const { bridge } = makeBridge();
    await renderDialog(bridge, 'knowledge-base');

    const note = await screen.findByTestId('create-pack-skills-note');
    expect(note.textContent).toContain('1 skill');
    expect(note.textContent).toContain('installs');

    // Untick "Connect AI tools" — the count stays, the consequence flips.
    await userEvent.click(screen.getByRole('checkbox'));

    await waitFor(() => {
      const after = screen.getByTestId('create-pack-skills-note');
      expect(after.textContent).toContain('1 skill');
      expect(after.textContent).toContain("won't be installed");
    });
  });

  test('the manifest renders on review and not on the configure screen', async () => {
    // The whole point of the split: the configure screen carries only inputs
    // the user can act on, and the pack's contents are read once, before it.
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
    // The grid replaces the form; no Create until a pack is picked again.
    expect(screen.queryByTestId('create-submit')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /Plain notes/ }));

    await waitFor(() => {
      expect(planCalls.at(-1)?.packId).toBe('plain-notes');
    });
    // Re-picking re-enters review, so the swapped pack's manifest is read there.
    await screen.findByText('daily/');

    fireEvent.click(screen.getByTestId('create-review-continue'));
    await submit('Notes');
    await waitFor(() => {
      expect(createNewCalls).toHaveLength(1);
    });
    expect(createNewCalls[0]?.packId).toBe('plain-notes');
  });
});
