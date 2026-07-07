/**
 * RTL behavior tests for the bottom "Ask AI" composer SHELL.
 *
 * The rich `@`-mention input (`ComposerMentionInput`) is mocked with a plain
 * textarea double that mirrors its imperative handle + `onEmptyChange`/`onSubmit`
 * contract, so these tests stay focused on the shell's responsibilities: the ⌘L
 * focus shortcut, the rotating/reduced-motion placeholder, agent-picker +
 * sticky-default wiring, Claude CLI terminal routing, the pending + clear flow,
 * and the defensive null-input toast. The real input's mention behavior +
 * active-editor non-pollution are covered in `ComposerMentionInput.dom.test.tsx`.
 *
 * `useHandoffDispatch` / `useInstalledAgents` / `useWorkspace` are mocked (the
 * established pattern from `OpenInAgentMenu.dom.test.tsx`); a recording double of
 * `buildComposerHandoffInput` mirrors its workspace-null contract and carries the
 * instruction + mentions through so we can assert they survive to dispatch.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  type ReactNode,
  type Ref,
  StrictMode,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import type { ComposerMentionInputHandle } from '@/editor/ComposerMentionInput';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import { matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import {
  loadStickyAgent as loadStickyDefaultAgent,
  saveStickyAgent as saveStickyDefaultAgent,
} from '@/lib/unified-agent-store';

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

mock.module('@/components/handoff/OpenInAgentMenuItem', () => ({
  TargetIcon: ({ id }: { id: string }) => <span data-testid={`target-icon-${id}`} />,
}));

// Passthrough the dropdown primitives (used by the shared AgentSplitButton) so
// jsdom doesn't fight Radix's portal + modal pointer-events trap; the picker's
// section gating + click handlers are what's under test, not Radix open/close.
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

// Inline `@`-mention paths the mock input reports (via getContent + the
// onMentionsChange callback); the test drives this to exercise top-row dedup
// against inline mentions. Reset per test.
let mockInlineMentions: string[] = [];
// Captures the latest `onMentionsChange` so a test can flip the inline set after
// mount and re-emit it (the real editor re-emits on every edit).
let emitMentions: ((mentions: string[]) => void) | null = null;

// Textarea double for the rich input: exposes the same imperative handle the
// shell drives, and routes Enter -> onSubmit + Escape -> blur. `getContent`
// returns the typed text as the instruction plus `mockInlineMentions` as the
// inline `@`-mention set (the inline chips + their on-hover × are exercised
// against the real editor in ComposerMentionInput.dom.test.tsx).
mock.module('@/editor/ComposerMentionInput', () => ({
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
    // Emit the seeded inline-mention set once on mount, mirroring the real
    // input's initial-seed emission.
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
mock.module('@/components/handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states: installStates, refresh: () => Promise.resolve() }),
}));

mock.module('@/lib/use-workspace', () => ({
  useWorkspace: () => ({ contentDir: '/tmp/project', pathSeparator: '/' }),
}));

// Controllable live-selection signals for the selection-pill tests. The composer
// reads the active body surface AND the `frontmatter` surface; default both null
// (no selection) keeps the shell tests pill-free. `usePublishFrontmatterSelection`
// is a no-op here (the publishing path is covered in use-selection-context tests).
let liveSelection: unknown = null;
let liveFrontmatterSelection: unknown = null;
mock.module('@/hooks/use-selection-context', () => ({
  useSelectionContext: (_docName: string | null, surface: string) =>
    surface === 'frontmatter' ? liveFrontmatterSelection : liveSelection,
  usePublishFrontmatterSelection: () => {},
}));

const recordAskedAiSpy = mock(() => {});
mock.module('@/lib/onboarding-signals', () => ({ recordOnboardingAskedAi: recordAskedAiSpy }));

const dispatchCalls: Array<{ target: string; input: unknown }> = [];
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

mock.module('@/components/handoff/useHandoffDispatch', () => ({
  useHandoffDispatch: () => ({
    dispatch: (target: string, input: unknown) => {
      dispatchCalls.push({ target, input });
      return dispatchImpl();
    },
  }),
  buildComposerHandoffInput: (args: {
    docName: string | null;
    folderRelativePath?: string;
    workspace: unknown;
    instruction: string;
    mentions: readonly string[];
    selection?: unknown;
  }) => {
    buildArgs.push(args);
    // Mirror the real builder: null only when the workspace is unresolved (a
    // null docName is project scope, not a null trigger). The `builderReturnsNull`
    // flag drives the defensive toast path deterministically.
    if (builderReturnsNull || !args.workspace) return null;
    return {
      compose: {
        instruction: args.instruction,
        mentions: args.mentions,
        selection: args.selection,
      },
    };
  },
}));

mock.module('sonner', () => ({
  toast: {
    error: (message: string) => {
      toastErrors.push(message);
    },
    success: () => {},
  },
}));

const FIRST_SUGGESTION = /Research the extinction of flightless birds/i;
const DEFAULT_AGENT_NAME = VISIBLE_TARGETS[0]?.displayName;

const ALL_INSTALLED: Record<string, { installed: boolean | null }> = {
  'claude-cowork': { installed: false },
  'claude-code': { installed: true },
  codex: { installed: true },
  cursor: { installed: true },
};

async function renderComposer(
  docName = 'notes',
  extra: Partial<{ dismissed: boolean; onDismiss: () => void; onReopen: () => void }> = {},
) {
  const { BottomComposer } = await import('./BottomComposer');
  return render(<BottomComposer docName={docName} surface="wysiwyg" {...extra} />);
}

// Variant that supplies a docked-terminal launcher so the picker offers the
// "Claude CLI" option (desktop parity). Records every launched input.
async function renderComposerWithTerminal(docName = 'notes') {
  const { BottomComposer } = await import('./BottomComposer');
  const { TerminalLaunchProvider } = await import('./handoff/TerminalLaunchContext');
  return render(
    <TerminalLaunchProvider
      value={{
        launchInTerminal: (input, cli) => {
          terminalLaunchCalls.push({ input, cli });
        },
      }}
    >
      <BottomComposer docName={docName} surface="wysiwyg" />
    </TerminalLaunchProvider>,
  );
}

// Variant whose launcher throws (no terminal session could be opened) — exercises
// the try/catch guard around launchInTerminal.
async function renderComposerWithThrowingTerminal(docName = 'notes') {
  const { BottomComposer } = await import('./BottomComposer');
  const { TerminalLaunchProvider } = await import('./handoff/TerminalLaunchContext');
  return render(
    <TerminalLaunchProvider
      value={{
        launchInTerminal: () => {
          throw new Error('no terminal session');
        },
      }}
    >
      <BottomComposer docName={docName} surface="wysiwyg" />
    </TerminalLaunchProvider>,
  );
}

// Desktop + a CLI install probe: installs a fake terminal bridge exposing
// `cliInstalledMap` so the no-pick default resolves to the first-installed CLI.
// (`terminalLaunch` still comes from the provider; the bridge only feeds the probe.)
async function renderComposerWithInstalledClis(installed: Record<string, boolean>) {
  (window as { okDesktop?: unknown }).okDesktop = {
    terminal: { cliInstalledMap: async () => installed },
  };
  return renderComposerWithTerminal();
}

// Folder mode: the composer is scoped to a folder (no open doc, no surface).
async function renderFolderComposer(folderPath = 'specs/foo') {
  const { BottomComposer } = await import('./BottomComposer');
  return render(<BottomComposer folderPath={folderPath} />);
}

function getInput() {
  return screen.getByRole('textbox', { name: 'Ask AI' }) as HTMLTextAreaElement;
}

function dispatchOpenAskAiShortcut() {
  const meta = new KeyboardEvent('keydown', {
    key: 'l',
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  const event = matchesKeyboardShortcut(meta, 'open-ask-ai')
    ? meta
    : new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true });
  act(() => {
    window.dispatchEvent(event);
  });
}

/** Point matchMedia at a fixed reduced-motion result; returns a restore fn. */
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

let consoleErrorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  installStates = { ...ALL_INSTALLED };
  dispatchImpl = () => Promise.resolve({ ok: true });
  builderReturnsNull = false;
  liveSelection = null;
  liveFrontmatterSelection = null;
  mockInlineMentions = [];
  emitMentions = null;
  dispatchCalls.length = 0;
  recordAskedAiSpy.mockClear();
  buildArgs.length = 0;
  terminalLaunchCalls.length = 0;
  toastErrors.length = 0;
  try {
    window.localStorage.clear();
  } catch {
    // localStorage may be unavailable in some sandboxes — sticky tests guard.
  }
});

afterEach(() => {
  cleanup();
  consoleErrorSpy.mockRestore();
  // A desktop-default test may install a fake terminal bridge — clear it so the
  // web-host tests (which expect no bridge) aren't polluted.
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
      // The resolved agent name now reads on the segmented send button ("Ask <agent>").
      expect(screen.getByTestId('ask-ai-send').textContent).toContain(DEFAULT_AGENT_NAME);
    }
  });

  test('the ⌘L shortcut focuses the persistent field', async () => {
    await renderComposer();
    const input = getInput();
    expect(document.activeElement).not.toBe(input);

    dispatchOpenAskAiShortcut();

    expect(document.activeElement).toBe(input);
  });

  test('mounting never steals focus, even under StrictMode effect double-invoke', async () => {
    // The reopen-focus effect must fire only on a genuine dismissed true -> false
    // transition, never on mount. React StrictMode double-invokes mount effects
    // in dev (which the app + e2e run under); a naive "skip the first render" ref
    // does not survive it — the second invoke steals the caret into the composer,
    // which on doc open closes an in-flight inline rename input. Rendering under
    // StrictMode reproduces that double-invoke so the previous-value guard stays
    // honest.
    const { BottomComposer } = await import('./BottomComposer');
    render(
      <StrictMode>
        <BottomComposer docName="notes" surface="wysiwyg" />
      </StrictMode>,
    );
    expect(document.activeElement).not.toBe(getInput());
  });

  test('⌘L is ignored while a native form field is focused (no caret theft)', async () => {
    await renderComposer();
    const composerInput = getInput();
    // A real native form field elsewhere in the page (e.g. a rename / search box).
    const nativeField = document.createElement('input');
    document.body.appendChild(nativeField);
    try {
      act(() => nativeField.focus());
      expect(document.activeElement).toBe(nativeField);

      // Dispatch ⌘L FROM the native field — the window capture handler sees it
      // with `event.target` = the native input and must bail before preventDefault.
      const meta = new KeyboardEvent('keydown', {
        key: 'l',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      const event = matchesKeyboardShortcut(meta, 'open-ask-ai')
        ? meta
        : new KeyboardEvent('keydown', {
            key: 'l',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          });
      act(() => {
        nativeField.dispatchEvent(event);
      });

      // Focus stayed in the native field; the composer never stole it, and the
      // shortcut did not consume the keystroke.
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
    // The instruction rides the compose scope through to dispatch.
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
    // Records in the dispatch's .then, gated on a confirmed-successful outcome.
    await waitFor(() => expect(recordAskedAiSpy).toHaveBeenCalledTimes(1));
  });

  test('an aborted submit (null compose input) does not record the Ask-AI step', async () => {
    // buildComposerHandoffInput returns null → dispatchComposed bails at its
    // input-null guard. The onboarding emit sits AFTER that guard, so it must
    // not fire — this pins the "only a successful dispatch counts" contract.
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

  test('the Claude CLI option launches in the docked terminal, not a deep-link dispatch', async () => {
    const user = userEvent.setup();
    await renderComposerWithTerminal();

    await user.click(screen.getByTestId('ask-ai-agent-trigger'));
    await user.click(await screen.findByTestId('ask-ai-agent-option-terminal'));

    // Per-CLI sticky id — picking the Claude row persists `terminal-cli:claude`.
    expect(loadStickyDefaultAgent()).toBe('terminal-cli:claude');

    fireEvent.change(getInput(), { target: { value: 'summarize this doc' } });
    fireEvent.keyDown(getInput(), { key: 'Enter' });

    await waitFor(() => expect(terminalLaunchCalls).toHaveLength(1));
    expect(terminalLaunchCalls[0]?.cli).toBe('claude');
    expect(terminalLaunchCalls[0]?.input).toMatchObject({
      compose: { instruction: 'summarize this doc' },
    });
    expect(dispatchCalls).toHaveLength(0);
    // A successful terminal launch records the Ask-AI onboarding step (gated by
    // the try/catch around launchInTerminal — a launch that throws records nothing).
    expect(recordAskedAiSpy).toHaveBeenCalledTimes(1);
  });

  test('a terminal launch that throws keeps the draft, toasts, and records no Ask-AI step', async () => {
    const user = userEvent.setup();
    await renderComposerWithThrowingTerminal();

    await user.click(screen.getByTestId('ask-ai-agent-trigger'));
    await user.click(await screen.findByTestId('ask-ai-agent-option-terminal'));

    fireEvent.change(getInput(), { target: { value: 'summarize this doc' } });
    fireEvent.keyDown(getInput(), { key: 'Enter' });

    // The catch surfaces a retry toast and returns early — so the guard's three
    // observable outcomes all hold: draft preserved (not cleared), an error toast,
    // and the Ask-AI onboarding step is NOT recorded (records only on success).
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
    // The send button reads "Ask Codex CLI".
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

    // Persisted the moment the user picks, with NO submit.
    expect(loadStickyDefaultAgent()).toBe('terminal-cli:codex');
    expect(terminalLaunchCalls).toHaveLength(0);
  });

  test('desktop with no sticky pick leads with the first-installed CLI (Codex when Claude is absent)', async () => {
    // No sticky (localStorage cleared in beforeEach). codex + cursor on PATH,
    // claude not → the no-pick default resolves to codex (first by priority),
    // matching what New chat would launch — NOT the first app target ("Claude").
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

  test('desktop with no sticky pick and no CLI installed defaults to the Claude CLI', async () => {
    await renderComposerWithInstalledClis({
      claude: false,
      codex: false,
      opencode: false,
      cursor: false,
    });
    // The install-nudge default: launching claude surfaces the "Get Claude" banner.
    // The " CLI" suffix distinguishes it from the app-target "Claude" (claude-code).
    await waitFor(() =>
      expect(screen.getByTestId('ask-ai-send').textContent).toContain('Claude CLI'),
    );
  });

  test('the Ask X picker lists the Terminal section before the Desktop section (Terminal-first)', async () => {
    const user = userEvent.setup();
    await renderComposerWithTerminal();

    await user.click(screen.getByTestId('ask-ai-agent-trigger'));
    // The split button's picker leads with Terminal, then Desktop.
    const terminalLabel = await screen.findByText('Terminal');
    const desktopLabel = screen.getByText('Desktop');
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
    expect(screen.getByTestId('ask-ai-send').textContent).toContain('Codex');
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
    // Compact, Cursor-style: name + extent, NOT the raw selected text.
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
    // Pin a passage from doc A, then render over a DIFFERENT active doc B. The
    // dispatched lead must follow the selection's own doc (A) so the passage is
    // attributed to the file it came from, not whatever doc is currently open.
    liveSelection = { ...inlineSel, docName: 'docA' };
    await renderComposer('docB');
    fireEvent.change(getInput(), { target: { value: 'explain this passage' } });
    fireEvent.click(screen.getByTestId('ask-ai-send'));

    await waitFor(() => expect(dispatchCalls).toHaveLength(1));
    expect(buildArgs[0]?.docName).toBe('docA');
    // The selection's own doc rides as the lead, never as a mention.
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
    // Unlike doc mode (chip appears on first keystroke), folder mode shows the
    // folder chip immediately — it is the composer's scope, not a touched file.
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
    // The folder is the dispatch lead — it never doubles as a @-mention.
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

  test('switching files while drafting accumulates a chip for each touched file', async () => {
    const { rerender } = await renderComposer('fileA');
    fireEvent.change(getInput(), { target: { value: 'drafting' } });
    await screen.findByTestId('composer-context-chip-file-fileA.md');

    // Switch to a different doc while the draft is still non-empty.
    const { BottomComposer } = await import('./BottomComposer');
    rerender(<BottomComposer docName="fileB" surface="wysiwyg" />);

    await screen.findByTestId('composer-context-chip-file-fileB.md');
    // Both chips coexist.
    expect(screen.getByTestId('composer-context-chip-file-fileA.md')).toBeTruthy();
  });

  test('X-ing a chip sticky-dismisses it — never re-added for this draft', async () => {
    const { rerender } = await renderComposer('fileA');
    fireEvent.change(getInput(), { target: { value: 'drafting' } });
    await screen.findByTestId('composer-context-chip-file-fileA.md');

    fireEvent.click(screen.getByRole('button', { name: /Remove fileA\.md from context/i }));
    expect(screen.queryByTestId('composer-context-chip-file-fileA.md')).toBeNull();

    // Returning to fileA (via a round-trip through fileB) does NOT re-add it.
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
    // fileA is inline → suppressed from the top row.
    expect(screen.queryByTestId('composer-context-chip-file-fileA.md')).toBeNull();
  });

  test('removing the inline mention lets the file (re)appear as a top chip (live invariant)', async () => {
    mockInlineMentions = ['fileA.md'];
    await renderComposer('fileA');
    fireEvent.change(getInput(), { target: { value: '@fileA do it' } });
    expect(screen.queryByTestId('composer-context-chip-file-fileA.md')).toBeNull();

    // The inline mention is removed → the file re-appears as a top chip.
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
    // Active doc (fileB) is the lead; fileA rides as a mention (lead excluded).
    expect(buildArgs[0]?.docName).toBe('fileB');
    expect(buildArgs[0]?.mentions).toContain('fileA.md');
    expect(buildArgs[0]?.mentions).not.toContain('fileB.md');
  });

  test('dismissing all file chips with no inline mentions falls back to project scope', async () => {
    await renderComposer('fileA');
    fireEvent.change(getInput(), { target: { value: 'drafting' } });
    await screen.findByTestId('composer-context-chip-file-fileA.md');
    fireEvent.click(screen.getByRole('button', { name: /Remove fileA\.md from context/i }));

    fireEvent.click(screen.getByTestId('ask-ai-send'));
    await waitFor(() => expect(dispatchCalls).toHaveLength(1));
    // No file chips, no inline mentions, no selection → project scope.
    expect(buildArgs[0]?.docName).toBeNull();
    expect(buildArgs[0]?.mentions).toEqual([]);
  });

  test('the file-chip set + dismissals reset after a dispatch', async () => {
    await renderComposer('fileA');
    fireEvent.change(getInput(), { target: { value: 'drafting' } });
    await screen.findByTestId('composer-context-chip-file-fileA.md');

    fireEvent.click(screen.getByTestId('ask-ai-send'));
    // After dispatch clears the field, the row is empty (fresh draft).
    await waitFor(() => expect(getInput().value).toBe(''));
    expect(screen.queryByTestId('composer-context-chips')).toBeNull();

    // Typing again re-adds the current file from scratch.
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
    // No literal markdown syntax leaks into the label.
    expect(pill.textContent).not.toContain('##');
    expect(pill.textContent).not.toContain('- item');
    // Cursor-style: basename + extent.
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
    // Collapsed by default — no preview.
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
    // It dispatches the frontmatter passage as a normal selection.
    fireEvent.click(screen.getByTestId('ask-ai-send'));
    await waitFor(() => expect(dispatchCalls).toHaveLength(1));
    expect(buildArgs[0]?.selection).toMatchObject({ kind: 'inline' });
  });
});

describe('BottomComposer (dismiss / reopen)', () => {
  test('clicking the collapse handle calls onDismiss', async () => {
    const onDismiss = mock(() => {});
    await renderComposer('notes', { onDismiss });

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Ask AI' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('when dismissed, the field renders nothing', async () => {
    await renderComposer('notes', { dismissed: true });

    expect(screen.queryByTestId('bottom-composer')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Ask AI' })).toBeNull();
  });

  test('⌘L while dismissed reopens (calls onReopen) instead of focusing', async () => {
    const onReopen = mock(() => {});
    await renderComposer('notes', { dismissed: true, onReopen });

    dispatchOpenAskAiShortcut();

    expect(onReopen).toHaveBeenCalledTimes(1);
  });
});

describe('BottomComposer (conflict footer stacking)', () => {
  // While a doc is in conflict-resolution mode, DiffView's footer (Exit
  // merge / Undo / Save resolution) owns the very bottom of the editor
  // column and publishes its measured height as `--conflict-footer-height`
  // on the document root. The composer must anchor its bottom to that var
  // (falling back to 0px outside conflict mode) instead of a hard
  // `bottom-0`, so it stacks ABOVE the conflict controls rather than
  // covering them. jsdom performs no layout, so the rendered bottom-anchor
  // class carrying the var is the observable seam for this cross-component
  // contract.
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
    // Step 3 ("asked AI") checks off only on a confirmed-successful dispatch. A
    // failed handoff (agent offline, cowork-skill install error) resolves
    // { ok: false } and must leave the step unchecked — otherwise a first ask
    // that never reached an agent still latches the card to "complete". Mirrors
    // the success-gated terminal path.
    dispatchImpl = () => Promise.resolve({ ok: false });

    await renderComposer();
    fireEvent.change(getInput(), { target: { value: 'condense this doc' } });
    fireEvent.click(screen.getByTestId('ask-ai-send'));

    await waitFor(() => expect(dispatchCalls).toHaveLength(1));
    // The clear runs in the dispatch's .finally, so an empty field proves the
    // promise settled and any success-gated record has had its chance to fire.
    await waitFor(() => expect(getInput().value).toBe(''));
    expect(recordAskedAiSpy).not.toHaveBeenCalled();
  });

  test('a null build result surfaces a toast instead of a silent no-op', async () => {
    // buildComposerHandoffInput returns null only when the workspace is
    // unresolved; the gate keeps that prod-unreachable, so this is defense in
    // depth. submit must toast.error + skip dispatch rather than do nothing.
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
