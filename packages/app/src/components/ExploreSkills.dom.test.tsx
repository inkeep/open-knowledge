/**
 * The Explore tab's Open Knowledge toggle: it fills the SAME grid from our repo
 * rather than linking out, and it is exclusive with the topic chips (they search
 * the directory; this reads one publisher's repo, so the two can't stack).
 *
 * Runs under `pnpm run test:dom` (jsdom). `<Trans>` resolves against the global
 * i18n activated by `tests/lingui-macro-preload.ts`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

const discoverSkillsInSource = vi.fn(async () => ({
  ok: true as const,
  skills: [
    { name: 'knowledge-base', description: 'Starter pack.' },
    { name: 'open-knowledge', description: 'The runtime contract.' },
  ],
}));
const fetchPublisherSkills = vi.fn(async () => ({
  ok: true as const,
  results: [
    {
      id: 'x',
      name: 'knowledge-base',
      source: 'inkeep/open-knowledge-skills',
      description: '',
      installs: 21,
      publisher: 'inkeep',
    },
    {
      id: 'y',
      name: 'open-knowledge',
      source: 'inkeep/open-knowledge-skills',
      description: '',
      installs: 478,
      publisher: 'inkeep',
    },
  ],
  backend: 'skills.sh' as const,
  degraded: false,
}));
const searchSkills = vi.fn(async () => ({
  ok: true as const,
  results: [] as Array<Record<string, unknown>>,
  backend: 'skills.sh' as const,
  degraded: false,
}));
vi.doMock('@/lib/skills-api', () => ({
  discoverSkillsInSource,
  fetchPublisherSkills,
  searchSkills,
}));
vi.doMock('@/hooks/use-popular-skills', () => ({
  usePopularSkills: () => ({ skills: [], isPending: false, failed: false }),
}));
vi.doMock('@/hooks/use-skill-directory', () => ({
  useSkillDirectory: () => ({ importedEntry: () => undefined, openResult: () => {} }),
}));

const { ExploreSkills } = await import('./ExploreSkills.tsx');

afterEach(cleanup);

function renderExplore() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ExploreSkills />
    </QueryClientProvider>,
  );
}

describe('ExploreSkills — Open Knowledge toggle', () => {
  test('fills the grid from our repo, ranked by installs, in place', async () => {
    renderExplore();
    await userEvent.click(screen.getByRole('button', { name: 'OpenKnowledge' }));
    await waitFor(() => expect(screen.getByText('open-knowledge')).toBeTruthy());
    expect(discoverSkillsInSource).toHaveBeenCalledWith('inkeep/open-knowledge-skills');
    // The repo lists open-knowledge SECOND; the publisher page's counts (478 vs
    // 21) are what puts it first, so this pins the merge, not the repo order.
    const order = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(order[0]).toContain('open-knowledge');
    expect(order[1]).toContain('knowledge-base');
  });

  test('an unrankable list still renders, in repository order', async () => {
    fetchPublisherSkills.mockResolvedValueOnce({ ok: false, error: 'upstream down' } as never);
    renderExplore();
    await userEvent.click(screen.getByRole('button', { name: 'OpenKnowledge' }));
    await waitFor(() => expect(screen.getByText('knowledge-base')).toBeTruthy());
    expect(screen.getByText('open-knowledge')).toBeTruthy();
  });

  test('a list that will not load says so, rather than rendering an empty grid', async () => {
    // The ranking source failing is a different branch (covered above): that one
    // still has a list. This is the list source itself failing, which leaves
    // nothing to show — the only path to the error copy.
    discoverSkillsInSource.mockResolvedValueOnce({ ok: false, error: 'clone failed' } as never);
    renderExplore();
    await userEvent.click(screen.getByRole('button', { name: 'OpenKnowledge' }));
    await waitFor(() =>
      expect(screen.getByText(/Couldn't load the OpenKnowledge skills/)).toBeTruthy(),
    );
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  test('search results arrive install-ranked without touching the sort control', async () => {
    // skills.sh answers in relevance order; the default sort is what reorders
    // them. Asserting the rendered order (not the control's label) pins the
    // behavior a user sees.
    searchSkills.mockResolvedValueOnce({
      ok: true,
      results: [
        {
          id: 'a',
          name: 'rarely-used',
          source: 'o/r',
          description: '',
          installs: 3,
          publisher: 'o',
        },
        {
          id: 'b',
          name: 'widely-used',
          source: 'o/r',
          description: '',
          installs: 900,
          publisher: 'o',
        },
      ],
      backend: 'skills.sh',
      degraded: false,
    } as never);
    renderExplore();
    await userEvent.type(screen.getByLabelText('Search skills'), 'design');
    await waitFor(() => expect(screen.getByText('widely-used')).toBeTruthy());
    const order = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(order[0]).toContain('widely-used');
    expect(order[1]).toContain('rarely-used');
  });

  test('a topic chip turns it back off instead of stacking into the query', async () => {
    renderExplore();
    const ok = screen.getByRole('button', { name: 'OpenKnowledge' });
    await userEvent.click(ok);
    await waitFor(() => expect(ok.getAttribute('aria-pressed')).toBe('true'));
    await userEvent.click(screen.getByRole('button', { name: 'Design' }));
    expect(ok.getAttribute('aria-pressed')).toBe('false');
    await waitFor(() => expect(screen.queryByText('open-knowledge')).toBeNull());
  });
});
