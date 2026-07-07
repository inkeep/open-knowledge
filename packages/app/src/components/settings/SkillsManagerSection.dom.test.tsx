/**
 * RTL behavioral tests for the Settings Skills manager.
 *
 * Mocks `/api/skills` and asserts the grouped list renders each scope's
 * skills with the right install-state badge (Installed vs Draft) and host
 * chips, that the global group is hidden while empty, and that a
 * fetch failure surfaces the error alert instead of a permanently-spinning
 * skeleton.
 *
 * Lingui macros aren't transformed in this substrate — stub to identity
 * renderers, same as the sibling .dom.test.tsx files.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { SkillsListSuccess } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      if (typeof strings === 'string') return strings;
      let out = '';
      strings.forEach((s, i) => {
        out += s;
        if (i < values.length) out += String(values[i]);
      });
      return out;
    },
  }),
}));

mock.module('sonner', () => ({
  toast: { error: mock(() => {}), info: mock(() => {}), success: mock(() => {}) },
}));
// The row's "Open with AI" menu pulls config / workspace / install-detection
// context this section test doesn't provide; stub it (handoff is covered by
// its own tests + useHandoffDispatch.test.ts).
mock.module('@/components/handoff/OpenInAgentMenu', () => ({
  OpenInAgentMenu: () => null,
}));
// The section opens skills as editor tabs via DocumentContext; this list test
// renders the section standalone (no provider), so stub the open hook.
mock.module('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ openDocument: () => {} }),
}));

const { SkillsManagerSection } = await import('./SkillsManagerSection');

const realFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = realFetch;
});

const EMPTY_TARGETS = { targets: [], configured: false };

/**
 * Route by URL: the section mounts both the skills list (`/api/skills`) and the
 * targets picker (`/api/skill-targets`). The targets response is held constant
 * across these tests — they assert the skills list, not the picker.
 */
function routeFetch(
  skillsResponse: () => { ok: boolean; status: number; json: () => Promise<unknown> },
) {
  global.fetch = mock(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/skill-targets')) {
      return { ok: true, status: 200, json: async () => EMPTY_TARGETS };
    }
    return skillsResponse();
  }) as unknown as typeof fetch;
}

function mockSkillsResponse(payload: SkillsListSuccess) {
  routeFetch(() => ({ ok: true, status: 200, json: async () => payload }));
}

function mockSkillsFailure() {
  routeFetch(() => ({ ok: false, status: 500, json: async () => ({ title: 'Internal error' }) }));
}

describe('SkillsManagerSection', () => {
  test('lists project skills with install-state and host badges', async () => {
    mockSkillsResponse({
      skills: [
        {
          name: 'trip-log',
          description: 'Log a trip',
          scope: 'project',
          path: '.ok/skills/trip-log/SKILL.md',
          installed: true,
          hosts: ['claude', 'cursor'],
        },
        {
          name: 'draft-skill',
          scope: 'project',
          path: '.ok/skills/draft-skill/SKILL.md',
          installed: false,
          hosts: [],
        },
      ],
      truncated: false,
    });

    render(<SkillsManagerSection />);

    await waitFor(() => expect(screen.getByTestId('skill-row-trip-log')).toBeDefined());

    // Installed skill: Installed badge + one chip per host dir.
    const installedRow = screen.getByTestId('skill-row-trip-log');
    expect(installedRow.textContent).toContain('Installed');
    expect(installedRow.textContent).toContain('claude');
    expect(installedRow.textContent).toContain('cursor');

    // Never-installed skill: Draft badge, and a nudge to add a description.
    const draftRow = screen.getByTestId('skill-row-draft-skill');
    expect(draftRow.textContent).toContain('Draft');
    expect(draftRow.textContent?.toLowerCase()).toContain('description');

    // Project group renders; global group is hidden while it has no skills.
    expect(screen.getByTestId('skills-group-project')).toBeDefined();
    expect(screen.queryByTestId('skills-group-global')).toBeNull();
  });

  test('renders the project empty state when there are no skills', async () => {
    mockSkillsResponse({ skills: [], truncated: false });
    render(<SkillsManagerSection />);
    await waitFor(() => expect(screen.getByTestId('skills-group-project-empty')).toBeDefined());
    expect(screen.queryByTestId('skills-group-global')).toBeNull();
  });

  test('surfaces an error alert on a failed fetch', async () => {
    mockSkillsFailure();
    render(<SkillsManagerSection />);
    await waitFor(() => expect(screen.getByTestId('settings-skills-error')).toBeDefined());
  });
});
