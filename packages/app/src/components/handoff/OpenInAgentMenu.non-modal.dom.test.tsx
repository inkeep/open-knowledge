import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { HandoffDispatchInput } from './useHandoffDispatch';

type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
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

vi.doMock('./useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states: {}, refresh: () => {} }),
}));
vi.doMock('./useHandoffDispatch', () => ({
  useHandoffDispatch: () => ({ dispatch: async () => {}, reinstallCoworkSkill: async () => {} }),
  composeThreadLaunchPrompt: (input: HandoffDispatchInput) =>
    `thread-prompt:${input.docContext?.relativePath ?? 'none'}`,
  startAgentThreadForInput: () => {},
  openInstallUrl: () => Promise.resolve(),
}));

const { OpenInAgentMenu } = await import('./OpenInAgentMenu');

const FILE_INPUT: HandoffDispatchInput = {
  docContext: null,
  projectDir: '/tmp/project',
  docPath: 'note.md',
};

describe('OpenInAgentMenu non-modal contract', () => {
  afterEach(() => {
    cleanup();
    document.body.style.pointerEvents = '';
  });

  test('opening the menu does not disable outside pointer events (body stays interactive)', async () => {
    render(<OpenInAgentMenu input={FILE_INPUT} open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.queryByTestId('open-in-agent-menu')).not.toBeNull();
    });

    expect(document.body.style.pointerEvents).not.toBe('none');
  });
});
