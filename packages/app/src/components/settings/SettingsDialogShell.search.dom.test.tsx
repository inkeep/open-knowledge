/**
 * DOM tests for the settings-dialog search surface: the sidebar
 * search box, its result navigation, the enabled-plugin gating of rule results,
 * and the scroll-to-flash of a navigated field.
 *
 * Mirrors the mock harness in `SettingsDialogShell.dom.test.tsx`: the lazy body
 * is a synchronous probe that records the props it receives (so we can assert
 * `activeId` / `markdownlintRuleQuery` navigation) and renders a `[data-field]`
 * node for the active section (so the Shell's flash effect has a target).
 */

import type { ConfigBinding, OkignoreBinding } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Radix/cmdk reach for DOM globals the jsdom preload doesn't expose; hoist the
// same shims the sibling shell test uses.
type WindowGlobals = { MutationObserver?: typeof MutationObserver; NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.MutationObserver === undefined &&
  globalWithDomShims.window?.MutationObserver !== undefined
) {
  globalWithDomShims.MutationObserver = globalWithDomShims.window.MutationObserver;
}
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}
// jsdom does not implement scrollIntoView; the flash effect calls it.
if (typeof HTMLElement.prototype.scrollIntoView !== 'function') {
  HTMLElement.prototype.scrollIntoView = () => {};
}

interface BodyProps {
  activeId: string;
  userBinding: ConfigBinding | null;
  okignoreBinding: OkignoreBinding | null;
  okignoreSynced: boolean;
  markdownlintRuleQuery?: { query: string; nonce: number } | null;
}
const probeProps: BodyProps[] = [];

let mockCollabUrl: string | null = 'ws://test.invalid';
let mockProjectConfig: unknown = { contentRules: { markdownlint: { enabled: true } } };

// A minimal fake catalog — the index reads only id/alias/aliases/name.
const FAKE_RULE_CATALOG = [
  {
    id: 'MD013',
    alias: 'line-length',
    aliases: ['line-length'],
    name: 'Line length',
    docUrl: '',
    tags: [],
    options: [],
  },
  {
    id: 'MD001',
    alias: 'heading-increment',
    aliases: ['heading-increment'],
    name: 'Heading levels increment',
    docUrl: '',
    tags: [],
    options: [],
  },
];

vi.doMock('@inkeep/open-knowledge-core', () => ({
  get SHOW_INSTALL_SKILL() {
    return true;
  },
  MARKDOWNLINT_RULE_CATALOG: FAKE_RULE_CATALOG,
}));

// The probe records props AND renders a `[data-field]` node for the active
// preferences section so the Shell's imperative flash effect finds a target.
vi.doMock('@/components/settings/SettingsDialogBodyLazy', () => ({
  SettingsDialogBodyLazy: (props: BodyProps) => {
    probeProps.push(props);
    return (
      <div data-testid="settings-body-probe">
        {props.activeId === 'preferences' ? <div data-field="editor.wordWrap" /> : null}
      </div>
    );
  },
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ collabUrl: mockCollabUrl }),
  DocumentProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    userBinding: null,
    userSynced: true,
    projectBinding: null,
    projectLocalBinding: null,
    okignoreBinding: null,
    okignoreSynced: false,
    userConfig: null,
    projectConfig: mockProjectConfig,
    projectLocalConfig: null,
    projectLocalSynced: false,
    merged: null,
  }),
}));

vi.doMock('@/lib/handoff/use-claude-desktop-integration', () => ({
  useClaudeDesktopIntegration: () => ({
    desktopPresent: false,
    skillInstalled: false,
    refresh: () => {},
  }),
}));

const { SettingsDialogShell } = await import('./SettingsDialogShell');

function latestProbe(): BodyProps | undefined {
  return probeProps[probeProps.length - 1];
}

describe('settings dialog search', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    probeProps.length = 0;
    mockCollabUrl = 'ws://test.invalid';
    mockProjectConfig = { contentRules: { markdownlint: { enabled: true } } };
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleErrorSpy.mockRestore();
  });

  test('empty query shows the plain group nav, no results list', () => {
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);
    expect(screen.getByTestId('settings-sidebar-item-preferences')).toBeDefined();
    expect(screen.queryByTestId('settings-search-results')).toBeNull();
  });

  test('typing a section name filters to a result that navigates on click', async () => {
    const user = userEvent.setup();
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    await user.type(screen.getByTestId('settings-search-input'), 'Sync');
    const result = await screen.findByTestId('settings-search-result-section:sync');
    // While searching, the plain group nav is hidden.
    expect(screen.queryByTestId('settings-sidebar-item-preferences')).toBeNull();

    await user.click(result);
    expect(latestProbe()?.activeId).toBe('sync');
    // Query cleared → group nav restored.
    expect(screen.getByTestId('settings-sidebar-item-preferences')).toBeDefined();
  });

  test('a markdownlint rule is searchable when the plugin is enabled', async () => {
    const user = userEvent.setup();
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    await user.type(screen.getByTestId('settings-search-input'), 'MD013');
    const result = await screen.findByTestId('settings-search-result-rule:MD013');

    await user.click(result);
    expect(latestProbe()?.activeId).toBe('plugin:markdownlint');
    expect(latestProbe()?.markdownlintRuleQuery?.query).toBe('MD013');
  });

  test('markdownlint rules are NOT indexed when the plugin is disabled', async () => {
    mockProjectConfig = { contentRules: { markdownlint: { enabled: false } } };
    const user = userEvent.setup();
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    await user.type(screen.getByTestId('settings-search-input'), 'MD013');
    // No rule result; the panel item is gone from the sidebar too.
    await waitFor(() => {
      expect(screen.getByTestId('settings-search-empty')).toBeDefined();
    });
    expect(screen.queryByTestId('settings-search-result-rule:MD013')).toBeNull();
  });

  test('a no-match query renders the empty state', async () => {
    const user = userEvent.setup();
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    await user.type(screen.getByTestId('settings-search-input'), 'zzzznomatch');
    await waitFor(() => {
      expect(screen.getByTestId('settings-search-empty')).toBeDefined();
    });
    // The polite live region announces the (zero) result count to SR users.
    expect(screen.getByTestId('settings-search-result-count').textContent).toContain('0');
  });

  test('navigating to a field flashes and scrolls its [data-field] node', async () => {
    const scrollSpy = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    const user = userEvent.setup();
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    await user.type(screen.getByTestId('settings-search-input'), 'Word wrap');
    const result = await screen.findByTestId(
      'settings-search-result-field:preferences:editor.wordWrap',
    );
    await user.click(result);

    expect(latestProbe()?.activeId).toBe('preferences');
    await waitFor(() => {
      const field = document.querySelector('[data-field="editor.wordWrap"]');
      expect(field?.classList.contains('animate-settings-nav-flash')).toBe(true);
    });
    expect(scrollSpy).toHaveBeenCalled();
    scrollSpy.mockRestore();
  });
});
