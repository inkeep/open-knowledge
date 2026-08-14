/**
 * Behavioral tests for the Settings → Configure agents section: it renders the
 * agent groups (In app / Terminal / External apps) with toggles, and flipping a toggle
 * persists an enable/disable override to the `enabled-agents` store so the
 * launcher dropdowns show/hide that agent.
 */

import type { InstallState } from '@inkeep/open-knowledge-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentCatalog } from '@/lib/acp/catalog';

// Minimal localStorage for the enabled-agents store (plain bun test has none).
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
    // Harness-mapped agents (agent.harness present) are the default-visible set.
    {
      id: 'claude-acp',
      name: 'Claude Agent',
      version: '1',
      source: 'registry',
      supported: true,
      featured: true,
      harness: { cli: 'claude', availability: 'unknown' },
    },
    {
      id: 'opencode-acp',
      name: 'OpenCode',
      version: '1',
      source: 'registry',
      supported: false,
      featured: false,
      harness: { cli: 'opencode', availability: 'not-found' },
    },
    // Not harness-mapped and not enabled → collapsed behind "Show more".
    {
      id: 'cline',
      name: 'Cline',
      version: '1',
      source: 'registry',
      supported: true,
      featured: false,
      description: 'Autonomous coding agent',
    },
    // Supported; harness not found on this host → not auto-detected (defaults
    // off), but the toggle stays operable. Carries a catalog blurb.
    {
      id: 'cursor',
      name: 'Cursor',
      version: '1',
      source: 'registry',
      supported: true,
      featured: false,
      description: 'ACP wrapper for Cursor',
      license: 'Apache-2.0',
      harness: { cli: 'cursor', availability: 'not-found' },
    },
    // Supported + harness present → detected → defaults on.
    {
      id: 'gemini',
      name: 'Gemini',
      version: '1',
      source: 'registry',
      supported: true,
      featured: false,
      description: 'ACP wrapper for Gemini',
      harness: { cli: 'pi', availability: 'present' },
    },
  ],
  stale: false,
  maxThreads: 8,
};
vi.doMock('@/lib/acp/catalog', () => ({
  fetchAgentCatalog: () => Promise.resolve(catalog),
}));

let states: Record<string, InstallState> = {};
vi.doMock('@/components/handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states, refresh: () => Promise.resolve() }),
}));

// Web-host default: no docked terminal → the Terminal group is absent. The
// Terminal-group describe below swaps this value in and restores it after.
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

import {
  getDefaultRegisteredAgent,
  registerAgent,
  reloadRegisteredAgentsFromStorage,
} from '@/lib/acp/registered-agents';

// Dynamic import AFTER the mock.module calls above: the shim registers mocks via
// vitest's runtime `vi.doMock` (no retroactive registry patch like bun), so the
// component — and its `fetchAgentCatalog` import — must resolve after the mocks.
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
  states = { 'claude-code': { installed: true }, codex: { installed: false } } as Record<
    string,
    InstallState
  >;
});

afterEach(() => cleanup());

describe('ConfigureAgentsSection', () => {
  test('renders In app + External apps groups (no Terminal on the web host)', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByText('Claude Agent')).toBeTruthy());
    expect(screen.getByText('In app')).toBeTruthy();
    expect(screen.getByText('External apps')).toBeTruthy();
    expect(screen.queryByText('Terminal')).toBeNull();
  });

  test('a platform-unsupported in-app agent renders disabled', async () => {
    renderSection();
    const toggle = await screen.findByTestId('configure-agents-in-app-registry:opencode-acp');
    expect(toggle.getAttribute('data-disabled')).toBe('');
  });

  test('a row shows the catalog description as its subtitle, never the license or an install signal', async () => {
    renderSection();
    // The human blurb, not the SPDX license. (A global "Not installed" check
    // would hit the external-apps group's own install hint, so scope to the license.)
    expect(await screen.findByText('ACP wrapper for Cursor')).toBeTruthy();
    expect(screen.getByText('ACP wrapper for Gemini')).toBeTruthy();
    expect(screen.queryByText('Apache-2.0')).toBeNull();
  });

  test('a present harness defaults on and a not-found one defaults off (toggle still operable)', async () => {
    renderSection();
    const present = await screen.findByTestId('configure-agents-in-app-registry:gemini');
    const notFound = await screen.findByTestId('configure-agents-in-app-registry:cursor');
    expect(present.getAttribute('aria-checked')).toBe('true');
    expect(notFound.getAttribute('aria-checked')).toBe('false');
    // Not a platform gate — the not-found row is still enabled to turn on.
    expect(notFound.getAttribute('data-disabled')).toBeNull();
  });

  test('collapses to the harness-mapped agents, with a Show more toggle for the rest', async () => {
    renderSection();
    // Default view: harness-mapped agents (Claude/OpenCode/Cursor/Gemini) show;
    // the non-mapped agent (Cline) is hidden behind the toggle.
    await screen.findByText('Claude Agent');
    expect(screen.getByText('ACP wrapper for Cursor')).toBeTruthy();
    expect(screen.queryByText('Cline')).toBeNull();
    const toggle = screen.getByTestId('configure-agents-in-app-show-more');
    expect(toggle.textContent).toContain('Show 1 more');

    fireEvent.click(toggle);

    // Expanded: the collapsed agent appears; the toggle flips to Show less.
    expect(screen.getByText('Cline')).toBeTruthy();
    expect(toggle.textContent).toContain('Show less');
  });

  test('enabling an in-app agent is visibility-only and does not change the launch default', async () => {
    // An explicit pick established a default before Settings is opened.
    registerAgent({ source: 'registry', id: 'codex-acp', name: 'Codex' });
    expect(getDefaultRegisteredAgent()?.id).toBe('codex-acp');

    renderSection();
    const toggle = await screen.findByTestId('configure-agents-in-app-registry:claude-acp');
    fireEvent.click(toggle);

    // The toggle records the enable override...
    await waitFor(() => expect(overrides()['in-app:registry:claude-acp']).toBe(true));
    // ...but the launch default is untouched (enabling is visibility, not a pick).
    expect(getDefaultRegisteredAgent()?.id).toBe('codex-acp');
  });

  test('disabling the current default moves the default to the next enabled agent', async () => {
    // Two registered agents, claude is the launch default; codex is the fallback.
    registerAgent({ source: 'registry', id: 'codex-acp', name: 'Codex' });
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    expect(getDefaultRegisteredAgent()?.id).toBe('claude-acp');

    renderSection();
    const toggle = await screen.findByTestId('configure-agents-in-app-registry:claude-acp');
    fireEvent.click(toggle); // disable the default

    await waitFor(() => expect(overrides()['in-app:registry:claude-acp']).toBe(false));
    // The default no longer points at the just-disabled agent — it moved to codex,
    // so the composer won't keep showing the disabled agent as selected.
    expect(getDefaultRegisteredAgent()?.id).toBe('codex-acp');
  });

  test('a detected external app is on with no override; a missing one is off', async () => {
    renderSection();
    // `claude-code` probes installed, `codex` probes absent (see the mock above).
    const detected = await screen.findByTestId('configure-agents-desktop-claude-code');
    const missing = await screen.findByTestId('configure-agents-desktop-codex');
    expect(overrides()['desktop:claude-code']).toBeUndefined();
    expect(detected.getAttribute('aria-checked')).toBe('true');
    expect(missing.getAttribute('aria-checked')).toBe('false');
  });

  test('toggling on an absent external app persists a true override and keeps the row', async () => {
    // The escape hatch: a user turns on an app they have not installed, and the
    // row stays put so selecting it can route to the installer.
    renderSection();
    const toggle = await screen.findByTestId('configure-agents-desktop-codex');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);

    await waitFor(() => expect(overrides()['desktop:codex']).toBe(true));
    const after = await screen.findByTestId('configure-agents-desktop-codex');
    expect(after.getAttribute('aria-checked')).toBe('true');
    // Still labeled as not installed — the override shows it, it does not claim
    // the app is there.
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
    await screen.findByText('Claude Agent'); // catalog resolved
    fireEvent.change(screen.getByTestId('configure-agents-search'), { target: { value: 'codex' } });
    // In-app 'Claude Agent' no longer matches; the ChatGPT Desktop row does
    // (via its `codex` target id — the label no longer contains the query).
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
    // The enabled-agents store is module-level state; localStorage.clear() in
    // the outer beforeEach doesn't reset it, and any later setAgentEnabled
    // flushes the whole in-memory map back to storage. Re-sync from the
    // now-empty storage so this describe starts from no overrides.
    const { reloadEnabledAgentsFromStorage } = await import('@/lib/acp/enabled-agents');
    reloadEnabledAgentsFromStorage();
  });
  afterEach(() => {
    terminalLaunchValue = null;
  });

  test('renders the Terminal group with per-CLI rows', async () => {
    renderSection();
    await screen.findByTestId('configure-agents-terminal-claude');
    expect(screen.getByText('Terminal')).toBeTruthy();
    expect(screen.getByTestId('configure-agents-terminal-codex')).toBeTruthy();
  });

  test('an absent CLI shows the Not installed hint; a present one does not', async () => {
    renderSection();
    await screen.findByTestId('configure-agents-terminal-codex');
    // codex CLI probed absent -> hint; claude probed present -> no hint. The
    // desktop rows also render "Not installed" hints in other states, so
    // scope the assertion to row containers.
    const codexRow = screen.getByTestId('configure-agents-terminal-codex').closest('div[class]');
    expect(codexRow?.parentElement?.textContent ?? '').toContain('Not installed');
  });

  test('toggling a CLI writes the terminal: override key, not the desktop one', async () => {
    renderSection();
    const toggle = await screen.findByTestId('configure-agents-terminal-claude');
    // Overrides persist in localStorage across this file's tests — assert the
    // click's DELTA: it writes the terminal key and leaves the desktop key as-is.
    const desktopKeyBefore = overrides()['desktop:claude-code'];
    fireEvent.click(toggle);
    await waitFor(() => expect(overrides()['terminal:claude']).toBe(false));
    expect(overrides()['desktop:claude-code']).toBe(desktopKeyBefore);
  });
});
