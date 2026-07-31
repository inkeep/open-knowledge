/**
 * `SkillsBasePage` is the Skills home. These tests pin its own wiring: the shared
 * empty-state header + create composer (with the `skill` scenario), the three add
 * actions and where each one lands, the popular shelf's three states, and the two
 * conditions that remove the composer. The heavy children (the composer, the lazy
 * modal) are stubbed, as is the popular-skills query — the page's job is deciding
 * what renders, not fetching.
 *
 * Runs under `bun run test:dom` (jsdom). `<Trans>` resolves against the global
 * i18n activated by `tests/lingui-macro-preload.ts`.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The shared composer: a stub that surfaces the scenario so we can assert the
// Skills home hands it the `skill` framing (author via open-knowledge-write-skill).
vi.doMock('@/components/empty-state/CreatePromptComposer', () => ({
  CreatePromptComposer: ({ scenario }: { scenario: string }) => (
    <div data-testid="create-composer" data-scenario={scenario} />
  ),
}));
vi.doMock('@/components/ImportSkillDialog', () => ({
  ImportSkillDialog: ({ open, defaultTab }: { open: boolean; defaultTab?: string }) =>
    open ? <div data-testid="import-skill-modal" data-tab={defaultTab} /> : null,
}));
let embedded = false;
vi.doMock('@/hooks/use-is-embedded', () => ({ useIsEmbedded: () => embedded }));
// Project skills drive the "Added" badge via `findImportedSkill`; empty by default.
let projectSkills: unknown[] = [];
vi.doMock('@/hooks/use-skills', () => ({
  useSkills: () => ({ status: 'ready', data: projectSkills }),
}));
// `useOpenSkill` reads `useDocumentContext` at render, so stub it (the page isn't
// wrapped in a DocumentProvider here — we're testing its own wiring, not nav).
vi.doMock('@/hooks/use-open-skill', () => ({ useOpenSkill: () => () => {} }));
const createBlank = vi.fn(async () => {});
vi.doMock('@/hooks/use-create-blank-skill', () => ({
  useCreateBlankSkill: () => ({ createBlank, creating: false }),
}));
// The shared react-query hook, stubbed so each test drives the shelf's state
// directly rather than through a QueryClientProvider.
let popularState: { skills: unknown[]; isPending: boolean; failed: boolean } = {
  skills: [],
  isPending: false,
  failed: false,
};
vi.doMock('@/hooks/use-popular-skills', () => ({ usePopularSkills: () => popularState }));

const { SkillsBasePage } = await import('./SkillsBasePage.tsx');

/** A skills.sh discovery result, shaped as `/api/skills/popular` returns them. */
function popularResult(n: number) {
  return {
    id: `r${n}`,
    name: `skill-${n}`,
    description: `Does thing ${n}.`,
    source: `owner/skill-${n}`,
    publisher: 'owner',
    installs: 1200,
  };
}

function loaded(count: number) {
  return {
    skills: Array.from({ length: count }, (_, i) => popularResult(i)),
    isPending: false,
    failed: false,
  };
}

describe('SkillsBasePage', () => {
  beforeEach(() => {
    createBlank.mockClear();
    embedded = false;
    projectSkills = [];
    popularState = { skills: [], isPending: false, failed: false };
  });
  afterEach(cleanup);

  test('reuses the shared header + composer (skill scenario) and the three add actions', () => {
    render(<SkillsBasePage />);
    expect(screen.getByRole('heading', { name: 'Create a skill.' })).not.toBeNull();
    expect(screen.getByTestId('create-composer').getAttribute('data-scenario')).toBe('skill');
    expect(screen.getByTestId('skill-source-upload')).not.toBeNull();
    expect(screen.getByTestId('skill-source-new')).not.toBeNull();
    expect(screen.getByTestId('skill-source-skills-sh')).not.toBeNull();
  });

  test.each([
    ['skill-source-skills-sh', 'skills-sh'],
    ['skill-source-upload', 'upload'],
  ])('%s opens the add-skill modal on the %s tab', async (testId, expectedTab) => {
    render(<SkillsBasePage />);
    expect(screen.queryByTestId('import-skill-modal')).toBeNull();
    fireEvent.click(screen.getByTestId(testId));
    await waitFor(() => expect(screen.getByTestId('import-skill-modal')).not.toBeNull());
    expect(screen.getByTestId('import-skill-modal').getAttribute('data-tab')).toBe(expectedTab);
  });

  test('Browse all in the shelf header opens the Explore tab too', async () => {
    popularState = loaded(2);
    render(<SkillsBasePage />);
    fireEvent.click(screen.getByTestId('skill-popular-browse-all'));
    await waitFor(() => expect(screen.getByTestId('import-skill-modal')).not.toBeNull());
    expect(screen.getByTestId('import-skill-modal').getAttribute('data-tab')).toBe('skills-sh');
  });

  test('New from scratch direct-creates a blank skill (no modal)', () => {
    render(<SkillsBasePage />);
    fireEvent.click(screen.getByTestId('skill-source-new'));
    expect(createBlank).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('import-skill-modal')).toBeNull();
  });

  test('renders at most six popular skills through the shared directory card', () => {
    popularState = loaded(12);
    render(<SkillsBasePage />);
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
    expect(screen.getByText('skill-0')).not.toBeNull();
    expect(screen.queryByText('skill-6')).toBeNull();
  });

  // Option-3 guarantee: a skills.sh outage takes the shelf but never the page's
  // path into the directory.
  test('hides the shelf when skills.sh returns nothing but keeps Browse skills.sh', () => {
    popularState = { skills: [], isPending: false, failed: true };
    render(<SkillsBasePage />);
    expect(screen.queryByTestId('skills-popular')).toBeNull();
    expect(screen.getByTestId('skill-source-skills-sh')).not.toBeNull();
    expect(screen.getByTestId('skill-source-upload')).not.toBeNull();
  });

  // Browse all is the only focusable control inside a section that disappears on
  // a failed fetch, so it must not exist until the cards do — otherwise a
  // keyboard user on it when the failure lands has focus dropped to the body.
  test('withholds Browse all while the fetch is pending, then shows it', () => {
    popularState = { skills: [], isPending: true, failed: false };
    const { unmount } = render(<SkillsBasePage />);
    expect(screen.getByTestId('skills-popular')).not.toBeNull();
    expect(screen.queryByTestId('skill-popular-browse-all')).toBeNull();
    unmount();

    popularState = loaded(2);
    render(<SkillsBasePage />);
    expect(screen.getByTestId('skill-popular-browse-all')).not.toBeNull();
  });

  test('marks an already-imported skill as Added', () => {
    popularState = loaded(1);
    projectSkills = [{ name: 'skill-0', scope: 'project', origin: { source: 'owner/skill-0' } }];
    render(<SkillsBasePage />);
    expect(screen.getByText('Added')).not.toBeNull();
  });

  test('still resolves Added through a collision rename', () => {
    popularState = loaded(1);
    projectSkills = [
      { name: 'skill-0-imported-2', scope: 'project', origin: { source: 'owner/skill-0' } },
    ];
    render(<SkillsBasePage />);
    expect(screen.getByText('Added')).not.toBeNull();
  });

  // Both conditions that remove the composer: an open sessions dock already
  // carries a dispatch affordance, and embedded OK would loop the handoff back.
  test.each([
    ['an open sessions dock', () => render(<SkillsBasePage sessionsDockOpen />)],
    [
      'embedded OK',
      () => {
        embedded = true;
        return render(<SkillsBasePage />);
      },
    ],
  ])('drops the composer for %s while keeping the add actions', (_label, doRender) => {
    doRender();
    expect(screen.queryByTestId('create-composer')).toBeNull();
    expect(screen.getByTestId('skill-source-upload')).not.toBeNull();
    expect(screen.getByTestId('skill-source-new')).not.toBeNull();
    expect(screen.getByTestId('skill-source-skills-sh')).not.toBeNull();
  });
});
