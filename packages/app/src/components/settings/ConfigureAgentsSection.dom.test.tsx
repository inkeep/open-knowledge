/**
 * Behavioral tests for the Settings → Configure agents section: it renders the
 * agent groups (In app / Terminal / External apps) with toggles, and flipping a toggle
 * persists an enable/disable override to the `enabled-agents` store so the
 * launcher dropdowns show/hide that agent.
 */

import type { InstallState } from '@inkeep/open-knowledge-core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
      harness: { cli: 'cursor', availability: 'not-found', credentials: 'unknown' },
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
      harness: { cli: 'pi', availability: 'present', credentials: 'unknown' },
    },
  ],
  stale: false,
  maxThreads: 8,
};
// Only the network call is stubbed. `harnessPresenceRank` is a pure ordering
// helper the component's sort depends on, so it must stay REAL — re-declaring it
// in the mock would test a copy of the rule instead of the rule.
// Swappable per test, like `states` and `terminalLaunchValue` above: the error
// path is a distinct ordering input, not just a different payload.
let fetchCatalog: () => Promise<typeof catalog> = () => Promise.resolve(catalog);
vi.doMock('@/lib/acp/catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/acp/catalog')>()),
  fetchAgentCatalog: () => fetchCatalog(),
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

import { reloadEnabledAgentsFromStorage } from '@/lib/acp/enabled-agents';
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
  // Both agent stores cache at module scope. Clearing storage without re-reading
  // them leaves a prior test's overrides live — every toggle test writes one.
  reloadEnabledAgentsFromStorage();
  fetchCatalog = () => Promise.resolve(catalog);
  states = { 'claude-code': { installed: true }, codex: { installed: false } } as Record<
    string,
    InstallState
  >;
});

afterEach(() => cleanup());

/** Open the In-app fold. Agents the harness probe reported `not-found` sit below
 *  it, so a test that asserts on one has to expand first. */
async function expandInApp(): Promise<void> {
  fireEvent.click(await screen.findByTestId('configure-agents-in-app-show-more'));
}

/** Group headings in DOM order — what the group-ordering rule acts on. The
 *  text is compared verbatim, so a maturity badge rendered back into a heading
 *  (the In app group used to carry one) reads as a heading-name change here. */
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
    // OpenCode's harness probe says not-found, so it sits below the fold.
    await expandInApp();
    const toggle = await screen.findByTestId('configure-agents-in-app-registry:opencode-acp');
    expect(toggle.getAttribute('data-disabled')).toBe('');
  });

  test('a row shows the catalog description as its subtitle, never the license or an install signal', async () => {
    renderSection();
    // The human blurb, not the SPDX license. (A global "Not installed" check
    // would hit the external-apps group's own install hint, so scope to the license.)
    await expandInApp();
    expect(await screen.findByText('ACP wrapper for Cursor')).toBeTruthy();
    expect(screen.getByText('ACP wrapper for Gemini')).toBeTruthy();
    expect(screen.queryByText('Apache-2.0')).toBeNull();
  });

  test('a present harness defaults on and a not-found one defaults off (toggle still operable)', async () => {
    renderSection();
    const present = await screen.findByTestId('configure-agents-in-app-registry:gemini');
    // Below the fold now; being folded is not being gated.
    await expandInApp();
    const notFound = await screen.findByTestId('configure-agents-in-app-registry:cursor');
    expect(present.getAttribute('aria-checked')).toBe('true');
    expect(notFound.getAttribute('aria-checked')).toBe('false');
    // Not a platform gate — the not-found row is still enabled to turn on.
    expect(notFound.getAttribute('data-disabled')).toBeNull();
  });

  test('an existing sign-in detects an agent whose CLI is not on PATH', async () => {
    // The Codex Desktop case. The adapter brings its own runtime, so a harness
    // the PATH probe ruled out is still ready to run when its credential
    // namespace already holds a sign-in: the row defaults on and stays above
    // the fold, exactly as a PATH-present one does.
    const cursor = catalog.agents.find((a) => a.id === 'cursor');
    const restore = cursor?.harness?.credentials;
    if (cursor?.harness) cursor.harness.credentials = 'present';
    try {
      renderSection();
      const row = await screen.findByTestId('configure-agents-in-app-registry:cursor');
      expect(row.getAttribute('aria-checked')).toBe('true');
      // Above the fold without expanding — no `expandInApp()` above.
      expect(screen.getByText('ACP wrapper for Cursor')).toBeTruthy();
    } finally {
      if (cursor?.harness && restore) cursor.harness.credentials = restore;
    }
  });

  test('collapses to agents the probe has not ruled out, with a Show more toggle for the rest', async () => {
    renderSection();
    // Default view = harness-mapped agents the probe did NOT rule out: Gemini
    // (present) and Claude Agent (unknown — pending is not a negative result).
    // Cursor and OpenCode (both not-found) join the un-mapped Cline below the
    // fold. An agent this machine cannot run has no claim on a default row just
    // because it is in the harness set.
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
    // `isPrimaryAgent` is a disjunction: harness-present OR checked. The fold
    // test above covers the harness arm; this covers the other one. A user who
    // deliberately enables an agent this machine reports `not-found` must not
    // have that agent hidden below a fold — the fold exists to cut catalogue
    // noise, and an explicit choice is not noise.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'in-app:registry:cursor': true }));
    // The override store caches at module scope, so a direct localStorage write
    // needs the same re-read the cross-tab `storage` listener performs.
    reloadEnabledAgentsFromStorage();
    renderSection();

    // Cursor is `availability: 'not-found'`, so without the override it sits
    // below the fold (asserted by the preceding test).
    expect(await screen.findByText('ACP wrapper for Cursor')).toBeTruthy();
    expect(screen.getByTestId('configure-agents-in-app-show-more').textContent).toContain(
      'Show 2 more',
    );
  });

  test('expanding pins present agents on top and sorts the rest alphabetically', async () => {
    renderSection();
    await screen.findByText('Claude Agent');
    await expandInApp();
    // Scoped to the In-app section: the external-apps group also has a row whose
    // text matches, and an unscoped query interleaves the two groups.
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
    // Regression guard: an agent with NO harness used to tie with the present
    // ones (`undefined === 'not-found'` is false), so the whole catalogue kept
    // its original order and only explicitly not-found agents sank.
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
      // Until the catalog lands the In-app group is held in place (pending, not
      // empty), so the reorder is only observable after it loads.
      await screen.findByTestId('configure-agents-in-app-show-more');
      expect(groupOrder()).toEqual(['External apps', 'In app']);
    } finally {
      if (gemini?.harness && restore.g) gemini.harness.availability = restore.g;
      if (claude?.harness && restore.c) claude.harness.availability = restore.c;
    }
  });

  test('a credentials-only agent lifts the In app group above one with nothing', async () => {
    // The group tier scores on `isHarnessDetected`, not PATH presence alone.
    // Scoring it on PATH would sink In app below External apps for the Codex
    // Desktop user this signal exists to serve: every harness ruled out by the
    // probe, yet one of them signed in and ready to run.
    const patched = catalog.agents.filter((a) => a.harness !== undefined);
    const restore = patched.map((a) => ({ a, ...a.harness }));
    for (const a of patched) {
      if (a.harness) a.harness.availability = 'not-found';
    }
    const cursor = catalog.agents.find((a) => a.id === 'cursor');
    if (cursor?.harness) cursor.harness.credentials = 'present';
    try {
      renderSection();
      // Cursor is the only agent left above the fold, and it got there on the
      // credential signal alone — waiting on it proves the catalog landed and
      // that the row-level arm fired, before scoring the group order.
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
    // External apps are strict on purpose: these rows deep-link into another
    // application, so an unresolved probe waits rather than asserting presence.
    // That is the same bar `isDesktopTargetEnabled` applies to the rows, and it
    // is deliberately unlike the fail-open rule the Terminal CLIs use.
    states = {};
    const gemini = catalog.agents.find((a) => a.id === 'gemini');
    const claude = catalog.agents.find((a) => a.id === 'claude-acp');
    const restore = { g: gemini?.harness?.availability, c: claude?.harness?.availability };
    if (gemini?.harness) gemini.harness.availability = 'not-found';
    if (claude?.harness) claude.harness.availability = 'not-found';
    try {
      renderSection();
      await screen.findByTestId('configure-agents-in-app-show-more');
      // Neither group can claim anything, so the declared order stands.
      expect(groupOrder()).toEqual(['In app', 'External apps']);
    } finally {
      if (gemini?.harness && restore.g) gemini.harness.availability = restore.g;
      if (claude?.harness && restore.c) claude.harness.availability = restore.c;
    }
  });

  test('a failed catalog holds the In app group in place rather than sinking it', async () => {
    // `catalogReady` is `!isLoading && !isError`, so a failed fetch scores the
    // group the same way a pending one does: it holds its declared position.
    // The group renders its own error state, so the user is told what happened
    // there — demoting it as well would move the section under a machine answer
    // that never arrived, which is the flicker the ordering rule exists to stop.
    fetchCatalog = () => Promise.reject(new Error('catalog unreachable'));
    renderSection();
    await screen.findByText(/Couldn't reach the agent registry/i);
    expect(groupOrder()).toEqual(['In app', 'External apps']);
  });

  test('a group whose every member is positively absent still sorts down', async () => {
    // The other half of the rule: `!== false` must not collapse into always-true.
    // A probe that has answered NO for every member is a real negative.
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
    // Asserted BEFORE the catalog resolves: the group has no rows yet, and
    // scoring it on that empty list would drop it below external apps for a frame.
    expect(groupOrder()).toEqual(['In app', 'External apps']);
    await screen.findByText('Claude Agent');
    expect(groupOrder()).toEqual(['In app', 'External apps']);
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

  /** Open the Terminal fold — CLIs the probe reported absent sit below it. */
  async function expandTerminal(): Promise<void> {
    fireEvent.click(await screen.findByTestId('configure-agents-terminal-show-more'));
  }

  test('renders the Terminal group with per-CLI rows', async () => {
    renderSection();
    await screen.findByTestId('configure-agents-terminal-claude');
    expect(screen.getByText('Terminal')).toBeTruthy();
    // codex probes absent, so it now sits below the fold.
    await expandTerminal();
    expect(screen.getByTestId('configure-agents-terminal-codex')).toBeTruthy();
  });

  test('Terminal sorts installed CLIs first and folds the not-installed ones', async () => {
    // This group used to render every CLI in catalogue order, so the absent ones
    // sat interleaved among the real ones.
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
