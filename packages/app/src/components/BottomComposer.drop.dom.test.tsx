import * as actualLinguiMacro from '@lingui/react/macro';
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
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
  liveRegionTexts,
  makeFilesDataTransfer,
  makeImageFile,
  removeAttachmentButton,
} from '@/editor/composer-drop.test-helper';
import { reloadEnabledAgentsFromStorage } from '@/lib/acp/enabled-agents';
import { registerAgent, reloadRegisteredAgentsFromStorage } from '@/lib/acp/registered-agents';
import { OK_SIDEBAR_DRAG_MIME } from '@/lib/sidebar-drag';
import { saveStickyAgent, terminalCliId } from '@/lib/unified-agent-store';

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

let installStates: Record<string, { installed: boolean | null }> = {};
vi.doMock('@/components/handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states: installStates, refresh: () => Promise.resolve() }),
}));

vi.doMock('@/lib/use-workspace', () => ({
  useWorkspace: () => ({ contentDir: '/tmp/project', pathSeparator: '/' }),
}));

vi.doMock('@/hooks/use-selection-context', () => ({
  useSelectionContext: () => null,
  usePublishFrontmatterSelection: () => {},
}));

vi.doMock('@/components/PageListContext', () => ({
  usePageList: () => ({ pageMeta: new Map() }),
}));

vi.doMock('@/lib/onboarding-signals', () => ({ recordOnboardingAskedAi: () => {} }));

let noteWindowMode = false;
vi.doMock('@/lib/note-window-mode', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/note-window-mode')>('@/lib/note-window-mode');
  return { ...actual, isNoteWindow: () => noteWindowMode };
});

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

type ComposeDispatch = (
  items: readonly { threadId: string; payload: { docName: string } }[],
) => Promise<boolean>;
const commentBatches: unknown[] = [];
let queuedCommentCount = 0;
vi.doMock('@/comments/store', () => ({
  dispatchComments: async ({ compose }: { compose: ComposeDispatch }) => {
    if (queuedCommentCount === 0) return [];
    const items = [{ threadId: 'c1', payload: { docName: 'notes' } }];
    const delivered = await compose(items);
    if (delivered) commentBatches.push(items);
    return delivered ? ['c1'] : [];
  },
  subscribeCommentPosted: () => () => {},
}));

vi.doMock('@/comments/comment-chips', async () => {
  const actual = await vi.importActual<typeof import('@/comments/comment-chips')>(
    '@/comments/comment-chips',
  );
  return {
    ...actual,
    useSelectedCommentCount: () => queuedCommentCount,
    useSelectedCommentDocs: () => (queuedCommentCount > 0 ? ['notes'] : []),
    toCommentBatchItem: () => ({
      docName: 'notes',
      body: 'look at this',
      quote: 'the tofu',
      anchorLost: false,
    }),
  };
});

const ALL_INSTALLED: Record<string, { installed: boolean | null }> = {
  'claude-cowork': { installed: false },
  'claude-code': { installed: true },
  codex: { installed: true },
  cursor: { installed: true },
};

const DROPPED_FILE_NAME = DROP_TEST_FILE_NAME;
const INSTRUCTION = 'please describe the attached picture';

async function renderComposer(docName = 'notes', { withTerminal = true } = {}) {
  const { BottomComposer } = await import('./BottomComposer');
  const { TooltipProvider } = await import('@/components/ui/tooltip');
  const { TerminalLaunchProvider } = await import('@/components/handoff/TerminalLaunchContext');
  return render(
    <TooltipProvider>
      <TerminalLaunchProvider
        value={
          withTerminal ? { launchInTerminal: () => {}, installedClis: { claude: true } } : null
        }
      >
        <BottomComposer docName={docName} surface="wysiwyg" />
      </TerminalLaunchProvider>
    </TooltipProvider>,
  );
}

function seedInstructionDraft() {
  setComposerDraftDoc({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: INSTRUCTION }] }],
  });
}

function getInput() {
  return screen.getByRole('textbox', { name: 'Ask AI' });
}

function visibleFeedback(): string[] {
  return [...toastMessages, ...liveRegionTexts()];
}

let launches: AgentThreadLaunchDetail[] = [];
let unsubscribeLaunches: (() => void) | null = null;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  backfillElementFromPoint();
  noteWindowMode = false;
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  installStates = { ...ALL_INSTALLED };
  dispatchCalls.length = 0;
  toastMessages.length = 0;
  commentBatches.length = 0;
  queuedCommentCount = 0;
  launches = [];
  unsubscribeLaunches = subscribeToAgentThreadLaunchRequests((detail) => launches.push(detail));
  try {
    window.localStorage.clear();
  } catch {}
  setComposerDraftDoc(null);
  reloadRegisteredAgentsFromStorage();
  reloadEnabledAgentsFromStorage();
});

afterEach(() => {
  cleanup();
  unsubscribeLaunches?.();
  consoleErrorSpy.mockRestore();
  delete (window as { okDesktop?: unknown }).okDesktop;
});

describe('image drop on the bottom Ask AI composer with the in-app thread target', () => {
  test('a dropped image attaches as a visible, removable chip', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    seedInstructionDraft();
    await renderComposer();

    dropImageOn(getInput());

    await waitFor(() => {
      expect(attachmentChipEvidence(DROPPED_FILE_NAME)).not.toBeNull();
    });

    const remove = removeAttachmentButton(DROPPED_FILE_NAME);
    expect(remove).toBeDefined();
    if (remove !== undefined) fireEvent.click(remove);
    await waitFor(() => {
      expect(attachmentChipEvidence(DROPPED_FILE_NAME)).toBeNull();
    });
  });

  test('a dropped image reaches the launched thread as an ACP image content block', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    seedInstructionDraft();
    await renderComposer();

    dropImageOn(getInput());
    await waitFor(() => {
      expect(attachmentChipEvidence(DROPPED_FILE_NAME)).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId('ask-ai-send'));

    await waitFor(() => {
      expect(launches).toHaveLength(1);
    });
    const parts = collectImageParts(launches[0]);
    expect(parts).toContainEqual(
      expect.objectContaining({ kind: 'image', mimeType: 'image/png', data: DROP_TEST_PNG_BASE64 }),
    );

    await waitFor(() => {
      expect(attachmentChipEvidence(DROPPED_FILE_NAME)).toBeNull();
    });
  });

  test('removing the chip keeps the image out of the launch payload', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    seedInstructionDraft();
    await renderComposer();

    dropImageOn(getInput());
    await waitFor(() => {
      expect(attachmentChipEvidence(DROPPED_FILE_NAME)).not.toBeNull();
    });
    const remove = removeAttachmentButton(DROPPED_FILE_NAME);
    expect(remove).toBeDefined();
    if (remove !== undefined) fireEvent.click(remove);

    fireEvent.click(screen.getByTestId('ask-ai-send'));

    await waitFor(() => {
      expect(launches).toHaveLength(1);
    });
    expect(collectImageParts(launches[0])).toEqual([]);
    expect(launches[0]?.prompt).toContain(INSTRUCTION);
  });
});

describe('image drop in a note window', () => {
  test('the drop is refused by name even with the in-app thread target selected', async () => {
    noteWindowMode = true;
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    seedInstructionDraft();
    await renderComposer();

    dropImageOn(getInput());

    await waitFor(() => {
      expect(dropRefusalText()).toContain('note windows');
    });
    expect(attachmentChipEvidence(DROPPED_FILE_NAME)).toBeNull();
    expect(launches).toEqual([]);
    expect(dispatchCalls).toEqual([]);
  });
});

describe('a drop that carries no attachable file', () => {
  test('an empty file is refused by name rather than falling through to the browser', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    seedInstructionDraft();
    await renderComposer();

    const input = getInput();
    const empty = new File([], 'screenshots', { type: '' });
    const dataTransfer = makeFilesDataTransfer([empty]);
    const dropEvent = createEvent.drop(input, { dataTransfer });
    act(() => {
      fireEvent(input, dropEvent);
    });

    expect(dropEvent.defaultPrevented).toBe(true);
    await waitFor(() => {
      expect(dropRefusalText()).toContain('Folders and empty files');
    });
    expect(attachmentChipEvidence('screenshots')).toBeNull();
  });
});

describe('the composer drop surface itself', () => {
  test('dragover is cancelled with a copy drop effect so a real browser will deliver the drop', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    seedInstructionDraft();
    await renderComposer();

    expectDragOverIsCancelled(getInput());
  });

  test('dragover in refuse mode sets dropEffect copy (never none) so the drop event still fires', async () => {
    saveStickyAgent('cursor');
    seedInstructionDraft();
    await renderComposer();
    expect(screen.getByTestId('ask-ai-send').textContent).toContain('Cursor');

    expectDragOverIsCancelled(getInput());
  });

  test('send stays disabled while a dropped image is still being read', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    seedInstructionDraft();
    await renderComposer();

    dropImageOn(getInput());

    expect(screen.getByTestId('ask-ai-send')).toHaveProperty('disabled', true);
    await waitFor(() => {
      expect(attachmentChipEvidence(DROPPED_FILE_NAME)).not.toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId('ask-ai-send')).toHaveProperty('disabled', false);
    });
  });
});

describe('drops on the composer card outside the text box', () => {
  test('a drop on the card root attaches just like a drop on the editor', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    seedInstructionDraft();
    await renderComposer();

    dropImageOn(screen.getByTestId('ask-ai-composer-card'));

    await waitFor(() => {
      expect(attachmentChipEvidence(DROPPED_FILE_NAME)).not.toBeNull();
    });
  });

  test('a drop on a non-editor child of the card attaches instead of falling through', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    seedInstructionDraft();
    await renderComposer();

    dropImageOn(screen.getByTestId('ask-ai-send'));

    await waitFor(() => {
      expect(attachmentChipEvidence(DROPPED_FILE_NAME)).not.toBeNull();
    });
  });

  test('a card drop for a target with no attachment channel refuses visibly', async () => {
    saveStickyAgent('cursor');
    seedInstructionDraft();
    await renderComposer();

    dropImageOn(screen.getByTestId('ask-ai-composer-card'));

    await waitFor(() => {
      expect(dropRefusalText()).toContain('opens via a link');
    });
    expect(toastMessages).toEqual([]);
    expect(attachmentChipEvidence(DROPPED_FILE_NAME)).toBeNull();
  });

  test('dragover on the card is cancelled with a copy drop effect', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    seedInstructionDraft();
    await renderComposer();

    expectDragOverIsCancelled(screen.getByTestId('ask-ai-composer-card'));
  });
});

describe('attachments with no agent configured at all', () => {
  test('an image drop is refused with a visible reason, not silently ignored', async () => {
    installStates = {};
    seedInstructionDraft();
    await renderComposer('notes', { withTerminal: false });

    dropImageOn(getInput());

    await waitFor(() => {
      expect(dropRefusalText()).toContain('No agents are set up yet');
    });
    expect(attachmentChipEvidence(DROPPED_FILE_NAME)).toBeNull();
  });

  test('a pasted image is refused with a visible reason, not a silent no-op', async () => {
    installStates = {};
    seedInstructionDraft();
    await renderComposer('notes', { withTerminal: false });

    act(() => {
      fireEvent.paste(getInput(), { clipboardData: makeFilesDataTransfer([makeImageFile()]) });
    });

    await waitFor(() => {
      expect(dropRefusalText()).toContain('No agents are set up yet');
    });
    expect(toastMessages).toEqual([]);
    expect(attachmentChipEvidence(DROPPED_FILE_NAME)).toBeNull();
  });
});

describe('pasting an image into the Ask AI composer', () => {
  test('a pasted image attaches for the in-app thread target', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    seedInstructionDraft();
    await renderComposer();

    act(() => {
      fireEvent.paste(getInput(), { clipboardData: makeFilesDataTransfer([makeImageFile()]) });
    });

    await waitFor(() => {
      expect(attachmentChipEvidence(DROPPED_FILE_NAME)).not.toBeNull();
    });
  });

  test('a pasted image is refused by name for a target with no attachment channel', async () => {
    saveStickyAgent('cursor');
    seedInstructionDraft();
    await renderComposer();

    act(() => {
      fireEvent.paste(getInput(), { clipboardData: makeFilesDataTransfer([makeImageFile()]) });
    });

    await waitFor(() => {
      expect(dropRefusalText()).toContain('opens via a link');
    });
    expect(toastMessages).toEqual([]);
    expect(attachmentChipEvidence(DROPPED_FILE_NAME)).toBeNull();
  });
});

describe('image drop followed by a target switch', () => {
  test('sending to a linkless target with an attachment pending refuses or strips visibly, never silently losing the image', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    seedInstructionDraft();
    await renderComposer();

    dropImageOn(getInput());
    await waitFor(() => {
      expect(attachmentChipEvidence(DROPPED_FILE_NAME)).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId('ask-ai-agent-trigger'));
    fireEvent.click(screen.getByTestId('ask-ai-agent-option-cursor'));
    expect(screen.getByTestId('ask-ai-send').textContent).toContain('Cursor');

    const feedbackBefore = new Set(visibleFeedback());
    fireEvent.click(screen.getByTestId('ask-ai-send'));

    await waitFor(() => {
      const fresh = visibleFeedback().filter((text) => !feedbackBefore.has(text));
      expect(fresh).not.toEqual([]);
    });
    expect(collectImageParts(launches)).toEqual([]);
    expect(collectImageParts(dispatchCalls)).toEqual([]);
  });
});

describe('image drop with a target that has no attachment channel', () => {
  test('a link-opened desktop target names the link constraint in the refusal', async () => {
    saveStickyAgent('cursor');
    seedInstructionDraft();
    await renderComposer();
    expect(screen.getByTestId('ask-ai-send').textContent).toContain('Cursor');

    dropImageOn(getInput());

    await waitFor(() => {
      expect(dropRefusalText()).toContain('opens via a link');
    });
    expect(attachmentChipEvidence(DROPPED_FILE_NAME)).toBeNull();
    expect(dispatchCalls).toEqual([]);
    expect(launches).toEqual([]);
  });

  test('a terminal CLI target names the terminal constraint in the refusal', async () => {
    saveStickyAgent(terminalCliId('claude'));
    seedInstructionDraft();
    await renderComposer();

    dropImageOn(getInput());

    await waitFor(() => {
      expect(dropRefusalText()).toContain('runs in a terminal');
    });
    expect(attachmentChipEvidence(DROPPED_FILE_NAME)).toBeNull();
    expect(dispatchCalls).toEqual([]);
    expect(launches).toEqual([]);
  });
});

describe('the attachment status live region', () => {
  test('announces the in-flight read first, then the ready count once it settles', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    seedInstructionDraft();
    await renderComposer();
    const region = screen.getByTestId('composer-attachment-status');
    expect(region.textContent).toBe('');

    dropImageOn(getInput());

    expect(region.textContent).toContain('Uploading');
    expect(region.textContent).not.toContain('ready to send');
    await waitFor(() => {
      expect(region.textContent).toContain('ready to send');
    });
    expect(region.textContent).not.toContain('Uploading');
  });
});

describe('image drop while comments are queued', () => {
  test('the comment batch ships with the image instead of blocking the send', async () => {
    queuedCommentCount = 1;
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    seedInstructionDraft();
    await renderComposer();

    dropImageOn(getInput());
    await waitFor(() => {
      expect(attachmentChipEvidence(DROPPED_FILE_NAME)).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId('ask-ai-send'));

    await waitFor(() => {
      expect(launches).toHaveLength(1);
    });
    expect(collectImageParts(launches[0])).toContainEqual(
      expect.objectContaining({ kind: 'image', mimeType: 'image/png', data: DROP_TEST_PNG_BASE64 }),
    );
    expect(commentBatches).toHaveLength(1);
    await waitFor(() => {
      expect(attachmentChipEvidence(DROPPED_FILE_NAME)).toBeNull();
    });
  });
});

describe('the drag highlight on the composer card', () => {
  test('an accept mount lights a distinct channel and survives a dragleave bubbling from a child', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    seedInstructionDraft();
    await renderComposer();
    const card = screen.getByTestId('ask-ai-composer-card');
    const input = getInput();
    const dataTransfer = makeFilesDataTransfer([makeImageFile()]);

    act(() => {
      fireEvent.dragEnter(card, { dataTransfer });
    });
    expect(card.getAttribute('data-drag-active')).toBe('accept');

    const leaveToChild = createEvent.dragLeave(card, { dataTransfer });
    Object.defineProperty(leaveToChild, 'relatedTarget', { value: input });
    act(() => {
      fireEvent.dragEnter(input, { dataTransfer });
      fireEvent(card, leaveToChild);
    });
    expect(card.getAttribute('data-drag-active')).toBe('accept');

    act(() => {
      fireEvent.dragLeave(card, { dataTransfer });
    });
    expect(card.getAttribute('data-drag-active')).toBeNull();
  });

  test('a refuse mount signals refusal during the drag instead of advertising acceptance', async () => {
    saveStickyAgent('cursor');
    seedInstructionDraft();
    await renderComposer();
    const card = screen.getByTestId('ask-ai-composer-card');

    act(() => {
      fireEvent.dragEnter(card, { dataTransfer: makeFilesDataTransfer([makeImageFile()]) });
    });

    expect(card.getAttribute('data-drag-active')).toBe('refuse');
  });

  test('a sidebar row drag does not light the card even when it advertises Files', async () => {
    registerAgent({ source: 'registry', id: 'claude-acp', name: 'Claude Agent' });
    seedInstructionDraft();
    await renderComposer();
    const card = screen.getByTestId('ask-ai-composer-card');
    const dataTransfer = {
      ...makeFilesDataTransfer([makeImageFile()]),
      types: ['Files', OK_SIDEBAR_DRAG_MIME],
    };

    act(() => {
      fireEvent.dragEnter(card, { dataTransfer });
    });

    expect(card.getAttribute('data-drag-active')).toBeNull();
  });
});
