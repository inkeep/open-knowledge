import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { setComposerDraftDoc } from '@/components/composer-draft-store';
import {
  type AgentThreadLaunchDetail,
  subscribeToAgentThreadLaunchRequests,
} from '@/components/handoff/thread-launch-events';
import {
  attachmentChipEvidence,
  backfillElementFromPoint,
  collectImageParts,
  DROP_TEST_FILE_NAME,
  DROP_TEST_PNG_BASE64,
  dropImageOn,
  dropRefusalText,
  expectDragOverIsCancelled,
  makeImageFile,
} from '@/editor/composer-drop.test-helper';
import { reloadEnabledAgentsFromStorage } from '@/lib/acp/enabled-agents';
import { registerAgent, reloadRegisteredAgentsFromStorage } from '@/lib/acp/registered-agents';
import { saveStickyAgent } from '@/lib/unified-agent-store';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

const toastMessages: string[] = [];
vi.doMock('sonner', () => ({
  toast: {
    error: (message: string) => {
      toastMessages.push(message);
    },
    info: (message: string) => {
      toastMessages.push(message);
    },
    warning: (message: string) => {
      toastMessages.push(message);
    },
    success: (message: string) => {
      toastMessages.push(message);
    },
  },
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
  DropdownMenuLabel: ({ children, ...props }: MenuChild) => <div {...props}>{children}</div>,
  DropdownMenuSeparator: () => <hr data-testid="menu-separator" />,
}));

vi.doMock('@/components/handoff/OpenInAgentMenuItem', () => ({
  TargetIcon: ({ id }: { id: string }) => <span data-testid={`target-icon-${id}`} />,
}));

let installStates: Record<string, { installed: boolean | null }> = {};
vi.doMock('@/components/handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states: installStates, refresh: () => Promise.resolve() }),
}));

vi.doMock('@/lib/use-workspace', () => ({
  useWorkspace: () => ({ contentDir: '/tmp/project', pathSeparator: '/' }),
}));

vi.doMock('@/lib/config-context', () => ({
  useConfigContext: () => ({ merged: { appearance: { preview: { autoOpen: true } } } }),
}));

const dispatchCalls: Array<{ target: string; input: unknown }> = [];
vi.doMock('@/components/handoff/useHandoffDispatch', async () => {
  const actual = await vi.importActual<typeof import('@/components/handoff/useHandoffDispatch')>(
    '@/components/handoff/useHandoffDispatch',
  );
  return {
    ...actual,
    useHandoffDispatch: () => ({
      dispatch: (target: string, input: unknown) => {
        dispatchCalls.push({ target, input });
        return Promise.resolve({ ok: true });
      },
      reinstallCoworkSkill: () => Promise.resolve({ kind: 'already-installed' }),
    }),
  };
});

const startCommentSubscribers = new Set<() => void>();
vi.doMock('@/comments/store', () => ({
  createThread: () => {},
  subscribeStartComment: (cb: () => void) => {
    startCommentSubscribers.add(cb);
    return () => startCommentSubscribers.delete(cb);
  },
  emitStartComment: () => {
    for (const cb of startCommentSubscribers) cb();
  },
  editComment: () => {},
  deleteThread: () => {},
  clearActiveThread: () => {},
  emitOpenThread: () => {},
  reopenThread: () => {},
  replaceOrphan: () => {},
  setActiveThread: () => {},
  toggleSending: () => {},
  dispatchComments: async () => [],
  subscribeCommentPosted: () => () => {},
}));

vi.doMock('@/comments/comment-chips', () => ({
  propertyAddress: (key: string) => key,
  revealThread: () => {},
}));

vi.doMock('@/editor/active-editor', async () => {
  const actual =
    await vi.importActual<typeof import('@/editor/active-editor')>('@/editor/active-editor');
  return { ...actual, getVisibleEditorForDoc: () => null };
});

vi.doMock('@/comments/anchor-decorations', () => ({ setCommentDraftRange: () => {} }));

vi.doMock('@/components/doc-panel-events', () => ({ requestDocPanelTab: () => {} }));

const { TooltipProvider } = await import('@/components/ui/tooltip');
const { ThreadCard } = await import('@/comments/ThreadCard');
const { CommentSelectionAffordance } = await import('@/comments/CommentSelectionAffordance');
const { UserMessageEditor } = await import('@/components/acp/UserMessageActions');
const { CreatePromptComposer } = await import('@/components/empty-state/CreatePromptComposer');

const DOC_TEXT = 'Toss the tofu with cornstarch.';
const QUOTE_FROM = DOC_TEXT.indexOf('the tofu');
const QUOTE_TO = QUOTE_FROM + 'the tofu'.length;

function fakeEditor() {
  return {
    isDestroyed: false,
    state: {
      selection: {
        from: QUOTE_FROM,
        to: QUOTE_TO,
        empty: false,
        ranges: [{ $from: { pos: QUOTE_FROM }, $to: { pos: QUOTE_TO } }],
      },
      doc: {
        nodesBetween: (from: number, to: number, fn: (node: unknown, pos: number) => void) => {
          fn(
            { isText: true, text: DOC_TEXT.slice(from, to), isBlock: false, isTextblock: false },
            from,
          );
        },
        content: { size: DOC_TEXT.length },
      },
    },
    commands: { setTextSelection: () => {} },
  };
}

function commentThread() {
  return {
    id: 't1',
    docName: 'recipes/stir-fry',
    target: { kind: 'body' as const },
    anchor: { quote: 'the tofu', prefix: '', suffix: '', start: 0, end: 8 },
    status: 'open' as const,
    body: 'press it?',
    createdAt: 1000,
    updatedAt: 1000,
    queued: true,
  };
}

async function expectDropIsRefusedWithAReason(textbox: Element) {
  expectDragOverIsCancelled(textbox);
  dropImageOn(textbox);
  await waitFor(() => {
    expect(dropRefusalText()).not.toBe('');
  });
  expect(attachmentChipEvidence(DROP_TEST_FILE_NAME)).toBeNull();
  expect(toastMessages).toEqual([]);
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  backfillElementFromPoint();
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  installStates = {
    'claude-code': { installed: true },
    codex: { installed: true },
    cursor: { installed: true },
  };
  toastMessages.length = 0;
  dispatchCalls.length = 0;
  startCommentSubscribers.clear();
  try {
    window.localStorage.clear();
  } catch {}
  setComposerDraftDoc(null);
  reloadRegisteredAgentsFromStorage();
  reloadEnabledAgentsFromStorage();
});

afterEach(() => {
  cleanup();
  consoleErrorSpy.mockRestore();
});

describe('every ComposerMentionInput surface either refuses the drop with a reason or defers it to its host', () => {
  test('comments ThreadCard edit composer', async () => {
    render(
      <TooltipProvider>
        <ThreadCard
          thread={commentThread()}
          cardRef={() => {}}
          focused={false}
          active={false}
          sending={false}
        />
      </TooltipProvider>,
    );
    screen.getByRole('button', { name: /edit this comment/i }).click();
    const textbox = await screen.findByRole('textbox', { name: /edit this comment/i });

    await expectDropIsRefusedWithAReason(textbox);
  });

  test('CommentSelectionAffordance comment composer', async () => {
    const { emitStartComment } = await import('@/comments/store');
    render(
      <TooltipProvider>
        <CommentSelectionAffordance
          // biome-ignore lint/suspicious/noExplicitAny: structural editor double
          editor={fakeEditor() as any}
          docName="recipes/stir-fry"
        />
      </TooltipProvider>,
    );
    act(() => {
      emitStartComment();
    });
    const textbox = await screen.findByRole('textbox', { name: /add a comment/i });

    await expectDropIsRefusedWithAReason(textbox);
  });

  test('UserMessageEditor resend composer defers the drop to its host panel', async () => {
    const hostDrops: string[] = [];
    render(
      <TooltipProvider>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: test-harness drop-target probe standing in for the host panel — drop is a pointer-only affordance, mirroring ThreadView's real drop host. */}
        <div
          onDrop={(event) => {
            hostDrops.push(...Array.from(event.dataTransfer.files).map((file) => file.name));
          }}
        >
          <UserMessageEditor
            initialText="try again with the screenshot"
            currentAgent={{ source: 'registry', id: 'claude-acp', name: 'Claude Agent' }}
            canSendHere
            onCancel={() => {}}
            onSend={() => Promise.resolve()}
          />
        </div>
      </TooltipProvider>,
    );
    const textbox = await screen.findByRole('textbox', { name: /edit and send again/i });

    dropImageOn(textbox, makeImageFile());

    expect(hostDrops).toEqual([DROP_TEST_FILE_NAME]);
    expect(dropRefusalText()).toBe('');
    expect(attachmentChipEvidence(DROP_TEST_FILE_NAME)).toBeNull();
  });

  test('empty-state CreatePromptComposer with a link-opened desktop target', async () => {
    saveStickyAgent('cursor');
    render(
      <TooltipProvider>
        <CreatePromptComposer scenario="new-project" />
      </TooltipProvider>,
    );
    const textbox = await screen.findByRole('textbox', {
      name: /describe the project you want to create/i,
    });

    await expectDropIsRefusedWithAReason(textbox);
    expect(dropRefusalText()).toContain('opens via a link');
  });
});

describe('the empty-state CreatePromptComposer with an in-app agent thread target', () => {
  function renderCreateComposer() {
    return render(
      <TooltipProvider>
        <CreatePromptComposer scenario="new-project" />
      </TooltipProvider>,
    );
  }

  test('a dropped image attaches as a pending chip instead of being refused', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    renderCreateComposer();
    const textbox = await screen.findByRole('textbox', {
      name: /describe the project you want to create/i,
    });

    expectDragOverIsCancelled(textbox);
    dropImageOn(textbox);

    await waitFor(() => {
      expect(attachmentChipEvidence(DROP_TEST_FILE_NAME)).not.toBeNull();
    });
    expect(dropRefusalText()).toBe('');
    expect(toastMessages).toEqual([]);
  });

  test('a dropped image reaches the launched thread intent as an image part', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    setComposerDraftDoc({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a wiki for the screenshot' }] },
      ],
    });
    const launches: AgentThreadLaunchDetail[] = [];
    const unsubscribe = subscribeToAgentThreadLaunchRequests((detail) => launches.push(detail));
    try {
      renderCreateComposer();
      const textbox = await screen.findByRole('textbox', {
        name: /describe the project you want to create/i,
      });

      dropImageOn(textbox);
      await waitFor(() => {
        expect(attachmentChipEvidence(DROP_TEST_FILE_NAME)).not.toBeNull();
      });

      fireEvent.click(screen.getByTestId('create-with-agent'));

      await waitFor(() => {
        expect(launches).toHaveLength(1);
      });
      expect(collectImageParts(launches[0])).toContainEqual(
        expect.objectContaining({
          kind: 'image',
          mimeType: 'image/png',
          data: DROP_TEST_PNG_BASE64,
        }),
      );
      await waitFor(() => {
        expect(attachmentChipEvidence(DROP_TEST_FILE_NAME)).toBeNull();
      });
    } finally {
      unsubscribe();
    }
  });

  test('a drop on the card outside the text box attaches instead of falling through', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    renderCreateComposer();
    await screen.findByRole('textbox', { name: /describe the project you want to create/i });

    const dropTarget = screen.getByTestId('create-with-agent');
    expectDragOverIsCancelled(dropTarget);
    dropImageOn(dropTarget);

    await waitFor(() => {
      expect(attachmentChipEvidence(DROP_TEST_FILE_NAME)).not.toBeNull();
    });
    expect(dropRefusalText()).toBe('');
  });

  test('the card signals accept while a file is dragged over it and clears when the drag leaves', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    renderCreateComposer();
    await screen.findByRole('textbox', { name: /describe the project you want to create/i });
    const card = screen.getByTestId('create-prompt-card');
    const dataTransfer = { types: ['Files'], files: [makeImageFile()], items: [] };

    act(() => {
      fireEvent.dragEnter(card, { dataTransfer });
    });
    expect(card.getAttribute('data-drag-active')).toBe('accept');

    act(() => {
      fireEvent.dragLeave(card, { dataTransfer });
    });
    expect(card.getAttribute('data-drag-active')).toBeNull();
  });

  test('the attach button is offered for an in-app agent and withheld for a link-opened target', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    renderCreateComposer();
    await screen.findByRole('textbox', { name: /describe the project you want to create/i });
    expect(screen.queryByTestId('create-attach-files')).not.toBeNull();

    fireEvent.click(screen.getByTestId('create-agent-option-cursor'));

    expect(screen.queryByTestId('create-attach-files')).toBeNull();
    expect(screen.getByTestId('create-prompt-card').getAttribute('data-drag-active')).toBeNull();
  });

  test('attach then switch to a link-opened target refuses the send and keeps the image pending, never silently stripped', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    setComposerDraftDoc({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a wiki for the screenshot' }] },
      ],
    });
    const launches: AgentThreadLaunchDetail[] = [];
    const unsubscribe = subscribeToAgentThreadLaunchRequests((detail) => launches.push(detail));
    try {
      renderCreateComposer();
      const textbox = await screen.findByRole('textbox', {
        name: /describe the project you want to create/i,
      });
      dropImageOn(textbox);
      await waitFor(() => {
        expect(attachmentChipEvidence(DROP_TEST_FILE_NAME)).not.toBeNull();
      });

      fireEvent.click(screen.getByTestId('create-agent-option-cursor'));
      fireEvent.click(screen.getByTestId('create-with-agent'));

      await waitFor(() => {
        expect(toastMessages.some((text) => text.includes("doesn't accept attachments"))).toBe(
          true,
        );
      });
      expect(collectImageParts(dispatchCalls)).toEqual([]);
      expect(collectImageParts(launches)).toEqual([]);
      expect(attachmentChipEvidence(DROP_TEST_FILE_NAME)).not.toBeNull();
    } finally {
      unsubscribe();
    }
  });
});
