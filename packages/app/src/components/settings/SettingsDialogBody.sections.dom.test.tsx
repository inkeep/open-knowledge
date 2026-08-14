import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createContext, type ReactNode, use, useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

type SyncStatus = {
  state: string;
  hasRemote: boolean;
  pausedReason?: string;
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
let projectLocalConfig: {
  autoSync?: { enabled?: boolean; mode?: 'off' | 'follow' | 'full' };
} | null = {
  autoSync: { enabled: true },
};
let projectLocalSynced = true;
let projectConfig: {
  autoSync?: { default?: boolean | null };
  content: { attachmentFolderPath: string };
} | null = {
  autoSync: { default: null },
  content: { attachmentFolderPath: './' },
};
let projectSynced = true;
let projectBinding: {
  patch: (patch: unknown) => { ok: true } | { ok: false; error: unknown };
} | null = null;
let projectBindingPatchCalls: unknown[] = [];
let syncModeWriterCalls: string[] = [];
let syncModeSelectCalls: string[] = [];
let syncDefaultWriterCalls: Array<boolean | string | null> = [];
let okignoreProps: Array<{ binding: unknown; synced: boolean }> = [];
let installDialogProps: Array<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reinstall: boolean;
}> = [];
let publishDialogProps: Array<{ open: boolean }> = [];
let claudeRefreshCalls = 0;
let claudeSkillInstalled = false;

const actualCore = await import('@inkeep/open-knowledge-core');

import * as actualLinguiMacro from '@lingui/react/macro';

vi.doMock('@inkeep/open-knowledge-core', () => ({
  ...actualCore,
  SHOW_INSTALL_SKILL: true,
}));

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

vi.doMock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    [key: string]: unknown;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked ? 'true' : 'false'}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      {...props}
    />
  ),
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

vi.doMock('@/hooks/use-skills', () => ({
  useSkills: () => ({ status: 'ready', data: [] }),
}));

vi.doMock('@/hooks/use-open-skill', () => ({
  useOpenSkill: () => () => {},
}));

const SelectHandlerCtx = createContext<((value: string) => void) | undefined>(undefined);
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
    <SelectHandlerCtx.Provider value={onValueChange}>
      <div data-testid="select-root" data-value={value}>
        {children}
      </div>
    </SelectHandlerCtx.Provider>
  ),
  SelectContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectItem: ({
    children,
    value,
    ...props
  }: {
    children?: ReactNode;
    value: string;
    [key: string]: unknown;
  }) => {
    const onValueChange = use(SelectHandlerCtx);
    return (
      <button type="button" onClick={() => onValueChange?.(value)} {...props}>
        {children}
      </button>
    );
  },
  SelectTrigger: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SelectValue: () => null,
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
  PublishToGitHubDialog: (props: { open: boolean }) => {
    publishDialogProps.push(props);
    return <div data-open={String(props.open)} data-testid="publish-dialog" />;
  },
}));

vi.doMock('@/components/InstallInClaudeDesktopDialog', () => ({
  InstallInClaudeDesktopDialog: (props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    reinstall: boolean;
  }) => {
    installDialogProps.push(props);
    return (
      <div
        data-open={String(props.open)}
        data-reinstall={String(props.reinstall)}
        data-testid="install-claude-dialog"
      />
    );
  },
}));

vi.doMock('./OkignoreSection', () => ({
  OkignoreSection: (props: { binding: unknown; synced: boolean }) => {
    okignoreProps.push(props);
    return <div data-testid="okignore-section">okignore synced: {String(props.synced)}</div>;
  },
}));

vi.doMock('./ProjectTemplatesSection', () => ({
  ProjectTemplatesSection: () => <div data-testid="project-templates-section" />,
}));

vi.doMock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatus: () => syncStatus,
  useGitSyncStatusDetailed: () => ({ status: syncStatus, fetchError: null }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    projectBinding,
    projectConfig,
    projectLocalConfig,
    projectLocalSynced,
    projectSynced,
  }),
}));

type ModeWriterFn = (mode: string) => { ok: true };
vi.doMock('@/hooks/use-enable-sync-with-confirm', () => ({
  useSyncModeWriter: (): ModeWriterFn => (mode: string) => {
    syncModeWriterCalls.push(mode);
    return { ok: true };
  },
  useSyncDefaultWriter: () => (next: boolean | string | null) => {
    syncDefaultWriterCalls.push(next);
    return { ok: true };
  },
  // Thin recorder mirroring the real hook's gating so the section's wiring is
  // exercised (deep confirm-flow behavior is covered against the real hook in
  // SettingsDialogBody.sync-mode.dom.test.tsx and the hook's own test).
  useSyncModeSelection: (writer: ModeWriterFn, currentMode: string) => {
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [pendingMode, setPendingMode] = useState<'follow' | 'full' | null>(null);
    return {
      confirmOpen,
      setConfirmOpen,
      pendingMode,
      onModeSelect: (next: string) => {
        syncModeSelectCalls.push(next);
        if (next === currentMode) return;
        if (next === 'off') {
          writer('off');
          return;
        }
        setPendingMode(next as 'follow' | 'full');
        setConfirmOpen(true);
      },
      onConfirm: () => {
        if (pendingMode) writer(pendingMode);
        setConfirmOpen(false);
      },
    };
  },
}));

vi.doMock('@/components/EnableSyncConfirmDialog', () => ({
  EnableSyncConfirmDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) => (
    <div data-open={String(open)} data-testid="sync-confirm-dialog">
      <button type="button" onClick={onConfirm}>
        Confirm sync
      </button>
    </div>
  ),
}));

vi.doMock('@/lib/handoff/use-claude-desktop-integration', () => ({
  useClaudeDesktopIntegration: () => ({
    desktopPresent: true,
    skillInstalled: claudeSkillInstalled,
    skillVersion: claudeSkillInstalled ? '1.0.0' : null,
    refresh: () => {
      claudeRefreshCalls += 1;
    },
  }),
}));

async function renderBody(
  props: {
    activeId: string;
    userBinding?: unknown;
    okignoreBinding?: unknown;
    okignoreSynced?: boolean;
  } = { activeId: 'sync' },
) {
  const { SettingsDialogBody } = await import('./SettingsDialogBody');
  render(
    <TooltipProvider>
      <SettingsDialogBody
        activeId={props.activeId}
        userBinding={(props.userBinding ?? null) as never}
        okignoreBinding={(props.okignoreBinding ?? null) as never}
        okignoreSynced={props.okignoreSynced ?? false}
      />
    </TooltipProvider>,
  );
}

describe('SettingsDialogBody section runtime dispatch', () => {
  beforeEach(() => {
    cleanup();
    syncStatus = null;
    projectLocalConfig = { autoSync: { enabled: true } };
    projectLocalSynced = true;
    projectConfig = { autoSync: { default: null }, content: { attachmentFolderPath: './' } };
    projectSynced = true;
    projectBindingPatchCalls = [];
    projectBinding = {
      patch: (patch: unknown) => {
        projectBindingPatchCalls.push(patch);
        return { ok: true };
      },
    };
    syncModeWriterCalls = [];
    syncModeSelectCalls = [];
    syncDefaultWriterCalls = [];
    okignoreProps = [];
    installDialogProps = [];
    publishDialogProps = [];
    claudeRefreshCalls = 0;
    claudeSkillInstalled = false;
  });

  test('body dispatches heavy project sections without owning a Dialog frame', async () => {
    const okignoreBinding = { id: 'okignore-binding' };

    await renderBody({ activeId: 'okignore', okignoreBinding, okignoreSynced: true });

    expect(screen.getByTestId('okignore-section').textContent).toContain('true');
    expect(okignoreProps.at(-1)).toEqual({ binding: okignoreBinding, synced: true });
    expect(screen.queryByRole('dialog')).toBeNull();

    cleanup();
    await renderBody({ activeId: 'project-templates' });
    expect(screen.getByTestId('project-templates-section')).not.toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();

    cleanup();
    await renderBody({ activeId: 'terminal' });
    expect(screen.getByTestId('settings-terminal-body')).not.toBeNull();
  });

  test('hotkeys section renders from the shared shortcut registry', async () => {
    await renderBody({ activeId: 'hotkeys' });

    expect(screen.getByTestId('settings-hotkeys')).not.toBeNull();
    expect(screen.getByTestId('settings-hotkeys-list').textContent).toContain('Editor');
    expect(screen.getAllByText('Workspace').length).toBeGreaterThan(0);
  });

  test('preferences shows no user/project scope badge (badges are plugin-panel-only)', async () => {
    await renderBody({ activeId: 'preferences' });
    expect(screen.queryByTestId('settings-scope-badge-user')).toBeNull();
    expect(screen.queryByTestId('settings-scope-badge-project')).toBeNull();
  });

  test('preferences includes attachments controls mapped to content.attachmentFolderPath', async () => {
    projectConfig = {
      autoSync: { default: null },
      content: { attachmentFolderPath: './' },
    };

    await renderBody({ activeId: 'preferences' });

    expect(screen.getByTestId('settings-attachments')).not.toBeNull();
    expect(screen.getByTestId('select-root').getAttribute('data-value')).toBe('same-folder');

    fireEvent.click(screen.getByText('Fixed folder in content root'));
    expect(projectBindingPatchCalls.at(-1)).toEqual({
      content: { attachmentFolderPath: 'attachments' },
    });
    expect(screen.getByTestId('settings-attachments-folder')).not.toBeNull();

    fireEvent.change(screen.getByTestId('settings-attachments-folder'), {
      target: { value: 'assets/uploads' },
    });
    fireEvent.blur(screen.getByTestId('settings-attachments-folder'));

    expect(projectBindingPatchCalls.at(-1)).toEqual({
      content: { attachmentFolderPath: 'assets/uploads' },
    });

    fireEvent.click(screen.getByText('Content root'));
    expect(projectBindingPatchCalls.at(-1)).toEqual({
      content: { attachmentFolderPath: '/' },
    });
  });

  test('preferences round trips current-folder attachment subfolders', async () => {
    projectConfig = {
      autoSync: { default: null },
      content: { attachmentFolderPath: './attachments' },
    };

    await renderBody({ activeId: 'preferences' });

    expect(screen.getByTestId('select-root').getAttribute('data-value')).toBe(
      'current-folder-subfolder',
    );
    expect((screen.getByTestId('settings-attachments-folder') as HTMLInputElement).value).toBe(
      'attachments',
    );

    fireEvent.change(screen.getByTestId('settings-attachments-folder'), {
      target: { value: 'media' },
    });
    fireEvent.blur(screen.getByTestId('settings-attachments-folder'));

    expect(projectBindingPatchCalls.at(-1)).toEqual({
      content: { attachmentFolderPath: './media' },
    });
  });

  test('fixed content-root folder strips leading dot slash to avoid remounting as current-folder mode', async () => {
    projectConfig = {
      autoSync: { default: null },
      content: { attachmentFolderPath: 'attachments' },
    };

    await renderBody({ activeId: 'preferences' });

    expect(screen.getByTestId('select-root').getAttribute('data-value')).toBe(
      'content-root-folder',
    );
    fireEvent.change(screen.getByTestId('settings-attachments-folder'), {
      target: { value: './media' },
    });
    fireEvent.blur(screen.getByTestId('settings-attachments-folder'));

    expect(projectBindingPatchCalls.at(-1)).toEqual({
      content: { attachmentFolderPath: 'media' },
    });

    projectConfig = {
      autoSync: { default: null },
      content: { attachmentFolderPath: 'media' },
    };
    cleanup();
    await renderBody({ activeId: 'preferences' });

    expect(screen.getByTestId('select-root').getAttribute('data-value')).toBe(
      'content-root-folder',
    );
  });

  test('preferences surfaces attachment patch failures inline', async () => {
    projectConfig = {
      autoSync: { default: null },
      content: { attachmentFolderPath: './' },
    };
    projectBinding = {
      patch: (patch: unknown) => {
        projectBindingPatchCalls.push(patch);
        return {
          ok: false,
          error: {
            code: 'SCHEMA_INVALID',
            issues: [
              {
                path: ['content', 'attachmentFolderPath'],
                message: 'Folder must stay inside the content root',
                issueCode: 'invalid_path',
              },
            ],
          },
        };
      },
    };

    await renderBody({ activeId: 'preferences' });

    fireEvent.click(screen.getByText('Fixed folder in content root'));

    expect(projectBindingPatchCalls.at(-1)).toEqual({
      content: { attachmentFolderPath: 'attachments' },
    });
    expect(within(screen.getByTestId('settings-attachments')).getByRole('alert').textContent).toBe(
      'Folder must stay inside the content root',
    );
  });

  test('sync section reflects the resolved mode and wires the three-way control', async () => {
    syncStatus = {
      state: 'idle',
      hasRemote: true,
      syncEnabled: true,
      syncMode: 'full',
      remote: {
        label: 'inkeep/open-knowledge',
        webUrl: 'https://github.com/inkeep/open-knowledge',
      },
    };
    // Legacy `enabled: true` derives to full mode.
    projectLocalConfig = { autoSync: { enabled: true } };

    await renderBody({ activeId: 'sync' });

    const modeToggle = screen.getByTestId('settings-sync-mode-toggle');
    expect(modeToggle.getAttribute('data-value')).toBe('full');
    expect(screen.getByTestId('settings-sync-remote-link').getAttribute('href')).toBe(
      'https://github.com/inkeep/open-knowledge',
    );
    expect(screen.getByTestId('settings-sync-remote-link').getAttribute('rel')).toBe(
      'noopener noreferrer',
    );

    // Selecting Off is the safe direction — commits immediately, no confirm.
    fireEvent.click(screen.getByTestId('settings-sync-mode-off'));
    expect(syncModeSelectCalls).toEqual(['off']);
    expect(syncModeWriterCalls).toEqual(['off']);

    cleanup();
    syncStatus = {
      state: 'idle',
      hasRemote: true,
      syncEnabled: true,
      syncMode: 'follow',
      remote: { label: 'ssh://git.example/repo.git', webUrl: null },
    };
    projectLocalConfig = { autoSync: { mode: 'follow' } };
    projectLocalSynced = false;

    await renderBody({ activeId: 'sync' });

    // Explicit mode wins; the control is disabled until the project-local config
    // has hydrated (cold-start guard).
    expect(screen.getByTestId('settings-sync-mode-toggle').getAttribute('data-value')).toBe(
      'follow',
    );
    expect(screen.getByTestId('settings-sync-mode-toggle').getAttribute('data-disabled')).toBe(
      'true',
    );
    expect(screen.getByTestId('settings-sync-remote-label').textContent).toBe(
      'ssh://git.example/repo.git',
    );
  });

  test('committed default control reflects autoSync.default and writes the chosen seed', async () => {
    syncStatus = {
      state: 'enabled',
      hasRemote: true,
      syncEnabled: false,
      remote: {
        label: 'inkeep/open-knowledge',
        webUrl: 'https://github.com/inkeep/open-knowledge',
      },
    };
    // Maintainer has committed "off by default".
    projectConfig = { autoSync: { default: false } };
    projectSynced = true;

    await renderBody({ activeId: 'sync' });

    // Current committed stance reflected on the group's selected value.
    expect(screen.getByTestId('settings-sync-default-toggle').getAttribute('data-value')).toBe(
      'off',
    );

    // "Full by default" writes the legacy boolean seed `true` (older builds honor it).
    fireEvent.click(screen.getByTestId('settings-sync-default-full'));
    expect(syncDefaultWriterCalls).toEqual([true]);

    // "Pull-only by default" writes the widened mode string.
    fireEvent.click(screen.getByTestId('settings-sync-default-follow'));
    expect(syncDefaultWriterCalls).toEqual([true, 'follow']);

    // "None" clears the committed seed (writes null → RFC 7396 delete).
    fireEvent.click(screen.getByTestId('settings-sync-default-ask'));
    expect(syncDefaultWriterCalls).toEqual([true, 'follow', null]);
  });

  test('committed default control is disabled until the committed config has synced', async () => {
    syncStatus = {
      state: 'enabled',
      hasRemote: true,
      syncEnabled: false,
      remote: {
        label: 'inkeep/open-knowledge',
        webUrl: 'https://github.com/inkeep/open-knowledge',
      },
    };
    projectConfig = { autoSync: { default: null } };
    projectSynced = false;

    await renderBody({ activeId: 'sync' });

    // Cold-start guard: a click before the committed doc syncs could overwrite a
    // maintainer's committed default with the schema default (null), silently
    // re-enabling the onboarding prompt for every collaborator.
    expect(screen.getByTestId('settings-sync-default-toggle').getAttribute('data-disabled')).toBe(
      'true',
    );
  });

  test('sync section keeps the mode control enabled and points a denied receiver at pull-only', async () => {
    syncStatus = {
      state: 'idle',
      hasRemote: true,
      syncEnabled: false,
      syncMode: 'off',
      pushPermission: { checkStatus: 'denied', deniedReason: 'no-collaborator' },
      remote: {
        label: 'inkeep/open-knowledge',
        webUrl: 'https://github.com/inkeep/open-knowledge',
      },
    };
    projectLocalConfig = { autoSync: { mode: 'off' } };
    projectLocalSynced = true;

    await renderBody({ activeId: 'sync' });

    // A denied probe no longer disables the control — pull-only never pushes, so
    // the receiver must be able to reach it.
    expect(screen.getByTestId('settings-sync-mode-toggle').getAttribute('data-disabled')).toBe(
      'false',
    );
    expect(screen.getByTestId('settings-sync-denied-hint').textContent).toContain(
      "You don't have permission to push",
    );
    // Off mode is not paused; the switch-to-pull affordance is full-only.
    expect(screen.queryByTestId('settings-sync-switch-follow')).toBeNull();
  });

  test('sync section offers Switch to pull-only when full sync is paused on a denied push probe', async () => {
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
    projectLocalConfig = { autoSync: { mode: 'full' } };
    projectLocalSynced = true;

    await renderBody({ activeId: 'sync' });

    expect(screen.getByTestId('settings-sync-switch-follow')).not.toBeNull();
    // The action routes through the mode selector toward pull-only.
    fireEvent.click(screen.getByTestId('settings-sync-switch-follow-action'));
    expect(syncModeSelectCalls).toEqual(['follow']);
    // Opening the confirm, not an immediate write (consent gate).
    expect(syncModeWriterCalls).toEqual([]);
    expect(screen.getByTestId('sync-confirm-dialog').getAttribute('data-open')).toBe('true');
  });

  test('sync section renders shared paused-reason copy for non-permission pause reasons', async () => {
    syncStatus = {
      state: 'disabled',
      hasRemote: true,
      pausedReason: 'protected-branch',
      syncEnabled: false,
      remote: {
        label: 'inkeep/open-knowledge',
        webUrl: 'https://github.com/inkeep/open-knowledge',
      },
    };
    projectLocalConfig = { autoSync: { enabled: false } };

    await renderBody({ activeId: 'sync' });

    expect(screen.getByTestId('settings-sync-reason').textContent).toBe(
      'Protected branch — cannot push',
    );
  });

  test('sync empty state offers Publish wizard and keeps the advanced git remote path', async () => {
    syncStatus = { state: 'dormant', hasRemote: false, syncEnabled: false };

    await renderBody({ activeId: 'sync' });

    expect(screen.getByTestId('settings-sync-empty').textContent).toContain(
      'lives only on this computer',
    );
    expect(screen.getByText(/git remote add origin/).textContent).toContain(
      'git remote add origin',
    );
    expect(screen.getByTestId('publish-dialog').getAttribute('data-open')).toBe('false');

    fireEvent.click(screen.getByTestId('settings-sync-setup'));

    await waitFor(() => {
      expect(screen.getByTestId('publish-dialog').getAttribute('data-open')).toBe('true');
    });
    expect(publishDialogProps.at(-1)?.open).toBe(true);
  });

  test('integrations row reflects shared Claude Desktop state and refreshes when installer closes', async () => {
    claudeSkillInstalled = false;
    await renderBody({ activeId: 'claude-desktop' });

    expect(screen.getByText('Install in Claude Desktop')).not.toBeNull();
    expect(screen.getByTestId('settings-install-claude-desktop').textContent).toBe('Install');

    fireEvent.click(screen.getByTestId('settings-install-claude-desktop'));
    await waitFor(() => {
      expect(screen.getByTestId('install-claude-dialog').getAttribute('data-open')).toBe('true');
    });
    expect(installDialogProps.at(-1)?.reinstall).toBe(false);

    act(() => {
      installDialogProps.at(-1)?.onOpenChange(false);
    });
    expect(claudeRefreshCalls).toBe(1);

    cleanup();
    claudeSkillInstalled = true;
    await renderBody({ activeId: 'claude-desktop' });

    expect(screen.getByTestId('settings-install-claude-desktop').textContent).toBe('Reinstall');
    expect(screen.getByTestId('install-claude-dialog').getAttribute('data-reinstall')).toBe('true');
  });
  // Drift guard: `plugin:<id>` is constructed independently in three places —
  // `pluginSettingsSectionId`, the shell's sidebar group, and this dispatcher.
  // Nothing in the type system ties them, and the enable notice's deep link
  // silently falls back to Preferences if they diverge. `lint-plugin-meta.test.ts`
  // is the local precedent for this shape of guard.
  test('dispatches every lint plugin id built by pluginSettingsSectionId', async () => {
    const { pluginSettingsSectionId } = await import('@/lib/use-settings-route');
    const { LINT_PLUGIN_META } = await import('./lint-plugin-meta');

    for (const plugin of LINT_PLUGIN_META) {
      cleanup();
      await renderBody({ activeId: pluginSettingsSectionId(plugin.id) });
      expect(screen.getByTestId(`settings-plugin-${plugin.id}`)).toBeTruthy();
    }
  });

  // Same drift guard, non-lint branch. Slides is a peer of the theme plugin: it
  // owns no `contentRules` slice, so it is NOT in LINT_PLUGIN_META and the
  // generic `plugin:` fallthrough (which only knows the lint registry) cannot
  // dispatch it. This pins the dispatch→panel half of the hand-wired id; the
  // shell sidebar half is pinned in SettingsDialogShell.dom.test.tsx.
  test('dispatches plugin:slides to its own panel above the lint-plugin fallthrough', async () => {
    const { pluginSettingsSectionId } = await import('@/lib/use-settings-route');
    await renderBody({ activeId: pluginSettingsSectionId('slides') });
    expect(screen.getByTestId('settings-plugin-slides')).toBeTruthy();
  });
});
