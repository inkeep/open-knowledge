/**
 * Behavioral tests for the empty-state CreatePromptComposer's chevron dropdown:
 * the "Desktop" section (app-agent rows) and the desktop-gated "Terminal" section
 * (the "Claude" CLI row). Every row SELECTS a create target — Desktop picks an app
 * agent, Terminal picks the docked Claude CLI — and the primary Create button
 * performs the selected target (app deep-link or terminal launch), reusing the same
 * create-scope handoff input. Pins selection -> button reflection, that the CLI
 * launch carries the typed brief verbatim, section gating, and the visible-text vs
 * accessible-name split.
 */

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

// Stub the brand-icon helper so the test doesn't pull next-themes / SVG vendor
// icons — the composer only needs *an* icon per row, not the themed artwork.
mock.module('@/components/handoff/OpenInAgentMenuItem', () => ({
  TargetIcon: ({ id }: { id: string }) => (
    <svg data-testid={`target-icon-${id}`} aria-hidden="true" />
  ),
}));

// Passthrough the dropdown primitives so jsdom doesn't fight Radix's portal +
// modal pointer-events trap; the composer's section gating + click handlers are
// what's under test, not Radix's open/close.
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
  // Transparent passthrough — the real role="group" semantics are exercised
  // against real Radix in OpenInAgentMenu/OpenInAgentTerminalRow .dom tests;
  // here the dropdown is fully mocked, so asserting the role would test the mock.
  DropdownMenuGroup: ({ children }: MenuChild) => <>{children}</>,
  DropdownMenuItem: ({ children, disabled, onSelect, ...props }: MenuChild) => (
    <button type="button" role="menuitem" disabled={disabled} onClick={onSelect} {...props}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children, ...props }: MenuChild) => <div {...props}>{children}</div>,
  DropdownMenuSeparator: () => <hr data-testid="menu-separator" />,
}));

// Mentions the mock input returns from getContent(); reset per test.
let mockMentions: string[] = [];
// Textarea double for the rich `@`-mention input: exposes the same imperative
// handle CreatePromptComposer drives (getContent / setText / focus) and routes
// Enter -> onSubmit, mirroring the real ComposerMentionInput contract. The real
// `@`-typeahead is exercised against the live editor in ComposerMentionInput's
// own tests; here we cover the create composer's wiring.
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
  // The smart-default effect resolves a selected agent once the install probe
  // settles; the chevron dropdown only mounts then.
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
    // Terminal-first: the Terminal section label precedes the Desktop one.
    expect(
      screen.getByText('Terminal').compareDocumentPosition(screen.getByText('Desktop')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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

    // Selecting the CLI row reflects in the primary button and does NOT launch yet.
    fireEvent.click(screen.getByTestId('create-with-cli-claude'));
    await waitFor(() => {
      expect(screen.getByTestId('create-with-agent').textContent).toContain(
        'Create with Claude CLI',
      );
    });
    expect(launchCalls).toEqual([]);

    // Clicking Create performs the docked-terminal launch with the create-scope input.
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

    // Give it intent so the input-required gate passes — the only thing blocking
    // the launch here is the unresolved workspace.
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

    // Plain Enter submits (Shift+Enter newlines) — matches the bottom composer.
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

    // Switching back to a Desktop agent must clear CLI mode (chooseAgent -> setCliMode(false)).
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

    // Nothing is shown while empty until the user actually attempts to create —
    // the requirement is opt-in, not a permanent label.
    expect(screen.queryByTestId('create-input-required')).toBeNull();

    fireEvent.click(screen.getByTestId('create-with-cli-claude')); // CLI mode
    await waitFor(() => {
      expect(screen.getByTestId('create-with-agent').textContent).toContain(
        'Create with Claude CLI',
      );
    });

    // Enter on an empty field surfaces the validation error (role=alert,
    // announced to screen readers) and does NOT launch.
    fireEvent.keyDown(screen.getByLabelText('Describe the project you want to create'), {
      key: 'Enter',
    });
    expect(launchCalls).toEqual([]);
    const enterError = screen.getByTestId('create-input-required');
    expect(enterError.textContent).toBe('Describe what you want to create to continue');
    expect(enterError.getAttribute('role')).toBe('alert');
    expect(enterError.className).toContain('text-destructive');

    // Clicking the (clickable) Create primary with empty input also surfaces the
    // error and does not launch — a natively-disabled button couldn't.
    fireEvent.click(screen.getByTestId('create-with-agent'));
    expect(launchCalls).toEqual([]);
    expect(screen.getByTestId('create-input-required').textContent).toBe(
      'Describe what you want to create to continue',
    );

    // Typing a valid brief clears the error.
    fireEvent.change(screen.getByLabelText('Describe the project you want to create'), {
      target: { value: 'Build a wiki' },
    });
    await waitFor(() => {
      expect(screen.queryByTestId('create-input-required')).toBeNull();
    });

    // Enter now launches with the typed brief — create works.
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
