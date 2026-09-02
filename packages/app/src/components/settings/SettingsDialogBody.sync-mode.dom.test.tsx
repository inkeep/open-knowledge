import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createContext, type ReactNode, StrictMode, use } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

type SyncStatus = {
  state: string;
  hasRemote: boolean;
  pausedReason?: string;
  pushPermission?: { checkStatus: 'allowed' | 'denied' | 'unknown'; deniedReason?: string };
  syncEnabled?: boolean;
  syncMode?: 'off' | 'follow' | 'full';
  ahead?: number;
  remote?: { label: string; webUrl: string | null } | null;
} | null;

let syncStatus: SyncStatus = null;
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

const ToggleGroupHandlerCtx = createContext<((value: string) => void) | undefined>(undefined);
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
    <ToggleGroupHandlerCtx.Provider value={onValueChange}>
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
    const onValueChange = use(ToggleGroupHandlerCtx);
    return (
      <button type="button" onClick={() => onValueChange?.(value as string)} {...props}>
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
  useGitSyncStatusDetailed: () => ({ status: syncStatus, fetchError: null }),
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
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
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

  test('a signed-out follower is told the anonymous floor overrides the setting', async () => {
    syncStatus = {
      ...syncStatus,
      pushPermission: { checkStatus: 'denied', deniedReason: 'not-authenticated' },
    } as SyncStatus;

    await renderSyncSection();

    expect(screen.queryByTestId('settings-sync-anon-floor-hint')).not.toBeNull();
  });

  test('a signed-in follower sees no anonymous-floor caption', async () => {
    syncStatus = { ...syncStatus, pushPermission: { checkStatus: 'allowed' } } as SyncStatus;

    await renderSyncSection();

    expect(screen.queryByTestId('settings-sync-anon-floor-hint')).toBeNull();
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
