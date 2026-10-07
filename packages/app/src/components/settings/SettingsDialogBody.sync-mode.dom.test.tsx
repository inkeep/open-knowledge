import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createContext, type ReactNode, StrictMode, use } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import { renderSettingsBody } from '@/test-utils/render-settings-body.test-helper';

type SyncStatus = {
  state: string;
  hasRemote: boolean;
  pausedReason?: string;
  refusedSymlinkPaths?: string[];
  pushPermission?: {
    checkStatus: 'allowed' | 'denied' | 'unknown';
    deniedReason?: string;
    unknownError?: string;
  };
  syncEnabled?: boolean;
  syncMode?: 'off' | 'follow' | 'full';
  ahead?: number;
  remote?: { label: string; webUrl: string | null } | null;
} | null;

let syncStatus: SyncStatus = null;
let syncFetchError: 'network' | 'server' | null = null;
let projectLocalConfig: {
  autoSync?: {
    enabled?: boolean;
    mode?: 'off' | 'follow' | 'full';
    pullIntervalSeconds?: number;
    pushIntervalSeconds?: number;
  };
} | null = null;
let projectConfig: {
  autoSync?: { default?: boolean | string | null };
  content: { attachmentFolderPath: string };
} | null = null;
let projectLocalSynced = true;
let projectSynced = true;
let localPatchCalls: unknown[] = [];
const projectLocalBinding: {
  patch: (patch: unknown) => { ok: true } | { ok: false; error: unknown };
} = {
  patch: (patch: unknown) => {
    localPatchCalls.push(patch);
    return { ok: true };
  },
};

import * as actualLinguiMacro from '@lingui/react/macro';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{(value === 1 ? one : other).replace('#', String(value))}</>
  ),
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

vi.doMock('@lingui/core/macro', () => ({
  ...actualLinguiMacro,
  msg: renderLinguiTemplate,
  plural: (value: number, options: { one: string; other: string }) =>
    (value === 1 ? options.one : options.other).replace('#', String(value)),
  t: renderLinguiTemplate,
}));

const toastErrors: string[] = [];
vi.doMock('sonner', () => ({ toast: { error: (m: string) => toastErrors.push(m) } }));

vi.doMock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.doMock('@/components/ui/collapsible', () => ({
  Collapsible: ({ children, open }: { children?: ReactNode; open?: boolean }) => (
    <div data-state={open === true ? 'open' : 'closed'}>{children}</div>
  ),
  CollapsibleContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.doMock('@/components/ui/switch', () => ({
  Switch: (props: Record<string, unknown>) => <button type="button" {...props} />,
}));

vi.doMock('@/components/ui/skeleton', () => ({
  Skeleton: ({ className }: { className?: string }) => <div className={className} />,
}));

vi.doMock('@/components/ui/form', () => ({
  Form: ({ children }: { children?: ReactNode }) => <form>{children}</form>,
  FormControl: ({ children }: { children?: ReactNode }) => <>{children}</>,
  FormDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  FormField: () => null,
  FormItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FormLabel: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  FormMessage: () => null,
}));

vi.doMock('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

const SelectHandlerCtx = createContext<
  { onValueChange?: (value: string) => void; value?: string } | undefined
>(undefined);
vi.doMock('@/components/ui/select', () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children?: ReactNode;
    value?: string;
    onValueChange?: (value: string) => void;
  }) => (
    <SelectHandlerCtx.Provider value={{ onValueChange, value }}>
      <div data-value={value}>{children}</div>
    </SelectHandlerCtx.Provider>
  ),
  SelectContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectItem: ({
    children,
    value,
    ...props
  }: {
    children?: ReactNode;
    value?: string;
    [key: string]: unknown;
  }) => {
    const ctx = use(SelectHandlerCtx);
    return (
      <button
        type="button"
        role="option"
        aria-selected={ctx?.value === value}
        onClick={() => ctx?.onValueChange?.(value as string)}
        {...props}
      >
        {children}
      </button>
    );
  },
  SelectTrigger: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <div {...props}>{children}</div>
  ),
  SelectValue: () => {
    const ctx = use(SelectHandlerCtx);
    return <span data-slot="select-value">{ctx?.value ?? ''}</span>;
  },
}));

const ToggleGroupHandlerCtx = createContext<
  { onValueChange?: (value: string) => void; value?: string } | undefined
>(undefined);
vi.doMock('@/components/ui/toggle-group', () => ({
  ToggleGroup: ({
    children,
    value,
    onValueChange,
    disabled,
    ...props
  }: {
    children?: ReactNode;
    value?: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
    [key: string]: unknown;
  }) => (
    <ToggleGroupHandlerCtx.Provider value={{ onValueChange, value }}>
      <div data-value={value} data-disabled={String(Boolean(disabled))} {...props}>
        {children}
      </div>
    </ToggleGroupHandlerCtx.Provider>
  ),
  ToggleGroupItem: ({
    children,
    value,
    ...props
  }: {
    children?: ReactNode;
    value?: string;
    [key: string]: unknown;
  }) => {
    const ctx = use(ToggleGroupHandlerCtx);
    const emitted = ctx?.value === value ? '' : (value as string);
    return (
      <button type="button" onClick={() => ctx?.onValueChange?.(emitted)} {...props}>
        {children}
      </button>
    );
  },
}));

vi.doMock('@/components/PublishToGitHubDialog', () => ({
  PublishToGitHubDialog: () => null,
}));
vi.doMock('@/components/AuthModal', () => ({ AuthModal: () => null }));
vi.doMock('@/components/InstallInClaudeDesktopDialog', () => ({
  InstallInClaudeDesktopDialog: () => null,
}));
vi.doMock('./OkignoreSection', () => ({ OkignoreSection: () => null }));
vi.doMock('./ProjectTemplatesSection', () => ({ ProjectTemplatesSection: () => null }));

vi.doMock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatus: () => syncStatus,
  useGitSyncStatusDetailed: () => ({ status: syncStatus, fetchError: syncFetchError }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    projectBinding: projectLocalBinding,
    projectConfig,
    projectLocalConfig,
    projectLocalBinding,
    projectLocalSynced,
    projectSynced,
  }),
}));

async function renderSyncSection({ strict = false }: { strict?: boolean } = {}) {
  const { SettingsDialogBody } = await import('./SettingsDialogBody');
  const tree = (
    <TooltipProvider>
      <SettingsDialogBody
        activeId="sync"
        userBinding={null as never}
        okignoreBinding={null as never}
        okignoreSynced={false}
      />
    </TooltipProvider>
  );
  return renderSettingsBody(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

describe('Settings Sync section — three-way mode control (real hooks + dialog)', () => {
  beforeEach(() => {
    cleanup();
    syncStatus = {
      state: 'idle',
      hasRemote: true,
      syncEnabled: false,
      syncMode: 'off',
      ahead: 0,
      remote: {
        label: 'inkeep/open-knowledge',
        webUrl: 'https://github.com/inkeep/open-knowledge',
      },
    };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    projectConfig = { autoSync: { default: null }, content: { attachmentFolderPath: './' } };
    projectLocalSynced = true;
    projectSynced = true;
    localPatchCalls = [];
    toastErrors.length = 0;
  });

  test('selecting Pull-only opens the one-directional confirm and patches mode on confirm', async () => {
    await renderSyncSection();

    fireEvent.click(screen.getByTestId('settings-sync-mode-follow'));

    expect(screen.getByRole('button', { name: 'Enable Auto (Pull only)' })).not.toBeNull();
    expect(screen.getByRole('note').textContent ?? '').toContain('Updates flow in');
    expect(localPatchCalls).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Enable Auto (Pull only)' }));
    expect(localPatchCalls).toEqual([{ autoSync: { mode: 'follow', enabled: null } }]);
  });

  test('selecting Full opens the bidirectional confirm and patches full on confirm', async () => {
    await renderSyncSection();

    fireEvent.click(screen.getByTestId('settings-sync-mode-full'));

    expect(screen.getByRole('button', { name: 'Enable Auto (Pull and Push)' })).not.toBeNull();
    expect(screen.getByRole('note').textContent ?? '').toContain('Commits happen automatically');

    fireEvent.click(screen.getByRole('button', { name: 'Enable Auto (Pull and Push)' }));
    expect(localPatchCalls).toEqual([{ autoSync: { mode: 'full', enabled: null } }]);
  });

  test('the push-outpaces-pull hint tracks both of its conditions', async () => {
    const hint = 'settings-sync-push-outpaces-pull-hint';

    projectLocalConfig = {
      autoSync: { mode: 'full', pullIntervalSeconds: 900, pushIntervalSeconds: 30 },
    };
    syncStatus = { ...syncStatus, syncMode: 'full', syncEnabled: true } as SyncStatus;
    await renderSyncSection();
    expect(screen.queryByTestId(hint)).toBeTruthy();
    cleanup();

    projectLocalConfig = {
      autoSync: { mode: 'full', pullIntervalSeconds: 30, pushIntervalSeconds: 900 },
    };
    await renderSyncSection();
    expect(screen.queryByTestId(hint)).toBeNull();
    cleanup();

    projectLocalConfig = {
      autoSync: { mode: 'follow', pullIntervalSeconds: 900, pushIntervalSeconds: 30 },
    };
    syncStatus = { ...syncStatus, syncMode: 'follow', syncEnabled: true } as SyncStatus;
    await renderSyncSection();
    expect(screen.queryByTestId(hint)).toBeNull();
  });

  test('selecting Off writes immediately with no confirmation', async () => {
    projectLocalConfig = { autoSync: { mode: 'full' } };
    syncStatus = { ...syncStatus, syncMode: 'full', syncEnabled: true } as SyncStatus;

    await renderSyncSection();

    fireEvent.click(screen.getByTestId('settings-sync-mode-off'));

    expect(localPatchCalls).toEqual([{ autoSync: { mode: 'off', enabled: null } }]);
    expect(screen.queryByRole('button', { name: /Enable/ })).toBeNull();
  });

  test('Switch to pull-only from a paused full sync discloses stranded commits then patches pull', async () => {
    projectLocalConfig = { autoSync: { mode: 'full' } };
    syncStatus = {
      state: 'disabled',
      hasRemote: true,
      syncEnabled: true,
      syncMode: 'full',
      pausedReason: 'no-push-permission',
      ahead: 2,
      remote: {
        label: 'inkeep/open-knowledge',
        webUrl: 'https://github.com/inkeep/open-knowledge',
      },
    };

    await renderSyncSection();

    fireEvent.click(screen.getByTestId('settings-sync-switch-follow-action'));

    expect(
      screen.getByText("You have 2 changes you haven't shared. They will stay on this computer."),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Enable Auto (Pull only)' }));
    expect(localPatchCalls).toEqual([{ autoSync: { mode: 'follow', enabled: null } }]);
  });

  test('a refused incoming symlink is named under the paused reason', async () => {
    projectLocalConfig = { autoSync: { mode: 'full' } };
    syncStatus = {
      state: 'idle',
      hasRemote: true,
      syncEnabled: true,
      syncMode: 'full',
      pausedReason: 'unsafe-incoming-symlinks',
      refusedSymlinkPaths: ['notes/leak.md'],
    };

    await renderSyncSection();

    expect(screen.getByTestId('sync-refused-symlinks').textContent).toContain('notes/leak.md');
  });

  test('a read-only follower still sees the symlink pause and the refused link', async () => {
    projectLocalConfig = { autoSync: { mode: 'follow' } };
    syncStatus = {
      state: 'disabled',
      hasRemote: true,
      syncEnabled: true,
      syncMode: 'follow',
      pausedReason: 'unsafe-incoming-symlinks',
      refusedSymlinkPaths: ['notes/leak.md'],
      pushPermission: { checkStatus: 'denied', deniedReason: 'no-collaborator' },
    };

    await renderSyncSection();

    expect(screen.getByTestId('settings-sync-reason').textContent).toContain('Sync is paused');
    expect(screen.getByTestId('sync-refused-symlinks').textContent).toContain('notes/leak.md');
  });

  test('a genuine read-only denial disables Full but keeps Off and Pull-only reachable', async () => {
    const user = userEvent.setup();
    syncStatus = {
      ...syncStatus,
      pushPermission: { checkStatus: 'denied', deniedReason: 'no-collaborator' },
    } as SyncStatus;

    await renderSyncSection();

    expect((screen.getByTestId('settings-sync-mode-full') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByTestId('settings-sync-mode-off') as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByTestId('settings-sync-mode-follow') as HTMLButtonElement).disabled).toBe(
      false,
    );
    const fullTrigger = screen
      .getByTestId('settings-sync-mode-full')
      .closest('[data-slot="tooltip-trigger"]');
    if (fullTrigger === null) throw new Error('expected Full to have a tooltip trigger');
    expect(screen.queryByTestId('settings-sync-mode-full-tip')).toBeNull();
    await user.hover(fullTrigger);
    expect((await screen.findByTestId('settings-sync-mode-full-tip')).textContent ?? '').toContain(
      "You don't have permission to push to this repo",
    );
  });

  test('a signed-out denial keeps Full enabled (push access is unknowable until sign-in)', async () => {
    syncStatus = {
      ...syncStatus,
      pushPermission: { checkStatus: 'denied', deniedReason: 'not-authenticated' },
    } as SyncStatus;

    await renderSyncSection();

    expect((screen.getByTestId('settings-sync-mode-full') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe('Settings Sync section — cycle cadence controls', () => {
  beforeEach(() => {
    cleanup();
    localPatchCalls = [];
    syncStatus = {
      state: 'idle',
      hasRemote: true,
      syncEnabled: true,
      syncMode: 'follow',
      ahead: 0,
      remote: {
        label: 'inkeep/open-knowledge',
        webUrl: 'https://github.com/inkeep/open-knowledge',
      },
    };
    projectLocalConfig = { autoSync: { mode: 'follow' } };
    projectConfig = { autoSync: { default: null }, content: { attachmentFolderPath: 'assets' } };
    projectLocalSynced = true;
    projectSynced = true;
  });

  test('Manual hides the cadence card entirely', async () => {
    projectLocalConfig = { autoSync: { mode: 'off' } };
    syncStatus = { ...syncStatus, syncMode: 'off' } as SyncStatus;

    await renderSyncSection();

    expect(screen.queryByTestId('settings-sync-intervals')).toBeNull();
  });

  test('the cadence controls sit behind the Advanced disclosure', async () => {
    await renderSyncSection();

    expect(screen.queryByTestId('settings-sync-advanced-trigger')).not.toBeNull();
  });

  test('Manual hides the disclosure along with the controls', async () => {
    projectLocalConfig = { autoSync: { mode: 'off' } };
    syncStatus = { ...syncStatus, syncMode: 'off' } as SyncStatus;

    await renderSyncSection();

    expect(screen.queryByTestId('settings-sync-advanced-trigger')).toBeNull();
  });

  test('Pull-only shows the pull cadence and hides the push one', async () => {
    await renderSyncSection();

    expect(screen.queryByTestId('settings-sync-pull-interval')).not.toBeNull();
    expect(screen.queryByTestId('settings-sync-push-interval')).toBeNull();
  });

  test('Pull and Push shows both cadence controls', async () => {
    projectLocalConfig = { autoSync: { mode: 'full' } };
    syncStatus = { ...syncStatus, syncMode: 'full' } as SyncStatus;

    await renderSyncSection();

    expect(screen.queryByTestId('settings-sync-pull-interval')).not.toBeNull();
    expect(screen.queryByTestId('settings-sync-push-interval')).not.toBeNull();
  });

  function selectedSeconds(testId: string): string | null | undefined {
    return screen.getByTestId(testId).closest('[data-value]')?.getAttribute('data-value');
  }

  test('an unset cadence selects the shipped default rather than nothing', async () => {
    await renderSyncSection();

    expect(selectedSeconds('settings-sync-pull-interval')).toBe('30');
  });

  test('a stored cadence is the selected one', async () => {
    projectLocalConfig = { autoSync: { mode: 'follow', pullIntervalSeconds: 900 } };

    await renderSyncSection();

    expect(selectedSeconds('settings-sync-pull-interval')).toBe('900');
  });

  test('presets render as human durations, not raw seconds', async () => {
    await renderSyncSection();

    const labels = screen.getAllByRole('option').map((o) => o.textContent);
    expect(labels).toEqual(['30 seconds', '1 minute', '5 minutes', '15 minutes', '1 hour']);
  });

  test('changing one leg writes both, leaving the other at its resolved value', async () => {
    projectLocalConfig = { autoSync: { mode: 'full', pushIntervalSeconds: 900 } };
    syncStatus = { ...syncStatus, syncMode: 'full' } as SyncStatus;
    const user = userEvent.setup();

    await renderSyncSection();
    const pullCard = screen.getByTestId('settings-sync-pull-interval').closest('[data-value]');
    if (pullCard === null || pullCard === undefined) throw new Error('expected a pull select');
    await user.click(within(pullCard as HTMLElement).getByRole('option', { name: '5 minutes' }));

    expect(localPatchCalls).toContainEqual({
      autoSync: { pullIntervalSeconds: 300, pushIntervalSeconds: 900 },
    });
  });
});

describe('Settings Sync section — Advanced disclosure intent', () => {
  beforeEach(() => {
    cleanup();
    syncStatus = {
      state: 'idle',
      hasRemote: true,
      syncEnabled: true,
      syncMode: 'follow',
      ahead: 0,
      remote: {
        label: 'inkeep/open-knowledge',
        webUrl: 'https://github.com/inkeep/open-knowledge',
      },
    };
    projectLocalConfig = { autoSync: { mode: 'follow' } };
    projectConfig = { autoSync: { default: null }, content: { attachmentFolderPath: 'assets' } };
    projectLocalSynced = true;
    projectSynced = true;
  });

  function disclosureState(): string | null | undefined {
    return screen
      .getByTestId('settings-sync-intervals')
      .closest('[data-state]')
      ?.getAttribute('data-state');
  }

  test('arriving with no intent leaves the disclosure collapsed', async () => {
    await renderSyncSection();

    expect(disclosureState()).toBe('closed');
  });

  test('the popover deep link lands on Sync with the disclosure expanded', async () => {
    const { openSyncSettings } = await import('@/lib/use-settings-route');
    openSyncSettings({ advanced: true });

    await renderSyncSection();

    expect(disclosureState()).toBe('open');
  });

  test('the deep link still lands expanded under StrictMode', async () => {
    const { openSyncSettings } = await import('@/lib/use-settings-route');
    openSyncSettings({ advanced: true });

    await renderSyncSection({ strict: true });

    expect(disclosureState()).toBe('open');
  });

  test('the intent is one-shot — a later visit to Sync is collapsed again', async () => {
    const { openSyncSettings } = await import('@/lib/use-settings-route');
    openSyncSettings({ advanced: true });
    await renderSyncSection();
    expect(disclosureState()).toBe('open');

    cleanup();
    await renderSyncSection();

    expect(disclosureState()).toBe('closed');
  });
});

describe('Settings Sync section — GitHub sign-in prompts', () => {
  beforeEach(() => {
    cleanup();
    syncStatus = {
      state: 'idle',
      hasRemote: true,
      syncEnabled: true,
      syncMode: 'full',
      ahead: 0,
      remote: {
        label: 'inkeep/open-knowledge',
        webUrl: 'https://github.com/inkeep/open-knowledge',
      },
    };
    projectLocalConfig = { autoSync: { mode: 'full' } };
    projectConfig = { autoSync: { default: null }, content: { attachmentFolderPath: './' } };
    projectLocalSynced = true;
    projectSynced = true;
    localPatchCalls = [];
    toastErrors.length = 0;
  });

  test('a GitHub paused sync keeps the sign-in prompt and its button', async () => {
    syncStatus = {
      ...syncStatus,
      pushPermission: { checkStatus: 'denied', deniedReason: 'not-authenticated' },
    } as SyncStatus;

    await renderSyncSection();

    const region = screen.getByTestId('settings-sync-reconnect');
    expect(region.textContent ?? '').toContain('Auto-sync is paused');
    expect(within(region).getByRole('button', { name: 'Sign in' })).not.toBeNull();
  });

  test('a GitHub host keeps the expired-session line and its sign-in button', async () => {
    syncStatus = {
      ...syncStatus,
      pushPermission: { checkStatus: 'unknown', unknownError: 'token-invalid' },
    } as SyncStatus;

    await renderSyncSection();

    const region = screen.getByTestId('settings-sync-signin-again');
    expect(region.textContent ?? '').toContain('GitHub session expired');
    expect(within(region).getByRole('button', { name: 'Sign in' })).not.toBeNull();
  });
});

describe('Settings Sync section — publish-to-GitHub reachability', () => {
  beforeEach(() => {
    cleanup();
    projectLocalConfig = { autoSync: { mode: 'off' } };
    projectConfig = { autoSync: { default: null }, content: { attachmentFolderPath: './' } };
    projectLocalSynced = true;
    projectSynced = true;
    localPatchCalls = [];
    toastErrors.length = 0;
  });

  test('a project with no remote is offered the GitHub publish flow', async () => {
    syncStatus = {
      state: 'dormant',
      hasRemote: false,
      syncEnabled: false,
      ahead: 0,
    } as SyncStatus;

    await renderSyncSection();

    expect(screen.getByTestId('settings-sync-setup')).not.toBeNull();
  });

  test('a non-GitHub remote is never offered the GitHub publish flow', async () => {
    syncStatus = {
      state: 'idle',
      hasRemote: true,
      syncEnabled: true,
      syncMode: 'off',
      ahead: 0,
      remote: { label: 'git.example.com/team/wiki', webUrl: null },
    } as SyncStatus;

    await renderSyncSection();

    expect(screen.queryByTestId('settings-sync-setup')).toBeNull();
    expect(screen.queryByTestId('settings-sync-empty')).toBeNull();
    expect(screen.getByTestId('settings-sync-remote-label').textContent).toContain(
      'git.example.com',
    );
  });

  test('a GitHub remote is not offered the publish flow either — it is already published', async () => {
    syncStatus = {
      state: 'idle',
      hasRemote: true,
      syncEnabled: true,
      syncMode: 'off',
      ahead: 0,
      remote: {
        label: 'inkeep/open-knowledge',
        webUrl: 'https://github.com/inkeep/open-knowledge',
      },
    } as SyncStatus;

    await renderSyncSection();

    expect(screen.queryByTestId('settings-sync-setup')).toBeNull();
  });
});

describe('Settings Sync section: unknown or missing remote never offers auto sync', () => {
  beforeEach(() => {
    cleanup();
    syncFetchError = null;
    projectLocalConfig = { autoSync: { mode: 'off' } };
    projectConfig = { autoSync: { default: null }, content: { attachmentFolderPath: './' } };
    projectLocalSynced = true;
    projectSynced = true;
    localPatchCalls = [];
    toastErrors.length = 0;
  });

  function expectNoModeControls() {
    expect(screen.queryByTestId('settings-sync-mode-toggle')).toBeNull();
    expect(screen.queryByTestId('settings-sync-mode-follow')).toBeNull();
    expect(screen.queryByTestId('settings-sync-mode-full')).toBeNull();
    expect(screen.queryByTestId('settings-sync-default')).toBeNull();
  }

  test('a status that is still loading offers no auto mode and no shared default', async () => {
    syncStatus = null;

    await renderSyncSection();

    expectNoModeControls();
    const loading = screen.getByTestId('settings-sync-loading');
    expect(within(loading).getByRole('status').textContent ?? '').toContain('Loading sync status');
  });

  test('a failed status fetch hides the sync controls and announces why', async () => {
    syncStatus = null;
    syncFetchError = 'server';

    await renderSyncSection();

    expectNoModeControls();
    expect(screen.queryByTestId('settings-sync-loading')).toBeNull();
    const unavailable = screen.getByTestId('settings-sync-unavailable');
    const message = within(unavailable).getByRole('status').textContent ?? '';
    expect(message).toContain("The server couldn't read this project's sync status");
    expect(message).toContain('They appear here as soon as the sync status loads');
  });

  test('an unreachable server is named as the reason the sync controls are hidden', async () => {
    syncStatus = null;
    syncFetchError = 'network';

    await renderSyncSection();

    expectNoModeControls();
    const unavailable = screen.getByTestId('settings-sync-unavailable');
    expect(within(unavailable).getByRole('status').textContent ?? '').toContain(
      "Couldn't reach the OpenKnowledge server",
    );
  });

  test('no remote shows the setup screen even when the engine is not dormant', async () => {
    syncStatus = { state: 'idle', hasRemote: false, syncEnabled: false, ahead: 0 };

    await renderSyncSection();

    expectNoModeControls();
    expect(screen.getByTestId('settings-sync-empty')).not.toBeNull();
  });

  test('no remote with auto sync off shows no auto sync warning', async () => {
    syncStatus = { state: 'dormant', hasRemote: false, syncEnabled: false, ahead: 0 };

    await renderSyncSection();

    expect(screen.getByTestId('settings-sync-empty')).not.toBeNull();
    expect(screen.queryByTestId('settings-sync-no-remote-auto-on')).toBeNull();
  });

  test('no remote, no local choice and the engine off shows the setup screen without a warning', async () => {
    syncStatus = {
      state: 'dormant',
      hasRemote: false,
      syncEnabled: false,
      syncMode: 'off',
      ahead: 0,
    };
    projectLocalConfig = {};

    await renderSyncSection();

    expect(screen.getByTestId('settings-sync-setup')).not.toBeNull();
    expect(screen.queryByTestId('settings-sync-no-remote-auto-on')).toBeNull();
  });

  test('no remote with auto sync already on warns and turns it off without a confirm', async () => {
    syncStatus = {
      state: 'dormant',
      hasRemote: false,
      syncEnabled: true,
      syncMode: 'follow',
      ahead: 0,
    };
    projectLocalConfig = { autoSync: { mode: 'follow' } };

    await renderSyncSection();

    expectNoModeControls();
    expect(screen.getByTestId('settings-sync-no-remote-auto-on').textContent ?? '').toContain(
      "there's no remote to sync with yet",
    );

    fireEvent.click(screen.getByTestId('settings-sync-no-remote-turn-off'));

    expect(localPatchCalls).toEqual([{ autoSync: { mode: 'off', enabled: null } }]);
  });

  test('turning auto-sync off moves focus to the setup button that stays on screen', async () => {
    syncStatus = {
      state: 'dormant',
      hasRemote: false,
      syncEnabled: true,
      syncMode: 'follow',
      ahead: 0,
    };
    projectLocalConfig = { autoSync: { mode: 'follow' } };
    const user = userEvent.setup();

    await renderSyncSection();

    await user.click(screen.getByTestId('settings-sync-no-remote-turn-off'));

    expect(localPatchCalls).toEqual([{ autoSync: { mode: 'off', enabled: null } }]);
    expect(document.activeElement).toBe(screen.getByTestId('settings-sync-setup'));
  });

  test('no remote with auto sync on from the shared default warns and turns it off locally', async () => {
    syncStatus = {
      state: 'dormant',
      hasRemote: false,
      syncEnabled: true,
      syncMode: 'full',
      ahead: 0,
    };
    projectLocalConfig = {};
    projectConfig = { autoSync: { default: 'full' }, content: { attachmentFolderPath: './' } };

    await renderSyncSection();

    expectNoModeControls();
    expect(screen.getByTestId('settings-sync-no-remote-auto-on').textContent ?? '').toContain(
      "there's no remote to sync with yet",
    );

    fireEvent.click(screen.getByTestId('settings-sync-no-remote-turn-off'));

    expect(localPatchCalls).toEqual([{ autoSync: { mode: 'off', enabled: null } }]);
  });

  test('a local Manual choice hides the warning before the engine reports the change', async () => {
    syncStatus = {
      state: 'dormant',
      hasRemote: false,
      syncEnabled: true,
      syncMode: 'full',
      ahead: 0,
    };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    projectConfig = { autoSync: { default: 'full' }, content: { attachmentFolderPath: './' } };

    await renderSyncSection();

    expect(screen.getByTestId('settings-sync-empty')).not.toBeNull();
    expect(screen.queryByTestId('settings-sync-no-remote-auto-on')).toBeNull();
  });

  test('the turn-off action waits for project settings to load', async () => {
    syncStatus = {
      state: 'dormant',
      hasRemote: false,
      syncEnabled: true,
      syncMode: 'full',
      ahead: 0,
    };
    projectLocalConfig = { autoSync: { mode: 'full' } };
    projectLocalSynced = false;

    await renderSyncSection();

    expect(
      (screen.getByTestId('settings-sync-no-remote-turn-off') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('Settings Sync section: a remote with no local choice shows the mode the engine runs', () => {
  beforeEach(() => {
    cleanup();
    syncFetchError = null;
    syncStatus = {
      state: 'idle',
      hasRemote: true,
      syncEnabled: true,
      syncMode: 'full',
      ahead: 0,
      remote: {
        label: 'inkeep/open-knowledge',
        webUrl: 'https://github.com/inkeep/open-knowledge',
      },
    };
    projectLocalConfig = {};
    projectConfig = { autoSync: { default: 'full' }, content: { attachmentFolderPath: './' } };
    projectLocalSynced = true;
    projectSynced = true;
    localPatchCalls = [];
    toastErrors.length = 0;
  });

  test('the mode control shows the shared default the engine runs and says where it comes from', async () => {
    await renderSyncSection();

    const toggle = screen.getByTestId('settings-sync-mode-toggle');
    expect(toggle.getAttribute('data-value')).toBe('full');
    expect(screen.getByTestId('settings-sync-body').textContent ?? '').toContain(
      'pushed to your remote automatically',
    );
    const note = screen.getByTestId('settings-sync-mode-from-default');
    expect(note.textContent ?? '').toContain("comes from the project's Shared default");
    expect(toggle.getAttribute('aria-describedby')).toBe(note.id);
    expect(localPatchCalls).toEqual([]);
  });

  test('a local choice wins over the engine report and drops the shared default note', async () => {
    projectLocalConfig = { autoSync: { mode: 'follow' } };

    await renderSyncSection();

    expect(screen.getByTestId('settings-sync-mode-toggle').getAttribute('data-value')).toBe(
      'follow',
    );
    expect(screen.queryByTestId('settings-sync-mode-from-default')).toBeNull();
  });

  test('picking Manual over the shared default writes a local choice without a confirm', async () => {
    await renderSyncSection();

    fireEvent.click(screen.getByTestId('settings-sync-mode-off'));

    expect(localPatchCalls).toEqual([{ autoSync: { mode: 'off', enabled: null } }]);
  });

  test("picking the mode the shared default already runs records it as this computer's choice", async () => {
    await renderSyncSection();

    fireEvent.click(screen.getByTestId('settings-sync-mode-full'));

    expect(screen.queryByRole('button', { name: 'Enable Auto (Pull and Push)' })).toBeNull();
    expect(localPatchCalls).toEqual([{ autoSync: { mode: 'full', enabled: null } }]);
  });

  test('re-picking a mode this computer already chose writes nothing', async () => {
    projectLocalConfig = { autoSync: { mode: 'full' } };

    await renderSyncSection();

    fireEvent.click(screen.getByTestId('settings-sync-mode-full'));

    expect(screen.getByTestId('settings-sync-mode-toggle').getAttribute('data-value')).toBe('full');
    expect(localPatchCalls).toEqual([]);
  });

  test('the shared default Auto mode offers the cadence controls for both legs', async () => {
    await renderSyncSection();

    expect(screen.getByTestId('settings-sync-advanced-trigger')).not.toBeNull();
    expect(screen.getByTestId('settings-sync-pull-interval')).not.toBeNull();
    expect(screen.getByTestId('settings-sync-push-interval')).not.toBeNull();
  });

  test('a push denial under the shared default Auto mode offers the pull-only switch', async () => {
    syncStatus = {
      ...syncStatus,
      state: 'disabled',
      pausedReason: 'no-push-permission',
      pushPermission: { checkStatus: 'denied', deniedReason: 'no-collaborator' },
    } as SyncStatus;

    await renderSyncSection();

    expect(screen.getByTestId('settings-sync-mode-toggle').getAttribute('data-value')).toBe('full');
    expect(screen.getByTestId('settings-sync-switch-follow')).not.toBeNull();
  });

  test('the shared default note waits until the local choice is known', async () => {
    projectLocalConfig = null;
    projectLocalSynced = false;
    syncStatus = { ...syncStatus, syncEnabled: false, syncMode: 'off' } as SyncStatus;

    await renderSyncSection();

    const toggle = screen.getByTestId('settings-sync-mode-toggle');
    expect(toggle.getAttribute('data-value')).toBe('off');
    expect(screen.queryByTestId('settings-sync-mode-from-default')).toBeNull();
    expect(toggle.getAttribute('aria-describedby')).toBeNull();
  });

  test('with no shared default the control shows Manual and no shared default note', async () => {
    projectConfig = { autoSync: { default: null }, content: { attachmentFolderPath: './' } };
    syncStatus = { ...syncStatus, syncEnabled: false, syncMode: 'off' } as SyncStatus;

    await renderSyncSection();

    expect(screen.getByTestId('settings-sync-mode-toggle').getAttribute('data-value')).toBe('off');
    expect(screen.queryByTestId('settings-sync-mode-from-default')).toBeNull();
  });

  test('with no shared default, pressing the shown Manual mode writes nothing', async () => {
    projectConfig = { autoSync: { default: null }, content: { attachmentFolderPath: './' } };
    syncStatus = { ...syncStatus, syncEnabled: false, syncMode: 'off' } as SyncStatus;

    await renderSyncSection();

    fireEvent.click(screen.getByTestId('settings-sync-mode-off'));

    expect(screen.getByTestId('settings-sync-mode-toggle').getAttribute('data-value')).toBe('off');
    expect(localPatchCalls).toEqual([]);
  });
});
