import {
  AGENT_REGISTRY,
  type AgentId,
  type ApplyIntent,
  agentIdForHandoffTarget,
  agentIdForTerminalCli,
  CONNECTION_ROW_AGENT_IDS,
  type HostSnapshot,
  type InstallState,
  type SatisfierId,
  TERMINAL_CLI_IDS,
  VISIBLE_HANDOFF_TARGETS,
} from '@inkeep/open-knowledge-core';
import * as actualLinguiMacro from '@lingui/react/macro';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  waitForElementToBeRemoved,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AgentCatalog } from '@/lib/acp/catalog';
import type { ApplyAgentConnectionsResult } from '@/lib/agent-connections';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

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
  ...actualLinguiMacro,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{(value === 1 ? one : other).replace('#', String(value))}</>
  ),
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    i18n: { locale: 'en' },
    t: renderLinguiTemplate,
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

const { AgentConnectionsSection } = await import('./AgentConnectionsSection');

const STORAGE_KEY = 'ok-acp-enabled-agents-v1';

function overrides(): Record<string, boolean> {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
}

const EMPTY_REPORT = { actions: [], conflicts: [], withheld: [] };

const DETECTED_CONNECTABLE: AgentId[] = ['claude', 'codex', 'cursor', 'opencode'];

function diskSatisfierIds(agentId: AgentId): SatisfierId[] {
  return AGENT_REGISTRY[agentId].satisfiers
    .filter((satisfier) => satisfier.scope !== 'session')
    .map((satisfier) => satisfier.id);
}

function satisfierId(
  agentId: AgentId,
  piece: 'mcp' | 'skill',
  scope: 'project' | 'user',
): SatisfierId {
  const id = AGENT_REGISTRY[agentId].satisfiers.find(
    (satisfier) => satisfier.piece === piece && satisfier.scope === scope,
  )?.id;
  if (id === undefined) throw new Error(`missing ${agentId}:${piece}:${scope}`);
  return id;
}

function snapshotWith(installed: readonly SatisfierId[] = []): HostSnapshot {
  const installedIds = new Set<string>(installed);
  const satisfiers = Object.fromEntries(
    Object.values(AGENT_REGISTRY).flatMap((agent) =>
      agent.satisfiers
        .filter((satisfier) => satisfier.probe.mode === 'probeable')
        .map((satisfier) => [
          satisfier.id,
          { state: installedIds.has(satisfier.id) ? 'satisfied' : 'absent' },
        ]),
    ),
  );
  return {
    probes: { env: 'desktop', satisfiers },
    detection: { detected: DETECTED_CONNECTABLE, probed: true },
  };
}

function partiallyUnprobedSnapshot(agentId: AgentId): HostSnapshot {
  const unprobed = new Set<string>(diskSatisfierIds(agentId));
  const base = snapshotWith([]);
  return {
    ...base,
    probes: {
      ...base.probes,
      satisfiers: Object.fromEntries(
        Object.entries(base.probes.satisfiers).map(([id, cell]) => [
          id,
          unprobed.has(id) ? { state: 'unprobed' } : cell,
        ]),
      ),
    },
  };
}

function result(snapshot: HostSnapshot | null, ok = true): ApplyAgentConnectionsResult {
  return { ok, report: EMPTY_REPORT, snapshot };
}

function terminalRow(cli: string): HTMLElement {
  const row = screen.getByTestId(`configure-agents-terminal-${cli}`).parentElement?.parentElement;
  if (!row) throw new Error(`no row for ${cli}`);
  return row;
}

function desktopRow(target: string): HTMLElement {
  const row = screen.getByTestId(`configure-agents-desktop-${target}`).parentElement?.parentElement;
  if (!row) throw new Error(`no desktop row for ${target}`);
  return row;
}

function accessibleDescription(control: HTMLElement): string {
  const ids = (control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  return ids
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderSection(
  applyConnections: (
    intents: readonly ApplyIntent[],
  ) => Promise<ApplyAgentConnectionsResult> = async () => result(null),
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <AgentConnectionsSection applyConnections={applyConnections} />
      </TooltipProvider>
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function expandInApp(): Promise<void> {
  fireEvent.click(await screen.findByTestId('configure-agents-in-app-show-more'));
}

async function expandDesktop(): Promise<void> {
  fireEvent.click(await screen.findByTestId('configure-agents-desktop-show-more'));
}

function groupOrder(): string[] {
  return screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent?.trim() ?? '');
}

describe('AgentConnectionsSection', () => {
  test('renders all three groups on the web host, Terminal last with nothing to back it', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByText('Claude Agent')).toBeTruthy());
    expect(screen.getByText('In app')).toBeTruthy();
    expect(screen.getByText('External apps')).toBeTruthy();
    expect(screen.getByText('Terminal')).toBeTruthy();
    expect(groupOrder()).toEqual(['In app', 'External apps', 'Terminal']);
  });

  test('the In app heading is the plain group name — no feature-Beta badge', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByText('Claude Agent')).toBeTruthy());
    expect(groupOrder()).toEqual(['In app', 'External apps', 'Terminal']);
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
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
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
      expect(groupOrder()).toEqual(['External apps', 'In app', 'Terminal']);
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
      expect(groupOrder()).toEqual(['In app', 'External apps', 'Terminal']);
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
    expect(groupOrder()).toEqual(['In app', 'External apps', 'Terminal']);
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
      expect(groupOrder()).toEqual(['In app', 'Terminal', 'External apps']);
    } finally {
      if (gemini?.harness && restore.g) gemini.harness.availability = restore.g;
      if (claude?.harness && restore.c) claude.harness.availability = restore.c;
    }
  });

  test('a failed catalog holds the In app group in place rather than sinking it', async () => {
    fetchCatalog = () => Promise.reject(new Error('catalog unreachable'));
    renderSection();
    await screen.findByText(/Couldn't reach the agent registry/i);
    expect(groupOrder()).toEqual(['In app', 'External apps', 'Terminal']);
  });

  test('a group whose every member is positively absent still sorts down', async () => {
    states = { 'claude-code': { installed: false }, codex: { installed: false } } as Record<
      string,
      InstallState
    >;
    renderSection();
    await screen.findByText('Claude Agent');
    expect(groupOrder()).toEqual(['In app', 'Terminal', 'External apps']);
  });

  test('the In app group does not sort down and jump back while its catalog loads', async () => {
    renderSection();
    expect(groupOrder()).toEqual(['In app', 'External apps', 'Terminal']);
    await screen.findByText('Claude Agent');
    expect(groupOrder()).toEqual(['In app', 'External apps', 'Terminal']);
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
    expect(screen.queryByTestId('configure-agents-desktop-codex')).toBeNull();
    expect(screen.getByTestId('configure-agents-desktop-cursor')).toBeTruthy();
    const fold = screen.getByTestId('configure-agents-desktop-show-more');
    expect(fold.textContent).toBe('Show 1 more');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    await expandDesktop();
    const missing = await screen.findByTestId('configure-agents-desktop-codex');
    expect(overrides()['desktop:claude-code']).toBeUndefined();
    expect(detected.getAttribute('aria-checked')).toBe('true');
    expect(missing.getAttribute('aria-checked')).toBe('false');
    expect(fold.textContent).toBe('Show less');
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(fold);
    expect(screen.queryByTestId('configure-agents-desktop-codex')).toBeNull();
    expect(screen.getByTestId('configure-agents-desktop-claude-code')).toBe(detected);
  });

  test('an absent external app cannot be switched on, and offers to install instead', async () => {
    renderSection();
    await expandDesktop();
    const toggle = await screen.findByTestId('configure-agents-desktop-codex');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.getAttribute('data-disabled')).toBe('');

    fireEvent.click(toggle);
    await waitFor(() => expect(overrides()['desktop:codex']).toBeUndefined());

    const row = toggle.closest('div[class*="flex items-center"]');
    expect(row?.textContent ?? '').toContain('Not installed');
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
    expect(screen.queryByTestId('configure-agents-desktop-show-more')).toBeNull();
    expect(screen.queryByTestId('configure-agents-no-results')).toBeNull();
  });

  test.each([false, true])(
    'search preserves external expansion %s with mixed matches',
    async (expanded) => {
      renderSection();
      await screen.findByText('Claude Agent');
      if (expanded) await expandDesktop();
      const search = screen.getByTestId('configure-agents-search');
      fireEvent.change(search, { target: { value: 'desktop' } });
      expect(screen.getByTestId('configure-agents-desktop-codex')).toBeTruthy();
      expect(screen.getByTestId('configure-agents-desktop-claude-code')).toBeTruthy();
      expect(screen.queryByTestId('configure-agents-desktop-show-more')).toBeNull();
      fireEvent.change(search, { target: { value: '' } });
      expect(
        screen.getByTestId('configure-agents-desktop-show-more').getAttribute('aria-expanded'),
      ).toBe(String(expanded));
      expect(screen.queryByTestId('configure-agents-desktop-codex') !== null).toBe(expanded);
    },
  );

  test('all absent external apps stay visible without a disclosure', async () => {
    states = {};
    const snapshot = { ...snapshotWith(), detection: { detected: [], probed: true } };
    renderSection(async () => result(snapshot));
    await screen.findByText('Claude Agent');
    await waitFor(() =>
      expect(screen.getByTestId('agent-connection-lm-studio').textContent).toContain(
        'Not detected',
      ),
    );
    expect(screen.getByTestId('configure-agents-desktop-claude-code')).toBeTruthy();
    expect(screen.getByTestId('configure-agents-desktop-codex')).toBeTruthy();
    expect(screen.getByTestId('configure-agents-desktop-cursor')).toBeTruthy();
    expect(screen.queryByTestId('configure-agents-desktop-show-more')).toBeNull();
  });

  test('enabled but absent external apps remain behind the disclosure', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'desktop:codex': true }));
    reloadEnabledAgentsFromStorage();
    renderSection();
    await screen.findByText('Claude Agent');
    expect(screen.queryByTestId('configure-agents-desktop-codex')).toBeNull();
    await expandDesktop();
    expect(screen.getByTestId('configure-agents-desktop-codex').getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  test('resolved presence keeps newly revealed desktop targets after visible targets', async () => {
    states = {
      'claude-code': { installed: null },
      codex: { installed: null },
      cursor: { installed: true },
    } as Record<string, InstallState>;
    renderSection(async () =>
      result({ ...snapshotWith(), detection: { detected: [], probed: true } }),
    );
    await waitFor(() => expect(screen.queryByTestId('configure-agents-desktop-codex')).toBeNull());
    await expandDesktop();
    const rows = screen.getAllByTestId(/^configure-agents-desktop-row-/);
    expect(rows[0].getAttribute('data-testid')).toBe('configure-agents-desktop-row-cursor');
  });

  test('focus returns to the group when detection removes its disclosure', async () => {
    renderSection();
    await screen.findByText('Claude Agent');
    const fold = screen.getByTestId('configure-agents-desktop-show-more');
    fold.focus();
    states = { ...states, codex: { installed: true } };
    fireEvent.click(fold);
    expect(screen.queryByTestId('configure-agents-desktop-show-more')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'External apps' }));
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

describe('AgentConnectionsSection — Terminal group (docked terminal present)', () => {
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
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('configure-agents-terminal-codex')).toBeNull();
    expect(screen.getByTestId('configure-agents-terminal-claude')).toBeTruthy();

    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
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

  test('an absent CLI with OpenKnowledge files says so, and keeps Install as its main action', async () => {
    terminalLaunchValue = { installedClis: { claude: true, pi: false } };
    reloadEnabledAgentsFromStorage();
    const snapshot = snapshotWith([satisfierId('pi', 'skill', 'user')]);
    renderSection(async () => result(snapshot));

    await screen.findByTestId('configure-agents-terminal-claude');
    await expandTerminal();
    const row = await waitFor(() => terminalRow('pi'));

    await waitFor(() =>
      expect(row.textContent ?? '').toContain('Not installed · OpenKnowledge files present'),
    );
    expect(within(row).getByRole('link', { name: /^Install\b/ })).toBeTruthy();
    expect(
      within(row).getByRole('button', { name: 'Remove OpenKnowledge from Pi CLI' }),
    ).toBeTruthy();
  });

  test('an absent CLI with nothing on disk offers no cleanup and no residual hint', async () => {
    terminalLaunchValue = { installedClis: { claude: true, pi: false } };
    reloadEnabledAgentsFromStorage();
    renderSection(async () => result(snapshotWith([])));

    await screen.findByTestId('configure-agents-terminal-claude');
    await expandTerminal();
    const row = await waitFor(() => terminalRow('pi'));

    await waitFor(() => expect(row.textContent ?? '').toContain('Not installed'));
    expect(row.textContent ?? '').not.toContain('OpenKnowledge files present');
    expect(within(row).queryByRole('button', { name: /^Remove\b/ })).toBeNull();
  });

  test('the cleanup button stays out of the switch accessible description', async () => {
    terminalLaunchValue = { installedClis: { claude: true, pi: false } };
    reloadEnabledAgentsFromStorage();
    const snapshot = snapshotWith([satisfierId('pi', 'skill', 'user')]);
    renderSection(async () => result(snapshot));

    await screen.findByTestId('configure-agents-terminal-claude');
    await expandTerminal();
    await waitFor(() => terminalRow('pi'));
    const toggle = screen.getByTestId('configure-agents-terminal-pi');

    await waitFor(() =>
      expect(accessibleDescription(toggle)).toContain('OpenKnowledge files present'),
    );
    expect(accessibleDescription(toggle)).not.toContain('Remove');
  });

  test('cleanup on an absent CLI opens the removal dialog for that agent', async () => {
    terminalLaunchValue = { installedClis: { claude: true, pi: false } };
    reloadEnabledAgentsFromStorage();
    const snapshot = snapshotWith([satisfierId('pi', 'skill', 'user')]);
    renderSection(async () => result(snapshot));

    await screen.findByTestId('configure-agents-terminal-claude');
    await expandTerminal();
    const row = await waitFor(() => terminalRow('pi'));
    const remove = await waitFor(() =>
      within(row).getByRole('button', { name: 'Remove OpenKnowledge from Pi CLI' }),
    );

    fireEvent.click(remove);
    expect(await screen.findByText('Remove OpenKnowledge from Pi?')).toBeTruthy();
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

describe('AgentConnectionsSection — connection status and action', () => {
  beforeEach(() => {
    terminalLaunchValue = { installedClis: { claude: true } };
    reloadEnabledAgentsFromStorage();
  });
  afterEach(() => {
    terminalLaunchValue = null;
  });

  function disableClaudeCli(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'terminal:claude': false }));
    reloadEnabledAgentsFromStorage();
  }

  test('a connectable CLI with its MCP entry reads Connected and offers Manage', async () => {
    const snapshot = snapshotWith([satisfierId('claude', 'mcp', 'project')]);
    renderSection(async () => result(snapshot));

    await screen.findByTestId('configure-agents-terminal-claude');
    await waitFor(() => expect(within(terminalRow('claude')).getByText('Connected')).toBeTruthy());
    expect(within(terminalRow('claude')).getByRole('button', { name: /^Manage\b/ })).toBeTruthy();
  });

  test('a connected Claude row carries no follow-up hint, because Claude asks on its own', async () => {
    const snapshot = snapshotWith([satisfierId('claude', 'mcp', 'project')]);
    renderSection(async () => result(snapshot));

    const row = await waitFor(() => terminalRow('claude'));
    await waitFor(() => expect(within(row).getByText('Connected')).toBeTruthy());
    expect(within(row).queryByTestId('configure-agents-terminal-row-claude-followup')).toBeNull();
    expect(screen.queryByTestId('configure-agents-desktop-row-claude-code-followup')).toBeNull();
  });

  test('a connected Codex row carries no follow-up hint either', async () => {
    terminalLaunchValue = { installedClis: { claude: true, codex: true } };
    reloadEnabledAgentsFromStorage();
    renderSection(async () => result(snapshotWith([satisfierId('codex', 'mcp', 'project')])));

    const row = await waitFor(() => terminalRow('codex'));
    await waitFor(() => expect(within(row).getByText('Connected')).toBeTruthy());
    expect(within(row).queryByTestId('configure-agents-terminal-row-codex-followup')).toBeNull();
  });

  test("Cursor's enable-in-settings hint sits on the desktop row as plain text, not a live region", async () => {
    terminalLaunchValue = { installedClis: { claude: true, cursor: true } };
    states = { ...states, cursor: { installed: true } } as Record<string, InstallState>;
    reloadEnabledAgentsFromStorage();
    renderSection(async () => result(snapshotWith([satisfierId('cursor', 'mcp', 'project')])));

    const desktopHint = await screen.findByTestId('configure-agents-desktop-row-cursor-followup');
    expect(desktopHint.getAttribute('role')).toBeNull();
    expect(desktopHint.textContent).toBe(
      "Cursor keeps project MCP servers off until you turn them on under Customize → MCPs. OpenKnowledge can't see that setting.",
    );
    expect(screen.queryByTestId('configure-agents-terminal-row-cursor-followup')).toBeNull();
  });

  test("a connected Cursor row's toggle is described by its follow-up hint", async () => {
    terminalLaunchValue = { installedClis: { claude: true, cursor: true } };
    states = { ...states, cursor: { installed: true } } as Record<string, InstallState>;
    reloadEnabledAgentsFromStorage();
    renderSection(async () => result(snapshotWith([satisfierId('cursor', 'mcp', 'project')])));

    await screen.findByTestId('configure-agents-desktop-row-cursor-followup');
    const toggle = screen.getByTestId('configure-agents-desktop-cursor');
    expect(accessibleDescription(toggle)).toContain(
      'Cursor keeps project MCP servers off until you turn them on under Customize → MCPs.',
    );
  });

  test('no hint when the machine-wide entry already carries the requirement', async () => {
    terminalLaunchValue = { installedClis: { claude: true, cursor: true } };
    states = { ...states, cursor: { installed: true } } as Record<string, InstallState>;
    reloadEnabledAgentsFromStorage();
    renderSection(async () =>
      result(
        snapshotWith([
          satisfierId('cursor', 'mcp', 'project'),
          satisfierId('cursor', 'mcp', 'user'),
        ]),
      ),
    );

    await screen.findByTestId('configure-agents-desktop-cursor');
    const row = desktopRow('cursor');
    await waitFor(() => expect(within(row).getByText('Connected')).toBeTruthy());
    expect(within(row).queryByTestId('configure-agents-desktop-row-cursor-followup')).toBeNull();
  });

  test('a row with nothing installed carries no follow-up hint', async () => {
    terminalLaunchValue = { installedClis: { claude: true, cursor: true } };
    states = { ...states, cursor: { installed: true } } as Record<string, InstallState>;
    reloadEnabledAgentsFromStorage();
    renderSection(async () => result(snapshotWith([])));

    await screen.findByTestId('configure-agents-desktop-cursor');
    const row = desktopRow('cursor');
    await waitFor(() => expect(within(row).getByText('Not connected')).toBeTruthy());
    expect(within(row).queryByTestId('configure-agents-desktop-row-cursor-followup')).toBeNull();
  });

  test('Not connected shows only when the row is on', async () => {
    renderSection(async () => result(snapshotWith([])));
    const onRow = await waitFor(() => terminalRow('claude'));
    expect(within(onRow).getByText('Not connected')).toBeTruthy();

    cleanup();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'terminal:claude': false }));
    reloadEnabledAgentsFromStorage();
    renderSection(async () => result(snapshotWith([])));
    const offRow = await waitFor(() => terminalRow('claude'));
    expect(within(offRow).queryByText('Not connected')).toBeNull();
    expect(within(offRow).getByRole('switch')).toBeTruthy();
  });

  test('an enabled CLI with nothing installed reads Not connected and offers to connect', async () => {
    renderSection(async () => result(snapshotWith([])));

    await screen.findByTestId('configure-agents-terminal-claude');
    await waitFor(() =>
      expect(within(terminalRow('claude')).getByText('Not connected')).toBeTruthy(),
    );
    expect(
      within(terminalRow('claude')).getByRole('button', { name: /^Add MCP & skill\b/ }),
    ).toBeTruthy();
  });

  test('the registry ruling a CLI absent locks the switch before the PATH probe answers', async () => {
    terminalLaunchValue = { installedClis: {} };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'terminal:hermes': false }));
    reloadEnabledAgentsFromStorage();
    renderSection(async () => result(snapshotWith([])));

    const row = await screen.findByTestId('configure-agents-terminal-row-hermes');
    expect(within(row).getByText('Not installed')).toBeTruthy();
    expect(
      screen.getByTestId('configure-agents-terminal-hermes').getAttribute('data-disabled'),
    ).toBe('');
  });

  test('a CLI whose own probe declined shows no status line, and stays usable', async () => {
    renderSection(async () => result(partiallyUnprobedSnapshot('claude')));

    await screen.findByTestId('configure-agents-terminal-claude');
    await waitFor(() => expect(within(terminalRow('claude')).getByRole('button')).toBeTruthy());
    const row = terminalRow('claude');
    expect(within(row).queryByText('Connected')).toBeNull();
    expect(within(row).queryByText('Not connected')).toBeNull();
    expect(within(row).getByRole('switch')).toBeTruthy();
  });

  test('a disabled CLI with files on disk offers Remove, not a connect action', async () => {
    disableClaudeCli();
    renderSection(async () => result(snapshotWith(diskSatisfierIds('claude'))));

    await screen.findByTestId('configure-agents-terminal-claude');
    await waitFor(() =>
      expect(within(terminalRow('claude')).getByRole('button', { name: /^Remove\b/ })).toBeTruthy(),
    );
    const row = terminalRow('claude');
    expect(within(row).queryByRole('button', { name: /^Add MCP & skill\b/ })).toBeNull();
    expect(within(row).getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  test('a disabled CLI with nothing installed offers no action button', async () => {
    disableClaudeCli();
    renderSection(async () => result(snapshotWith([])));

    await screen.findByTestId('configure-agents-terminal-claude');
    await expandDesktop();
    await waitFor(() => expect(screen.getByTestId('agent-connection-lm-studio')).toBeTruthy());
    expect(within(terminalRow('claude')).queryByRole('button')).toBeNull();
    expect(within(terminalRow('claude')).getByRole('switch')).toBeTruthy();
  });

  test('pressing Remove opens the confirmation dialog listing the files to delete', async () => {
    disableClaudeCli();
    const user = userEvent.setup();
    renderSection(async () => result(snapshotWith(diskSatisfierIds('claude'))));

    await screen.findByTestId('configure-agents-terminal-claude');
    await waitFor(() =>
      expect(within(terminalRow('claude')).getByRole('button', { name: /^Remove\b/ })).toBeTruthy(),
    );
    await user.click(within(terminalRow('claude')).getByRole('button', { name: /^Remove\b/ }));

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Remove OpenKnowledge from Claude?',
    });
    expect(within(dialog).getByText('Project MCP server')).toBeTruthy();
  });

  test('a tool uninstalled after setup is off by default yet still offers Remove', async () => {
    terminalLaunchValue = { installedClis: { claude: false } };
    states = { 'claude-code': { installed: false } } as Record<string, InstallState>;
    reloadEnabledAgentsFromStorage();
    const snapshot: HostSnapshot = {
      ...snapshotWith([satisfierId('claude', 'mcp', 'project')]),
      detection: { detected: [], probed: true },
    };
    renderSection(async () => result(snapshot));

    fireEvent.click(await screen.findByTestId('configure-agents-terminal-show-more'));
    await waitFor(() =>
      expect(within(terminalRow('claude')).getByRole('button', { name: /^Remove\b/ })).toBeTruthy(),
    );
    expect(within(terminalRow('claude')).getByRole('switch').getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  test('focus lands on the group heading after a cleanup removes the row control', async () => {
    terminalLaunchValue = { installedClis: { claude: true, pi: false } };
    reloadEnabledAgentsFromStorage();
    const seeded = snapshotWith([satisfierId('pi', 'skill', 'user')]);
    const cleared = snapshotWith([]);
    let applied = false;
    renderSection(async () => {
      const snap = applied ? cleared : seeded;
      applied = true;
      return result(snap);
    });

    await screen.findByTestId('configure-agents-terminal-claude');
    fireEvent.click(await screen.findByTestId('configure-agents-terminal-show-more'));
    const row = await waitFor(() => terminalRow('pi'));
    const remove = await waitFor(() =>
      within(row).getByRole('button', { name: 'Remove OpenKnowledge from Pi CLI' }),
    );
    const heading = row.closest('section')?.querySelector('h4') as HTMLElement;
    expect(heading).toBeTruthy();

    remove.focus();
    expect(document.activeElement).toBe(remove);

    fireEvent.click(remove);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitForElementToBeRemoved(() => screen.queryByRole('alertdialog'));
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  test('a paired row whose sibling is present claims no residue and offers no cleanup', async () => {
    terminalLaunchValue = { installedClis: { claude: false } };
    states = { 'claude-code': { installed: true } } as Record<string, InstallState>;
    reloadEnabledAgentsFromStorage();
    const snapshot: HostSnapshot = {
      ...snapshotWith([satisfierId('claude', 'mcp', 'project')]),
      detection: { detected: [], probed: true },
    };
    renderSection(async () => result(snapshot));

    fireEvent.click(await screen.findByTestId('configure-agents-terminal-show-more'));
    const row = await waitFor(() => terminalRow('claude'));

    await waitFor(() => expect(row.textContent ?? '').toContain('Not installed'));
    expect(row.textContent ?? '').not.toContain('OpenKnowledge files present');
    expect(within(row).queryByRole('button', { name: /^Remove OpenKnowledge from/ })).toBeNull();
  });

  test('a paired row whose sibling presence is unknown makes no residue claim', async () => {
    terminalLaunchValue = null;
    states = { codex: { installed: false } } as Record<string, InstallState>;
    reloadEnabledAgentsFromStorage();
    const snapshot: HostSnapshot = {
      ...snapshotWith([satisfierId('codex', 'mcp', 'project')]),
      detection: { detected: [], probed: false },
    };
    renderSection(async () => result(snapshot));

    fireEvent.click(await screen.findByTestId('configure-agents-desktop-show-more'));
    const row = await waitFor(() => desktopRow('codex'));

    await waitFor(() => expect(row.textContent ?? '').toContain('Not installed'));
    expect(row.textContent ?? '').not.toContain('OpenKnowledge files present');
    expect(within(row).queryByRole('button', { name: /^Remove OpenKnowledge from/ })).toBeNull();
  });

  test('a desktop row carries the same residual hint and cleanup link', async () => {
    terminalLaunchValue = { installedClis: { claude: true, codex: false } };
    states = { codex: { installed: false } } as Record<string, InstallState>;
    reloadEnabledAgentsFromStorage();
    const snapshot: HostSnapshot = {
      ...snapshotWith([satisfierId('codex', 'mcp', 'project')]),
      detection: { detected: [], probed: true },
    };
    renderSection(async () => result(snapshot));

    fireEvent.click(await screen.findByTestId('configure-agents-desktop-show-more'));
    const row = await waitFor(() => desktopRow('codex'));

    await waitFor(() =>
      expect(row.textContent ?? '').toContain('Not installed · OpenKnowledge files present'),
    );
    expect(within(row).getByRole('button', { name: /^Remove OpenKnowledge from/ })).toBeTruthy();
  });

  test('an unlaunchable row carries the residual hint and cleanup link too', async () => {
    const snapshot: HostSnapshot = {
      ...snapshotWith(diskSatisfierIds('lm-studio')),
      detection: { detected: [], probed: true },
    };
    renderSection(async () => result(snapshot));

    fireEvent.click(await screen.findByTestId('configure-agents-desktop-show-more'));
    const row = await waitFor(() => screen.getByTestId('agent-connection-lm-studio'));
    await waitFor(() => expect(row.textContent ?? '').toContain('OpenKnowledge files present'));
    expect(within(row).getByRole('button', { name: /^Remove OpenKnowledge from/ })).toBeTruthy();
  });

  test('an External-app row shows its connection status too', async () => {
    renderSection(async () => result(snapshotWith([satisfierId('claude', 'mcp', 'project')])));

    const sw = await screen.findByTestId('configure-agents-desktop-claude-code');
    const row = sw.parentElement?.parentElement as HTMLElement;
    await waitFor(() => expect(within(row).getByText('Connected')).toBeTruthy());
    expect(within(row).getByRole('button', { name: /^Manage\b/ })).toBeTruthy();
  });
});

describe('AgentConnectionsSection — connect dialog on switch press', () => {
  beforeEach(() => {
    terminalLaunchValue = { installedClis: { claude: true } };
    reloadEnabledAgentsFromStorage();
  });
  afterEach(() => {
    terminalLaunchValue = null;
  });

  function disableClaudeCli(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'terminal:claude': false }));
    reloadEnabledAgentsFromStorage();
  }

  test('switching on an unconnected CLI opens the connect dialog', async () => {
    disableClaudeCli();
    renderSection(async () => result(snapshotWith([])));

    const toggle = await screen.findByTestId('configure-agents-terminal-claude');
    await expandDesktop();
    await waitFor(() => expect(screen.getByTestId('agent-connection-lm-studio')).toBeTruthy());
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);

    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(overrides()['terminal:claude']).toBe(true);
  });

  test('cancelling the connect dialog puts the switch back to an explicit off', async () => {
    disableClaudeCli();
    const user = userEvent.setup();
    renderSection(async () => result(snapshotWith([])));

    const toggle = await screen.findByTestId('configure-agents-terminal-claude');
    await expandDesktop();
    await waitFor(() => expect(screen.getByTestId('agent-connection-lm-studio')).toBeTruthy());
    fireEvent.click(toggle);
    const dialog = await screen.findByRole('dialog');
    expect(overrides()['terminal:claude']).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(overrides()['terminal:claude']).toBe(false);
    expect(
      screen.getByTestId('configure-agents-terminal-claude').getAttribute('aria-checked'),
    ).toBe('false');
  });

  test('switching on again and saving keeps the switch on and writes the files', async () => {
    disableClaudeCli();
    const user = userEvent.setup();
    const intentsSeen: ApplyIntent[][] = [];
    renderSection(async (intents) => {
      intentsSeen.push([...intents]);
      const wrote = intents.some((intent) => intent.desired === 'present');
      return result(
        wrote ? snapshotWith([satisfierId('claude', 'mcp', 'project')]) : snapshotWith([]),
      );
    });

    const toggle = await screen.findByTestId('configure-agents-terminal-claude');
    await expandDesktop();
    await waitFor(() => expect(screen.getByTestId('agent-connection-lm-studio')).toBeTruthy());
    fireEvent.click(toggle);
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const writeIntents = intentsSeen.flat().filter((intent) => intent.desired === 'present');
    expect(writeIntents.length).toBeGreaterThan(0);
    expect(
      screen.getByTestId('configure-agents-terminal-claude').getAttribute('aria-checked'),
    ).toBe('true');
    expect(overrides()['terminal:claude']).toBe(true);
  });

  test('opening the page with unconnected tools installed opens zero dialogs', async () => {
    terminalLaunchValue = { installedClis: { claude: true, codex: true } };
    reloadEnabledAgentsFromStorage();
    renderSection(async () => result(snapshotWith([])));

    await screen.findByTestId('configure-agents-terminal-claude');
    await waitFor(() =>
      expect(within(terminalRow('claude')).getByText('Not connected')).toBeTruthy(),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      within(terminalRow('claude')).getByRole('button', { name: /^Add MCP & skill\b/ }),
    ).toBeTruthy();
  });

  test('cancelling a Connect-button dialog leaves the switch untouched', async () => {
    const user = userEvent.setup();
    renderSection(async () => result(snapshotWith([])));

    const toggle = await screen.findByTestId('configure-agents-terminal-claude');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    const connect = await within(terminalRow('claude')).findByRole('button', {
      name: /^Add MCP & skill\b/,
    });
    await user.click(connect);
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      screen.getByTestId('configure-agents-terminal-claude').getAttribute('aria-checked'),
    ).toBe('true');
    expect(overrides()['terminal:claude']).toBeUndefined();
  });
});

describe('AgentConnectionsSection — an agent nothing can open', () => {
  beforeEach(() => {
    terminalLaunchValue = { installedClis: { claude: true } };
    reloadEnabledAgentsFromStorage();
  });
  afterEach(() => {
    terminalLaunchValue = null;
  });

  test('LM Studio rides with the external apps, since nothing can open it', async () => {
    renderSection(async () => result(snapshotWith([])));

    await screen.findByText('External apps');
    await expandDesktop();
    expect(screen.getByTestId('agent-connection-lm-studio')).toBeTruthy();
    expect(screen.queryByText('Connect only')).toBeNull();
  });

  test('its row carries no switch, having no launcher entry to control', async () => {
    renderSection(async () => result(snapshotWith([])));

    await expandDesktop();
    const row = await screen.findByTestId('agent-connection-lm-studio');
    expect(within(row).queryByRole('switch')).toBeNull();
  });

  test('removal is reachable from the row once its setup is on disk', async () => {
    renderSection(async () => result(snapshotWith(diskSatisfierIds('lm-studio'))));

    await expandDesktop();
    const row = await screen.findByTestId('agent-connection-lm-studio');
    await waitFor(() =>
      expect(within(row).getByRole('button', { name: /^Remove\b/ })).toBeTruthy(),
    );
  });

  test('search finds it and filters the launchable rows out', async () => {
    renderSection(async () => result(snapshotWith([])));

    await screen.findByText('External apps');
    fireEvent.change(screen.getByTestId('configure-agents-search'), {
      target: { value: 'lm studio' },
    });

    await waitFor(() => expect(screen.getByTestId('agent-connection-lm-studio')).toBeTruthy());
    expect(screen.queryByTestId('configure-agents-desktop-show-more')).toBeNull();
    expect(screen.queryByText('Terminal')).toBeNull();
  });

  test('Claude Desktop has no connection row — OK writes nothing for it', async () => {
    renderSection(async () => result(snapshotWith([])));

    await screen.findByText('External apps');
    expect(screen.queryByTestId('agent-connection-claude-desktop')).toBeNull();
    expect(screen.getByTestId('configure-agents-desktop-claude-code')).toBeTruthy();
    expect(screen.getAllByText('Claude Desktop')).toHaveLength(1);
    expect(screen.queryByText('Claude Desktop (chat)')).toBeNull();
  });
});

describe('AgentConnectionsSection — no connection row lost on any host', () => {
  beforeEach(() => {
    reloadEnabledAgentsFromStorage();
  });
  afterEach(() => {
    terminalLaunchValue = null;
  });

  function connectionRowFor(agentId: AgentId): HTMLElement | null {
    const connectOnly = screen.queryByTestId(`agent-connection-${agentId}`);
    if (connectOnly) return connectOnly;
    const cli = TERMINAL_CLI_IDS.find((c) => agentIdForTerminalCli(c) === agentId);
    if (cli) {
      const row = screen.queryByTestId(`configure-agents-terminal-row-${cli}`);
      if (row) return row;
    }
    const target = VISIBLE_HANDOFF_TARGETS.find((tg) => agentIdForHandoffTarget(tg.id) === agentId);
    if (target) {
      const row = screen.queryByTestId(`configure-agents-desktop-${target.id}`);
      if (row) return row;
    }
    return null;
  }

  test('desktop host keeps a connection row for every agent that has one today', async () => {
    terminalLaunchValue = {
      installedClis: Object.fromEntries(TERMINAL_CLI_IDS.map((cli) => [cli, cli === 'claude'])),
    };
    reloadEnabledAgentsFromStorage();
    renderSection(async () => result(snapshotWith([])));
    await screen.findByText('External apps');

    expect(connectionRowFor('opencode')).toBeNull();
    fireEvent.click(await screen.findByTestId('configure-agents-terminal-show-more'));
    expect(connectionRowFor('opencode')).not.toBeNull();

    await expandDesktop();
    expect(CONNECTION_ROW_AGENT_IDS.length).toBeGreaterThanOrEqual(10);
    for (const agentId of CONNECTION_ROW_AGENT_IDS) {
      expect(
        connectionRowFor(agentId),
        `no connection row for ${agentId} on desktop`,
      ).not.toBeNull();
    }
  });

  test('web host keeps a connection row for every agent, terminal CLIs included', async () => {
    terminalLaunchValue = null;
    reloadEnabledAgentsFromStorage();
    renderSection(async () => result(snapshotWith([])));
    await screen.findByText('External apps');

    expect(screen.getByText('Terminal')).toBeTruthy();
    await expandDesktop();
    expect(CONNECTION_ROW_AGENT_IDS.length).toBeGreaterThanOrEqual(10);
    for (const agentId of CONNECTION_ROW_AGENT_IDS) {
      expect(connectionRowFor(agentId), `no connection row for ${agentId} on web`).not.toBeNull();
    }
  });

  test('a web terminal row reports and configures, but offers no switch', async () => {
    terminalLaunchValue = null;
    reloadEnabledAgentsFromStorage();
    renderSection(async () => result(snapshotWith([])));
    await screen.findByText('Terminal');

    const row = await screen.findByTestId('configure-agents-terminal-row-claude');
    expect(within(row).queryByRole('switch')).toBeNull();
  });
});

describe('AgentConnectionsSection — degraded install-state read', () => {
  beforeEach(() => {
    terminalLaunchValue = { installedClis: { claude: true, codex: false } };
    reloadEnabledAgentsFromStorage();
  });
  afterEach(() => {
    terminalLaunchValue = null;
  });

  test('a row action names the agent it acts on, not just the verb', async () => {
    renderSection(async () => result(snapshotWith(diskSatisfierIds('claude'))));

    const manage = await waitFor(() =>
      within(terminalRow('claude')).getByRole('button', { name: /^Manage\b/ }),
    );
    expect(manage.getAttribute('aria-label')).toBe('Manage Claude CLI');
    expect(manage.textContent).toContain('Manage');
  });

  const READ_FAILED_NOTICE = "Couldn't check which tools are connected.";

  test('a failed read shows a retryable notice while every group and row still renders', async () => {
    renderSection(async () => result(null, false));

    await screen.findByText(READ_FAILED_NOTICE);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();

    expect(screen.getByText('In app')).toBeTruthy();
    expect(screen.getByText('Terminal')).toBeTruthy();
    expect(screen.getByText('External apps')).toBeTruthy();
    expect(screen.getByText('Claude Agent')).toBeTruthy();
    expect(screen.getByTestId('configure-agents-terminal-claude')).toBeTruthy();
    expect(screen.getByTestId('configure-agents-desktop-claude-code')).toBeTruthy();
  });

  test('a host that probed nothing but reported ok still shows the notice', async () => {
    renderSection(async () =>
      result(
        { probes: { env: 'desktop', satisfiers: {} }, detection: { detected: [], probed: false } },
        true,
      ),
    );

    await screen.findByText(READ_FAILED_NOTICE);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  test('a host that answered nothing counts as a failed read, keys or no keys', async () => {
    const allUnprobed = Object.fromEntries(
      Object.keys(snapshotWith([]).probes.satisfiers).map((id) => [id, { state: 'unprobed' }]),
    );
    renderSection(async () =>
      result(
        {
          probes: { env: 'local-web', satisfiers: allUnprobed },
          detection: { detected: [], probed: false },
        },
        true,
      ),
    );

    await screen.findByText(READ_FAILED_NOTICE);
    const section = screen.getByTestId('settings-configure-agents');
    for (const label of [/^Add MCP & skill/, /^Manage/, /^Remove/]) {
      expect(within(section).queryByRole('button', { name: label })).toBeNull();
    }
  });

  test('a factless read offers no row action, only Retry', async () => {
    renderSection(async () =>
      result(
        { probes: { env: 'desktop', satisfiers: {} }, detection: { detected: [], probed: false } },
        true,
      ),
    );

    await screen.findByText(READ_FAILED_NOTICE);
    const section = screen.getByTestId('settings-configure-agents');
    for (const label of [/^Add MCP & skill/, /^Manage/, /^Remove/, /^Install/]) {
      expect(within(section).queryByRole('button', { name: label })).toBeNull();
    }
    expect(screen.getByTestId('configure-agents-terminal-claude')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  test('a host that read fine but cannot apply changes shows no notice', async () => {
    renderSection(async () => result(snapshotWith([]), false));

    await screen.findByText('External apps');
    expect(screen.queryByText(READ_FAILED_NOTICE)).toBeNull();
  });

  test('a failed read costs the connection column, not any rows', async () => {
    renderSection(async () => result(null, false));

    await screen.findByText(READ_FAILED_NOTICE);
    expect(screen.getByTestId('agent-connection-lm-studio')).toBeTruthy();
    const row = screen.getByTestId('agent-connection-lm-studio');
    expect(within(row).queryByRole('button')).toBeNull();
  });

  test('Retry keeps its own button mounted so focus survives the attempt', async () => {
    renderSection(async () => result(null, false));
    await screen.findByText(READ_FAILED_NOTICE);

    const retry = screen.getByRole('button', { name: 'Retry' });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBe(retry));
    expect(document.activeElement).toBe(retry);
  });

  test('an External-apps row wires its hint to its switch', async () => {
    renderSection();
    await expandDesktop();
    const toggle = await screen.findByTestId('configure-agents-desktop-codex');
    const row = screen.getByTestId('configure-agents-desktop-row-codex');

    const hint = within(row).getByText('Not installed');
    expect(hint.id).toBe('configure-agents-desktop-row-codex-hint');
    expect((toggle.getAttribute('aria-describedby') ?? '').split(' ')).toContain(hint.id);
  });

  test('an In-app row carries a handle so its disabled switch can be explained', async () => {
    renderSection();
    await screen.findByText('In app');
    expect(screen.getAllByTestId(/^configure-agents-in-app-row-/).length).toBeGreaterThan(0);
  });

  test('the action button carries the description itself, not a wrapper', async () => {
    renderSection(async () => result(snapshotWith(diskSatisfierIds('claude'))));
    const row = await waitFor(() => terminalRow('claude'));
    const status = within(row).getByText('Connected');
    const manage = within(row).getByRole('button', { name: /^Manage/ });
    expect(manage.getAttribute('aria-describedby')).toBe(status.parentElement?.id ?? status.id);
  });

  test('a row control points at the status and hint that qualify it', async () => {
    terminalLaunchValue = { installedClis: {} };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'terminal:hermes': false }));
    reloadEnabledAgentsFromStorage();
    renderSection(async () => result(snapshotWith([])));

    const row = await screen.findByTestId('configure-agents-terminal-row-hermes');
    const hint = within(row).getByText('Not installed');
    expect(hint.id).toBeTruthy();
    const described =
      screen.getByTestId('configure-agents-terminal-hermes').getAttribute('aria-describedby') ?? '';
    expect(described.split(' ')).toContain(hint.id);
  });

  test('a switch still toggles and persists while the read is failing', async () => {
    renderSection(async () => result(null, false));

    const toggle = await screen.findByTestId('configure-agents-terminal-claude');
    fireEvent.click(toggle);
    await waitFor(() => expect(overrides()['terminal:claude']).toBe(false));
  });

  test('retrying a failed read populates connection status without a page reload', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const apply = async () => {
      calls += 1;
      return calls === 1
        ? result(null, false)
        : result(snapshotWith([satisfierId('claude', 'mcp', 'project')]));
    };
    renderSection(apply);

    await screen.findByText(READ_FAILED_NOTICE);
    expect(within(terminalRow('claude')).queryByText('Connected')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(within(terminalRow('claude')).getByText('Connected')).toBeTruthy());
    expect(screen.queryByText(READ_FAILED_NOTICE)).toBeNull();
  });

  test('search still filters across groups while the read is failing', async () => {
    renderSection(async () => result(null, false));
    await screen.findByText('Claude Agent');

    fireEvent.change(screen.getByTestId('configure-agents-search'), {
      target: { value: 'codex' },
    });
    await waitFor(() => expect(screen.queryByText('Claude Agent')).toBeNull());
    expect(screen.getByTestId('configure-agents-desktop-codex')).toBeTruthy();
  });
});

describe('AgentConnectionsSection — missing skill and paired rows', () => {
  beforeEach(() => {
    terminalLaunchValue = { installedClis: { claude: true } };
    reloadEnabledAgentsFromStorage();
  });
  afterEach(() => {
    terminalLaunchValue = null;
  });

  test('the dialog suggests the skill when the MCP entry is present but the skill is not', async () => {
    const user = userEvent.setup();
    renderSection(async () => result(snapshotWith([satisfierId('claude', 'mcp', 'project')])));

    await screen.findByTestId('configure-agents-terminal-claude');
    await user.click(within(terminalRow('claude')).getByRole('button', { name: /^Manage\b/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/loses edit attribution and the live preview/i)).toBeTruthy();
  });

  test('the dialog for an agent with two rows says the setup covers both', async () => {
    const user = userEvent.setup();
    renderSection(async () => result(snapshotWith([])));

    await screen.findByTestId('configure-agents-terminal-claude');
    await user.click(
      within(terminalRow('claude')).getByRole('button', { name: /^Add MCP & skill\b/ }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/changes here apply to both/i)).toBeTruthy();
  });

  test('switching on a CLI that only lacks its skill opens no dialog', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'terminal:claude': false }));
    reloadEnabledAgentsFromStorage();
    renderSection(async () => result(snapshotWith([satisfierId('claude', 'mcp', 'project')])));

    const toggle = await screen.findByTestId('configure-agents-terminal-claude');
    await waitFor(() => expect(within(terminalRow('claude')).getByText('Connected')).toBeTruthy());
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);

    expect(overrides()['terminal:claude']).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('the skill suggestion clears once the skill is selected', async () => {
    const user = userEvent.setup();
    renderSection(async () => result(snapshotWith([satisfierId('claude', 'mcp', 'project')])));

    await screen.findByTestId('configure-agents-terminal-claude');
    await user.click(within(terminalRow('claude')).getByRole('button', { name: /^Manage\b/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/loses edit attribution and the live preview/i)).toBeTruthy();

    await user.click(within(dialog).getByRole('checkbox', { name: 'Project skill' }));

    await waitFor(() =>
      expect(within(dialog).queryByText(/loses edit attribution and the live preview/i)).toBeNull(),
    );
  });

  test('the shared-setup note shows on every host, since the pairing is not host-dependent', async () => {
    terminalLaunchValue = null;
    reloadEnabledAgentsFromStorage();
    const user = userEvent.setup();
    renderSection(async () => result(snapshotWith([])));

    const sw = await screen.findByTestId('configure-agents-desktop-claude-code');
    const row = sw.parentElement?.parentElement as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /^Add MCP & skill\b/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/changes here apply to both/i)).toBeTruthy();
  });

  test('connecting one row shows the paired row connected too', async () => {
    const user = userEvent.setup();
    const apply = async (intents: readonly ApplyIntent[]) =>
      intents.length === 0
        ? result(snapshotWith([]))
        : result(snapshotWith(diskSatisfierIds('claude')));
    renderSection(apply);

    await screen.findByTestId('configure-agents-terminal-claude');
    await waitFor(() =>
      expect(within(terminalRow('claude')).getByText('Not connected')).toBeTruthy(),
    );

    await user.click(
      within(terminalRow('claude')).getByRole('button', { name: /^Add MCP & skill\b/ }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await waitFor(() => expect(within(terminalRow('claude')).getByText('Connected')).toBeTruthy());
    const desktopRow = screen.getByTestId('configure-agents-desktop-claude-code').parentElement
      ?.parentElement as HTMLElement;
    expect(within(desktopRow).getByText('Connected')).toBeTruthy();
  });
});

describe('AgentConnectionsSection — an absent tool locks its switch', () => {
  afterEach(() => {
    terminalLaunchValue = null;
  });

  async function reload(): Promise<void> {
    const { reloadEnabledAgentsFromStorage } = await import('@/lib/acp/enabled-agents');
    reloadEnabledAgentsFromStorage();
  }

  async function expandTerminalFold(): Promise<void> {
    const more = screen.queryByTestId('configure-agents-terminal-show-more');
    if (more !== null) fireEvent.click(more);
  }

  test('an absent CLI left off cannot be switched on', async () => {
    terminalLaunchValue = { installedClis: { claude: true, codex: false } };
    await reload();
    renderSection();
    await expandTerminalFold();

    const toggle = await screen.findByTestId('configure-agents-terminal-codex');
    expect(toggle.getAttribute('data-disabled')).toBe('');
  });

  test('an absent CLI the user had turned on stays switchable, so the choice can be undone', async () => {
    terminalLaunchValue = { installedClis: { claude: true, codex: false } };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'terminal:codex': true }));
    await reload();
    renderSection();
    await expandTerminalFold();

    const toggle = await screen.findByTestId('configure-agents-terminal-codex');
    expect(toggle.getAttribute('data-disabled')).toBeNull();

    fireEvent.click(toggle);
    await waitFor(() => expect(overrides()['terminal:codex']).toBe(false));
  });

  test('a probe that has not answered leaves the switch alone', async () => {
    terminalLaunchValue = { installedClis: { claude: true } };
    await reload();
    renderSection();
    await expandTerminalFold();

    const toggle = await screen.findByTestId('configure-agents-terminal-codex');
    expect(toggle.getAttribute('data-disabled')).toBeNull();
  });

  test('a present CLI is never locked', async () => {
    terminalLaunchValue = { installedClis: { claude: true, codex: true } };
    await reload();
    renderSection();

    const toggle = await screen.findByTestId('configure-agents-terminal-codex');
    expect(toggle.getAttribute('data-disabled')).toBeNull();
  });
});

describe('a host that cannot manage connections', () => {
  test('says so once and offers no row actions', async () => {
    renderSection(async () => ({
      ok: false,
      unavailable: true,
      error: 'Managing AI tool connections is unavailable in this build.',
      report: EMPTY_REPORT,
      snapshot: snapshotWith([]),
    }));

    await screen.findByTestId('configure-agents-read-only');
    expect(
      screen.getByText('Managing agent connections is unavailable in this build.'),
    ).toBeTruthy();
    expect(screen.queryByText("Couldn't check which tools are connected.")).toBeNull();
    await screen.findByText('External apps');
    const section = screen.getByTestId('settings-configure-agents');
    for (const label of [/^Add MCP & skill/, /^Manage/, /^Remove/]) {
      expect(within(section).queryByRole('button', { name: label })).toBeNull();
    }
  });

  test('a read-only build hides the cleanup link even when files are on disk', async () => {
    terminalLaunchValue = { installedClis: { claude: true, pi: false } };
    reloadEnabledAgentsFromStorage();
    renderSection(async () => ({
      ok: false,
      unavailable: true,
      error: 'Managing AI tool connections is unavailable in this build.',
      report: EMPTY_REPORT,
      snapshot: snapshotWith([satisfierId('pi', 'skill', 'user')]),
    }));

    await screen.findByTestId('configure-agents-read-only');
    fireEvent.click(await screen.findByTestId('configure-agents-terminal-show-more'));
    const row = await waitFor(() => terminalRow('pi'));

    await waitFor(() => expect(row.textContent ?? '').toContain('OpenKnowledge files present'));
    expect(within(row).queryByRole('button', { name: /^Remove OpenKnowledge from/ })).toBeNull();
  });

  test('a host that can manage connections shows no such notice', async () => {
    renderSection(async () => result(snapshotWith([])));
    await screen.findByText('External apps');
    expect(screen.queryByTestId('configure-agents-read-only')).toBeNull();
  });
});

describe('Install links', () => {
  test('a terminal row that is not installed links to the vendor page from the registry', async () => {
    renderSection(async () => result(snapshotWith([])));
    const link = await screen.findByRole('link', { name: 'Install Hermes CLI' });
    expect(link.getAttribute('href')).toBe(AGENT_REGISTRY.hermes.external?.installUrl);
  });
});
