import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createContext, type ReactNode, use, useState } from 'react';
import { FormProvider } from 'react-hook-form';
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
  Form: ({ children, ...form }: { children?: ReactNode; [key: string]: unknown }) => (
    <FormProvider {...(form as never)}>
      <form>{children}</form>
    </FormProvider>
  ),
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

const configContext = () => ({
  projectBinding,
  projectConfig,
  projectLocalConfig,
  projectLocalSynced,
  projectSynced,
});
vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: configContext,
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
  useSyncIntervalWriter:
    () => (_next: { pullIntervalSeconds: number; pushIntervalSeconds: number }) => ({
      ok: true as const,
    }),
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
  });

  test('project preferences stacks the Terminal block only on a pty-capable Electron host', async () => {
    const w = window as unknown as { okDesktop?: unknown };
    w.okDesktop = {
      config: { ptyAvailable: true },
      terminal: { cliPreflight: () => Promise.resolve({ onPath: 'absent' }) },
    };
    try {
      await renderBody({ activeId: 'project-preferences' });
      expect(screen.getByTestId('settings-terminal-body')).not.toBeNull();

      cleanup();
      w.okDesktop = undefined;
      await renderBody({ activeId: 'project-preferences' });
      expect(screen.queryByTestId('settings-terminal-body')).toBeNull();
    } finally {
      w.okDesktop = undefined;
    }
  });

  test('project preferences stacks attachments and content rules under one page title', async () => {
    await renderBody({ activeId: 'project-preferences' });

    const page = screen.getByTestId('settings-project-preferences');
    expect(page.tagName).toBe('SECTION');
    expect(page.getAttribute('aria-labelledby')).toBe('settings-project-preferences-title');
    expect(document.getElementById('settings-project-preferences-title')?.textContent).toBe(
      'Preferences',
    );
    expect(screen.getByTestId('settings-attachments')).not.toBeNull();
    expect(screen.getByTestId('settings-content-rules')).not.toBeNull();
    expect(screen.queryByTestId('settings-link-previews')).toBeNull();

    expect(screen.getAllByTestId('settings-scope-badge-project').length).toBe(3);

    const pageTitles = screen.getAllByRole('heading', { level: 3 });
    expect(pageTitles.length).toBe(1);
    expect(pageTitles[0]?.textContent).toBe('Preferences');
    const blockTitles = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
    expect(blockTitles).toContain('Attachments');
    expect(blockTitles).toContain('Content rules');
  });

  test('hotkeys section renders from the shared shortcut registry', async () => {
    await renderBody({ activeId: 'hotkeys' });

    expect(screen.getByTestId('settings-hotkeys')).not.toBeNull();
    expect(screen.getByTestId('settings-hotkeys-list').textContent).toContain('Editor');
    expect(screen.getAllByText('Workspace').length).toBeGreaterThan(0);
    expect(screen.getByTestId('settings-scope-badge-user')).not.toBeNull();
  });

  test('user preferences carries the User badge on its heading', async () => {
    await renderBody({
      activeId: 'preferences',
      userBinding: { current: () => ({}), subscribe: () => () => {} },
    });
    expect(screen.getByTestId('settings-scope-badge-user')).not.toBeNull();
    expect(screen.queryByTestId('settings-scope-badge-project')).toBeNull();
  });

  test('sync page stacks the config-sharing block under the sync controls', async () => {
    syncStatus = { state: 'dormant', hasRemote: false, syncEnabled: false };

    await renderBody({ activeId: 'sync' });

    expect(document.querySelector('[data-field="section:sharing"]')).not.toBeNull();

    const pageTitles = screen.getAllByRole('heading', { level: 3 });
    expect(pageTitles.map((h) => h.textContent)).toEqual(['Sync & sharing']);
    const blockTitles = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
    expect(blockTitles).toContain('Sync');
    expect(blockTitles).toContain('Config sharing');

    const page = screen.getByTestId('settings-sync-sharing');
    expect(page.tagName).toBe('SECTION');
    expect(page.getAttribute('aria-labelledby')).toBe('settings-sync-sharing-title');

    expect(screen.getByTestId('settings-scope-badge-project-local').textContent).toBe(
      'This machine',
    );
    expect(screen.getByTestId('settings-scope-badge-project').textContent).toBe('Project');
  });

  test('project preferences includes attachments controls mapped to content.attachmentFolderPath', async () => {
    projectConfig = {
      autoSync: { default: null },
      content: { attachmentFolderPath: './' },
    };

    await renderBody({ activeId: 'project-preferences' });

    const attachments = () => within(screen.getByTestId('settings-attachments'));
    expect(screen.getByTestId('settings-attachments')).not.toBeNull();
    expect(attachments().getByTestId('select-root').getAttribute('data-value')).toBe('same-folder');

    fireEvent.click(attachments().getByText('Fixed folder in content root'));
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

    fireEvent.click(attachments().getByText('Content root'));
    expect(projectBindingPatchCalls.at(-1)).toEqual({
      content: { attachmentFolderPath: '/' },
    });
  });

  test('project preferences round trips current-folder attachment subfolders', async () => {
    projectConfig = {
      autoSync: { default: null },
      content: { attachmentFolderPath: './attachments' },
    };

    await renderBody({ activeId: 'project-preferences' });

    expect(
      within(screen.getByTestId('settings-attachments'))
        .getByTestId('select-root')
        .getAttribute('data-value'),
    ).toBe('current-folder-subfolder');
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

    await renderBody({ activeId: 'project-preferences' });

    const attachmentsSelectValue = () =>
      within(screen.getByTestId('settings-attachments'))
        .getByTestId('select-root')
        .getAttribute('data-value');
    expect(attachmentsSelectValue()).toBe('content-root-folder');
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
    await renderBody({ activeId: 'project-preferences' });

    expect(attachmentsSelectValue()).toBe('content-root-folder');
  });

  test('project preferences surfaces attachment patch failures inline', async () => {
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

    await renderBody({ activeId: 'project-preferences' });

    fireEvent.click(
      within(screen.getByTestId('settings-attachments')).getByText('Fixed folder in content root'),
    );

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
    projectConfig = { autoSync: { default: false } };
    projectSynced = true;

    await renderBody({ activeId: 'sync' });

    expect(screen.getByTestId('settings-sync-default-toggle').getAttribute('data-value')).toBe(
      'off',
    );

    const defaultBlock = within(screen.getByTestId('settings-sync-default'));
    expect(defaultBlock.getByTestId('settings-scope-badge-project').textContent).toBe('Project');

    fireEvent.click(screen.getByTestId('settings-sync-default-full'));
    expect(syncDefaultWriterCalls).toEqual([true]);

    fireEvent.click(screen.getByTestId('settings-sync-default-follow'));
    expect(syncDefaultWriterCalls).toEqual([true, 'follow']);

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

    expect(screen.getByTestId('settings-sync-mode-toggle').getAttribute('data-disabled')).toBe(
      'false',
    );
    expect(screen.getByTestId('settings-sync-denied-hint').textContent).toContain(
      "You don't have permission to push",
    );
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
    fireEvent.click(screen.getByTestId('settings-sync-switch-follow-action'));
    expect(syncModeSelectCalls).toEqual(['follow']);
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

  test('sync section shows the not-found copy instead of the reconnect prescription', async () => {
    syncStatus = {
      state: 'auth-error',
      hasRemote: true,
      pausedReason: 'auth-error',
      pushErrorCode: 'auth-not-found-as-identity',
      syncEnabled: true,
      remote: {
        label: 'inkeep/open-knowledge',
        webUrl: 'https://github.com/inkeep/open-knowledge',
      },
    };
    projectLocalConfig = { autoSync: { enabled: true } };

    await renderBody({ activeId: 'sync' });

    expect(screen.getByTestId('settings-sync-reason').textContent).toBe(
      'Repository not found — it may not exist, or the account used may not have access.',
    );
    expect(screen.queryByText('Reconnect required')).toBeNull();
  });

  test('sync section keeps the not-found copy when a denied probe verdict is also in hand', async () => {
    syncStatus = {
      state: 'auth-error',
      hasRemote: true,
      pausedReason: 'auth-error',
      pushErrorCode: 'auth-not-found-as-identity',
      pushPermission: {
        checkStatus: 'denied',
        deniedReason: 'private-no-access',
        resolvedLogin: 'bob',
      },
      syncEnabled: true,
      remote: {
        label: 'inkeep/open-knowledge',
        webUrl: 'https://github.com/inkeep/open-knowledge',
      },
    };
    projectLocalConfig = { autoSync: { mode: 'full' } };

    await renderBody({ activeId: 'sync' });

    expect(screen.getByTestId('settings-sync-reason').textContent).toBe(
      'Repository not found — it may not exist, or the account used may not have access.',
    );
    expect(screen.queryByTestId('settings-sync-switch-follow')).toBeNull();
    expect(screen.queryByTestId('settings-sync-denied-hint')).toBeNull();
    expect(screen.getByTestId('settings-sync-identity').textContent).toBe('Authenticated as bob.');
    expect((screen.getByTestId('settings-sync-mode-full') as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.queryByTestId('settings-sync-mode-full-tip')).toBeNull();
  });

  test('sync section renders both identity sentences when the wire carries a declared miss', async () => {
    syncStatus = {
      state: 'auth-error',
      hasRemote: true,
      pausedReason: 'auth-error',
      pushErrorCode: 'auth-not-found-as-identity',
      pushPermission: {
        checkStatus: 'denied',
        deniedReason: 'private-no-access',
        resolvedLogin: 'bob',
        declaredLogin: 'alice',
        declaredSource: 'remote-url',
      },
      syncEnabled: true,
      remote: {
        label: 'inkeep/open-knowledge',
        webUrl: 'https://github.com/inkeep/open-knowledge',
      },
    };
    projectLocalConfig = { autoSync: { mode: 'full' } };

    await renderBody({ activeId: 'sync' });

    const identity = screen.getByTestId('settings-sync-identity');
    expect(identity.textContent).toContain('Authenticated as bob.');
    expect(identity.textContent).toContain(
      "Your remote URL names alice, but that account's credentials couldn't be used.",
    );
  });

  test('sync section still explains the not-found failure after an offline transition', async () => {
    syncStatus = {
      state: 'offline',
      hasRemote: true,
      pausedReason: 'auth-error',
      pushErrorCode: 'auth-not-found-as-identity',
      pushPermission: { checkStatus: 'denied', deniedReason: 'private-no-access' },
      syncEnabled: true,
      remote: {
        label: 'inkeep/open-knowledge',
        webUrl: 'https://github.com/inkeep/open-knowledge',
      },
    };
    projectLocalConfig = { autoSync: { mode: 'full' } };

    await renderBody({ activeId: 'sync' });

    expect(screen.getByTestId('settings-sync-reason').textContent).toBe(
      'Repository not found — it may not exist, or the account used may not have access.',
    );
    expect(screen.queryByTestId('settings-sync-switch-follow')).toBeNull();
    expect(screen.queryByTestId('settings-sync-denied-hint')).toBeNull();
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
  test('dispatches every lint plugin id built by pluginSettingsSectionId', async () => {
    const { pluginSettingsSectionId } = await import('@/lib/use-settings-route');
    const { LINT_PLUGIN_META } = await import('./lint-plugin-meta');

    for (const plugin of LINT_PLUGIN_META) {
      cleanup();
      await renderBody({ activeId: pluginSettingsSectionId(plugin.id) });
      expect(screen.getByTestId(`settings-plugin-${plugin.id}`)).toBeTruthy();
    }
  });

  test('dispatches plugin:slides to its own panel above the lint-plugin fallthrough', async () => {
    const { pluginSettingsSectionId } = await import('@/lib/use-settings-route');
    await renderBody({ activeId: pluginSettingsSectionId('slides') });
    expect(screen.getByTestId('settings-plugin-slides')).toBeTruthy();
  });
});
