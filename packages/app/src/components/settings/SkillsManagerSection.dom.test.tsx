import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.doMock('@lingui/react/macro', () => ({
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

vi.doMock('sonner', () => ({
  toast: { error: vi.fn(() => {}), info: vi.fn(() => {}), success: vi.fn(() => {}) },
}));

const { SkillsManagerSection } = await import('./SkillsManagerSection');

const realFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = realFetch;
});

const EMPTY_TARGETS = { targets: [], configured: false };

function mockTargets() {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => EMPTY_TARGETS,
  })) as unknown as typeof fetch;
}

describe('SkillsManagerSection', () => {
  test('renders the section and the folders surface', async () => {
    mockTargets();
    render(<SkillsManagerSection scope="project" />);
    expect(screen.getByTestId('settings-skills-section')).toBeDefined();
    await waitFor(() => expect(screen.getByTestId('settings-skill-folders')).toBeDefined());
  });

  test('does not render authoring buttons or the scope-grouped skills list', async () => {
    mockTargets();
    render(<SkillsManagerSection scope="project" />);
    await waitFor(() => expect(screen.getByTestId('settings-skills-section')).toBeDefined());

    expect(screen.queryByTestId('settings-skills-new-button')).toBeNull();
    expect(screen.queryByTestId('settings-skills-import-button')).toBeNull();
    expect(screen.queryByTestId('skills-group-project')).toBeNull();
    expect(screen.queryByTestId('skills-group-global')).toBeNull();
  });
});
