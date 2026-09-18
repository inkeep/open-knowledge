import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentCatalog } from './catalog';
import { useAgentCatalogQuery, useHydrateRegisteredAgentMeta } from './catalog';
import {
  getDefaultRegisteredAgent,
  registerAgent,
  reloadRegisteredAgentsFromStorage,
} from './registered-agents';

const backing = new Map<string, string>();
if (typeof globalThis.localStorage === 'undefined') {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
    clear: () => backing.clear(),
  };
}

const catalog: AgentCatalog = {
  agents: [
    {
      id: 'claude-acp',
      name: 'Claude',
      version: '1',
      source: 'registry',
      supported: true,
      featured: true,
      iconUrl: 'https://registry.example/claude.svg',
    },
  ],
  stale: false,
  maxThreads: 8,
};

function Harness() {
  useHydrateRegisteredAgentMeta();
  return null;
}

function CatalogObserver({ enabled }: { enabled: boolean }) {
  useAgentCatalogQuery(enabled);
  return null;
}

beforeEach(() => {
  localStorage.clear();
  reloadRegisteredAgentsFromStorage();
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => catalog,
  })) as unknown as typeof fetch;
});

afterEach(() => cleanup());

describe('useAgentCatalogQuery', () => {
  test('a failed catalog read is logged once however many instances observe the shared query', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <CatalogObserver enabled />
        <CatalogObserver enabled={false} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(
      consoleError.mock.calls.filter(
        ([message]) => message === '[acp-catalog] agent catalog request failed',
      ),
    ).toHaveLength(1);
    consoleError.mockRestore();
  });
});

describe('useHydrateRegisteredAgentMeta', () => {
  test('fills a seeded agent brand icon from the catalog on mount', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude' });
    expect(getDefaultRegisteredAgent()?.iconUrl).toBeUndefined();

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(getDefaultRegisteredAgent()?.iconUrl).toBe('https://registry.example/claude.svg'),
    );
  });
});
