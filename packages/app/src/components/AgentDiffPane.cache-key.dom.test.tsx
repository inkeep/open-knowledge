// @vitest-environment jsdom

import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const fetchAgentBurstDiff = vi.fn((agentId: string) =>
  Promise.resolve({
    diff: '',
    before: 'base line\n',
    after: `${agentId} line\n`,
    properties: { changes: [], unparseable: null },
  }),
);

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

function viewFor(agentId: string) {
  return {
    agentId,
    agentName: 'Agent',
    agentColor: '#888888',
    docName: 'notes',
    keptCount: 1,
    maxVersions: 3,
  };
}

function paneFor(agentId: string) {
  return (
    <TooltipProvider>
      <AgentDiffPane view={viewFor(agentId)} isPanelCollapsed={false} onTogglePanel={() => {}} />
    </TooltipProvider>
  );
}

afterEach(() => {
  cleanup();
  fetchAgentBurstDiff.mockClear();
});

describe('AgentDiffPane — version-diff cache key', () => {
  test('a second agent on the same document does not read the first agent cached diff', async () => {
    const { rerender } = render(paneFor('agent-1'));
    await waitFor(() => expect(fetchAgentBurstDiff).toHaveBeenCalledTimes(1));

    rerender(paneFor('agent-2'));
    await waitFor(() => expect(fetchAgentBurstDiff).toHaveBeenCalledTimes(2));

    expect(fetchAgentBurstDiff.mock.calls.map((call) => call[0])).toEqual(['agent-1', 'agent-2']);
  });
});
