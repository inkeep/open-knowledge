import type { InstallState } from '@inkeep/open-knowledge-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentCatalog } from '@/lib/acp/catalog';

const backing = new Map<string, string>();
if (typeof globalThis.localStorage === 'undefined') {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
    clear: () => backing.clear(),
  };
}

vi.doMock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

const catalog: AgentCatalog = {
  agents: [
    {
      id: 'claude-acp',
      name: 'Claude Agent',
      version: '1',
      source: 'registry',
      supported: true,
      featured: true,
      harness: { cli: 'claude', availability: 'unknown', credentials: 'unknown' },
    },
    {
      id: 'opencode-acp',
      name: 'OpenCode',
      version: '1',
      source: 'registry',
      supported: false,
      featured: false,
      harness: { cli: 'opencode', availability: 'not-found', credentials: 'unknown' },
    },
    {
      id: 'cline',
      name: 'Cline',
      version: '1',
      source: 'registry',
      supported: true,
      featured: false,
      description: 'Autonomous coding agent',
    },
    {
      id: 'cursor',
      name: 'Cursor',
      version: '1',
      source: 'registry',
      supported: true,
      featured: false,
      description: 'ACP wrapper for Cursor',
      license: 'Apache-2.0',
      harness: { cli: 'cursor', availability: 'not-found', credentials: 'unknown' },
    },
    {
      id: 'gemini',
      name: 'Gemini',
      version: '1',
      source: 'registry',
      supported: true,
      featured: false,
      description: 'ACP wrapper for Gemini',
      harness: { cli: 'pi', availability: 'present', credentials: 'unknown' },
    },
  ],
  stale: false,
  maxThreads: 8,
};
let fetchCatalog: () => Promise<typeof catalog> = () => Promise.resolve(catalog);
vi.doMock('@/lib/acp/catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/acp/catalog')>()),
  fetchAgentCatalog: () => fetchCatalog(),
}));

let states: Record<string, InstallState> = {};
vi.doMock('@/components/handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states, refresh: () => Promise.resolve() }),
}));

let terminalLaunchValue: { installedClis: Record<string, boolean> } | null = null;
vi.doMock('@/components/handoff/TerminalLaunchContext', () => ({
  useTerminalLaunch: () => terminalLaunchValue,
}));

vi.doMock('@/components/handoff/OpenInAgentMenuItem', () => ({
  TargetIcon: ({ id }: { id: string }) => <svg data-testid={`target-icon-${id}`} aria-hidden />,
}));
vi.doMock('@/components/acp/RegisteredAgentIcon', () => ({
  RegisteredAgentIcon: () => <svg data-testid="registered-agent-icon" aria-hidden />,
}));

import { reloadEnabledAgentsFromStorage } from '@/lib/acp/enabled-agents';
import {
  getDefaultRegisteredAgent,
  registerAgent,
  reloadRegisteredAgentsFromStorage,
} from '@/lib/acp/registered-agents';

const { ConfigureAgentsSection } = await import('./ConfigureAgentsSection');

const STORAGE_KEY = 'ok-acp-enabled-agents-v1';

function overrides(): Record<string, boolean> {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ConfigureAgentsSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  reloadRegisteredAgentsFromStorage();
  reloadEnabledAgentsFromStorage();
  fetchCatalog = () => Promise.resolve(catalog);
  states = { 'claude-code': { installed: true }, codex: { installed: false } } as Record<
    string,
    InstallState
  >;
});

afterEach(() => cleanup());

async function expandInApp(): Promise<void> {
  fireEvent.click(await screen.findByTestId('configure-agents-in-app-show-more'));
}

function groupOrder(): string[] {
  return screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent?.trim() ?? '');
}

describe('ConfigureAgentsSection', () => {
  test('renders In app + External apps groups (no Terminal on the web host)', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByText('Claude Agent')).toBeTruthy());
    expect(screen.getByText('In app')).toBeTruthy();
    expect(screen.getByText('External apps')).toBeTruthy();
    expect(screen.queryByText('Terminal')).toBeNull();
  });

  test('the In app heading is the plain group name — no feature-Beta badge', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByText('Claude Agent')).toBeTruthy());
    expect(groupOrder()).toEqual(['In app', 'External apps']);
    expect(screen.queryByText('Beta')).toBeNull();
  });

  test('a platform-unsupported in-app agent renders disabled', async () => {
    renderSection();
    await expandInApp();
    const toggle = await screen.findByTestId('configure-agents-in-app-registry:opencode-acp');
    expect(toggle.getAttribute('data-disabled')).toBe('');
  });

  test('a row shows the catalog description as its subtitle, never the license or an install signal', async () => {
    renderSection();
    await expandInApp();
    expect(await screen.findByText('ACP wrapper for Cursor')).toBeTruthy();
    expect(screen.getByText('ACP wrapper for Gemini')).toBeTruthy();
    expect(screen.queryByText('Apache-2.0')).toBeNull();
  });

  test('a present harness defaults on and a not-found one defaults off (toggle still operable)', async () => {
    renderSection();
    const present = await screen.findByTestId('configure-agents-in-app-registry:gemini');
    await expandInApp();
    const notFound = await screen.findByTestId('configure-agents-in-app-registry:cursor');
    expect(present.getAttribute('aria-checked')).toBe('true');
    expect(notFound.getAttribute('aria-checked')).toBe('false');
    expect(notFound.getAttribute('data-disabled')).toBeNull();
  });

  test('an existing sign-in detects an agent whose CLI is not on PATH', async () => {
    const cursor = catalog.agents.find((a) => a.id === 'cursor');
    const restore = cursor?.harness?.credentials;
    if (cursor?.harness) cursor.harness.credentials = 'present';
    try {
      renderSection();
      const row = await screen.findByTestId('configure-agents-in-app-registry:cursor');
      expect(row.getAttribute('aria-checked')).toBe('true');
      expect(screen.getByText('ACP wrapper for Cursor')).toBeTruthy();
    } finally {
      if (cursor?.harness && restore) cursor.harness.credentials = restore;
    }
  });

  test('collapses to agents the probe has not ruled out, with a Show more toggle for the rest', async () => {
    renderSection();
    await screen.findByText('Claude Agent');
    expect(screen.getByText('ACP wrapper for Gemini')).toBeTruthy();
    expect(screen.queryByText('ACP wrapper for Cursor')).toBeNull();
    expect(screen.queryByText('Cline')).toBeNull();
    const toggle = screen.getByTestId('configure-agents-in-app-show-more');
    expect(toggle.textContent).toContain('Show 3 more');

    fireEvent.click(toggle);

    expect(screen.getByText('Cline')).toBeTruthy();
    expect(screen.getByText('ACP wrapper for Cursor')).toBeTruthy();
    expect(toggle.textContent).toContain('Show less');
  });

  test('an agent the probe ruled out stays above the fold once the user enables it', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'in-app:registry:cursor': true }));
    reloadEnabledAgentsFromStorage();
    renderSection();

    expect(await screen.findByText('ACP wrapper for Cursor')).toBeTruthy();
    expect(screen.getByTestId('configure-agents-in-app-show-more').textContent).toContain(
      'Show 2 more',
    );
  });

  test('expanding pins present agents on top and sorts the rest alphabetically', async () => {
    renderSection();
    await screen.findByText('Claude Agent');
    await expandInApp();
    const inApp = within(
      document.querySelector<HTMLElement>(
        'section[aria-labelledby="settings-configure-agents-in-app"]',
      ) as HTMLElement,
    );
    const names = inApp
      .getAllByText(/^(Claude Agent|Gemini|Cursor|OpenCode|Cline)$/)
      .map((n) => n.textContent ?? '');

    const primary = names.slice(0, 2);
    expect(primary).toContain('Claude Agent');
    expect(primary).toContain('Gemini');

    const tail = names.slice(2);
    expect(tail).toEqual([...tail].sort((a, b) => a.localeCompare(b)));
    expect(tail).toContain('Cline');
  });

  test('a group with something installed sorts above one with nothing', async () => {
    const gemini = catalog.agents.find((a) => a.id === 'gemini');
    const claude = catalog.agents.find((a) => a.id === 'claude-acp');
    const restore = { g: gemini?.harness?.availability, c: claude?.harness?.availability };
    if (gemini?.harness) gemini.harness.availability = 'not-found';
    if (claude?.harness) claude.harness.availability = 'not-found';
    try {
      renderSection();
      await screen.findByTestId('configure-agents-in-app-show-more');
      expect(groupOrder()).toEqual(['External apps', 'In app']);
    } finally {
      if (gemini?.harness && restore.g) gemini.harness.availability = restore.g;
      if (claude?.harness && restore.c) claude.harness.availability = restore.c;
    }
  });

  test('a credentials-only agent lifts the In app group above one with nothing', async () => {
    const patched = catalog.agents.filter((a) => a.harness !== undefined);
    const restore = patched.map((a) => ({ a, ...a.harness }));
    for (const a of patched) {
      if (a.harness) a.harness.availability = 'not-found';
    }
    const cursor = catalog.agents.find((a) => a.id === 'cursor');
    if (cursor?.harness) cursor.harness.credentials = 'present';
    try {
      renderSection();
      await screen.findByText('ACP wrapper for Cursor');
      expect(groupOrder()).toEqual(['In app', 'External apps']);
    } finally {
      for (const r of restore) {
        if (r.a.harness && r.availability && r.credentials) {
          r.a.harness.availability = r.availability;
          r.a.harness.credentials = r.credentials;
        }
      }
    }
  });

  test('groups keep their declared order when both have something present', async () => {
    renderSection();
    await screen.findByText('Claude Agent');
    expect(groupOrder()).toEqual(['In app', 'External apps']);
  });

  test('an external-apps group whose probe has not answered does NOT claim presence', async () => {
    states = {};
    const gemini = catalog.agents.find((a) => a.id === 'gemini');
    const claude = catalog.agents.find((a) => a.id === 'claude-acp');
    const restore = { g: gemini?.harness?.availability, c: claude?.harness?.availability };
    if (gemini?.harness) gemini.harness.availability = 'not-found';
    if (claude?.harness) claude.harness.availability = 'not-found';
    try {
      renderSection();
      await screen.findByTestId('configure-agents-in-app-show-more');
      expect(groupOrder()).toEqual(['In app', 'External apps']);
    } finally {
      if (gemini?.harness && restore.g) gemini.harness.availability = restore.g;
      if (claude?.harness && restore.c) claude.harness.availability = restore.c;
    }
  });

  test('a failed catalog holds the In app group in place rather than sinking it', async () => {
    fetchCatalog = () => Promise.reject(new Error('catalog unreachable'));
    renderSection();
    await screen.findByText(/Couldn't reach the agent registry/i);
    expect(groupOrder()).toEqual(['In app', 'External apps']);
  });

  test('a group whose every member is positively absent still sorts down', async () => {
    states = { 'claude-code': { installed: false }, codex: { installed: false } } as Record<
      string,
      InstallState
    >;
    renderSection();
    await screen.findByText('Claude Agent');
    expect(groupOrder()).toEqual(['In app', 'External apps']);
  });

  test('the In app group does not sort down and jump back while its catalog loads', async () => {
    renderSection();
    expect(groupOrder()).toEqual(['In app', 'External apps']);
    await screen.findByText('Claude Agent');
    expect(groupOrder()).toEqual(['In app', 'External apps']);
  });

  test('enabling an in-app agent is visibility-only and does not change the launch default', async () => {
    registerAgent({ source: 'registry', id: 'codex-acp', name: 'Codex' });
    expect(getDefaultRegisteredAgent()?.id).toBe('codex-acp');

    renderSection();
    const toggle = await screen.findByTestId('configure-agents-in-app-registry:claude-acp');
    fireEvent.click(toggle);

    await waitFor(() => expect(overrides()['in-app:registry:claude-acp']).toBe(true));
    expect(getDefaultRegisteredAgent()?.id).toBe('codex-acp');
  });

  test('disabling the current default moves the default to the next enabled agent', async () => {
    registerAgent({ source: 'registry', id: 'codex-acp', name: 'Codex' });
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    expect(getDefaultRegisteredAgent()?.id).toBe('claude-acp');

    renderSection();
    const toggle = await screen.findByTestId('configure-agents-in-app-registry:claude-acp');
    fireEvent.click(toggle);

    await waitFor(() => expect(overrides()['in-app:registry:claude-acp']).toBe(false));
    expect(getDefaultRegisteredAgent()?.id).toBe('codex-acp');
  });

  test('a detected external app is on with no override; a missing one is off', async () => {
    renderSection();
    const detected = await screen.findByTestId('configure-agents-desktop-claude-code');
    const missing = await screen.findByTestId('configure-agents-desktop-codex');
    expect(overrides()['desktop:claude-code']).toBeUndefined();
    expect(detected.getAttribute('aria-checked')).toBe('true');
    expect(missing.getAttribute('aria-checked')).toBe('false');
  });

  test('toggling on an absent external app persists a true override and keeps the row', async () => {
    renderSection();
    const toggle = await screen.findByTestId('configure-agents-desktop-codex');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);

    await waitFor(() => expect(overrides()['desktop:codex']).toBe(true));
    const after = await screen.findByTestId('configure-agents-desktop-codex');
    expect(after.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Not installed')).toBeTruthy();
  });

  test('toggling a detected external app off persists a false override', async () => {
    renderSection();
    const toggle = await screen.findByTestId('configure-agents-desktop-claude-code');
    fireEvent.click(toggle);
    await waitFor(() => expect(overrides()['desktop:claude-code']).toBe(false));
  });

  test('search filters agents across groups', async () => {
    renderSection();
    await screen.findByText('Claude Agent');
    fireEvent.change(screen.getByTestId('configure-agents-search'), { target: { value: 'codex' } });
    await waitFor(() => expect(screen.queryByText('Claude Agent')).toBeNull());
    expect(screen.getByTestId('configure-agents-desktop-codex')).toBeTruthy();
    expect(screen.queryByTestId('configure-agents-no-results')).toBeNull();
  });

  test('a query matching nothing shows the no-results line', async () => {
    renderSection();
    await screen.findByText('Claude Agent');
    fireEvent.change(screen.getByTestId('configure-agents-search'), {
      target: { value: 'zzzznope' },
    });
    await waitFor(() => expect(screen.getByTestId('configure-agents-no-results')).toBeTruthy());
  });
});

describe('ConfigureAgentsSection — Terminal group (docked terminal present)', () => {
  beforeEach(async () => {
    terminalLaunchValue = { installedClis: { claude: true, codex: false } };
    const { reloadEnabledAgentsFromStorage } = await import('@/lib/acp/enabled-agents');
    reloadEnabledAgentsFromStorage();
  });
  afterEach(() => {
    terminalLaunchValue = null;
  });

  async function expandTerminal(): Promise<void> {
    fireEvent.click(await screen.findByTestId('configure-agents-terminal-show-more'));
  }

  test('renders the Terminal group with per-CLI rows', async () => {
    renderSection();
    await screen.findByTestId('configure-agents-terminal-claude');
    expect(screen.getByText('Terminal')).toBeTruthy();
    await expandTerminal();
    expect(screen.getByTestId('configure-agents-terminal-codex')).toBeTruthy();
  });

  test('Terminal sorts installed CLIs first and folds the not-installed ones', async () => {
    renderSection();
    const fold = await screen.findByTestId('configure-agents-terminal-show-more');
    expect(screen.queryByTestId('configure-agents-terminal-codex')).toBeNull();
    expect(screen.getByTestId('configure-agents-terminal-claude')).toBeTruthy();

    fireEvent.click(fold);
    expect(screen.getByTestId('configure-agents-terminal-codex')).toBeTruthy();
    expect(fold.textContent).toContain('Show less');
  });

  test('an absent CLI shows the Not installed hint; a present one does not', async () => {
    renderSection();
    await expandTerminal();
    await screen.findByTestId('configure-agents-terminal-codex');
    const codexRow = screen.getByTestId('configure-agents-terminal-codex').closest('div[class]');
    expect(codexRow?.parentElement?.textContent ?? '').toContain('Not installed');
  });

  test('toggling a CLI writes the terminal: override key, not the desktop one', async () => {
    renderSection();
    const toggle = await screen.findByTestId('configure-agents-terminal-claude');
    const desktopKeyBefore = overrides()['desktop:claude-code'];
    fireEvent.click(toggle);
    await waitFor(() => expect(overrides()['terminal:claude']).toBe(false));
    expect(overrides()['desktop:claude-code']).toBe(desktopKeyBefore);
  });
});
