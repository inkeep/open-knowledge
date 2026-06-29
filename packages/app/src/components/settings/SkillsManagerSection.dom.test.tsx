
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
mock.module('@/components/handoff/OpenInAgentMenu', () => ({
  OpenInAgentMenu: () => null,
}));
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

    const installedRow = screen.getByTestId('skill-row-trip-log');
    expect(installedRow.textContent).toContain('Installed');
    expect(installedRow.textContent).toContain('claude');
    expect(installedRow.textContent).toContain('cursor');

    const draftRow = screen.getByTestId('skill-row-draft-skill');
    expect(draftRow.textContent).toContain('Draft');
    expect(draftRow.textContent?.toLowerCase()).toContain('description');

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
