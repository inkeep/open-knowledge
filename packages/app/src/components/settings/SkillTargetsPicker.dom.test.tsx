
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const { SkillTargetsPicker } = await import('./SkillTargetsPicker');

const realFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = realFetch;
});

describe('SkillTargetsPicker', () => {
  test('renders a checkbox per editor reflecting the committed set', async () => {
    global.fetch = mock(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ targets: ['claude'], configured: true }),
    })) as unknown as typeof fetch;

    render(<SkillTargetsPicker />);

    await waitFor(() => expect(screen.getByTestId('skill-target-claude')).toBeDefined());
    expect(screen.getByTestId('skill-target-claude').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('skill-target-cursor').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('skill-target-codex')).toBeDefined();
  });

  test('toggling an editor PUTs the updated target set', async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, method: init?.method, body: init?.body as string | undefined });
      if (init?.method === 'PUT') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            targets: ['claude', 'cursor'],
            reprojected: [],
            bundleHosts: [],
            removedFrom: [],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ targets: ['claude'], configured: true }),
      };
    }) as unknown as typeof fetch;

    render(<SkillTargetsPicker />);
    await waitFor(() => expect(screen.getByTestId('skill-target-cursor')).toBeDefined());

    fireEvent.click(screen.getByTestId('skill-target-cursor'));

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT');
    expect(put).toBeDefined();
    const sent = JSON.parse(put?.body ?? '{}') as { targets: string[] };
    expect(new Set(sent.targets)).toEqual(new Set(['claude', 'cursor']));
  });
});
