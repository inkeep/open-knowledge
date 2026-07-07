import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { CommentAnchor } from '@/editor/comments/comment-store';

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

mock.module('@/components/handoff/AgentSplitButton', () => ({
  AgentSplitButton: ({
    primary,
    onPrimary,
    primaryDisabled,
    testIds,
  }: {
    primary: ReactNode;
    onPrimary: () => void;
    primaryDisabled?: boolean;
    testIds: { primary: string };
  }) => (
    <button
      type="button"
      data-testid={testIds.primary}
      disabled={primaryDisabled}
      onClick={onPrimary}
    >
      {primary}
    </button>
  ),
}));

mock.module('@/components/handoff/TerminalLaunchContext', () => ({
  useTerminalLaunch: () => null,
}));

mock.module('@/hooks/use-installed-clis', () => ({
  useInstalledClis: () => ({}),
}));

mock.module('@/components/handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({
    states: { codex: { installed: true } },
    refresh: () => Promise.resolve(),
  }),
}));

mock.module('@/lib/use-workspace', () => ({
  useWorkspace: () => ({ contentDir: '/tmp/project', pathSeparator: '/' }),
}));

const recordOnboardingAskedAi = mock(() => {});
mock.module('@/lib/onboarding-signals', () => ({ recordOnboardingAskedAi }));

const dispatchCalls: Array<{ target: string; input: unknown }> = [];
const buildCalls: Array<{
  docName: string | null;
  workspace: unknown;
  instruction: string;
  mentions: readonly string[];
}> = [];

mock.module('@/components/handoff/useHandoffDispatch', () => ({
  useHandoffDispatch: () => ({
    dispatch: (target: string, input: unknown) => {
      dispatchCalls.push({ target, input });
      return Promise.resolve({ ok: true as const });
    },
  }),
  buildComposerHandoffInput: (args: {
    docName: string | null;
    workspace: unknown;
    instruction: string;
    mentions: readonly string[];
  }) => {
    buildCalls.push(args);
    if (!args.workspace) return null;
    return {
      compose: {
        instruction: args.instruction,
        mentions: args.mentions,
      },
    };
  },
}));

const toastErrors: string[] = [];
mock.module('sonner', () => ({
  toast: {
    error: (message: string) => toastErrors.push(message),
  },
}));

const { DocumentCommentsPanel } = await import('./DocumentCommentsPanel');
const { getDocumentCommentSnapshot, resetDocumentCommentsForTests, setPendingDocumentComment } =
  await import('@/editor/comments/comment-store');

function anchor(overrides: Partial<CommentAnchor> = {}): CommentAnchor {
  const anchorText = overrides.anchorText ?? 'selected text';
  const markdown = overrides.markdown ?? anchorText;
  return {
    docName: 'notes',
    textStart: 0,
    textEnd: anchorText.length,
    anchorText,
    markdown,
    charLen: markdown.length,
    lineCount: (markdown.match(/\n/g)?.length ?? 0) + 1,
    ...overrides,
  };
}

beforeEach(() => {
  dispatchCalls.length = 0;
  buildCalls.length = 0;
  toastErrors.length = 0;
  recordOnboardingAskedAi.mockClear();
  resetDocumentCommentsForTests();
});

afterEach(() => {
  cleanup();
  resetDocumentCommentsForTests();
});

describe('DocumentCommentsPanel', () => {
  test('stacks selected comments and submits one formatted instruction to the resolved agent', async () => {
    setPendingDocumentComment(
      anchor({
        anchorText: 'first selected passage',
        markdown: '**first selected passage**',
      }),
    );

    render(<DocumentCommentsPanel docName="notes" />);

    fireEvent.change(screen.getByPlaceholderText('Add a comment'), {
      target: { value: 'Tighten the first claim.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));

    act(() => {
      setPendingDocumentComment(
        anchor({
          textStart: 40,
          textEnd: 62,
          anchorText: 'second selected passage',
          markdown: 'second selected passage',
        }),
      );
    });
    fireEvent.change(screen.getByPlaceholderText('Add a comment'), {
      target: { value: 'Add source detail here.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));

    expect(screen.getByText('Tighten the first claim.')).toBeTruthy();
    expect(screen.getByText('Add source detail here.')).toBeTruthy();
    expect(getDocumentCommentSnapshot('notes').comments).toHaveLength(2);

    fireEvent.click(screen.getByTestId('comments-send'));

    await waitFor(() => expect(dispatchCalls).toHaveLength(1));

    expect(dispatchCalls[0]?.target).toBe('codex');
    expect(buildCalls).toHaveLength(1);
    expect(buildCalls[0]?.docName).toBe('notes');
    expect(buildCalls[0]?.mentions).toEqual([]);
    expect(buildCalls[0]?.instruction).toContain('Comment 1');
    expect(buildCalls[0]?.instruction).toContain('**first selected passage**');
    expect(buildCalls[0]?.instruction).toContain('> Tighten the first claim.');
    expect(buildCalls[0]?.instruction).toContain('Comment 2');
    expect(buildCalls[0]?.instruction).toContain('second selected passage');
    expect(buildCalls[0]?.instruction).toContain('> Add source detail here.');

    await waitFor(() => expect(getDocumentCommentSnapshot('notes').comments).toHaveLength(0));
    expect(screen.getByText('No comments')).toBeTruthy();
    expect(recordOnboardingAskedAi).toHaveBeenCalledTimes(1);
    expect(toastErrors).toEqual([]);
  });
});
