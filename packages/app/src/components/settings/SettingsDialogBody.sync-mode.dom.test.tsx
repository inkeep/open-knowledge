/**
 * Integration coverage for the three-way sync-mode control in the Settings Sync
 * section. Unlike the sibling sections test (which stubs the sync hooks), this
 * renders the REAL `useSyncModeSelection` / `useSyncModeWriter` hooks and the
 * REAL `EnableSyncConfirmDialog`, mocking only the config-binding boundary, the
 * status feed, and leaf UI primitives. It proves the actual wiring: select a
 * mode -> the consent dialog opens with the right copy -> confirming patches
 * `autoSync.mode` on the project-local binding.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createContext, type ReactNode, use } from 'react';
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
  autoSync?: { enabled?: boolean; mode?: 'off' | 'follow' | 'full' };
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
  Collapsible: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CollapsibleContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

// The sync section renders no Switch (mode uses a ToggleGroup); a bare stub
// satisfies the module import without tripping the switch-role a11y lint.
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

vi.doMock('@/components/ui/select', () => ({
  Select: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
}));

// Recorder ToggleGroup: reliable, deterministic clicks that forward the item
// value to the REAL onValueChange handler (the hook under test).
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

// Import the component AFTER the doMock calls so it picks up the mocked deps
// while keeping the REAL sync hooks + REAL EnableSyncConfirmDialog. RTL itself
// depends on none of the mocked modules, so it stays a static top-level import
// (the Tier-3 filename contract requires it).
async function renderSyncSection() {
  const { SettingsDialogBody } = await import('./SettingsDialogBody');
  render(
    <TooltipProvider>
      <SettingsDialogBody
        activeId="sync"
        userBinding={null as never}
        okignoreBinding={null as never}
        okignoreSynced={false}
      />
    </TooltipProvider>,
  );
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

    // The real pull-variant confirmation renders; no write yet.
    expect(screen.getByRole('button', { name: 'Enable Follow' })).not.toBeNull();
    expect(screen.getByRole('note').textContent ?? '').toContain('Updates flow in');
    expect(localPatchCalls).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Enable Follow' }));
    expect(localPatchCalls).toEqual([{ autoSync: { mode: 'follow', enabled: null } }]);
  });

  test('selecting Full opens the bidirectional confirm and patches full on confirm', async () => {
    await renderSyncSection();

    fireEvent.click(screen.getByTestId('settings-sync-mode-full'));

    expect(screen.getByRole('button', { name: 'Enable auto-sync' })).not.toBeNull();
    expect(screen.getByRole('note').textContent ?? '').toContain('Commits happen automatically');

    fireEvent.click(screen.getByRole('button', { name: 'Enable auto-sync' }));
    expect(localPatchCalls).toEqual([{ autoSync: { mode: 'full', enabled: null } }]);
  });

  test('selecting Off writes immediately with no confirmation', async () => {
    projectLocalConfig = { autoSync: { mode: 'full' } };
    syncStatus = { ...syncStatus, syncMode: 'full', syncEnabled: true } as SyncStatus;

    await renderSyncSection();

    fireEvent.click(screen.getByTestId('settings-sync-mode-off'));

    expect(localPatchCalls).toEqual([{ autoSync: { mode: 'off', enabled: null } }]);
    // No confirmation dialog for the safe direction.
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

    // Pull-variant confirm with the stranded-commit disclosure sourced from ahead.
    expect(
      screen.getByText("You have 2 changes you haven't shared. They will stay on this computer."),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Enable Follow' }));
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
    // The disabled Full item carries a tooltip explaining the read-only denial.
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
