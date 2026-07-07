import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createContext, type ReactNode, use, useState } from 'react';
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
  remote?: { label: string; webUrl: string | null } | null;
} | null;

let syncStatus: SyncStatus = null;
let projectLocalConfig: { autoSync?: { enabled?: boolean } } | null = {
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
let syncWriterCalls: boolean[] = [];
let syncDefaultWriterCalls: Array<boolean | null> = [];
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

mock.module('@inkeep/open-knowledge-core', () => ({
  ...actualCore,
  SHOW_INSTALL_SKILL: true,
}));

mock.module('@lingui/react/macro', () => ({
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{(value === 1 ? one : other).replace('#', String(value))}</>
  ),
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

mock.module('@lingui/core/macro', () => ({
  msg: renderLinguiTemplate,
  plural: (value: number, options: { one: string; other: string }) =>
    (value === 1 ? options.one : options.other).replace('#', String(value)),
  t: renderLinguiTemplate,
}));

mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

mock.module('@/components/ui/collapsible', () => ({
  Collapsible: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CollapsibleContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

mock.module('@/components/ui/switch', () => ({
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

mock.module('@/components/ui/skeleton', () => ({
  Skeleton: ({ className }: { className?: string }) => <div className={className} />,
}));

mock.module('@/components/ui/form', () => ({
  Form: ({ children }: { children?: ReactNode }) => <form>{children}</form>,
  FormControl: ({ children }: { children?: ReactNode }) => <>{children}</>,
  FormDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  FormField: () => null,
  FormItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FormLabel: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  FormMessage: () => null,
}));

mock.module('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

const SelectHandlerCtx = createContext<((value: string) => void) | undefined>(undefined);
mock.module('@/components/ui/select', () => ({
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
mock.module('@/components/ui/toggle-group', () => ({
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

mock.module('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

mock.module('@/components/PublishToGitHubDialog', () => ({
  PublishToGitHubDialog: (props: { open: boolean }) => {
    publishDialogProps.push(props);
    return <div data-open={String(props.open)} data-testid="publish-dialog" />;
  },
}));

mock.module('@/components/InstallInClaudeDesktopDialog', () => ({
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

mock.module('./OkignoreSection', () => ({
  OkignoreSection: (props: { binding: unknown; synced: boolean }) => {
    okignoreProps.push(props);
    return <div data-testid="okignore-section">okignore synced: {String(props.synced)}</div>;
  },
}));

mock.module('./ProjectTemplatesSection', () => ({
  ProjectTemplatesSection: () => <div data-testid="project-templates-section" />,
}));

mock.module('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatus: () => syncStatus,
  useGitSyncStatusDetailed: () => ({ status: syncStatus, fetchError: null }),
}));

mock.module('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    projectBinding,
    projectConfig,
    projectLocalConfig,
    projectLocalSynced,
    projectSynced,
  }),
}));

mock.module('@/hooks/use-enable-sync-with-confirm', () => ({
  useSyncEnabledWriter: () => ({
    write: (enabled: boolean) => {
      syncWriterCalls.push(enabled);
      return true;
    },
  }),
  useSyncDefaultWriter: () => (next: boolean | null) => {
    syncDefaultWriterCalls.push(next);
    return { ok: true };
  },
  useEnableSyncWithConfirm: (writer: { write: (enabled: boolean) => boolean }) => {
    const [confirmOpen, setConfirmOpen] = useState(false);
    return {
      confirmOpen,
      setConfirmOpen,
      onToggleRequest: (enabled: boolean) => {
        if (enabled) {
          setConfirmOpen(true);
          return;
        }
        writer.write(false);
      },
      onConfirm: () => {
        writer.write(true);
        setConfirmOpen(false);
      },
    };
  },
  EnableSyncConfirmDialog: () => null,
}));

mock.module('@/components/EnableSyncConfirmDialog', () => ({
  EnableSyncConfirmDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) => (
    <div data-open={String(open)} data-testid="sync-confirm-dialog">
      <button type="button" onClick={onConfirm}>
        Confirm sync
      </button>
    </div>
  ),
}));

mock.module('@/lib/handoff/use-claude-desktop-integration', () => ({
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
    <SettingsDialogBody
      activeId={props.activeId}
      userBinding={(props.userBinding ?? null) as never}
      okignoreBinding={(props.okignoreBinding ?? null) as never}
      okignoreSynced={props.okignoreSynced ?? false}
    />,
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
    syncWriterCalls = [];
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

  test('sync section reads checked state from project-local config and keeps the writer/confirm path', async () => {
    syncStatus = {
      state: 'enabled',
      hasRemote: true,
      syncEnabled: false,
      remote: {
        label: 'inkeep/open-knowledge',
        webUrl: 'https://github.com/inkeep/open-knowledge',
      },
    };
    projectLocalConfig = { autoSync: { enabled: true } };

    await renderBody({ activeId: 'sync' });

    const toggle = screen.getByTestId('settings-sync-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('settings-sync-remote-link').getAttribute('href')).toBe(
      'https://github.com/inkeep/open-knowledge',
    );
    expect(screen.getByTestId('settings-sync-remote-link').getAttribute('rel')).toBe(
      'noopener noreferrer',
    );

    fireEvent.click(toggle);
    expect(syncWriterCalls).toEqual([false]);

    cleanup();
    syncStatus = {
      state: 'enabled',
      hasRemote: true,
      syncEnabled: true,
      remote: { label: 'ssh://git.example/repo.git', webUrl: null },
    };
    projectLocalConfig = { autoSync: { enabled: false } };
    projectLocalSynced = false;

    await renderBody({ activeId: 'sync' });

    expect(screen.getByTestId('settings-sync-toggle').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('settings-sync-toggle').hasAttribute('disabled')).toBe(true);
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

    // "On by default" writes the committed seed `true`.
    fireEvent.click(screen.getByTestId('settings-sync-default-on'));
    expect(syncDefaultWriterCalls).toEqual([true]);

    // "Ask each person" clears the committed seed (writes null → RFC 7396 delete).
    fireEvent.click(screen.getByTestId('settings-sync-default-ask'));
    expect(syncDefaultWriterCalls).toEqual([true, null]);
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

  test('sync section disables the toggle with denied-specific accessible copy when push permission is denied', async () => {
    syncStatus = {
      state: 'idle',
      hasRemote: true,
      syncEnabled: false,
      pushPermission: { checkStatus: 'denied', deniedReason: 'no-collaborator' },
      remote: {
        label: 'inkeep/open-knowledge',
        webUrl: 'https://github.com/inkeep/open-knowledge',
      },
    };
    projectLocalConfig = { autoSync: { enabled: false } };
    projectLocalSynced = true;

    await renderBody({ activeId: 'sync' });

    const toggle = screen.getByTestId('settings-sync-toggle') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-label')).toBe(
      "Sync disabled — you don't have permission to push",
    );
    expect(screen.getByTestId('settings-sync-body').textContent).toContain(
      "you don't have permission to push",
    );
    expect(screen.queryByTestId('settings-sync-reason')).toBeNull();
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
});
