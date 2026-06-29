
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@/components/ui/button';
import type { EditWithAiSelectionSnapshot } from './EditWithAiPopover';

type WindowGlobals = {
  MutationObserver?: typeof MutationObserver;
  NodeFilter?: typeof NodeFilter;
};
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & {
    window?: WindowGlobals;
    ResizeObserver?: unknown;
  };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.MutationObserver === undefined &&
  globalWithDomShims.window?.MutationObserver !== undefined
) {
  globalWithDomShims.MutationObserver = globalWithDomShims.window.MutationObserver;
}
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

const dispatchCalls: Array<{ target: string; input: unknown }> = [];
const buildArgs: unknown[] = [];
const toastErrors: string[] = [];
let refreshCount = 0;

mock.module('sonner', () => ({
  toast: {
    error: (message: string) => {
      toastErrors.push(message);
    },
    success: () => {},
  },
}));

mock.module('./useInstalledAgents', () => ({
  useInstalledAgents: () => ({
    states: {
      'claude-cowork': { installed: false },
      'claude-code': { installed: true },
      codex: { installed: false },
      cursor: { installed: false },
    },
    refresh: () => {
      refreshCount += 1;
      return Promise.resolve();
    },
  }),
}));

mock.module('./useHandoffDispatch', () => ({
  useHandoffDispatch: () => ({
    dispatch: (target: string, input: unknown) => {
      dispatchCalls.push({ target, input });
      return Promise.resolve({ ok: true });
    },
    reinstallCoworkSkill: () => Promise.resolve({ kind: 'already-installed' }),
  }),
  buildSelectionOrDocHandoffInput: (args: { selectionMarkdown: string }) => {
    buildArgs.push(args);
    return args.selectionMarkdown === '' ? null : { __built: true };
  },
}));

const { EditWithAiPopover } = await import('./EditWithAiPopover');

const SNAPSHOT: EditWithAiSelectionSnapshot = {
  docName: 'specs/foo/SPEC',
  workspace: { contentDir: '/Users/x/notes', pathSeparator: '/' },
  selectionMarkdown: 'The selected passage.',
};

function renderPopover({
  open,
  onOpenChange = () => {},
  snapshot,
}: {
  open: boolean;
  onOpenChange?: (next: boolean) => void;
  snapshot: EditWithAiSelectionSnapshot | null;
}) {
  return render(
    <EditWithAiPopover open={open} onOpenChange={onOpenChange} snapshot={snapshot}>
      <Button data-testid="trigger">Edit with AI</Button>
    </EditWithAiPopover>,
  );
}

afterEach(() => {
  cleanup();
  dispatchCalls.length = 0;
  buildArgs.length = 0;
  toastErrors.length = 0;
  refreshCount = 0;
});

describe('EditWithAiPopover', () => {
  test('renders the instruction panel and refreshes install state when open', () => {
    renderPopover({ open: true, snapshot: SNAPSHOT });

    expect(screen.getByTestId('edit-with-ai-instruction')).toBeTruthy();
    expect(refreshCount).toBe(1);
  });

  test('stays closed and does not refresh when open is false', () => {
    renderPopover({ open: false, snapshot: null });

    expect(screen.queryByTestId('edit-with-ai-instruction')).toBeNull();
    expect(refreshCount).toBe(0);
  });

  test('dispatches a selection-scoped handoff carrying the snapshot and typed instruction', async () => {
    const user = userEvent.setup();
    const onOpenChange = mock(() => {});
    renderPopover({ open: true, onOpenChange, snapshot: SNAPSHOT });

    await user.type(screen.getByTestId('edit-with-ai-instruction'), 'make it concise');
    await user.click(screen.getByTestId('edit-with-ai-target-claude-code'));

    expect(buildArgs).toEqual([
      {
        docName: 'specs/foo/SPEC',
        workspace: { contentDir: '/Users/x/notes', pathSeparator: '/' },
        instruction: 'make it concise',
        selectionMarkdown: 'The selected passage.',
      },
    ]);
    expect(dispatchCalls).toEqual([{ target: 'claude-code', input: { __built: true } }]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('allows a pick with an empty instruction', async () => {
    const user = userEvent.setup();
    renderPopover({ open: true, snapshot: SNAPSHOT });

    await user.click(screen.getByTestId('edit-with-ai-target-claude-code'));

    expect((buildArgs[0] as { instruction: string }).instruction).toBe('');
    expect(dispatchCalls).toEqual([{ target: 'claude-code', input: { __built: true } }]);
  });

  test('null input from the builder surfaces a toast and skips dispatch', async () => {
    const user = userEvent.setup();
    renderPopover({ open: true, snapshot: { ...SNAPSHOT, selectionMarkdown: '' } });

    await user.click(screen.getByTestId('edit-with-ai-target-claude-code'));

    expect(dispatchCalls).toEqual([]);
    expect(toastErrors).toHaveLength(1);
  });
});
