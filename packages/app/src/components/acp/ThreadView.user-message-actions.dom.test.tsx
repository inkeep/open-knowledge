/**
 * RTL mount tests for the per-message actions on a sent user turn: Copy, and
 * Edit-and-resend with its destination menu (this conversation, a new one, or a
 * new one with a different agent).
 *
 * The subject is where a revision GOES and what rides with it — the editor
 * field's own behavior (chips, `@`-typeahead, key handling) belongs to
 * `ComposerMentionInput.dom.test.tsx`, and this suite drives the textarea
 * double instead.
 */

import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { act, cleanup, render as rtlRender, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { RenderedItem, ThreadRenderModel } from '@/lib/acp/thread-event-model';
import { MockComposerMentionInput } from './composer-mention-input.test-helper';

const render = (ui: Parameters<typeof rtlRender>[0]) => rtlRender(ui, { wrapper: TooltipProvider });

let model: ThreadRenderModel | null = null;
const prompt = vi.fn((_threadId: string, _content: string, _attachments?: unknown) => {});
/** What the mocked launcher settles on. `deduped` stands in for the guard
 *  swallowing the call, which in the real module returns before `createThread`
 *  and so says nothing on its own; `failed` has already toasted by the time it
 *  settles. Both mean the revision never went. */
let launchOutcome: 'started' | 'deduped' | 'failed' = 'started';
/** Set to hold a launch in flight; the test resolves it when it wants the
 *  editor's awaited close to run. Creation really does take tens of seconds. */
let heldLaunch: { promise: Promise<'started' | 'deduped' | 'failed'>; settle: () => void } | null =
  null;
function holdNextLaunch(): void {
  let release!: () => void;
  const promise = new Promise<'started' | 'deduped' | 'failed'>((resolve) => {
    release = () => resolve(launchOutcome);
  });
  heldLaunch = { promise, settle: release };
}
const launchAgentThread = vi.fn(
  (
    _agent: { source: string; id: string },
    _prompt: string | null,
    _docName: string | null,
    _titleHint: string | null,
    _stageDraft?: string | null,
    _attachments?: unknown,
  ) => heldLaunch?.promise ?? Promise.resolve(launchOutcome),
);
const toastError = vi.fn((_message: string) => {});
const resumeThread = vi.fn((..._args: unknown[]) => {});
const createThread = vi.fn((_args: { prompt?: string }) => {});
/** Archived threads must resume before they accept a send; this is that failing. */
let resumeRejects = false;
/** The agents the picker offers, as the registration store would report them. */
let registeredAgents: readonly {
  source: 'registry' | 'custom';
  id: string;
  name: string;
}[] = [];

vi.doMock('@/lib/acp/thread-client', () => ({
  getAgentThreadClient: () => ({
    respondPermission: () => {},
    respondRuntimeConsent: () => {},
    cancel: () => {},
    prompt,
    steer: () => {},
    editQueued: async () => {},
    holdQueued: () => {},
    removeQueued: () => {},
    setMode: () => {},
    setConfigOption: () => {},
    closeThread: () => {},
    createThread: async (args: { prompt?: string }) => {
      createThread(args);
      return { threadId: 'thread-2' };
    },
    resumeThread: async (..._args: unknown[]) => {
      resumeThread(..._args);
      if (resumeRejects) throw new Error('resume failed');
    },
    retryThread: async () => {},
    authenticateThread: async () => {},
  }),
  ThreadResumeError: class ThreadResumeError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  useAgentThread: () => ({ info: undefined, events: [], lastSeq: 5 }),
  useAgentThreadModel: () => model,
}));

vi.doMock('@/lib/acp/launch-agent-thread', () => ({
  launchAgentThread,
  hasInflightThreadLaunch: () => false,
}));

vi.doMock('@/lib/acp/registered-agents', () => ({
  useRegisteredAgents: () => registeredAgents,
  useDefaultRegisteredAgent: () => null,
  registerAgent: () => {},
  pickEffectiveDefaultAgent: () => null,
}));

// `enabled-agents` is NOT mocked: `agent-visibility` reads its `resolveEnabled`
// too, and the real store's no-override default (a registered agent is shown)
// is exactly the state these tests want.

vi.doMock('sonner', () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn() },
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ systemProvider: null }),
}));

vi.doMock('@/lib/use-workspace', () => ({
  useWorkspace: () => null,
}));

vi.doMock('@/components/acp/AgentMarkdown', () => ({
  AgentMarkdown: ({ text }: { text: string }) => <div data-testid="rendered-markdown">{text}</div>,
}));

vi.doMock('@/editor/ComposerMentionInput', () => ({
  ComposerMentionInput: MockComposerMentionInput,
}));

const { ThreadView } = await import('./ThreadView');

function makeInfo(overrides?: Partial<ThreadInfo>): ThreadInfo {
  return {
    threadId: 'thread-1',
    agent: { id: 'claude', name: 'Claude Agent', source: 'registry' },
    title: 'Test thread',
    // `ready` with no active turn is the state that accepts a send.
    status: 'ready',
    createdAt: 1,
    lastActivityAt: 2,
    lastSeq: 5,
    archived: false,
    ...overrides,
  };
}

function userMessage(overrides?: Partial<Extract<RenderedItem, { kind: 'message' }>>) {
  return {
    kind: 'message' as const,
    role: 'user' as const,
    text: 'explain this to me',
    messageId: 'user-0',
    ...overrides,
  };
}

function mountWith(items: RenderedItem[], info?: Partial<ThreadInfo>) {
  model = {
    items,
    plan: [],
    turnActive: false,
    tokenUsage: null,
    terminals: {},
    permissionsByToolCall: {},
  };
  return render(<ThreadView info={makeInfo(info)} />);
}

/** Open the editor on the one user turn on screen. */
async function startEditing(): Promise<void> {
  await userEvent.click(screen.getByTestId('agent-thread-user-message-edit'));
}

/** Replace the editor's text, the way typing over a selection would. */
async function rewriteTo(text: string): Promise<void> {
  const field = screen.getByTestId('agent-thread-user-message-edit-field');
  await userEvent.clear(field);
  await userEvent.type(field, text);
}

beforeEach(() => {
  registeredAgents = [
    { source: 'registry', id: 'claude', name: 'Claude Agent' },
    { source: 'registry', id: 'codex-acp', name: 'Codex' },
  ];
});

afterEach(() => {
  cleanup();
  prompt.mockClear();
  launchAgentThread.mockClear();
  toastError.mockClear();
  launchOutcome = 'started';
  heldLaunch = null;
  resumeRejects = false;
  resumeThread.mockClear();
  createThread.mockClear();
  model = null;
});

describe('sent-message actions', () => {
  test('a sent message offers Copy and Edit; an agent reply offers neither', () => {
    mountWith([
      userMessage(),
      { kind: 'message', role: 'agent', text: 'here you go', messageId: 'a-0' },
    ]);
    // One action row, on the one user turn — the agent's reply is prose, not a
    // thing you resend.
    expect(screen.getAllByTestId('agent-thread-user-message-actions')).toHaveLength(1);
    expect(screen.getByTestId('agent-thread-user-message-copy')).toBeDefined();
    expect(screen.getByTestId('agent-thread-user-message-edit')).toBeDefined();
  });

  test('Copy puts the message text on the clipboard and acknowledges it', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    mountWith([userMessage({ text: 'the exact words I sent' })]);
    await userEvent.click(screen.getByTestId('agent-thread-user-message-copy'));
    expect(writeText).toHaveBeenCalledWith('the exact words I sent');
    // The icon swap is the whole feedback — without the label change there is
    // nothing for a screen reader to announce.
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeDefined();
    vi.unstubAllGlobals();
  });

  test('a sent message carries the time it was sent', () => {
    mountWith([userMessage({ sentAt: Date.now() })]);
    expect(screen.getByTestId('agent-thread-user-message-sent-at').textContent).not.toBe('');
  });

  test('a thread that can take no further sends still offers Copy and Edit', () => {
    // A revision handed to a FRESH thread never touches this one, so a dead
    // thread is no reason to withdraw the whole affordance — and a crashed
    // agent is when handing the prompt to a different one is worth the most.
    mountWith([userMessage()], { status: 'exited' });
    expect(screen.getByTestId('agent-thread-user-message-copy')).toBeDefined();
    expect(screen.getByTestId('agent-thread-user-message-edit')).toBeDefined();
  });
});

describe('edit and resend', () => {
  test('the editor opens seeded with the message, and Cancel leaves the turn as it was', async () => {
    mountWith([userMessage({ text: 'explain this to me' })]);
    await startEditing();
    expect(
      (screen.getByTestId('agent-thread-user-message-edit-field') as HTMLTextAreaElement).value,
    ).toBe('explain this to me');
    await userEvent.click(screen.getByTestId('agent-thread-user-message-edit-cancel'));
    expect(screen.queryByTestId('agent-thread-user-message-editor')).toBeNull();
    expect(prompt).not.toHaveBeenCalled();
    // The original is still in the transcript — an abandoned edit changes
    // nothing about what was said.
    expect(screen.getByTestId('agent-thread-user-message')).toBeDefined();
  });

  test('closing the editor hands focus back to the Edit button that opened it', async () => {
    // The editor is the focused node; when it unmounts focus falls to <body>,
    // and a keyboard reader resumes from the top of the transcript rather than
    // the turn they were working on.
    mountWith([userMessage()]);
    await startEditing();
    await userEvent.click(screen.getByTestId('agent-thread-user-message-edit-cancel'));
    expect(document.activeElement).toBe(screen.getByTestId('agent-thread-user-message-edit'));
  });

  test('sending a revision also returns focus to the turn it came from', async () => {
    mountWith([userMessage()]);
    await startEditing();
    await rewriteTo('explain this to me, briefly');
    await userEvent.click(screen.getByTestId('agent-thread-user-message-edit-send'));
    expect(document.activeElement).toBe(screen.getByTestId('agent-thread-user-message-edit'));
  });

  test('Send puts the revision into this conversation as a new turn', async () => {
    mountWith([userMessage()]);
    await startEditing();
    await rewriteTo('explain this to me, briefly');
    await userEvent.click(screen.getByTestId('agent-thread-user-message-edit-send'));
    expect(prompt).toHaveBeenCalledWith('thread-1', 'explain this to me, briefly', undefined);
    // Re-sending never starts a thread — the destination menu is what does.
    expect(launchAgentThread).not.toHaveBeenCalled();
  });

  test('the original turn survives the resend rather than being rewritten', async () => {
    // The agent has already answered what was said; editing the bubble in place
    // would leave that reply answering words no longer on screen.
    mountWith([userMessage({ text: 'original wording' })]);
    await startEditing();
    await rewriteTo('revised wording');
    await userEvent.click(screen.getByTestId('agent-thread-user-message-edit-send'));
    expect(screen.getByTestId('rendered-markdown').textContent).toBe('original wording');
  });

  test('an emptied revision has nothing to send, and Send says so', async () => {
    mountWith([userMessage()]);
    await startEditing();
    await userEvent.clear(screen.getByTestId('agent-thread-user-message-edit-field'));
    expect(
      (screen.getByTestId('agent-thread-user-message-edit-send') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  test("a message's attachments ride the resend", async () => {
    // A revision of "look at this screenshot and…" that arrives without the
    // screenshot is a different ask.
    const attachment = {
      kind: 'image' as const,
      name: 'shot.png',
      mimeType: 'image/png',
      data: 'AAAA',
    };
    mountWith([userMessage({ attachments: [attachment] })]);
    await startEditing();
    await rewriteTo('and now the other half');
    await userEvent.click(screen.getByTestId('agent-thread-user-message-edit-send'));
    expect(prompt).toHaveBeenCalledWith('thread-1', 'and now the other half', [attachment]);
  });
});

describe('sending a revision somewhere else', () => {
  async function openSendMenu(): Promise<void> {
    await userEvent.click(screen.getByTestId('agent-thread-user-message-edit-send-menu'));
  }

  test('the menu offers this conversation, a new one, and each other agent', async () => {
    mountWith([userMessage()]);
    await startEditing();
    await openSendMenu();
    expect(screen.getByTestId('agent-thread-send-target-this-thread')).toBeDefined();
    expect(screen.getByTestId('agent-thread-send-target-new-thread')).toBeDefined();
    expect(screen.getByTestId('agent-thread-send-target-agent-registry:codex-acp')).toBeDefined();
    // This thread's own agent heads the new-chat list once, as the default —
    // listing it again below would read as two different destinations.
    expect(screen.queryByTestId('agent-thread-send-target-agent-registry:claude')).toBeNull();
  });

  test('a new chat runs the revision on a fresh thread with this thread’s agent', async () => {
    mountWith([userMessage()]);
    await startEditing();
    await rewriteTo('try again from scratch');
    await openSendMenu();
    await userEvent.click(screen.getByTestId('agent-thread-send-target-new-thread'));
    expect(launchAgentThread).toHaveBeenCalledWith(
      { source: 'registry', id: 'claude' },
      'try again from scratch',
      null,
      null,
      null,
      [],
    );
    // Nothing lands back in the conversation the message came from.
    expect(prompt).not.toHaveBeenCalled();
  });

  test('picking a different agent starts that agent on the revision', async () => {
    mountWith([userMessage()]);
    await startEditing();
    await rewriteTo('second opinion please');
    await openSendMenu();
    await userEvent.click(screen.getByTestId('agent-thread-send-target-agent-registry:codex-acp'));
    expect(launchAgentThread).toHaveBeenCalledWith(
      { source: 'registry', id: 'codex-acp' },
      'second opinion please',
      null,
      null,
      null,
      [],
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  test('a thread whose agent is the only one registered still offers a new chat', async () => {
    registeredAgents = [{ source: 'registry', id: 'claude', name: 'Claude Agent' }];
    mountWith([userMessage()]);
    await startEditing();
    await openSendMenu();
    expect(screen.getByTestId('agent-thread-send-target-new-thread')).toBeDefined();
  });

  test('attachments follow the revision into a new chat', async () => {
    const attachment = {
      kind: 'image' as const,
      name: 'shot.png',
      mimeType: 'image/png',
      data: 'AAAA',
    };
    mountWith([userMessage({ attachments: [attachment] })]);
    await startEditing();
    await rewriteTo('what do you make of this');
    await openSendMenu();
    await userEvent.click(screen.getByTestId('agent-thread-send-target-agent-registry:codex-acp'));
    expect(launchAgentThread).toHaveBeenCalledWith(
      { source: 'registry', id: 'codex-acp' },
      'what do you make of this',
      null,
      null,
      null,
      [attachment],
    );
  });
});

describe('a revision is never destroyed by something other than sending it', () => {
  test('a thread that stops accepting sends mid-edit leaves the editor and the words alone', async () => {
    // The editor and the action row used to be gated on different conditions,
    // so a status change under an open editor unmounted it — discarding the
    // typed revision — and left the row hidden forever, taking Copy with it.
    const { rerender } = mountWith([userMessage()]);
    await startEditing();
    await rewriteTo('most of a long revision');

    rerender(<ThreadView info={makeInfo({ status: 'exited' })} />);

    const field = screen.getByTestId('agent-thread-user-message-edit-field');
    expect((field as HTMLTextAreaElement).value).toBe('most of a long revision');
    // Only the destination that needs this thread is withdrawn.
    expect(
      (screen.getByTestId('agent-thread-user-message-edit-send') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test('cancelling an edit on a dead thread hands the row back with Copy on it', async () => {
    const { rerender } = mountWith([userMessage()]);
    await startEditing();
    rerender(<ThreadView info={makeInfo({ status: 'exited' })} />);
    await userEvent.click(screen.getByTestId('agent-thread-user-message-edit-cancel'));

    expect(screen.getByTestId('agent-thread-user-message-actions')).toBeDefined();
    expect(screen.getByTestId('agent-thread-user-message-copy')).toBeDefined();
  });

  test('a launch the dedup guard swallows keeps the editor open and says so', async () => {
    // The guard returns before `createThread`, so nothing else reports it: no
    // promise, no toast. Closing the editor on that would delete the only copy
    // of what was typed and read as the click doing nothing.
    launchOutcome = 'deduped';
    mountWith([userMessage()]);
    await startEditing();
    await rewriteTo('the only copy of this text');
    await userEvent.click(screen.getByTestId('agent-thread-user-message-edit-send-menu'));
    await userEvent.click(screen.getByTestId('agent-thread-send-target-new-thread'));

    expect(
      (screen.getByTestId('agent-thread-user-message-edit-field') as HTMLTextAreaElement).value,
    ).toBe('the only copy of this text');
    expect(toastError).toHaveBeenCalled();
    // The editor survived its own send, so the sending reset is observable
    // here: the region has emptied again, where an ungated label would still
    // be announcing.
    expect(
      within(screen.getByTestId('agent-thread-user-message-editor'))
        .queryAllByRole('status')
        .map((node) => node.textContent),
    ).not.toContain('Sending…');
  });

  test('a send in flight holds the field shut against a second dispatch', async () => {
    // Creation takes tens of seconds. Without the guard the second click reaches
    // the launcher's dedup guard and reports a collision for a send that is
    // about to succeed.
    holdNextLaunch();
    mountWith([userMessage()]);
    await startEditing();
    await rewriteTo('one send only');

    // Mounted empty from the editor's first render and scoped to it, so the
    // announcement is not lost to a region that appears and fills in the same
    // cycle, and the unrelated always-mounted drop notice cannot stand in.
    const editorRegions = (): HTMLElement[] =>
      within(screen.getByTestId('agent-thread-user-message-editor')).queryAllByRole('status');
    expect(editorRegions()).toHaveLength(1);
    const statusRegion = editorRegions()[0];
    expect(statusRegion?.textContent).toBe('');

    await userEvent.click(screen.getByTestId('agent-thread-user-message-edit-send-menu'));
    await userEvent.click(screen.getByTestId('agent-thread-send-target-new-thread'));

    // Still open, and saying so rather than just greying out.
    const sendButton = screen.getByTestId(
      'agent-thread-user-message-edit-send',
    ) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    expect(sendButton.getAttribute('aria-busy')).toBe('true');
    // Enter bypasses `disabled` entirely, so the imperative guard is what this
    // reaches.
    await userEvent.type(screen.getByTestId('agent-thread-user-message-edit-field'), '{Enter}');
    expect(launchAgentThread).toHaveBeenCalledTimes(1);
    expect(prompt).not.toHaveBeenCalled();

    // The disabled button's label swap announces nothing on its own; the region
    // populating on start is what carries the news — the same node, so the
    // announcement did not come from a region that mounted already filled.
    expect(statusRegion?.textContent).toBe('Sending…');

    await act(async () => {
      heldLaunch?.settle();
    });
    expect(screen.queryByTestId('agent-thread-user-message-editor')).toBeNull();
  });

  test('a send the user gave up on cannot delete the revision they typed next', async () => {
    // Nothing on screen said the first send was still running, so they cancelled
    // and started over. The abandoned completion must not tear down the editor
    // that now belongs to a different revision.
    holdNextLaunch();
    mountWith([userMessage()]);
    await startEditing();
    await rewriteTo('revision A');
    await userEvent.click(screen.getByTestId('agent-thread-user-message-edit-send-menu'));
    await userEvent.click(screen.getByTestId('agent-thread-send-target-new-thread'));

    await userEvent.click(screen.getByTestId('agent-thread-user-message-edit-cancel'));
    await startEditing();
    await rewriteTo('revision B');

    await act(async () => {
      heldLaunch?.settle();
    });

    expect(screen.queryByTestId('agent-thread-user-message-editor')).not.toBeNull();
    expect(
      (screen.getByTestId('agent-thread-user-message-edit-field') as HTMLTextAreaElement).value,
    ).toBe('revision B');
  });

  test('an archived thread whose resume fails keeps the revision in the field', async () => {
    // The one path where `sendText` itself reports false: the thread has to
    // resume before it can take a send, and that resume rejected.
    resumeRejects = true;
    mountWith([userMessage()], { archived: true });
    await startEditing();
    await rewriteTo('words that must survive');
    await userEvent.click(screen.getByTestId('agent-thread-user-message-edit-send'));

    expect(resumeThread).toHaveBeenCalled();
    expect(
      (screen.getByTestId('agent-thread-user-message-edit-field') as HTMLTextAreaElement).value,
    ).toBe('words that must survive');

    // And the banner's fallback must not carry a second copy: the editor holds
    // this revision WITH its attachments, so a stashed failed prompt would offer
    // the same words again minus them, and taking both would run one revision as
    // two threads.
    await userEvent.click(await screen.findByTestId('agent-thread-resume-fallback-new'));
    const fallback = createThread.mock.calls[0]?.[0];
    // The banner really did reach the client: without this, a fallback that
    // stopped creating threads at all would satisfy the check below.
    expect(fallback).toBeDefined();
    expect(fallback?.prompt).toBeUndefined();
  });

  test('superseding a notice ahead of an open editor does not remount it away', async () => {
    // The React key is derived from a model.items position for this reason: the
    // folded view drops the notice, every later row shifts down, and a key built
    // on that position would remount the bubble and take the revision with it.
    const notice = {
      kind: 'notice' as const,
      text: 'agent failed to start',
      tone: 'error' as const,
      failure: null,
      attempts: 1,
      superseded: false,
    };
    const message = userMessage();
    const view = mountWith([notice, message] as RenderedItem[]);
    await startEditing();
    await rewriteTo('typed while the notice was still there');

    // A later ready answers the failure, so the card stops describing anything.
    notice.superseded = true;
    view.rerender(<ThreadView info={makeInfo()} />);

    // The fold dropped it, so every later row shifted. Without this the field
    // assertion below also passes when nothing moved, which is the only thing
    // that makes the key matter.
    expect(screen.queryByTestId('agent-thread-notice')).toBeNull();
    expect(
      (screen.getByTestId('agent-thread-user-message-edit-field') as HTMLTextAreaElement).value,
    ).toBe('typed while the notice was still there');
  });

  test('a new chat does not pull focus back to the turn that was left behind', async () => {
    // The new thread activates its own dock tab and moves focus into that
    // composer. Reaching for the old Edit button teleports the user twice and
    // parks them on a control that no longer describes where they are.
    mountWith([userMessage()]);
    await startEditing();
    await rewriteTo('off to someone else');
    await userEvent.click(screen.getByTestId('agent-thread-user-message-edit-send-menu'));
    await userEvent.click(screen.getByTestId('agent-thread-send-target-new-thread'));

    expect(document.activeElement).not.toBe(screen.getByTestId('agent-thread-user-message-edit'));
  });

  test('a launch that starts closes the editor', async () => {
    mountWith([userMessage()]);
    await startEditing();
    await rewriteTo('off it goes');
    await userEvent.click(screen.getByTestId('agent-thread-user-message-edit-send-menu'));
    await userEvent.click(screen.getByTestId('agent-thread-send-target-new-thread'));

    expect(screen.queryByTestId('agent-thread-user-message-editor')).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('a dead thread keeps the destinations that do not need it', () => {
  test('the other-agent destination still sends from an exited thread', async () => {
    mountWith([userMessage()], { status: 'exited' });
    await startEditing();
    await rewriteTo('the agent here crashed, you try');
    await userEvent.click(screen.getByTestId('agent-thread-user-message-edit-send-menu'));
    await userEvent.click(screen.getByTestId('agent-thread-send-target-agent-registry:codex-acp'));

    expect(launchAgentThread).toHaveBeenCalledWith(
      { source: 'registry', id: 'codex-acp' },
      'the agent here crashed, you try',
      null,
      null,
      null,
      [],
    );
  });

  test('only the same-thread destination is withdrawn', async () => {
    mountWith([userMessage()], { status: 'exited' });
    await startEditing();
    await userEvent.click(screen.getByTestId('agent-thread-user-message-edit-send-menu'));

    expect(
      screen.getByTestId('agent-thread-send-target-this-thread').getAttribute('aria-disabled'),
    ).toBe('true');
    expect(screen.getByTestId('agent-thread-send-target-new-thread')).toBeDefined();
  });
});

describe('discoverability of the newest turn', () => {
  test('the last sent message keeps its actions on screen; earlier ones wait for a hover', () => {
    // Cross-agent dispatch is a capability nothing else in the app points at,
    // so at least one entry point has to be visible without a hover.
    mountWith([
      userMessage({ text: 'first', messageId: 'user-0' }),
      { kind: 'message', role: 'agent', text: 'reply', messageId: 'a-0' },
      userMessage({ text: 'second', messageId: 'user-1' }),
    ]);
    const rows = screen.getAllByTestId('agent-thread-user-message-actions');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.className).toContain('opacity-0');
    expect(rows[1]?.className).not.toContain('opacity-0');
  });
});
