import type { EditorView as CodeMirrorView } from '@codemirror/view';
import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Editor } from '@tiptap/core';
import { type ReactNode, type Ref, useEffect, useImperativeHandle, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ComposerMentionInputHandle } from '@/editor/ComposerMentionInput';
import { FULL_PAGE_CM_HOST_SELECTORS, type FullPageCmHost } from '@/editor/document-scrollports';
import type { EditorSurface } from '@/editor/selection-stats';
import { reloadEnabledAgentsFromStorage } from '@/lib/acp/enabled-agents';
import {
  getDefaultRegisteredAgent,
  registerAgent,
  reloadRegisteredAgentsFromStorage,
} from '@/lib/acp/registered-agents';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import { matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import {
  loadStickyAgent as loadStickyDefaultAgent,
  saveStickyAgent as saveStickyDefaultAgent,
} from '@/lib/unified-agent-store';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

vi.doMock('@/components/handoff/OpenInAgentMenuItem', () => ({
  TargetIcon: ({ id }: { id: string }) => <span data-testid={`target-icon-${id}`} />,
}));

type MenuChild = {
  children?: ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
  [key: string]: unknown;
};
vi.doMock('@/components/ui/dropdown-menu', () => ({
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
  DropdownMenuCheckboxItem: ({ children, disabled, checked, ...props }: MenuChild) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked === true}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children, ...props }: MenuChild) => <div {...props}>{children}</div>,
  DropdownMenuSeparator: () => <hr data-testid="menu-separator" />,
}));

let mockInlineMentions: string[] = [];
let emitMentions: ((mentions: string[]) => void) | null = null;

vi.doMock('@/editor/ComposerMentionInput', () => ({
  ComposerMentionInput: ({
    ref,
    ariaLabel,
    onEmptyChange,
    onMentionsChange,
    onSubmit,
    className,
  }: {
    ref?: Ref<ComposerMentionInputHandle>;
    ariaLabel: string;
    onEmptyChange: (isEmpty: boolean) => void;
    onMentionsChange?: (mentions: string[]) => void;
    onSubmit: () => void;
    className?: string;
  }) => {
    const localRef = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
      emitMentions = onMentionsChange ?? null;
      onMentionsChange?.(mockInlineMentions);
    }, [onMentionsChange]);
    useImperativeHandle(ref, () => ({
      focus: () => localRef.current?.focus(),
      blur: () => localRef.current?.blur(),
      clear: () => {
        if (localRef.current) localRef.current.value = '';
        onEmptyChange(true);
        onMentionsChange?.([]);
      },
      getContent: () => ({
        instruction: localRef.current?.value ?? '',
        mentions: mockInlineMentions,
      }),
    }));
    return (
      <textarea
        ref={localRef}
        aria-label={ariaLabel}
        className={className}
        onChange={(event) => onEmptyChange(event.target.value.trim() === '')}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            localRef.current?.blur();
          } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
    );
  },
}));

let installStates: Record<string, { installed: boolean | null }> = {};
vi.doMock('@/components/handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states: installStates, refresh: () => Promise.resolve() }),
}));

vi.doMock('@/lib/use-workspace', () => ({
  useWorkspace: () => ({ contentDir: '/tmp/project', pathSeparator: '/' }),
}));

let liveSelection: unknown = null;
let liveFrontmatterSelection: unknown = null;
let pageMeta: ReadonlyMap<string, { docExt?: string }> = new Map();
vi.doMock('@/hooks/use-selection-context', () => ({
  useSelectionContext: (_docName: string | null, surface: string) =>
    surface === 'frontmatter' ? liveFrontmatterSelection : liveSelection,
  usePublishFrontmatterSelection: () => {},
}));

vi.doMock('@/components/PageListContext', () => ({
  usePageList: () => ({ pageMeta }),
}));

const recordAskedAiSpy = vi.fn(() => {});
vi.doMock('@/lib/onboarding-signals', () => ({ recordOnboardingAskedAi: recordAskedAiSpy }));

const dispatchCalls: Array<{ target: string; input: unknown }> = [];
const startThreadCalls: unknown[] = [];
const startThreadOpts: unknown[] = [];
const buildArgs: Array<{
  docName: string | null;
  folderRelativePath?: string;
  workspace: unknown;
  instruction: string;
  mentions: readonly string[];
  selection?: unknown;
}> = [];
const toastErrors: string[] = [];
let dispatchImpl: () => Promise<{ ok: boolean }> = () => Promise.resolve({ ok: true });
let builderReturnsNull = false;
const terminalLaunchCalls: Array<{ input: unknown; cli: string | undefined }> = [];

vi.doMock('@/components/handoff/useHandoffDispatch', () => ({
  useHandoffDispatch: () => ({
    dispatch: (target: string, input: unknown) => {
      dispatchCalls.push({ target, input });
      return dispatchImpl();
    },
  }),
  buildComposerHandoffInput: (args: {
    docName: string | null;
    docRelativePath?: string;
    folderRelativePath?: string;
    workspace: unknown;
    instruction: string;
    mentions: readonly string[];
    selection?: unknown;
  }) => {
    buildArgs.push(args);
    if (builderReturnsNull || !args.workspace) return null;
    return {
      compose: {
        instruction: args.instruction,
        mentions: args.mentions,
        selection: args.selection,
      },
    };
  },
  startAgentThreadForInput: (input: unknown, opts?: unknown) => {
    startThreadCalls.push(input);
    startThreadOpts.push(opts);
  },
  openInstallUrl: () => Promise.resolve(),
}));

vi.doMock('sonner', () => ({
  toast: {
    error: (message: string) => {
      toastErrors.push(message);
    },
    success: () => {},
  },
}));

let selectedCommentCount = 0;
let selectedCommentDocs: readonly { docName: string; count: number }[] = [];
const commentPostedListeners = new Set<() => void>();
function emitCommentPostedForTest() {
  for (const listener of commentPostedListeners) listener();
}

vi.doMock('@/comments/store', () => ({
  dispatchComments: vi.fn(async () => []),
  subscribeCommentPosted: (listener: () => void) => {
    commentPostedListeners.add(listener);
    return () => commentPostedListeners.delete(listener);
  },
}));

vi.doMock('@/comments/comment-chips', async () => {
  const actual = await vi.importActual<typeof import('@/comments/comment-chips')>(
    '@/comments/comment-chips',
  );
  return {
    ...actual,
    useSelectedCommentCount: () => selectedCommentCount,
    useSelectedCommentDocs: () => selectedCommentDocs,
  };
});

const FIRST_SUGGESTION = /Research the extinction of flightless birds/i;
const DEFAULT_AGENT_NAME = VISIBLE_TARGETS[0]?.displayName;
const EXPECTED_COMPOSER_POPUP_LABELS = ['composer-mention', 'composer-slash'] as const;

const ALL_INSTALLED: Record<string, { installed: boolean | null }> = {
  'claude-cowork': { installed: false },
  'claude-code': { installed: true },
  codex: { installed: true },
  cursor: { installed: true },
};

async function renderComposer(
  docName = 'notes',
  props: Partial<{ dismissed: boolean; onDismiss: () => void; onReopen: () => void }> = {},
  options: { strict?: boolean; surface?: EditorSurface } = {},
) {
  const { BottomComposer } = await import('./BottomComposer');
  const { TooltipProvider } = await import('@/components/ui/tooltip');
  return render(
    <BottomComposer docName={docName} surface={options.surface ?? 'wysiwyg'} {...props} />,
    {
      reactStrictMode: options.strict,
      wrapper: TooltipProvider,
    },
  );
}

async function renderComposerWithTerminal(
  docName = 'notes',
  installedClis: Record<string, boolean> = {},
) {
  const { BottomComposer } = await import('./BottomComposer');
  const { TerminalLaunchProvider } = await import('./handoff/TerminalLaunchContext');
  const { TooltipProvider } = await import('@/components/ui/tooltip');
  return render(
    <TerminalLaunchProvider
      value={{
        launchInTerminal: (input, cli) => {
          terminalLaunchCalls.push({ input, cli });
        },
        installedClis,
      }}
    >
      <BottomComposer docName={docName} surface="wysiwyg" />
    </TerminalLaunchProvider>,
    { wrapper: TooltipProvider },
  );
}

async function renderComposerWithThrowingTerminal(docName = 'notes') {
  const { BottomComposer } = await import('./BottomComposer');
  const { TerminalLaunchProvider } = await import('./handoff/TerminalLaunchContext');
  return render(
    <TerminalLaunchProvider
      value={{
        launchInTerminal: () => {
          throw new Error('no terminal session');
        },
        installedClis: {},
      }}
    >
      <BottomComposer docName={docName} surface="wysiwyg" />
    </TerminalLaunchProvider>,
  );
}

async function renderComposerWithInstalledClis(installed: Record<string, boolean>) {
  (window as { okDesktop?: unknown }).okDesktop = {
    terminal: { cliInstalledMap: async () => installed },
  };
  return renderComposerWithTerminal('notes', installed);
}

async function renderFolderComposer(folderPath = 'specs/foo') {
  const { BottomComposer } = await import('./BottomComposer');
  return render(<BottomComposer folderPath={folderPath} />);
}

function getInput() {
  return screen.getByRole('textbox', { name: 'Ask AI' }) as HTMLTextAreaElement;
}

function makeOpenAskAiEvent() {
  const meta = new KeyboardEvent('keydown', {
    key: 'L',
    code: 'KeyL',
    metaKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  return matchesKeyboardShortcut(meta, 'open-ask-ai')
    ? meta
    : new KeyboardEvent('keydown', {
        key: 'L',
        code: 'KeyL',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
}

function dispatchOpenAskAiShortcut() {
  const event = makeOpenAskAiEvent();
  act(() => {
    window.dispatchEvent(event);
  });
}

function stubReducedMotion(matches: boolean): () => void {
  const original = window.matchMedia;
  const stub = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  window.matchMedia = stub;
  (globalThis as { matchMedia?: typeof window.matchMedia }).matchMedia = stub;
  return () => {
    window.matchMedia = original;
    (globalThis as { matchMedia?: typeof window.matchMedia }).matchMedia = original;
  };
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  installStates = { ...ALL_INSTALLED };
  dispatchImpl = () => Promise.resolve({ ok: true });
  builderReturnsNull = false;
  liveSelection = null;
  liveFrontmatterSelection = null;
  pageMeta = new Map();
  mockInlineMentions = [];
  emitMentions = null;
  dispatchCalls.length = 0;
  startThreadCalls.length = 0;
  startThreadOpts.length = 0;
  recordAskedAiSpy.mockClear();
  buildArgs.length = 0;
  terminalLaunchCalls.length = 0;
  toastErrors.length = 0;
  selectedCommentCount = 0;
  selectedCommentDocs = [];
  commentPostedListeners.clear();
  try {
    window.localStorage.clear();
  } catch {}
  reloadRegisteredAgentsFromStorage();
  reloadEnabledAgentsFromStorage();
});

afterEach(() => {
  cleanup();
  consoleErrorSpy.mockRestore();
  delete (window as { okDesktop?: unknown }).okDesktop;
});

describe('BottomComposer (shell behavior)', () => {
  test('exports the component', async () => {
    const mod = await import('./BottomComposer');
    expect(typeof mod.BottomComposer).toBe('function');
  });

  test('renders a persistent Ask AI field with picker + send, no idle pill and no shortcut badge', async () => {
    await renderComposer();

    expect(getInput()).toBeTruthy();
    expect(screen.getByTestId('ask-ai-send')).toBeTruthy();
    expect(screen.getByTestId('ask-ai-agent-trigger')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ask AI' })).toBeNull();
    expect(screen.getByTestId('bottom-composer').querySelector('kbd')).toBeNull();
    if (DEFAULT_AGENT_NAME) {
      expect(screen.getByTestId('ask-ai-send').textContent).toContain(DEFAULT_AGENT_NAME);
    }
  });

  test('the ⇧⌘L shortcut focuses the persistent field', async () => {
    await renderComposer();
    const input = getInput();
    expect(document.activeElement).not.toBe(input);

    dispatchOpenAskAiShortcut();

    expect(document.activeElement).toBe(input);
  });

  test('mounting never steals focus, even under StrictMode effect double-invoke', async () => {
    await renderComposer('notes', {}, { strict: true });
    expect(document.activeElement).not.toBe(getInput());
  });

  test('⇧⌘L is ignored while a native form field is focused (no caret theft)', async () => {
    await renderComposer();
    const composerInput = getInput();
    const nativeField = document.createElement('input');
    document.body.appendChild(nativeField);
    try {
      act(() => nativeField.focus());
      expect(document.activeElement).toBe(nativeField);

      const event = makeOpenAskAiEvent();
      act(() => {
        nativeField.dispatchEvent(event);
      });

      expect(document.activeElement).toBe(nativeField);
      expect(document.activeElement).not.toBe(composerInput);
      expect(event.defaultPrevented).toBe(false);
    } finally {
      nativeField.remove();
    }
  });

  test('Escape blurs the field but keeps it docked', async () => {
    await renderComposer();
    const input = getInput();
    act(() => input.focus());
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(getInput()).toBeTruthy();
    expect(document.activeElement).not.toBe(input);
  });

  test('reduced motion: shows a single static suggestion alongside the stable field name', async () => {
    const restore = stubReducedMotion(true);
    try {
      await renderComposer();
      expect(screen.getByText(FIRST_SUGGESTION)).toBeTruthy();
      expect(getInput()).toBeTruthy();
    } finally {
      restore();
    }
  });

  test('the animated placeholder is an aria-hidden overlay over the input wrapper', async () => {
    const restore = stubReducedMotion(false);
    try {
      await renderComposer();
      const input = getInput();
      const overlay = input.parentElement?.querySelector('[aria-hidden="true"]');
      expect(overlay).toBeTruthy();
    } finally {
      restore();
    }
  });

  test('typing hides the placeholder overlay', async () => {
    const restore = stubReducedMotion(true);
    try {
      await renderComposer();
      expect(screen.getByText(FIRST_SUGGESTION)).toBeTruthy();

      fireEvent.change(getInput(), { target: { value: 'condense this doc' } });

      expect(screen.queryByText(FIRST_SUGGESTION)).toBeNull();
    } finally {
      restore();
    }
  });
});

describe('BottomComposer (dispatch + picker + sticky default)', () => {
  test('Enter dispatches to the first-installed default carrying the typed instruction', async () => {
    await renderComposer('specs/foo/SPEC');
    const input = getInput();

    fireEvent.change(input, { target: { value: 'condense this doc' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(dispatchCalls).toHaveLength(1));
    expect(dispatchCalls[0]?.target).toBe('claude-code');
    expect(buildArgs[0]).toMatchObject({
      docName: 'specs/foo/SPEC',
      workspace: { contentDir: '/tmp/project', pathSeparator: '/' },
      instruction: 'condense this doc',
    });
    expect(dispatchCalls[0]?.input).toMatchObject({
      compose: { instruction: 'condense this doc' },
    });
  });

  test('clicking Send dispatches the same way as Enter', async () => {
    await renderComposer();
    fireEvent.change(getInput(), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('ask-ai-send'));

    await waitFor(() => expect(dispatchCalls).toHaveLength(1));
    expect(dispatchCalls[0]?.target).toBe('claude-code');
  });

  test('a successful dispatch records the Ask-AI onboarding step', async () => {
    await renderComposer('specs/foo/SPEC');
    fireEvent.change(getInput(), { target: { value: 'condense this doc' } });
    fireEvent.keyDown(getInput(), { key: 'Enter' });

    await waitFor(() => expect(dispatchCalls).toHaveLength(1));
    await waitFor(() => expect(recordAskedAiSpy).toHaveBeenCalledTimes(1));
  });

  test('an aborted submit (null compose input) does not record the Ask-AI step', async () => {
    builderReturnsNull = true;
    await renderComposer('specs/foo/SPEC');
    fireEvent.change(getInput(), { target: { value: 'this submit aborts' } });
    fireEvent.keyDown(getInput(), { key: 'Enter' });

    await waitFor(() => expect(toastErrors.length).toBeGreaterThan(0));
    expect(dispatchCalls).toHaveLength(0);
    expect(recordAskedAiSpy).not.toHaveBeenCalled();
  });

  test('picking a non-default agent dispatches to it and persists the choice', async () => {
    const user = userEvent.setup();
    await renderComposer();

    await user.click(screen.getByTestId('ask-ai-agent-trigger'));
    await user.click(await screen.findByTestId('ask-ai-agent-option-codex'));

    expect(loadStickyDefaultAgent()).toBe('codex');

    fireEvent.change(getInput(), { target: { value: 'do the thing' } });
    fireEvent.keyDown(getInput(), { key: 'Enter' });

    await waitFor(() => expect(dispatchCalls).toHaveLength(1));
    expect(dispatchCalls[0]?.target).toBe('codex');
  });

  test('the agent menu carries the marker the scroll clamp treats as composer-owned', async () => {
    const user = userEvent.setup();
    await renderComposer();

    await user.click(screen.getByTestId('ask-ai-agent-trigger'));
    const menu = await screen.findByTestId('ask-ai-agent-menu');

    expect(
      menu.closest('[data-composer-portal]'),
      'the menu is a Radix popper that renders outside the card, so the clamp cannot recognise ' +
        'it by containment and matches this marker instead. Matching the generic ' +
        '[data-radix-popper-content-wrapper] instead would exempt every popper in the app, so the ' +
        "composer's own menu has to be marked at the call site",
    ).not.toBeNull();
  });

  test('picking an in-app agent launches a thread and persists the choice', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    const user = userEvent.setup();
    await renderComposer();

    await user.click(screen.getByTestId('ask-ai-agent-trigger'));
    await user.click(await screen.findByTestId('ask-ai-agent-option-thread-registry:claude-acp'));

    expect(loadStickyDefaultAgent()).toBe('in-app-thread');
    expect(screen.getByTestId('ask-ai-send').textContent).toContain('Ask Claude Agent');

    fireEvent.change(getInput(), { target: { value: 'summarize this doc' } });
    fireEvent.keyDown(getInput(), { key: 'Enter' });

    await waitFor(() => expect(startThreadCalls).toHaveLength(1));
    expect(startThreadCalls[0]).toMatchObject({ compose: { instruction: 'summarize this doc' } });
    expect(dispatchCalls).toHaveLength(0);
    expect(recordAskedAiSpy).toHaveBeenCalledTimes(1);
  });

  test('with a registered agent and nothing picked, the primary defaults to in-app thread', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    await renderComposer();

    expect(loadStickyDefaultAgent()).toBeNull();
    expect(screen.getByTestId('ask-ai-send').textContent).toContain('Ask Claude Agent');

    fireEvent.change(getInput(), { target: { value: 'summarize this doc' } });
    fireEvent.keyDown(getInput(), { key: 'Enter' });

    await waitFor(() => expect(startThreadCalls).toHaveLength(1));
    expect(startThreadOpts[0]).toMatchObject({ agent: { source: 'registry', id: 'claude-acp' } });
    expect(dispatchCalls).toHaveLength(0);
  });

  test('registered agents get their own thread rows; picking one becomes the default', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    registerAgent({ source: 'registry', id: 'cursor-acp', name: 'Cursor Agent' });
    const user = userEvent.setup();
    await renderComposer();

    await user.click(screen.getByTestId('ask-ai-agent-trigger'));
    expect(screen.queryByTestId('ask-ai-agent-option-thread')).toBeNull();
    await user.click(await screen.findByTestId('ask-ai-agent-option-thread-registry:claude-acp'));

    expect(loadStickyDefaultAgent()).toBe('in-app-thread');
    expect(getDefaultRegisteredAgent()).toMatchObject({ id: 'claude-acp' });
    expect(screen.getByTestId('ask-ai-send').textContent).toContain('Ask Claude Agent');

    fireEvent.change(getInput(), { target: { value: 'summarize this doc' } });
    fireEvent.keyDown(getInput(), { key: 'Enter' });
    await waitFor(() => expect(startThreadCalls).toHaveLength(1));
  });

  test('the Settings row opens Configure agents', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    const user = userEvent.setup();
    await renderComposer();

    window.location.hash = '';
    await user.click(screen.getByTestId('ask-ai-agent-trigger'));
    await user.click(await screen.findByTestId('ask-ai-agent-option-settings'));

    expect(window.location.hash).toBe('#settings/agent-connections');
    expect(startThreadCalls).toHaveLength(0);
    expect(dispatchCalls).toHaveLength(0);
  });

  test('the Claude CLI option launches in the docked terminal, not a deep-link dispatch', async () => {
    const user = userEvent.setup();
    await renderComposerWithTerminal();

    await user.click(screen.getByTestId('ask-ai-agent-trigger'));
    await user.click(await screen.findByTestId('ask-ai-agent-option-terminal'));

    expect(loadStickyDefaultAgent()).toBe('terminal-cli:claude');

    fireEvent.change(getInput(), { target: { value: 'summarize this doc' } });
    fireEvent.keyDown(getInput(), { key: 'Enter' });

    await waitFor(() => expect(terminalLaunchCalls).toHaveLength(1));
    expect(terminalLaunchCalls[0]?.cli).toBe('claude');
    expect(terminalLaunchCalls[0]?.input).toMatchObject({
      compose: { instruction: 'summarize this doc' },
    });
    expect(dispatchCalls).toHaveLength(0);
    expect(recordAskedAiSpy).toHaveBeenCalledTimes(1);
  });

  test('a terminal launch that throws keeps the draft, toasts, and records no Ask-AI step', async () => {
    const user = userEvent.setup();
    await renderComposerWithThrowingTerminal();

    await user.click(screen.getByTestId('ask-ai-agent-trigger'));
    await user.click(await screen.findByTestId('ask-ai-agent-option-terminal'));

    fireEvent.change(getInput(), { target: { value: 'summarize this doc' } });
    fireEvent.keyDown(getInput(), { key: 'Enter' });

    await waitFor(() => expect(toastErrors.length).toBeGreaterThan(0));
    expect(toastErrors.some((m) => m.includes('open the terminal'))).toBe(true);
    expect(getInput().value).toBe('summarize this doc');
    expect(recordAskedAiSpy).not.toHaveBeenCalled();
    expect(dispatchCalls).toHaveLength(0);
  });

  test('the Codex CLI option launches the docked terminal with cli=codex', async () => {
    const user = userEvent.setup();
    await renderComposerWithTerminal();

    await user.click(screen.getByTestId('ask-ai-agent-trigger'));
    await user.click(await screen.findByTestId('ask-ai-agent-option-terminal-codex'));

    expect(loadStickyDefaultAgent()).toBe('terminal-cli:codex');
    expect(screen.getByTestId('ask-ai-send').textContent).toContain('Codex CLI');

    fireEvent.change(getInput(), { target: { value: 'do the codex thing' } });
    fireEvent.keyDown(getInput(), { key: 'Enter' });

    await waitFor(() => expect(terminalLaunchCalls).toHaveLength(1));
    expect(terminalLaunchCalls[0]?.cli).toBe('codex');
    expect(dispatchCalls).toHaveLength(0);
  });

  test('the Cursor CLI option launches the docked terminal with cli=cursor', async () => {
    const user = userEvent.setup();
    await renderComposerWithTerminal();

    await user.click(screen.getByTestId('ask-ai-agent-trigger'));
    await user.click(await screen.findByTestId('ask-ai-agent-option-terminal-cursor'));

    expect(loadStickyDefaultAgent()).toBe('terminal-cli:cursor');

    fireEvent.change(getInput(), { target: { value: 'do the cursor thing' } });
    fireEvent.keyDown(getInput(), { key: 'Enter' });

    await waitFor(() => expect(terminalLaunchCalls).toHaveLength(1));
    expect(terminalLaunchCalls[0]?.cli).toBe('cursor');
    expect(dispatchCalls).toHaveLength(0);
  });

  test('a sticky per-CLI pick from a prior session preselects that CLI on mount', async () => {
    saveStickyDefaultAgent('terminal-cli:cursor');
    await renderComposerWithTerminal();
    expect(screen.getByTestId('ask-ai-send').textContent).toContain('Cursor CLI');
  });

  test('picking a CLI persists on pick alone — no submit required (4b)', async () => {
    const user = userEvent.setup();
    await renderComposerWithTerminal();

    await user.click(screen.getByTestId('ask-ai-agent-trigger'));
    await user.click(await screen.findByTestId('ask-ai-agent-option-terminal-codex'));

    expect(loadStickyDefaultAgent()).toBe('terminal-cli:codex');
    expect(terminalLaunchCalls).toHaveLength(0);
  });

  test('desktop with no sticky pick leads with the first-installed CLI (Codex when Claude is absent)', async () => {
    await renderComposerWithInstalledClis({
      claude: false,
      codex: true,
      opencode: false,
      cursor: true,
    });
    await waitFor(() =>
      expect(screen.getByTestId('ask-ai-send').textContent).toContain('Codex CLI'),
    );
  });

  test('no CLI installed and no in-app agent shows a plain Ask — no forced Claude CLI', async () => {
    await renderComposerWithInstalledClis({
      claude: false,
      codex: false,
      opencode: false,
      cursor: false,
    });
    await waitFor(() => expect(screen.getByTestId('ask-ai-send').textContent).toContain('Ask'));
    expect(screen.getByTestId('ask-ai-send').textContent).not.toContain('Claude CLI');
  });

  test('the Ask X picker lists the Terminal section before the External apps section (Terminal-first)', async () => {
    const user = userEvent.setup();
    await renderComposerWithTerminal();

    await user.click(screen.getByTestId('ask-ai-agent-trigger'));
    const terminalLabel = await screen.findByText('Terminal');
    const desktopLabel = screen.getByText('External apps');
    expect(
      terminalLabel.compareDocumentPosition(desktopLabel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('without a docked terminal (web host) all Terminal CLI options are absent', async () => {
    const user = userEvent.setup();
    await renderComposer();

    await user.click(screen.getByTestId('ask-ai-agent-trigger'));
    await screen.findByTestId('ask-ai-agent-option-codex');
    expect(screen.queryByTestId('ask-ai-agent-option-terminal')).toBeNull();
    expect(screen.queryByTestId('ask-ai-agent-option-terminal-codex')).toBeNull();
    expect(screen.queryByTestId('ask-ai-agent-option-terminal-cursor')).toBeNull();
  });

  test('a sticky agent from a prior session is preselected on mount', async () => {
    saveStickyDefaultAgent('codex');
    await renderComposer();
    expect(screen.getByTestId('ask-ai-send').textContent).toContain('ChatGPT');
  });

  test('a sticky agent that is no longer installed falls back to first-installed', async () => {
    saveStickyDefaultAgent('cursor');
    installStates = { ...ALL_INSTALLED, cursor: { installed: false } };
    await renderComposer();

    const sendButton = screen.getByTestId('ask-ai-send');
    expect(sendButton.textContent).toContain('Claude');
    expect(sendButton.textContent).not.toContain('Cursor');
  });

  test('after a resolved dispatch the field clears but stays docked', async () => {
    await renderComposer();
    fireEvent.change(getInput(), { target: { value: 'summarize' } });
    fireEvent.click(screen.getByTestId('ask-ai-send'));

    await waitFor(() => expect(getInput().value).toBe(''));
    expect(getInput()).toBeTruthy();
  });

  test('Send shows a pending state while the dispatch is in flight', async () => {
    let resolveDispatch: (value: { ok: boolean }) => void = () => {};
    dispatchImpl = () =>
      new Promise<{ ok: boolean }>((resolve) => {
        resolveDispatch = resolve;
      });

    await renderComposer();
    fireEvent.change(getInput(), { target: { value: 'in flight' } });
    fireEvent.click(screen.getByTestId('ask-ai-send'));

    expect((screen.getByTestId('ask-ai-send') as HTMLButtonElement).disabled).toBe(true);
    expect(getInput().value).toBe('in flight');

    act(() => {
      resolveDispatch({ ok: true });
    });

    await waitFor(() => expect(getInput().value).toBe(''));
  });

  test('Send is disabled and Enter is a no-op while the field is empty', async () => {
    await renderComposer();

    expect((screen.getByTestId('ask-ai-send') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(getInput(), { key: 'Enter' });
    expect(dispatchCalls).toHaveLength(0);
  });
});

describe('BottomComposer (selection pill)', () => {
  const inlineSel = {
    surface: 'wysiwyg',
    docName: 'notes',
    markdown: 'hello world',
    charLen: 11,
    lineCount: 1,
  };
  const linesSel = {
    surface: 'source',
    docName: 'notes',
    markdown: 'a\nb\nc',
    charLen: 5,
    lineCount: 3,
    sourceLineStart: 10,
    sourceLineEnd: 12,
  };

  test('a live single-line selection renders a removable pill with a compact label (no raw text)', async () => {
    liveSelection = inlineSel;
    await renderComposer();
    const pill = screen.getByTestId('composer-selection-pill');
    expect(pill.textContent).toContain('notes.md');
    expect(pill.textContent).not.toContain('hello world');
    expect(screen.getByRole('button', { name: 'Remove selection' })).toBeTruthy();
  });

  test('a multi-line source selection shows a compact line-range label', async () => {
    liveSelection = linesSel;
    await renderComposer();
    expect(screen.getByTestId('composer-selection-pill').textContent).toContain('notes.md (10-12)');
  });

  test('removing the pill clears it', async () => {
    liveSelection = inlineSel;
    await renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Remove selection' }));
    expect(screen.queryByTestId('composer-selection-pill')).toBeNull();
  });

  test('submit threads the selection (as inline) into the dispatch input', async () => {
    liveSelection = inlineSel;
    await renderComposer('notes');
    fireEvent.change(getInput(), { target: { value: 'summarize this' } });
    fireEvent.click(screen.getByTestId('ask-ai-send'));

    await waitFor(() => expect(dispatchCalls).toHaveLength(1));
    expect(buildArgs[0]?.selection).toEqual({ kind: 'inline', markdown: 'hello world' });
    expect(dispatchCalls[0]?.input).toMatchObject({
      compose: { selection: { kind: 'inline', markdown: 'hello world' } },
    });
  });

  test('a pinned selection alone (empty instruction) enables Send and dispatches', async () => {
    liveSelection = inlineSel;
    await renderComposer();
    expect((screen.getByTestId('ask-ai-send') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('ask-ai-send'));
    await waitFor(() => expect(dispatchCalls).toHaveLength(1));
    expect(buildArgs[0]?.selection).toEqual({ kind: 'inline', markdown: 'hello world' });
  });

  test('the lead doc is the SELECTION’s own doc, not the active doc (cross-doc pin)', async () => {
    liveSelection = { ...inlineSel, docName: 'docA' };
    await renderComposer('docB');
    fireEvent.change(getInput(), { target: { value: 'explain this passage' } });
    fireEvent.click(screen.getByTestId('ask-ai-send'));

    await waitFor(() => expect(dispatchCalls).toHaveLength(1));
    expect(buildArgs[0]?.docName).toBe('docA');
    expect(buildArgs[0]?.mentions).not.toContain('docA.md');
  });

  test('the pill clears after a resolved dispatch', async () => {
    liveSelection = inlineSel;
    await renderComposer();
    fireEvent.click(screen.getByTestId('ask-ai-send'));
    await waitFor(() => expect(screen.queryByTestId('composer-selection-pill')).toBeNull());
  });
});

describe('BottomComposer (folder mode)', () => {
  test('shows the folder as a top-row context chip from the first render (basename label)', async () => {
    await renderFolderComposer('specs/foo');
    const chip = await screen.findByTestId('composer-context-chip-file-specs/foo');
    expect(chip.textContent).toContain('foo');
    expect(screen.getByRole('button', { name: /Remove foo from context/i })).toBeTruthy();
  });

  test('does not render the collapse handle (folder view has no footer to reopen from)', async () => {
    await renderFolderComposer('specs/foo');
    expect(screen.queryByTestId('ask-ai-collapse')).toBeNull();
  });

  test('Send dispatches folder scope: null docName + folderRelativePath, folder not in mentions', async () => {
    await renderFolderComposer('specs/foo');
    fireEvent.change(getInput(), { target: { value: 'audit this folder' } });
    fireEvent.click(screen.getByTestId('ask-ai-send'));

    await waitFor(() => expect(dispatchCalls).toHaveLength(1));
    expect(buildArgs[0]).toMatchObject({
      docName: null,
      folderRelativePath: 'specs/foo',
      instruction: 'audit this folder',
    });
    expect(buildArgs[0]?.mentions).not.toContain('specs/foo');
    expect(dispatchCalls[0]?.target).toBe('claude-code');
  });

  test('X-ing the folder chip sticky-drops it (to project scope) for the draft', async () => {
    await renderFolderComposer('specs/foo');
    await screen.findByTestId('composer-context-chip-file-specs/foo');
    fireEvent.click(screen.getByRole('button', { name: /Remove foo from context/i }));
    expect(screen.queryByTestId('composer-context-chip-file-specs/foo')).toBeNull();
  });
});

describe('BottomComposer (top-row file-context chips lifecycle)', () => {
  test('an empty prompt shows NO file chip', async () => {
    await renderComposer('specs/foo/SPEC');
    expect(screen.queryByTestId('composer-context-chips')).toBeNull();
    expect(screen.queryByTestId('composer-context-chip-file-specs/foo/SPEC.md')).toBeNull();
  });

  test('the first keystroke adds the active file as a top-row chip (basename label)', async () => {
    await renderComposer('specs/foo/SPEC');
    fireEvent.change(getInput(), { target: { value: 'do a thing' } });
    const chip = await screen.findByTestId('composer-context-chip-file-specs/foo/SPEC.md');
    expect(chip.textContent).toContain('SPEC.md');
    expect(screen.getByRole('button', { name: /Remove SPEC\.md from context/i })).toBeTruthy();
  });

  test('the first keystroke uses docExt metadata for an active .mdx document', async () => {
    pageMeta = new Map([['foo', { docExt: '.mdx' }]]);
    await renderComposer('foo');
    fireEvent.change(getInput(), { target: { value: 'do a thing' } });

    expect(await screen.findByTestId('composer-context-chip-file-foo.mdx')).toBeTruthy();
    expect(screen.queryByTestId('composer-context-chip-file-foo.md')).toBeNull();
  });

  test('extension-qualified and extensionless routes for the same .mdx doc do not duplicate chips', async () => {
    pageMeta = new Map([['foo', { docExt: '.mdx' }]]);
    const { rerender } = await renderComposer('foo.mdx');
    fireEvent.change(getInput(), { target: { value: 'drafting' } });
    await screen.findByTestId('composer-context-chip-file-foo.mdx');

    const { BottomComposer } = await import('./BottomComposer');
    rerender(<BottomComposer docName="foo" surface="wysiwyg" />);

    expect(screen.getByTestId('composer-context-chip-file-foo.mdx')).toBeTruthy();
    expect(screen.queryByTestId('composer-context-chip-file-foo.md')).toBeNull();
  });

  test('switching same-stem md/mdx documents replaces the prior file chip', async () => {
    const { rerender } = await renderComposer('foo.md');
    fireEvent.change(getInput(), { target: { value: 'drafting' } });
    await screen.findByTestId('composer-context-chip-file-foo.md');

    const { BottomComposer } = await import('./BottomComposer');
    rerender(<BottomComposer docName="foo.mdx" surface="wysiwyg" />);

    await screen.findByTestId('composer-context-chip-file-foo.mdx');
    expect(screen.queryByTestId('composer-context-chip-file-foo.md')).toBeNull();
  });

  test('switching files while drafting accumulates a chip for each touched file', async () => {
    const { rerender } = await renderComposer('fileA');
    fireEvent.change(getInput(), { target: { value: 'drafting' } });
    await screen.findByTestId('composer-context-chip-file-fileA.md');

    const { BottomComposer } = await import('./BottomComposer');
    rerender(<BottomComposer docName="fileB" surface="wysiwyg" />);

    await screen.findByTestId('composer-context-chip-file-fileB.md');
    expect(screen.getByTestId('composer-context-chip-file-fileA.md')).toBeTruthy();
  });

  test('X-ing a chip sticky-dismisses it — never re-added for this draft', async () => {
    const { rerender } = await renderComposer('fileA');
    fireEvent.change(getInput(), { target: { value: 'drafting' } });
    await screen.findByTestId('composer-context-chip-file-fileA.md');

    fireEvent.click(screen.getByRole('button', { name: /Remove fileA\.md from context/i }));
    expect(screen.queryByTestId('composer-context-chip-file-fileA.md')).toBeNull();

    const { BottomComposer } = await import('./BottomComposer');
    rerender(<BottomComposer docName="fileB" surface="wysiwyg" />);
    await screen.findByTestId('composer-context-chip-file-fileB.md');
    rerender(<BottomComposer docName="fileA" surface="wysiwyg" />);
    expect(screen.queryByTestId('composer-context-chip-file-fileA.md')).toBeNull();
  });

  test('a file referenced inline as an @-mention is NOT shown as a top chip (inline wins)', async () => {
    mockInlineMentions = ['fileA.md'];
    await renderComposer('fileA');
    fireEvent.change(getInput(), { target: { value: '@fileA do it' } });
    expect(screen.queryByTestId('composer-context-chip-file-fileA.md')).toBeNull();
  });

  test('removing the inline mention lets the file (re)appear as a top chip (live invariant)', async () => {
    mockInlineMentions = ['fileA.md'];
    await renderComposer('fileA');
    fireEvent.change(getInput(), { target: { value: '@fileA do it' } });
    expect(screen.queryByTestId('composer-context-chip-file-fileA.md')).toBeNull();

    act(() => emitMentions?.([]));
    expect(await screen.findByTestId('composer-context-chip-file-fileA.md')).toBeTruthy();
  });

  test('dispatch carries the file-chip set as @path mentions (active doc is the lead)', async () => {
    const { rerender } = await renderComposer('fileA');
    fireEvent.change(getInput(), { target: { value: 'drafting' } });
    await screen.findByTestId('composer-context-chip-file-fileA.md');
    const { BottomComposer } = await import('./BottomComposer');
    rerender(<BottomComposer docName="fileB" surface="wysiwyg" />);
    await screen.findByTestId('composer-context-chip-file-fileB.md');

    fireEvent.click(screen.getByTestId('ask-ai-send'));
    await waitFor(() => expect(dispatchCalls).toHaveLength(1));
    expect(buildArgs[0]?.docName).toBe('fileB');
    expect(buildArgs[0]?.mentions).toContain('fileA.md');
    expect(buildArgs[0]?.mentions).not.toContain('fileB.md');
  });

  test('dispatch carries the .mdx relative path for an active .mdx lead', async () => {
    pageMeta = new Map([['fileA', { docExt: '.mdx' }]]);
    await renderComposer('fileA');
    fireEvent.change(getInput(), { target: { value: 'drafting' } });
    await screen.findByTestId('composer-context-chip-file-fileA.mdx');

    fireEvent.click(screen.getByTestId('ask-ai-send'));
    await waitFor(() => expect(dispatchCalls).toHaveLength(1));

    expect(buildArgs[0]?.docName).toBe('fileA');
    expect(buildArgs[0]?.docRelativePath).toBe('fileA.mdx');
    expect(buildArgs[0]?.mentions).not.toContain('fileA.mdx');
  });

  test('dismissing all file chips with no inline mentions falls back to project scope', async () => {
    await renderComposer('fileA');
    fireEvent.change(getInput(), { target: { value: 'drafting' } });
    await screen.findByTestId('composer-context-chip-file-fileA.md');
    fireEvent.click(screen.getByRole('button', { name: /Remove fileA\.md from context/i }));

    fireEvent.click(screen.getByTestId('ask-ai-send'));
    await waitFor(() => expect(dispatchCalls).toHaveLength(1));
    expect(buildArgs[0]?.docName).toBeNull();
    expect(buildArgs[0]?.mentions).toEqual([]);
  });

  test('the file-chip set + dismissals reset after a dispatch', async () => {
    await renderComposer('fileA');
    fireEvent.change(getInput(), { target: { value: 'drafting' } });
    await screen.findByTestId('composer-context-chip-file-fileA.md');

    fireEvent.click(screen.getByTestId('ask-ai-send'));
    await waitFor(() => expect(getInput().value).toBe(''));
    expect(screen.queryByTestId('composer-context-chips')).toBeNull();

    fireEvent.change(getInput(), { target: { value: 'again' } });
    expect(await screen.findByTestId('composer-context-chip-file-fileA.md')).toBeTruthy();
  });
});

describe('BottomComposer (compact selection chip + preview)', () => {
  const headingSel = {
    surface: 'wysiwyg',
    docName: 'notes',
    markdown: '## Heading\n- item one\n- item two',
    charLen: 30,
    lineCount: 3,
  };
  const linesSel = {
    surface: 'source',
    docName: 'notes',
    markdown: 'a\nb\nc',
    charLen: 5,
    lineCount: 3,
    sourceLineStart: 10,
    sourceLineEnd: 12,
  };
  const frontmatterSel = {
    surface: 'frontmatter',
    docName: 'notes',
    markdown: 'a long description value',
    charLen: 24,
    lineCount: 1,
  };

  test('the chip label is compact (name + range), never raw markdown', async () => {
    liveSelection = headingSel;
    await renderComposer('notes');
    const pill = screen.getByTestId('composer-selection-pill');
    expect(pill.textContent).not.toContain('##');
    expect(pill.textContent).not.toContain('- item');
    expect(screen.getByTestId('composer-selection-peek').textContent).toContain('notes.md');
  });

  test('a source line selection labels the real line range', async () => {
    liveSelection = linesSel;
    await renderComposer('notes');
    expect(screen.getByTestId('composer-selection-peek').textContent).toContain('notes.md (10-12)');
  });

  test('expanding the chip peeks the light-rendered preview (no literal ## / -)', async () => {
    liveSelection = headingSel;
    await renderComposer('notes');
    expect(screen.queryByTestId('composer-selection-preview')).toBeNull();

    fireEvent.click(screen.getByTestId('composer-selection-peek'));
    const preview = screen.getByTestId('composer-selection-preview');
    expect(preview.textContent).toContain('Heading');
    expect(preview.textContent).toContain('• item one');
    expect(preview.textContent).not.toContain('##');
    expect(preview.textContent).not.toContain('- item');
  });

  test('a frontmatter-surface selection pins the same pill as a body selection', async () => {
    liveFrontmatterSelection = frontmatterSel;
    await renderComposer('notes');
    const pill = screen.getByTestId('composer-selection-pill');
    expect(pill).toBeTruthy();
    fireEvent.click(screen.getByTestId('ask-ai-send'));
    await waitFor(() => expect(dispatchCalls).toHaveLength(1));
    expect(buildArgs[0]?.selection).toMatchObject({ kind: 'inline' });
  });
});

describe('BottomComposer (dismiss / reopen)', () => {
  test('clicking the collapse handle calls onDismiss', async () => {
    const onDismiss = vi.fn(() => {});
    await renderComposer('notes', { onDismiss });

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Ask AI' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('when dismissed, the field renders nothing', async () => {
    await renderComposer('notes', { dismissed: true });

    expect(screen.queryByTestId('bottom-composer')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Ask AI' })).toBeNull();
  });

  test('⇧⌘L while dismissed reopens (calls onReopen) instead of focusing', async () => {
    const onReopen = vi.fn(() => {});
    await renderComposer('notes', { dismissed: true, onReopen });

    dispatchOpenAskAiShortcut();

    expect(onReopen).toHaveBeenCalledTimes(1);
  });

  test('⇧⌘L reads the current dismissed state, so a dismiss on a live instance still reopens', async () => {
    const onReopen = vi.fn(() => {});
    const { BottomComposer } = await import('./BottomComposer');
    const { rerender } = await renderComposer('notes', { onReopen });

    rerender(<BottomComposer docName="notes" surface="wysiwyg" onReopen={onReopen} dismissed />);
    dispatchOpenAskAiShortcut();

    expect(
      onReopen,
      'the open-Ask-AI subscription has no deps, so it is built once at mount and never rebuilt, ' +
        'and dismissing returns null only after every hook has run, which keeps that one ' +
        'subscription alive on the same instance. Reading `dismissed` and `onReopen` out of the ' +
        'mount closure instead of at call time would route a post-dismiss ⇧⌘L to the focus ' +
        'branch, where the input ref is already null, and the composer would never reopen',
    ).toHaveBeenCalledTimes(1);
  });
});

describe('BottomComposer (conflict footer stacking)', () => {
  test('the wrapper anchors its bottom to --conflict-footer-height, not a hard bottom-0', async () => {
    await renderComposer('notes');

    const wrapper = screen.getByTestId('bottom-composer');
    expect(wrapper.className).toContain('bottom-[var(--conflict-footer-height,0px)]');
    expect(wrapper.className).not.toMatch(/(?:^|\s)bottom-0(?:\s|$)/);
  });
});

describe('BottomComposer (failure + defensive guards)', () => {
  test('an unsuccessful ({ok:false}) dispatch still clears the field and adds no bespoke toast', async () => {
    dispatchImpl = () => Promise.resolve({ ok: false });

    await renderComposer();
    fireEvent.change(getInput(), { target: { value: 'condense this doc' } });
    fireEvent.click(screen.getByTestId('ask-ai-send'));

    await waitFor(() => expect(getInput().value).toBe(''));
    expect(dispatchCalls).toHaveLength(1);
    expect(toastErrors).toHaveLength(0);
  });

  test('an unsuccessful ({ok:false}) dispatch does not record the Ask-AI onboarding step', async () => {
    dispatchImpl = () => Promise.resolve({ ok: false });

    await renderComposer();
    fireEvent.change(getInput(), { target: { value: 'condense this doc' } });
    fireEvent.click(screen.getByTestId('ask-ai-send'));

    await waitFor(() => expect(dispatchCalls).toHaveLength(1));
    await waitFor(() => expect(getInput().value).toBe(''));
    expect(recordAskedAiSpy).not.toHaveBeenCalled();
  });

  test('a null build result surfaces a toast instead of a silent no-op', async () => {
    builderReturnsNull = true;

    await renderComposer();
    fireEvent.change(getInput(), { target: { value: 'do the thing' } });
    fireEvent.keyDown(getInput(), { key: 'Enter' });

    await waitFor(() => expect(toastErrors).toHaveLength(1));
    expect(toastErrors[0]).toContain('send your prompt');
    expect(dispatchCalls).toHaveLength(0);
  });

  test('Enter committing an IME composition does not submit; a following plain Enter does', async () => {
    await renderComposer();
    const input = getInput();
    fireEvent.change(input, { target: { value: 'にほんご' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(dispatchCalls).toHaveLength(0);

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(dispatchCalls).toHaveLength(1));
  });
});

describe('BottomComposer ⇧⌘L — overlay gate', () => {
  const askAiEvent = makeOpenAskAiEvent;

  test('claims ⇧⌘L with no overlay open', async () => {
    await renderComposer();

    const event = askAiEvent();
    act(() => {
      document.body.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
  });

  test('declines ⇧⌘L while an overlay owns the keyboard', async () => {
    const { BottomComposer } = await import('./BottomComposer');
    const { Dialog, DialogContent, DialogDescription, DialogTitle } = await import(
      '@/components/ui/dialog'
    );
    render(
      <>
        <BottomComposer docName="notes" surface="wysiwyg" />
        <Dialog open>
          <DialogContent>
            <DialogTitle>Command palette</DialogTitle>
            <DialogDescription>Search files and commands</DialogDescription>
          </DialogContent>
        </Dialog>
      </>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).not.toBeNull());
    const composerInput = document.querySelector('textarea');
    expect(composerInput).not.toBeNull();

    const event = askAiEvent();
    act(() => {
      document.body.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(composerInput);
  });
});

describe('BottomComposer (queued-comments chip lifecycle)', () => {
  const DETACH = /leave these comments out of this message/i;
  const REATTACH = /add your comments to this message/i;

  test('a ticked batch rides the message by default', async () => {
    selectedCommentCount = 2;
    await renderComposer();
    expect(screen.getByRole('button', { name: DETACH })).toBeTruthy();
  });

  test('the ✕ takes the batch off this message and leaves the way back', async () => {
    selectedCommentCount = 2;
    await renderComposer();
    fireEvent.click(screen.getByRole('button', { name: DETACH }));
    expect(screen.queryByRole('button', { name: DETACH })).toBeNull();
    expect(screen.getByRole('button', { name: REATTACH })).toBeTruthy();
  });

  test('posting a new comment re-attaches a dismissed batch', async () => {
    selectedCommentCount = 2;
    await renderComposer();
    fireEvent.click(screen.getByRole('button', { name: DETACH }));
    expect(screen.queryByRole('button', { name: DETACH })).toBeNull();

    selectedCommentCount = 3;
    act(() => emitCommentPostedForTest());

    expect(screen.getByRole('button', { name: DETACH })).toBeTruthy();
    expect(screen.queryByRole('button', { name: REATTACH })).toBeNull();
  });

  test('a post while the batch is already attached changes nothing', async () => {
    selectedCommentCount = 1;
    await renderComposer();
    selectedCommentCount = 2;
    act(() => emitCommentPostedForTest());
    expect(screen.getByRole('button', { name: DETACH })).toBeTruthy();
  });
});

describe('BottomComposer (end-of-document scroll compensation)', () => {
  const PORT_BOTTOM = 700;
  const CARD_TOP = 600;
  const CARET_INSIDE_THE_GAP = 700;
  const CARET_INSIDE_THE_GAP_AFTER_A_REVEAL = 900;
  const planted: HTMLElement[] = [];
  const registered: Array<{ docName: string; editor: Editor }> = [];
  const registeredCmViews: Array<{ docName: string; view: CodeMirrorView }> = [];

  async function registerCaseEditor(docName: string, editor: Editor): Promise<void> {
    const { registerEditor } = await import('@/editor/active-editor');
    registerEditor(docName, editor);
    registered.push({ docName, editor });
  }

  async function registerCaseCmView(
    docName: string,
    host: FullPageCmHost,
    view: CodeMirrorView,
  ): Promise<void> {
    const { registerFullPageCmView } = await import('@/editor/full-page-cm-views');
    registerFullPageCmView(docName, view, host);
    registeredCmViews.push({ docName, view });
  }

  function trackScroll(el: HTMLElement, scrollTop: number): number[] {
    const writes: number[] = [];
    let current = scrollTop;
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true });
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => current,
      set: (next: number) => {
        current = next;
        writes.push(next);
      },
    });
    el.getBoundingClientRect = () => new DOMRect(0, 0, 0, PORT_BOTTOM);
    return writes;
  }

  function plantScrollport(scrollTop: number): { el: HTMLElement; writes: number[] } {
    const el = document.createElement('div');
    el.className = 'editor-doc-scroll';
    const writes = trackScroll(el, scrollTop);
    document.body.appendChild(el);
    planted.push(el);
    return { el, writes };
  }

  function plantCmScrollport(
    host: FullPageCmHost,
    scrollTop: number,
  ): { scroller: HTMLElement; writes: number[] } {
    const outer = document.createElement('div');
    outer.className = 'editor-doc-scroll';
    const selector = FULL_PAGE_CM_HOST_SELECTORS[host];
    const hostEl = document.createElement('div');
    if (selector.startsWith('[')) hostEl.setAttribute(selector.slice(1, -1), '');
    else hostEl.className = selector.slice(1);
    const scroller = document.createElement('div');
    scroller.className = 'cm-scroller';
    const writes = trackScroll(scroller, scrollTop);
    hostEl.append(scroller);
    outer.append(hostEl);
    document.body.append(outer);
    planted.push(outer);
    return { scroller, writes };
  }

  function plantPortal(attributes: Record<string, string>): HTMLElement {
    const portal = document.createElement('div');
    for (const [name, value] of Object.entries(attributes)) portal.setAttribute(name, value);
    const row = document.createElement('button');
    row.type = 'button';
    portal.appendChild(row);
    document.body.appendChild(portal);
    planted.push(portal);
    return row;
  }

  let nowSpy: ReturnType<typeof vi.spyOn> | null = null;
  let realGetBoundingClientRect: (this: Element) => DOMRect;

  function giveTheCardALayoutBox(): void {
    realGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      return this.matches('[data-testid="ask-ai-composer-card"]')
        ? new DOMRect(0, CARD_TOP, 0, PORT_BOTTOM - CARD_TOP)
        : realGetBoundingClientRect.call(this);
    };
  }

  const nextFrame = () =>
    act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

  beforeEach(async () => {
    const { __resetScrollRestoreCoordination } = await import(
      '@/editor/scroll-restore-coordination'
    );
    __resetScrollRestoreCoordination();
    nowSpy = vi.spyOn(performance, 'now').mockReturnValue(0);
    giveTheCardALayoutBox();
  });

  afterEach(async () => {
    Element.prototype.getBoundingClientRect = realGetBoundingClientRect;
    vi.useRealTimers();
    nowSpy?.mockRestore();
    nowSpy = null;
    const { unregisterEditor } = await import('@/editor/active-editor');
    for (const { docName, editor } of registered.splice(0)) unregisterEditor(docName, editor);
    const { unregisterFullPageCmView } = await import('@/editor/full-page-cm-views');
    for (const { docName, view } of registeredCmViews.splice(0)) {
      unregisterFullPageCmView(docName, view);
    }
    const { __resetScrollRestoreCoordination } = await import(
      '@/editor/scroll-restore-coordination'
    );
    __resetScrollRestoreCoordination();
    for (const el of planted.splice(0)) el.remove();
  });

  test('clamps only the scrollport the reader had already parked at its end', async () => {
    const nearEnd = plantScrollport(380);
    const midDocument = plantScrollport(100);

    await renderComposer();
    await nextFrame();

    expect(
      nearEnd.writes,
      'a reader already at the end of the document has to be carried down as the card grows, ' +
        'which is the whole compensation this component performs',
    ).not.toHaveLength(0);
    expect(
      nearEnd.el.scrollTop,
      'the clamp target is `scrollHeight - clientHeight`, 1000 - 600 here, and the reader started ' +
        'at 380 — inside the 40px slack but not at the end. Writing back the position already ' +
        'held under-clamps by the difference, which the e2e oracle tolerates up to the resting ' +
        'clearance',
    ).toBe(400);
    expect(
      midDocument.writes,
      'a scrollport parked mid-document must be left alone. Dropping the pinned filter turns ' +
        'every composer resize into a scroll-jack to the end of every enumerated surface',
    ).toHaveLength(0);
  });

  function caretEditorStub(port: { el: HTMLElement }, caretDocY: number): Editor {
    const dom = document.createElement('div');
    port.el.appendChild(dom);
    dom.getClientRects = () => [new DOMRect(0, 0, 0, 18)] as unknown as DOMRectList;
    return {
      isDestroyed: false,
      editorView: {
        dom,
        state: { selection: { head: 1 } },
        coordsAtPos: () => ({
          top: caretDocY - port.el.scrollTop - 18,
          bottom: caretDocY - port.el.scrollTop,
          left: 0,
          right: 0,
        }),
      },
    } as unknown as Editor;
  }

  function caretCmViewStub(scroller: HTMLElement, caretDocY: number): CodeMirrorView {
    return {
      scrollDOM: scroller,
      state: { selection: { main: { head: 1 } } },
      coordsAtPos: () => ({
        top: caretDocY - scroller.scrollTop - 18,
        bottom: caretDocY - scroller.scrollTop,
        left: 0,
        right: 0,
      }),
    } as unknown as CodeMirrorView;
  }

  test('reveals the caret when the composer opens and leaves the scrollport alone on a document switch', async () => {
    const { BottomComposer } = await import('./BottomComposer');
    const port = plantScrollport(100);
    const opened = caretEditorStub(port, CARET_INSIDE_THE_GAP);
    const switchedTo = caretEditorStub(port, CARET_INSIDE_THE_GAP_AFTER_A_REVEAL);
    await registerCaseEditor('opened-doc', opened);
    await registerCaseEditor('switched-doc', switchedTo);

    const { rerender } = await renderComposer('opened-doc', {}, { strict: true });
    await nextFrame();
    await nextFrame();

    expect(
      port.writes,
      'the composer arriving over the document is the transition this reveal exists for. This ' +
        'case renders with `reactStrictMode` because the reveal effect schedules a frame its own ' +
        'cleanup cancels: a double-invoked mount has to re-schedule and still reveal',
    ).not.toHaveLength(0);

    const afterOpen = port.writes.length;
    rerender(<BottomComposer docName="switched-doc" surface="wysiwyg" />);
    await nextFrame();
    await nextFrame();

    expect(
      port.writes.length,
      'switching documents under an already-mounted, already-open composer is not the card ' +
        'arriving over a caret. Scrolling `.editor-doc-scroll` here is a delta ' +
        'ScrollPreservingContainer did not write, so it reads as an external scroll and abandons ' +
        'the restore it is mid-way through. The reveal effect keys on `dismissed` alone so a ' +
        'switch never re-runs it. `switched-doc` deliberately carries a caret BELOW the ' +
        'occlusion line the first reveal left behind, so widening those dependencies produces a ' +
        'write and reds this assertion. Give both stubs the same caret and it passes either way',
    ).toBe(afterOpen);
  });

  test('a document switch inside the pending reveal frame reveals neither document', async () => {
    const { BottomComposer } = await import('./BottomComposer');
    const port = plantScrollport(100);
    await registerCaseEditor('arrived-over-doc', caretEditorStub(port, CARET_INSIDE_THE_GAP));
    await registerCaseEditor(
      'switched-under-doc',
      caretEditorStub(port, CARET_INSIDE_THE_GAP_AFTER_A_REVEAL),
    );

    const { rerender } = await renderComposer('arrived-over-doc');
    rerender(<BottomComposer docName="switched-under-doc" surface="wysiwyg" />);
    await nextFrame();
    await nextFrame();

    expect(
      port.writes,
      'the reveal reads the card geometry a frame after the effect schedules it, and a switch ' +
        'inside that window re-aims it: the frame was scheduled for the document the card ' +
        'arrived over, and the document under the card is now a different one. Revealing either ' +
        'scrolls `.editor-doc-scroll` during the switch restore, which is the write the ' +
        'doc-switch case above exists to forbid',
    ).toHaveLength(0);
  });

  test('a surface toggle under a mounted composer reveals neither surface', async () => {
    const { BottomComposer } = await import('./BottomComposer');
    const wysiwygPort = plantScrollport(100);
    const cmPort = plantCmScrollport('textDocEditor', 100);
    await registerCaseEditor('toggled-doc', caretEditorStub(wysiwygPort, CARET_INSIDE_THE_GAP));
    await registerCaseCmView(
      'toggled-doc',
      'textDocEditor',
      caretCmViewStub(cmPort.scroller, CARET_INSIDE_THE_GAP),
    );

    const { rerender } = await renderComposer('toggled-doc');
    await nextFrame();
    await nextFrame();
    const afterOpen = wysiwygPort.writes.length;

    rerender(<BottomComposer docName="toggled-doc" surface="source" />);
    await nextFrame();
    await nextFrame();

    expect(
      cmPort.writes,
      'toggling into source mode under an already-open card is not the card arriving. ' +
        'mode-switch-landing owns where the source view lands, and a reveal firing here writes a ' +
        'scroll delta that landing did not make. The reveal effect keys on `dismissed` alone so ' +
        'the toggle never re-runs it, and adding `effectiveSurface` back to those dependencies ' +
        'produces a write here',
    ).toHaveLength(0);
    expect(wysiwygPort.writes.length).toBe(afterOpen);
  });

  test('a surface toggle inside the pending reveal frame reveals neither surface', async () => {
    const { BottomComposer } = await import('./BottomComposer');
    const wysiwygPort = plantScrollport(100);
    const cmPort = plantCmScrollport('textDocEditor', 100);
    await registerCaseEditor('mid-frame-doc', caretEditorStub(wysiwygPort, CARET_INSIDE_THE_GAP));
    await registerCaseCmView(
      'mid-frame-doc',
      'textDocEditor',
      caretCmViewStub(cmPort.scroller, CARET_INSIDE_THE_GAP),
    );

    const { rerender } = await renderComposer('mid-frame-doc');
    rerender(<BottomComposer docName="mid-frame-doc" surface="source" />);
    await nextFrame();
    await nextFrame();

    expect(
      wysiwygPort.writes,
      'the frame was scheduled for the surface the card arrived over, and the surface under the ' +
        'card is now a different one. Dropping the surface half of the in-frame staleness check ' +
        'lets that frame reveal the visual editor caret while the document is painting its ' +
        'source view',
    ).toHaveLength(0);
    expect(cmPort.writes).toHaveLength(0);
  });

  test('reveals the caret on a CodeMirror surface, not only in the visual editor', async () => {
    const port = plantCmScrollport('textDocEditor', 100);
    await registerCaseCmView(
      'text-doc',
      'textDocEditor',
      caretCmViewStub(port.scroller, CARET_INSIDE_THE_GAP),
    );

    await renderComposer('text-doc', {}, { surface: 'source' });
    await nextFrame();
    await nextFrame();

    expect(
      port.writes,
      'the component has to forward the surface it was given rather than reveal only on ' +
        'wysiwyg. Restoring a wysiwyg-only guard here leaves every CodeMirror surface with the ' +
        'caret under the card, which is the bug, and the module-level caret-reveal tests cannot ' +
        'see it because they call the module directly',
    ).not.toHaveLength(0);
  });

  test('a CodeMirror host that registers after the arrival frame is not chased', async () => {
    const port = plantCmScrollport('textDocEditor', 100);

    await renderComposer('late-host-doc', {}, { surface: 'source' });
    await nextFrame();
    await nextFrame();

    await registerCaseCmView(
      'late-host-doc',
      'textDocEditor',
      caretCmViewStub(port.scroller, CARET_INSIDE_THE_GAP),
    );
    await nextFrame();
    await nextFrame();

    expect(
      port.writes,
      'a lazily loaded text or Mermaid host can finish mounting after the one reveal frame. ' +
        'Leaving that arrival alone is deliberate. All three full-page CodeMirror hosts build ' +
        'their EditorView with no selection, so a view that registers this late has its caret ' +
        'at position 0, which a bottom-anchored card cannot occlude. Subscribing to ' +
        'subscribeFullPageCmViewRegistry to retry would turn the one-shot reveal into a ' +
        'deferred write against a scrollport that mode-switch landing or scroll restore is ' +
        'still placing, which is the write the document-switch cases above and the ' +
        'yielded-frame cases below forbid. The stub caret here sits inside the gap, so a retry ' +
        'implementation reds this',
    ).toHaveLength(0);
  });

  test('a remount with the composer still open reveals again', async () => {
    const port = plantScrollport(100);
    const editor = caretEditorStub(port, CARET_INSIDE_THE_GAP);
    await registerCaseEditor('remounted-doc', editor);

    const { unmount } = await renderComposer('remounted-doc', {}, { strict: true });
    await nextFrame();
    await nextFrame();
    expect(port.writes).not.toHaveLength(0);

    unmount();
    port.el.scrollTop = 100;
    const beforeRemount = port.writes.length;

    await renderComposer('remounted-doc', {}, { strict: true });
    await nextFrame();
    await nextFrame();

    expect(
      port.writes.length,
      'the composer unmounts whenever the terminal or agents column opens, so closing one puts ' +
        'the card back over a document it never left. That is the card arriving, not a switch ' +
        'underneath a mounted one, so a fresh mount reveals again',
    ).toBeGreaterThan(beforeRemount);
  });

  test('a reveal frame yields to a held scroll suppression, and a reopen recovers it', async () => {
    const { acquireScrollRestoreSuppression } = await import(
      '@/editor/scroll-restore-coordination'
    );
    const { BottomComposer } = await import('./BottomComposer');
    const port = plantScrollport(100);
    const editor = caretEditorStub(port, CARET_INSIDE_THE_GAP);
    await registerCaseEditor('held-doc', editor);
    const held = acquireScrollRestoreSuppression('held-doc', 'navigation');

    const { rerender } = await renderComposer('held-doc', {}, { strict: true });
    await nextFrame();
    await nextFrame();

    expect(
      port.writes,
      'a landing or a navigation seam owns the scrollport while it holds a suppression, and it ' +
        'will place the document itself. The reveal has to yield rather than fight it',
    ).toHaveLength(0);

    held.release();
    rerender(<BottomComposer docName="held-doc" surface="wysiwyg" dismissed />);
    await nextFrame();
    rerender(<BottomComposer docName="held-doc" surface="wysiwyg" />);
    await nextFrame();
    await nextFrame();

    expect(
      port.writes,
      'yielding costs the caret its reveal for that arrival, so it stays where the seam left it ' +
        'until the card arrives again. Closing and reopening flips `dismissed`, which is the ' +
        'only dependency the reveal effect has, so it re-runs and reveals',
    ).not.toHaveLength(0);
  });

  test('a reveal frame that yielded does not fire on the next document switch', async () => {
    const { acquireScrollRestoreSuppression } = await import(
      '@/editor/scroll-restore-coordination'
    );
    const { BottomComposer } = await import('./BottomComposer');
    const port = plantScrollport(100);
    const yielded = caretEditorStub(port, CARET_INSIDE_THE_GAP);
    const switchedTo = caretEditorStub(port, CARET_INSIDE_THE_GAP_AFTER_A_REVEAL);
    await registerCaseEditor('yielded-doc', yielded);
    await registerCaseEditor('after-yield-doc', switchedTo);
    const held = acquireScrollRestoreSuppression('yielded-doc', 'navigation');

    const { rerender } = await renderComposer('yielded-doc', {}, { strict: true });
    await nextFrame();
    await nextFrame();
    expect(
      port.writes,
      'precondition: the frame has to reach the held suppression and yield, or the switch ' +
        'below measures a latch that was never at risk',
    ).toHaveLength(0);

    held.release();
    rerender(<BottomComposer docName="after-yield-doc" surface="wysiwyg" />);
    await nextFrame();
    await nextFrame();

    expect(
      port.writes,
      'a frame that yielded to a seam must not be retried on the next document switch, or the ' +
        'reveal lands against a scrollport ScrollPreservingContainer is restoring and the ' +
        'restore is abandoned. The effect does not re-run on a switch, so a yield costs that ' +
        'arrival its reveal and nothing carries over',
    ).toHaveLength(0);
  });

  test('stops clamping once the 300ms compensation budget is spent', async () => {
    const atEnd = plantScrollport(380);

    await renderComposer();
    await nextFrame();
    const beforeDeadline = atEnd.writes.length;
    expect(beforeDeadline).not.toBe(0);

    nowSpy?.mockReturnValue(301);
    await nextFrame();
    await nextFrame();

    expect(
      atEnd.writes.length,
      'without the elapsed-time exit the compensator stops being a burst that tracks one card ' +
        'resize and becomes a permanent clamp, holding every pinned scrollport at its end for the ' +
        'life of the mount and fighting every programmatic scroll that fires none of the four ' +
        'cancel events — CodeMirror reveal, outline navigation, find-jump, scroll restore',
    ).toBe(beforeDeadline);
  });

  const CANCEL_EVENTS = [
    ['keydown', (target: HTMLElement) => fireEvent.keyDown(target, { key: 'PageUp' })],
    ['mousedown', (target: HTMLElement) => fireEvent.mouseDown(target)],
    ['wheel', (target: HTMLElement) => fireEvent.wheel(target, { deltaY: 64 })],
    ['touchstart', (target: HTMLElement) => fireEvent.touchStart(target)],
  ] as const;

  test.each(CANCEL_EVENTS)(
    'a %s outside the card cancels the clamp, one inside it does not',
    async (eventName, fire) => {
      const atEnd = plantScrollport(400);

      await renderComposer();
      await nextFrame();
      const beforeInside = atEnd.writes.length;
      expect(beforeInside).not.toBe(0);

      fire(getInput());
      await nextFrame();
      expect(
        atEnd.writes.length,
        `driving the composer is what grows the card, so a ${eventName} inside it must not stop ` +
          'the clamp that tracks the growth',
      ).toBeGreaterThan(beforeInside);

      const beforeOutside = atEnd.writes.length;
      fire(document.body);
      await nextFrame();
      await nextFrame();
      expect(
        atEnd.writes.length,
        `a ${eventName} outside the card is the reader taking over the scroll, so without it in ` +
          'the cancel set the clamp fights them for the rest of its 300ms budget',
      ).toBe(beforeOutside);
    },
  );

  test.each(CANCEL_EVENTS)(
    'a %s in a composer-owned portal keeps the clamp, the same event in a document popup cancels it',
    async (eventName, fire) => {
      const atEnd = plantScrollport(400);
      const composerPortalRow = plantPortal({
        'data-radix-popper-content-wrapper': '',
        'data-composer-portal': '',
      });
      const documentPopupRow = plantPortal({ 'data-suggestion-popup': 'tag-suggestion' });

      await renderComposer();
      await nextFrame();
      const beforePortal = atEnd.writes.length;
      expect(beforePortal).not.toBe(0);

      fire(composerPortalRow);
      await nextFrame();
      expect(
        atEnd.writes.length,
        `the composer's own agent menu is portalled out of the card, so a ${eventName} inside it ` +
          'is still the author driving the composer and must not stop the clamp that tracks the ' +
          'growth that click causes',
      ).toBeGreaterThan(beforePortal);

      const beforeDocumentPopup = atEnd.writes.length;
      fire(documentPopupRow);
      await nextFrame();
      await nextFrame();
      expect(
        atEnd.writes.length,
        `a ${eventName} in the document body's own tag/slash/wiki-link popup is the reader ` +
          'working in the document, not in the composer. Matching bare [data-suggestion-popup] ' +
          'or bare [data-radix-popper-content-wrapper] exempts every popup and every Radix ' +
          'surface in the app, so the clamp keeps forcing pinned scrollports to their end while ' +
          'the reader interacts with something else entirely',
      ).toBe(beforeDocumentPopup);
    },
  );

  test('the composer portal exemption covers exactly the popups the composer owns', async () => {
    const { COMPOSER_SUGGESTION_POPUP_LABELS } = await import('./BottomComposer');
    expect(
      [...COMPOSER_SUGGESTION_POPUP_LABELS].toSorted(),
      'this list is the whole definition of which suggestion popups the clamp treats as the ' +
        "author's own surface. Dropping a member silently reclassifies a popup the composer owns " +
        'as a foreign surface, so picking a row in it cancels the clamp and drops the last line ' +
        'back under the growing card. The per-label cases below also cover that direction. Each ' +
        'row still plants its own popup, so dropping a member from production reds there too. ' +
        'What only this equality catches is production growing past this expectation, which then ' +
        'gets no case of its own, and this expectation shrinking below production. An edit that ' +
        'drops a label from both lists at once is invisible to both, which is why membership ' +
        'stays a judgment call',
    ).toEqual([...EXPECTED_COMPOSER_POPUP_LABELS].toSorted());
  });

  test.each(EXPECTED_COMPOSER_POPUP_LABELS)(
    'a mousedown in the %s popup keeps the clamp, because the composer owns that popup',
    async (label) => {
      const atEnd = plantScrollport(400);
      const composerPopupRow = plantPortal({ 'data-suggestion-popup': label });

      await renderComposer();
      await nextFrame();
      const before = atEnd.writes.length;
      expect(before).not.toBe(0);

      fireEvent.mouseDown(composerPopupRow);
      await nextFrame();
      await nextFrame();
      expect(
        atEnd.writes.length,
        `the ${label} popup is the composer's own suggestion menu, portalled to the body rather ` +
          'than nested in the card, so picking a row in it is the author driving the composer. ' +
          'A selector fragment that no longer matches this label silently reclassifies a popup ' +
          'the composer owns as a foreign surface and cancels the clamp on the click that grows ' +
          'the card',
      ).toBeGreaterThan(before);
    },
  );

  test('a dep change mid-burst supersedes the in-flight clamp instead of stacking a second loop on it', async () => {
    const atEnd = plantScrollport(400);
    const { BottomComposer } = await import('./BottomComposer');
    const { rerender } = await renderComposer();
    await nextFrame();
    expect(atEnd.writes.length).not.toBe(0);

    rerender(<BottomComposer docName="notes" surface="wysiwyg" dismissed />);
    await nextFrame();

    const beforeSettleFrame = atEnd.writes.length;
    await nextFrame();
    expect(
      atEnd.writes.length - beforeSettleFrame,
      'React tears the old effect down before it sets the new one up, and the destructor runs a ' +
        'settle pass for the collapsing card. If the disposal token lives inside the effect ' +
        'callback the incoming run starts blind to that settle pass, so dismiss, reopen, a ' +
        'markdown-mode toggle and a document switch each leave a second per-frame writer and a ' +
        'second set of four window listeners on the same scrollport. The token has to outlive a ' +
        'single effect run for the incoming run to supersede the outgoing one',
    ).toBe(1);
  });

  test('unmounting supersedes the in-flight clamp instead of stacking a second loop on it', async () => {
    const atEnd = plantScrollport(400);

    const { unmount } = await renderComposer();
    await nextFrame();
    expect(atEnd.writes.length).not.toBe(0);

    unmount();
    await nextFrame();

    const beforeSettleFrame = atEnd.writes.length;
    await nextFrame();
    expect(
      atEnd.writes.length - beforeSettleFrame,
      'the destructor runs a settle pass for the collapsing card, so it must first dispose the ' +
        'burst it is replacing. Without a shared disposal token both loops keep writing, so every ' +
        'unmount and every coalesced resize adds another window listener set and another writer ' +
        'to the same scrollport',
    ).toBe(1);

    nowSpy?.mockReturnValue(301);
    await nextFrame();
    const afterDeadline = atEnd.writes.length;
    await nextFrame();
    expect(
      atEnd.writes.length,
      'the post-unmount settle pass is a burst like any other, so it has to stop writing at the ' +
        'same 300ms deadline rather than owning the scrollport for the life of the page',
    ).toBe(afterDeadline);
  });

  test('unmounting a dismissed composer releases the settle clamp instead of leaving it ownerless', async () => {
    const atEnd = plantScrollport(400);
    const { BottomComposer } = await import('./BottomComposer');
    const { rerender, unmount } = await renderComposer();
    await nextFrame();
    rerender(<BottomComposer docName="notes" surface="wysiwyg" dismissed />);
    await nextFrame();
    unmount();
    await nextFrame();
    const afterUnmount = atEnd.writes.length;
    await nextFrame();
    await nextFrame();
    expect(
      atEnd.writes.length,
      'the collapsed branch installs a clamp of its own, four window listeners, a per-frame ' +
        'writer and a 400ms backstop, so unmounting out of it has to release the token. Without ' +
        'a destructor the burst keeps pinning live document scrollports after the component is gone',
    ).toBe(afterUnmount);
  });

  test('the 400ms backstop tears the clamp down when the elapsed-time deadline never arms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const atEnd = plantScrollport(400);

    await renderComposer();
    await nextFrame();
    expect(atEnd.writes.length).not.toBe(0);

    act(() => {
      vi.advanceTimersByTime(400);
    });

    const afterBackstop = atEnd.writes.length;
    await nextFrame();
    await nextFrame();
    expect(
      atEnd.writes.length,
      'the elapsed-time deadline only arms once the clock advances, and a clock that never ' +
        'advances is exactly the case where a frozen tab, a paused debugger or a machine that ' +
        'stops painting leaves the burst alive. The 400ms timer is the wall-clock backstop that ' +
        'ends it anyway, so without it the four window listeners and the per-frame writer outlive ' +
        'the card resize they were installed for. This case holds performance.now at 0 so the ' +
        'deadline arm cannot fire, and fakes only setTimeout and clearTimeout so that jsdom, ' +
        'which drives requestAnimationFrame off setInterval, keeps producing real frames',
    ).toBe(afterBackstop);
  });
});
