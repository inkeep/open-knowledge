import type { ConfigBinding, OkignoreBinding } from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

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

let mockUserBinding: ConfigBinding | null = null;
let mockUserSynced = false;
let mockOkignoreBinding: OkignoreBinding | null = null;
let mockOkignoreSynced = false;
let mockCollabUrl: string | null = 'ws://test.invalid';
let mockDesktopPresent = false;
let mockBodyMode: BodyMode = 'probe';
let mockShowInstallSkill = true;
let mockProjectConfig: unknown = { contentRules: { markdownlint: { enabled: true } } };
let mockMerged: unknown = null;

vi.doMock('@inkeep/open-knowledge-core', () => ({
  get SHOW_INSTALL_SKILL() {
    return mockShowInstallSkill;
  },
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

    expect(probeProps.length).toBeGreaterThan(0);
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
    expect(screen.getAllByText('Open a project to edit.').length).toBeGreaterThan(0);
  });

  test('the Plugins group always lists the theme plugin, even with no project', () => {
    mockCollabUrl = null;
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);
    expect(screen.getByTestId('settings-sidebar-item-plugin:theme')).toBeTruthy();
    expect(screen.getByText('Themes')).toBeTruthy();
  });

  test('omits the Slides plugin from the sidebar until slides.enabled is true', () => {
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
    expect(screen.getByText('Slidev')).toBeTruthy();
  });

  test('has a per-scope Plugins manage item under both User and This project', () => {
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);
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

    await userEvent.click(screen.getByTestId('settings-sidebar-item-hotkeys'));
    expect(probeProps[probeProps.length - 1]?.activeId).toBe('hotkeys');
    expect(window.location.hash).toBe('#settings/plugin:markdownlint');

    const { openPluginSettings } = await import('@/lib/use-settings-route');
    await act(async () => {
      openPluginSettings('markdownlint');
    });
    expect(probeProps[probeProps.length - 1]?.activeId).toBe('plugin:markdownlint');
  });

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
    vi.stubGlobal('okDesktop', { config: { ptyAvailable: false } });
    try {
      render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

      const className = screen.getByTestId('settings-dialog').getAttribute('class');
      expectVisualClassTokens(className, ['max-h-[calc(100dvh-6rem)]']);
      expectVisualClassTokensAbsent(className, ['max-h-[calc(100dvh-4rem)]']);
      expect(screen.getByTestId('dialog-drag-strip')).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
