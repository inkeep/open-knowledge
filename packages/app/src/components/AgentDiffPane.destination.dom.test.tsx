// @vitest-environment jsdom

import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

let releasePresent: (() => void) | undefined;

const fetchAgentBurstDiff = vi.fn((agentId: string) => {
  if (agentId === 'missing') return Promise.reject(new Error('burst diff unavailable'));
  return new Promise((resolve) => {
    releasePresent = () =>
      resolve({
        diff: '',
        before: 'base line\n',
        after: 'present line\n',
        properties: { changes: [], unparseable: null },
      });
  });
});

vi.doMock('@/lib/use-activity-panel', () => ({ fetchAgentBurstDiff }));

vi.doMock('@/components/RenderedDiffView', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/components/RenderedDiffView')>();
  return {
    ...mod,
    computeRenderedDiff: () => ({ ok: false as const }),
    RenderedDiffView: () => null,
  };
});

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: (s: string) => s }),
}));

const { AgentDiffPane } = await import('@/components/AgentDiffPane');
const { TooltipProvider } = await import('@/components/ui/tooltip');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  releasePresent = undefined;
});

describe('AgentDiffPane destination settlement', () => {
  test('a failed selection does not settle the next selection as failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onDestinationComplete = vi.fn();
    const onDestinationFailed = vi.fn();
    const pane = (agentId: string) => (
      <TooltipProvider>
        <AgentDiffPane
          view={{
            agentId,
            agentName: 'Agent',
            agentColor: '#888888',
            docName: 'notes',
            keptCount: 1,
            maxVersions: 3,
          }}
          isPanelCollapsed={false}
          onTogglePanel={() => {}}
          onDestinationComplete={onDestinationComplete}
          onDestinationFailed={onDestinationFailed}
        />
      </TooltipProvider>
    );

    const { rerender } = render(pane('missing'));
    await waitFor(() => expect(onDestinationFailed).toHaveBeenCalledTimes(1));

    rerender(pane('present'));
    await waitFor(() => expect(releasePresent).toBeDefined());
    expect(onDestinationFailed).toHaveBeenCalledTimes(1);
    releasePresent?.();

    await waitFor(() => expect(onDestinationComplete).toHaveBeenCalledTimes(1));
    expect(onDestinationFailed).toHaveBeenCalledTimes(1);
  });
});
