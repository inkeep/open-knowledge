/**
 * Tier-3 RTL mount test for the SettingsDialogShell userBinding gating
 * contract.
 *
 * Pins the behavioral data-flow that the source-string guards in
 * `SettingsDialogShell.test.ts` cannot reach: the ternary
 * `userBinding={userSynced ? userBinding : null}` is the
 * single behavioral invariant the shell/body split was designed to
 * preserve — it gates the settings form against an unsynced CRDT
 * binding. A refactor that breaks the data flow without changing the
 * ternary's literal text (e.g. `useConfigContext()` returning a stale
 * closure, or an intermediate prop passing `userBinding` unconditionally
 * through a HOC) could ship the regression silently — the form would
 * bind to an unsynced doc and overwrite user config with schema defaults.
 *
 * Approach: mock `SettingsDialogBodyLazy` to a synchronous probe
 * component that records the `userBinding` prop it receives. Mount the
 * Shell with `open={true}` and `useConfigContext` returning controlled
 * `userBinding` / `userSynced` values; assert the probe received `null`
 * when `userSynced` is false and the real binding when true.
 */

import type { ConfigBinding, OkignoreBinding } from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

// Radix UI primitives (used by shadcn `Dialog`) reach for DOM globals at
// mount time that `tests/dom/jsdom-preload.ts` does not expose. Hoist the
// needed shims locally.
type WindowGlobals = {
  MutationObserver?: typeof MutationObserver;
  NodeFilter?: typeof NodeFilter;
};
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & {
    window?: WindowGlobals;
    ResizeObserver?: unknown;
  };
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

// Captures one prop-snapshot per render so the test can inspect the
// `userBinding` value the body would see.
interface BodyProps {
  activeId: string;
  userBinding: ConfigBinding | null;
  okignoreBinding: OkignoreBinding | null;
  okignoreSynced: boolean;
}
const probeProps: BodyProps[] = [];
type BodyMode = 'probe' | 'suspend' | 'throw';

function resetProbe() {
  probeProps.length = 0;
}

const pendingBodyChunk = new Promise<never>(() => {});

// Module-level toggle the test cases flip before the Context mock factory
// is read. Default to an unsynced binding so the initial render path is
// exercised on every case.
let mockUserBinding: ConfigBinding | null = null;
let mockUserSynced = false;
let mockOkignoreBinding: OkignoreBinding | null = null;
let mockOkignoreSynced = false;
let mockCollabUrl: string | null = 'ws://test.invalid';
let mockDesktopPresent = false;
let mockBodyMode: BodyMode = 'probe';
let mockShowInstallSkill = true;
// markdownlint is opt-in (off by default); the default mock represents a
// project that has enabled it, so the Plugins group lists its panel.
let mockProjectConfig: unknown = { contentRules: { markdownlint: { enabled: true } } };
// The layered `merged` config drives user-scope plugin visibility (Themes,
// Slides). Default null → Themes shows (default-on gate) and Slides hides
// (default-off gate).
let mockMerged: unknown = null;

vi.doMock('@inkeep/open-knowledge-core', () => ({
  get SHOW_INSTALL_SKILL() {
    return mockShowInstallSkill;
  },
  // The shell builds its search index from the rule catalog when markdownlint
  // is an enabled plugin; an empty catalog keeps these nav/gating cases (which
  // don't exercise rule search) from tripping the mock's missing-export guard.
  MARKDOWNLINT_RULE_CATALOG: [],
}));

vi.doMock('@/components/settings/SettingsDialogBodyLazy', () => ({
  SettingsDialogBodyLazy: (props: BodyProps) => {
    if (mockBodyMode === 'suspend') throw pendingBodyChunk;
    if (mockBodyMode === 'throw') throw new Error('settings chunk failed');
    probeProps.push(props);
    return <div data-testid="settings-body-probe" />;
  },
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ collabUrl: mockCollabUrl }),
  DocumentProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    userBinding: mockUserBinding,
    userSynced: mockUserSynced,
    projectBinding: null,
    projectLocalBinding: null,
    okignoreBinding: mockOkignoreBinding,
    okignoreSynced: mockOkignoreSynced,
    userConfig: null,
    projectConfig: mockProjectConfig,
    projectLocalConfig: null,
    projectLocalSynced: false,
    merged: mockMerged,
  }),
}));

vi.doMock('@/lib/handoff/use-claude-desktop-integration', () => ({
  useClaudeDesktopIntegration: () => ({
    desktopPresent: mockDesktopPresent,
    skillInstalled: false,
    refresh: () => {},
  }),
}));

const { SettingsDialogShell } = await import('./SettingsDialogShell');

// A sentinel ConfigBinding identity for the synced case — only its
// reference equality matters for the assertions below; methods are
// never called by the probe.
const SENTINEL_USER_BINDING = {
  current: () => ({}) as never,
  patch: () => ({ ok: true, value: { applied: [], effective: {} } }) as never,
  subscribe: () => () => {},
  hasSynced: () => true,
  subscribeSynced: () => () => {},
  dispose: () => {},
} as unknown as ConfigBinding;

describe('SettingsDialogShell userBinding gating (Tier-3 mount)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetProbe();
    mockUserBinding = null;
    mockUserSynced = false;
    mockOkignoreBinding = null;
    mockOkignoreSynced = false;
    mockCollabUrl = 'ws://test.invalid';
    mockDesktopPresent = false;
    mockBodyMode = 'probe';
    mockShowInstallSkill = true;
    mockProjectConfig = { contentRules: { markdownlint: { enabled: true } } };
    mockMerged = null;
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleErrorSpy.mockRestore();
  });

  test('passes userBinding={null} to the body when userSynced is false (binding withheld until synced)', () => {
    mockUserBinding = SENTINEL_USER_BINDING;
    mockUserSynced = false;

    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    // The body received SOMETHING (Suspense resolved synchronously
    // because the lazy reference is mocked to a plain component).
    expect(probeProps.length).toBeGreaterThan(0);
    // Most recent render carries the gated value: even though the
    // ConfigProvider has a live binding, `userSynced=false` masks it.
    const latest = probeProps[probeProps.length - 1];
    expect(latest?.userBinding).toBeNull();
  });

  test('passes the real userBinding to the body once userSynced flips true', () => {
    mockUserBinding = SENTINEL_USER_BINDING;
    mockUserSynced = true;

    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    expect(probeProps.length).toBeGreaterThan(0);
    const latest = probeProps[probeProps.length - 1];
    expect(latest?.userBinding).toBe(SENTINEL_USER_BINDING);
  });

  test('passes userBinding={null} when the binding itself is absent regardless of userSynced', () => {
    // Cold-start edge case: the binding has not been constructed yet
    // (collabUrl null, or before the effect runs). The gating ternary
    // should still produce null — `userSynced ? null : null` is null —
    // proving the prop pipeline does not invent a non-null binding.
    mockUserBinding = null;
    mockUserSynced = true;

    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    expect(probeProps.length).toBeGreaterThan(0);
    const latest = probeProps[probeProps.length - 1];
    expect(latest?.userBinding).toBeNull();
  });

  test('renders the dialog frame, navigation landmark, and default Preferences section immediately', () => {
    render(<SettingsDialogShell open onOpenChange={() => {}} />);

    expect(screen.getByTestId('settings-dialog')).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy ?? '')?.textContent).toBe('Settings');
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Settings content' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeTruthy();
    expect(screen.getByText('User')).toBeTruthy();
    expect(screen.getByText('This project')).toBeTruthy();
    expect(screen.queryByTestId('settings-sidebar-item-attachments')).toBeNull();
    expect(screen.queryByText('Integrations') === null).toBe(true);
    expect(
      screen.getByTestId('settings-sidebar-item-preferences').getAttribute('aria-current'),
    ).toBe('page');
    expect(probeProps.at(-1)?.activeId).toBe('preferences');
  });

  test('disables project sections with an announced caption when no project is loaded', () => {
    mockCollabUrl = null;

    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    const sync = screen.getByTestId('settings-sidebar-item-sync') as HTMLButtonElement;
    expect(sync.disabled).toBe(true);
    expect(sync.getAttribute('aria-disabled')).toBe('true');
    expect(sync.getAttribute('aria-describedby')).toBe('settings-group-project-caption');
    // The project group gates on a loaded project (its caption renders); the
    // Plugins group no longer gates — the user-scope theme plugin keeps it shown.
    expect(screen.getAllByText('Open a project to edit.').length).toBeGreaterThan(0);
  });

  test('the Plugins group always lists the theme plugin, even with no project', () => {
    mockCollabUrl = null;
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);
    // Themes is user-scope (no project required), so its panel shows in the
    // Plugins group even when the project-scope items are gated.
    expect(screen.getByTestId('settings-sidebar-item-plugin:theme')).toBeTruthy();
    expect(screen.getByText('Themes')).toBeTruthy();
  });

  test('omits the Slides plugin from the sidebar until slides.enabled is true', () => {
    // Slides ships off. With no `slides.enabled` (default) the item is absent;
    // the shell sidebar half of the `plugin:slides` drift guard (dispatch half
    // lives in SettingsDialogBody.sections.dom.test.tsx).
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);
    expect(screen.queryByTestId('settings-sidebar-item-plugin:slides')).toBeNull();

    cleanup();
    mockMerged = { slides: { enabled: false } };
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);
    expect(screen.queryByTestId('settings-sidebar-item-plugin:slides')).toBeNull();
  });

  test('lists the Slidev plugin in the Plugins group once slides.enabled is true', () => {
    mockMerged = { slides: { enabled: true } };
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);
    expect(screen.getByTestId('settings-sidebar-item-plugin:slides')).toBeTruthy();
    // The nav names the renderer, not the config key it is gated on.
    expect(screen.getByText('Slidev')).toBeTruthy();
  });

  test('has a per-scope Plugins manage item under both User and This project', () => {
    // Default mock has a project (mockCollabUrl set) with markdownlint enabled.
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);
    // Two manage entries — one per scope — plus the shared Plugins panel group.
    expect(screen.getByTestId('settings-sidebar-item-user-plugins-manage')).toBeTruthy();
    expect(screen.getByTestId('settings-sidebar-item-plugins-manage')).toBeTruthy();
    expect(screen.getByTestId('settings-sidebar-item-plugin:markdownlint')).toBeTruthy();
    expect(screen.getByTestId('settings-sidebar-item-plugin:theme')).toBeTruthy();
  });

  test('hides or shows the Integrations group from desktop availability', () => {
    const { rerender } = render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);
    expect(screen.queryByTestId('settings-sidebar-item-claude-desktop') === null).toBe(true);

    mockDesktopPresent = true;
    rerender(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    expect(screen.getByText('Integrations')).toBeTruthy();
    expect(screen.getByTestId('settings-sidebar-item-claude-desktop')).toBeTruthy();
  });

  test('changes sections through the sidebar and resets to Preferences on each fresh open', async () => {
    const { rerender } = render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    await userEvent.click(screen.getByTestId('settings-sidebar-item-sync'));
    expect(screen.getByTestId('settings-sidebar-item-sync').getAttribute('aria-current')).toBe(
      'page',
    );
    expect(probeProps.at(-1)?.activeId).toBe('sync');

    rerender(<SettingsDialogShell open={false} onOpenChange={() => {}} />);
    rerender(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    expect(
      screen.getByTestId('settings-sidebar-item-preferences').getAttribute('aria-current'),
    ).toBe('page');
    expect(probeProps.at(-1)?.activeId).toBe('preferences');
  });

  test('shows a non-null accessible skeleton while the body chunk is pending', () => {
    mockBodyMode = 'suspend';

    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    const status = screen.getByTestId('settings-content-skeleton');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.textContent).toContain('Loading settings');
    expect(screen.getByTestId('settings-dialog')).toBeTruthy();
    expect(screen.queryByTestId('settings-body-probe') === null).toBe(true);
  });

  // Regression: the plugin-enable notice fires a deep link while the dialog is
  // ALREADY open. `initialSection` cannot carry that — an in-dialog hash write
  // is a replaceState (no `hashchange`), and after a sidebar click moved
  // `activeId` without touching the hash, the target can equal the current
  // hash. Both make a hash-only channel a no-op on second use.
  test('an in-dialog deep link re-activates its section even when the hash already matches', async () => {
    window.location.hash = '#settings/plugin:markdownlint';
    render(
      <SettingsDialogShell
        open={true}
        initialSection="plugin:markdownlint"
        onOpenChange={() => {}}
      />,
    );
    expect(probeProps[probeProps.length - 1]?.activeId).toBe('plugin:markdownlint');

    // Sidebar click moves the panel; the hash deliberately stays put.
    await userEvent.click(screen.getByTestId('settings-sidebar-item-hotkeys'));
    expect(probeProps[probeProps.length - 1]?.activeId).toBe('hotkeys');
    expect(window.location.hash).toBe('#settings/plugin:markdownlint');

    // Same target as the current hash — must still land.
    const { openPluginSettings } = await import('@/lib/use-settings-route');
    await act(async () => {
      openPluginSettings('markdownlint');
    });
    expect(probeProps[probeProps.length - 1]?.activeId).toBe('plugin:markdownlint');
  });

  // Second half of the `plugin:<id>` drift guard (the body dispatcher is pinned
  // in SettingsDialogBody.sections.dom.test.tsx). The sidebar builds the id
  // independently of `pluginSettingsSectionId`; if the two drift, the enable
  // notice's deep link lands on a section the sidebar never highlights.
  test('builds sidebar ids for enabled plugins that match pluginSettingsSectionId', async () => {
    const { pluginSettingsSectionId } = await import('@/lib/use-settings-route');
    mockProjectConfig = {
      contentRules: { markdownlint: { enabled: true }, frontmatter: { enabled: true } },
    };

    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    for (const id of ['markdownlint', 'frontmatter']) {
      expect(
        screen.getByTestId(`settings-sidebar-item-${pluginSettingsSectionId(id)}`),
      ).toBeTruthy();
    }
  });

  test('contains body render failures inside the dialog frame', async () => {
    mockBodyMode = 'throw';

    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    expect((await screen.findByRole('alert')).textContent).toContain('Settings failed to load');
    expect(screen.getByTestId('settings-dialog')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeTruthy();
  });

  test('keeps its own 4rem height cap in the browser', () => {
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    const className = screen.getByTestId('settings-dialog').getAttribute('class');
    expectVisualClassTokens(className, ['max-h-[calc(100dvh-4rem)]']);
    expectVisualClassTokensAbsent(className, ['max-h-[calc(100dvh-6rem)]']);
    expect(screen.queryByTestId('dialog-drag-strip')).toBeNull();
  });

  test('yields to the drag-band clearance on the desktop host', () => {
    // The shell reads `okDesktop.config` during render, so the host stub needs
    // more shape than the drag-band gate itself looks at.
    vi.stubGlobal('okDesktop', { config: { ptyAvailable: false } });
    try {
      render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

      // Its own 4rem cap would leave the dialog 16px under the 3rem band.
      const className = screen.getByTestId('settings-dialog').getAttribute('class');
      expectVisualClassTokens(className, ['max-h-[calc(100dvh-6rem)]']);
      expectVisualClassTokensAbsent(className, ['max-h-[calc(100dvh-4rem)]']);
      expect(screen.getByTestId('dialog-drag-strip')).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
