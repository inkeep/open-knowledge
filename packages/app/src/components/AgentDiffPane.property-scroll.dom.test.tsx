/**
 * RTL mount test: the agent diff pane's scroll-to-first-change on a write that
 * touched only frontmatter.
 *
 * The defect this guards: the scroll effect used to key off a non-empty body
 * diff, so the one case where the property block is the entire change — the
 * case the block exists for — never scrolled. The rows rendered above the fold
 * of a long document and the pane opened parked at the top.
 *
 * Stubbed seams: the burst-diff fetch, and `scrollIntoView` (jsdom has no
 * layout; the preload leaves a no-op on the prototype, spied on here).
 *
 * Invocation: `pnpm run test:dom` from `packages/app/`.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/use-activity-panel', () => ({
  fetchAgentBurstDiff: () =>
    Promise.resolve({
      // Body identical on both sides: the whole change is in the frontmatter.
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
    // The scroll waits out a 120ms DOM-settle debounce plus a double rAF.
    await waitFor(
      () => expect(scrolled.some((el) => el.hasAttribute('data-property-change'))).toBe(true),
      { timeout: 3000 },
    );
  });
});
