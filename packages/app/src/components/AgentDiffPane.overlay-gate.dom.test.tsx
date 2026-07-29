/**
 * RTL behavior tests for the AgentDiffPane keyboard gate.
 *
 * This pane is the one guarded listener that stays on BUBBLE phase, so it
 * carries two arms the capture-phase sites do not need, and neither is
 * exercised anywhere else:
 *
 *  - `event.defaultPrevented` covers Escape. A dismissable layer claims Escape
 *    from a capture-phase listener on `document`, which also flips its
 *    `data-state` before this bubble-phase handler runs — so by then the layer
 *    probe alone reads "nothing open" and the pane would close out from under
 *    the dialog the user was dismissing.
 *  - the layer probe covers the review chords (j / k / ← / →), which no layer
 *    cancels.
 *
 * The overlay is a REAL Radix Dialog rather than a stub, because the
 * `defaultPrevented` arm is a claim about what Radix's DismissableLayer
 * actually does to the event.
 *
 * Substrate: jsdom via `pnpm run test:dom`.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

const closeAgentDiff = vi.fn(() => {});
const setAgentDiffKept = vi.fn(() => {});

import * as actualLinguiMacro from '@lingui/react/macro';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

vi.doMock('@/lib/agent-diff-store', () => ({
  closeAgentDiff,
  setAgentDiffKept,
}));

vi.doMock('@/lib/use-activity-panel', () => ({
  fetchAgentBurstDiff: () => Promise.resolve({ diff: '', before: '', after: '' }),
}));

const view = {
  agentId: 'agent-1',
  agentName: 'Agent',
  agentColor: '#888888',
  docName: 'docs/team/spec',
  keptCount: 1,
  maxVersions: 3,
};

async function renderPane({ withOverlay }: { withOverlay: boolean }) {
  const { AgentDiffPane } = await import('./AgentDiffPane');
  const { Dialog, DialogContent, DialogDescription, DialogTitle } = await import(
    '@/components/ui/dialog'
  );
  render(
    <TooltipProvider>
      <AgentDiffPane view={view} isPanelCollapsed={false} onTogglePanel={() => {}} />
      {withOverlay ? (
        <Dialog open>
          <DialogContent>
            <DialogTitle>Command palette</DialogTitle>
            <DialogDescription>Search files and commands</DialogDescription>
          </DialogContent>
        </Dialog>
      ) : null}
    </TooltipProvider>,
  );
  if (withOverlay) {
    await waitFor(() => expect(screen.getByRole('dialog')).not.toBeNull());
  }
}

function press(key: string) {
  act(() => {
    fireEvent.keyDown(document.body, { key });
  });
}

describe('AgentDiffPane keyboard gate', () => {
  beforeEach(() => {
    closeAgentDiff.mockClear();
    setAgentDiffKept.mockClear();
  });

  afterEach(cleanup);

  test('Escape closes the pane with no overlay open', async () => {
    await renderPane({ withOverlay: false });

    press('Escape');

    expect(closeAgentDiff).toHaveBeenCalledTimes(1);
  });

  test('Escape does not close the pane while a dialog owns the keyboard', async () => {
    await renderPane({ withOverlay: true });

    press('Escape');

    expect(closeAgentDiff).not.toHaveBeenCalled();
  });

  test('Escape already claimed by a dismissed layer does not also close the pane', async () => {
    // jsdom dispatches synchronously, so a real Radix layer is still in the DOM
    // when this bubble-phase handler runs and the layer probe alone would cover
    // it. A real browser runs a microtask checkpoint between listeners, so React
    // has already unmounted the layer by then and the probe reads "nothing
    // open" — leaving `defaultPrevented` as the only thing standing between the
    // user and a pane that closes out from under the dialog they dismissed.
    // Reproduce that end state: cancelled Escape, no layer left in the DOM.
    await renderPane({ withOverlay: false });

    const claimEscape = (event: Event) => {
      if ((event as KeyboardEvent).key === 'Escape') event.preventDefault();
    };
    document.addEventListener('keydown', claimEscape, { capture: true });

    try {
      press('Escape');
    } finally {
      document.removeEventListener('keydown', claimEscape, { capture: true });
    }

    expect(closeAgentDiff).not.toHaveBeenCalled();
  });

  test('j steps the version with no overlay open', async () => {
    await renderPane({ withOverlay: false });

    press('j');

    expect(setAgentDiffKept).toHaveBeenCalledWith(2);
  });

  test('j and ArrowRight do not step the version while a dialog is open', async () => {
    await renderPane({ withOverlay: true });

    press('j');
    press('ArrowRight');

    expect(setAgentDiffKept).not.toHaveBeenCalled();
  });

  test('k does not step the version while a dialog is open', async () => {
    await renderPane({ withOverlay: true });

    press('k');

    expect(setAgentDiffKept).not.toHaveBeenCalled();
  });
});
