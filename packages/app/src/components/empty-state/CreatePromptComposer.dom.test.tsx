import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { CreateScenario, InstallState } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ReactNode, type Ref, useImperativeHandle, useRef } from 'react';
import type { HandoffDispatchInput } from '@/components/handoff/useHandoffDispatch';
import type { Workspace } from '@/lib/workspace-paths';

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

mock.module('@/lib/config-context', () => ({
  useConfigContext: () => ({ merged: { appearance: { preview: { autoOpen: true } } } }),
}));

let states: Record<string, InstallState> = {};
mock.module('@/components/handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states, refresh: () => Promise.resolve() }),
}));

let workspaceValue: Workspace | null = null;
mock.module('@/lib/use-workspace', () => ({
  useWorkspace: () => workspaceValue,
}));

mock.module('@/components/handoff/OpenInAgentMenuItem', () => ({
  TargetIcon: ({ id }: { id: string }) => (
    <svg data-testid={`target-icon-${id}`} aria-hidden="true" />
  ),
}));

type MenuChild = {
  children?: ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
  [key: string]: unknown;
};
mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: MenuChild) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: MenuChild) => <>{children}</>,
  DropdownMenuContent: ({ children, ...props }: MenuChild) => (
    <div role="menu" {...props}>
      {children}
    </div>
  ),
  DropdownMenuGroup: ({ children }: MenuChild) => <>{children}</>,
  DropdownMenuItem: ({ children, disabled, onSelect, ...props }: MenuChild) => (
    <button type="button" role="menuitem" disabled={disabled} onClick={onSelect} {...props}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children, ...props }: MenuChild) => <div {...props}>{children}</div>,
  DropdownMenuSeparator: () => <hr data-testid="menu-separator" />,
}));

let mockMentions: string[] = [];
type MentionHandle = {
  focus: () => void;
  blur: () => void;
  clear: () => void;
  setText: (text: string) => void;
  getContent: () => { instruction: string; mentions: string[] };
};
mock.module('@/editor/ComposerMentionInput', () => ({
  ComposerMentionInput: ({
    ref,
    ariaLabel,
    placeholder,
    onEmptyChange,
    onSubmit,
    className,
  }: {
    ref?: Ref<MentionHandle>;
    ariaLabel: string;
    placeholder?: string;
    onEmptyChange: (isEmpty: boolean) => void;
    onSubmit: () => void;
    className?: string;
  }) => {
    const localRef = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => ({
      focus: () => localRef.current?.focus(),
      blur: () => localRef.current?.blur(),
      clear: () => {
        if (localRef.current) localRef.current.value = '';
        onEmptyChange(true);
      },
      setText: (text: string) => {
        if (localRef.current) localRef.current.value = text;
        onEmptyChange(text.trim() === '');
      },
      getContent: () => ({ instruction: localRef.current?.value ?? '', mentions: mockMentions }),
    }));
    return (
      <textarea
        ref={localRef}
        aria-label={ariaLabel}
        placeholder={placeholder}
        className={className}
        onChange={(event) => onEmptyChange(event.target.value.trim() === '')}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
    );
  },
}));

const installedAll: Record<string, InstallState> = {
  'claude-code': { installed: true },
  codex: { installed: true },
  cursor: { installed: true },
};

const launchCalls: HandoffDispatchInput[] = [];

const { CreatePromptComposer } = await import('./CreatePromptComposer');
const { TerminalLaunchProvider } = await import('@/components/handoff/TerminalLaunchContext');

async function renderComposer(
  opts: { withTerminal: boolean; scenario?: CreateScenario } = { withTerminal: true },
) {
  const value = opts.withTerminal
    ? { launchInTerminal: (i: HandoffDispatchInput) => launchCalls.push(i) }
    : null;
  render(
    <TerminalLaunchProvider value={value}>
      <CreatePromptComposer scenario={opts.scenario ?? 'new-project'} />
    </TerminalLaunchProvider>,
  );
  await waitFor(() => {
    expect(screen.getByTestId('create-with-agent-menu')).toBeTruthy();
  });
}

describe('CreatePromptComposer Desktop / Terminal sections', () => {
  afterEach(() => {
    cleanup();
    launchCalls.length = 0;
    states = {};
    workspaceValue = null;
    mockMentions = [];
  });

  test('renders Desktop and Terminal sections with the CLI launch row when a launcher is present', async () => {
    states = { ...installedAll };
    workspaceValue = { contentDir: '/tmp/project', pathSeparator: '/' };
    await renderComposer({ withTerminal: true });

    expect(screen.getByText('Desktop')).toBeTruthy();
    expect(screen.getByText('Terminal')).toBeTruthy();
    expect(screen.getByTestId('create-with-cli-claude')).toBeTruthy();
    expect(screen.queryByTestId('menu-separator')).not.toBeNull();
  });

  test('omits the Terminal section (label, row, separator) on the web host while keeping Desktop', async () => {
    states = { ...installedAll };
    workspaceValue = { contentDir: '/tmp/project', pathSeparator: '/' };
    await renderComposer({ withTerminal: false });

    expect(screen.getByText('Desktop')).toBeTruthy();
    expect(screen.queryByText('Terminal')).toBeNull();
    expect(screen.queryByTestId('create-with-cli-claude')).toBeNull();
    expect(screen.queryByTestId('menu-separator')).toBeNull();
  });

  test('selecting the Terminal Claude row switches the button to CLI mode; Create launches with the typed brief', async () => {
    states = { ...installedAll };
    workspaceValue = { contentDir: '/tmp/project', pathSeparator: '/' };
    await renderComposer({ withTerminal: true, scenario: 'new-project' });

    fireEvent.change(screen.getByLabelText('Describe the project you want to create'), {
      target: { value: 'Build a competitor wiki' },
    });

    fireEvent.click(screen.getByTestId('create-with-cli-claude'));
    await waitFor(() => {
      expect(screen.getByTestId('create-with-agent').textContent).toContain(
        'Create with Claude CLI',
      );
    });
    expect(launchCalls).toEqual([]);

    fireEvent.click(screen.getByTestId('create-with-agent'));
    expect(launchCalls).toEqual([
      {
        docContext: null,
        createDescription: 'Build a competitor wiki',
        createScenario: 'new-project',
        createMentions: [],
        projectDir: '/tmp/project',
        docPath: '',
      },
    ]);
  });

  test('CLI mode does not launch when the workspace is unresolved', async () => {
    states = { ...installedAll };
    workspaceValue = null; // buildCreateHandoffInput returns null until the workspace resolves.
    await renderComposer({ withTerminal: true });

    fireEvent.change(screen.getByLabelText('Describe the project you want to create'), {
      target: { value: 'Build a wiki' },
    });
    fireEvent.click(screen.getByTestId('create-with-cli-claude'));
    await waitFor(() => {
      expect(screen.getByTestId('create-with-agent').textContent).toContain(
        'Create with Claude CLI',
      );
    });
    fireEvent.click(screen.getByTestId('create-with-agent'));
    expect(launchCalls).toEqual([]);
  });

  test('Desktop selection items set the default and do not launch the terminal', async () => {
    states = { ...installedAll };
    workspaceValue = { contentDir: '/tmp/project', pathSeparator: '/' };
    await renderComposer({ withTerminal: true });

    fireEvent.click(screen.getByTestId('create-agent-option-codex'));

    await waitFor(() => {
      expect(screen.getByTestId('create-with-agent').textContent).toContain('Create with Codex');
    });
    expect(launchCalls).toEqual([]);
  });

  test('the Terminal row shows visible "Claude" with accessible name "Claude CLI"', async () => {
    states = { ...installedAll };
    workspaceValue = { contentDir: '/tmp/project', pathSeparator: '/' };
    await renderComposer({ withTerminal: true });

    const row = screen.getByTestId('create-with-cli-claude');
    expect(row.textContent).toBe('Claude');
    expect(row.getAttribute('aria-label')).toBe('Claude CLI');
  });

  test('Enter in CLI mode launches the terminal with the typed brief', async () => {
    states = { ...installedAll };
    workspaceValue = { contentDir: '/tmp/project', pathSeparator: '/' };
    await renderComposer({ withTerminal: true, scenario: 'new-project' });

    const field = screen.getByLabelText('Describe the project you want to create');
    fireEvent.change(field, { target: { value: 'Build a wiki' } });
    fireEvent.click(screen.getByTestId('create-with-cli-claude')); // enter CLI mode
    await waitFor(() => {
      expect(screen.getByTestId('create-with-agent').textContent).toContain(
        'Create with Claude CLI',
      );
    });

    fireEvent.keyDown(field, { key: 'Enter' });
    expect(launchCalls).toEqual([
      {
        docContext: null,
        createDescription: 'Build a wiki',
        createScenario: 'new-project',
        createMentions: [],
        projectDir: '/tmp/project',
        docPath: '',
      },
    ]);
  });

  test('selecting a Desktop agent after CLI reverts the button and does not launch', async () => {
    states = { ...installedAll };
    workspaceValue = { contentDir: '/tmp/project', pathSeparator: '/' };
    await renderComposer({ withTerminal: true });

    fireEvent.click(screen.getByTestId('create-with-cli-claude')); // enter CLI mode
    await waitFor(() => {
      expect(screen.getByTestId('create-with-agent').textContent).toContain(
        'Create with Claude CLI',
      );
    });

    fireEvent.click(screen.getByTestId('create-agent-option-codex'));
    await waitFor(() => {
      expect(screen.getByTestId('create-with-agent').textContent).toContain('Create with Codex');
    });
    expect(launchCalls).toEqual([]);
  });

  test('renders the @-mention input in place of the plain textarea', async () => {
    states = { ...installedAll };
    workspaceValue = { contentDir: '/tmp/project', pathSeparator: '/' };
    await renderComposer({ withTerminal: true });
    expect(screen.getByLabelText('Describe the project you want to create')).toBeTruthy();
  });

  test('threads the inserted @-mentions through the create handoff input', async () => {
    states = { ...installedAll };
    workspaceValue = { contentDir: '/tmp/project', pathSeparator: '/' };
    mockMentions = ['notes/structure.md', 'glossary.md'];
    await renderComposer({ withTerminal: true, scenario: 'existing-repo' });

    const field = screen.getByLabelText('Describe the project you want to create');
    fireEvent.change(field, { target: { value: 'draft a spec' } });
    fireEvent.click(screen.getByTestId('create-with-cli-claude')); // CLI mode
    await waitFor(() => {
      expect(screen.getByTestId('create-with-agent').textContent).toContain(
        'Create with Claude CLI',
      );
    });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(launchCalls).toEqual([
      {
        docContext: null,
        createDescription: 'draft a spec',
        createScenario: 'existing-repo',
        createMentions: ['notes/structure.md', 'glossary.md'],
        projectDir: '/tmp/project',
        docPath: '',
      },
    ]);
  });

  test('empty brief: no error by default; an empty create attempt surfaces the validation error and does not launch; valid input clears it', async () => {
    states = { ...installedAll };
    workspaceValue = { contentDir: '/tmp/project', pathSeparator: '/' };
    await renderComposer({ withTerminal: true });

    expect(screen.queryByTestId('create-input-required')).toBeNull();

    fireEvent.click(screen.getByTestId('create-with-cli-claude')); // CLI mode
    await waitFor(() => {
      expect(screen.getByTestId('create-with-agent').textContent).toContain(
        'Create with Claude CLI',
      );
    });

    fireEvent.keyDown(screen.getByLabelText('Describe the project you want to create'), {
      key: 'Enter',
    });
    expect(launchCalls).toEqual([]);
    const enterError = screen.getByTestId('create-input-required');
    expect(enterError.textContent).toBe('Describe what you want to create to continue');
    expect(enterError.getAttribute('role')).toBe('alert');
    expect(enterError.className).toContain('text-destructive');

    fireEvent.click(screen.getByTestId('create-with-agent'));
    expect(launchCalls).toEqual([]);
    expect(screen.getByTestId('create-input-required').textContent).toBe(
      'Describe what you want to create to continue',
    );

    fireEvent.change(screen.getByLabelText('Describe the project you want to create'), {
      target: { value: 'Build a wiki' },
    });
    await waitFor(() => {
      expect(screen.queryByTestId('create-input-required')).toBeNull();
    });

    fireEvent.keyDown(screen.getByLabelText('Describe the project you want to create'), {
      key: 'Enter',
    });
    expect(launchCalls).toEqual([
      {
        docContext: null,
        createDescription: 'Build a wiki',
        createScenario: 'new-project',
        createMentions: [],
        projectDir: '/tmp/project',
        docPath: '',
      },
    ]);
  });

  test('a starter suggestion prefills the field (setText) and Create carries it', async () => {
    states = { ...installedAll };
    workspaceValue = { contentDir: '/tmp/project', pathSeparator: '/' };
    await renderComposer({ withTerminal: true, scenario: 'new-project' });

    const field = screen.getByLabelText(
      'Describe the project you want to create',
    ) as HTMLTextAreaElement;
    expect(field.value).toBe('');

    const chip = document.querySelector<HTMLButtonElement>('[data-testid^="create-suggestion-"]');
    expect(chip).not.toBeNull();
    fireEvent.click(chip as HTMLButtonElement);
    expect(field.value.length).toBeGreaterThan(0);
    const prefilled = field.value;

    fireEvent.click(screen.getByTestId('create-with-cli-claude')); // CLI mode
    await waitFor(() => {
      expect(screen.getByTestId('create-with-agent').textContent).toContain(
        'Create with Claude CLI',
      );
    });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(launchCalls[0]?.createDescription).toBe(prefilled);
  });
});
