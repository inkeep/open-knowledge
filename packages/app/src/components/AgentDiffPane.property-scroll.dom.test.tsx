import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/use-activity-panel', () => ({
  fetchAgentBurstDiff: () =>
    Promise.resolve({
      diff: '',
      before: 'Same body.\n',
      after: 'Same body.\n',
      properties: {
        changes: [{ key: 'status', kind: 'changed', before: 'draft', after: 'ready' }],
        unparseable: null,
      },
    }),
}));

import { TooltipProvider } from '@/components/ui/tooltip';

const { AgentDiffPane } = await import('./AgentDiffPane');

const view = {
  agentId: 'agent-1',
  agentName: 'Agent',
  agentColor: '#888888',
  docName: 'notes',
  keptCount: 1,
  maxVersions: 3,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AgentDiffPane — property-only scroll', () => {
  test('scrolls to the property row when the body diff is empty', async () => {
    const scrolled: HTMLElement[] = [];
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (
      this: HTMLElement,
    ) {
      scrolled.push(this);
    });

    render(
      <TooltipProvider>
        <AgentDiffPane view={view} isPanelCollapsed={false} onTogglePanel={() => {}} />
      </TooltipProvider>,
    );

    await screen.findByTestId('property-diff-row');
    await waitFor(
      () => expect(scrolled.some((el) => el.hasAttribute('data-property-change'))).toBe(true),
      { timeout: 3000 },
    );
  });
});
