/**
 * the install-target brand marks must name themselves (they were
 * unidentifiable at rest) and the "+N" overflow must list the extra locations,
 * not be an opaque count. This asserts the label mapping + overflow slicing on
 * the rendered cluster (each shown icon carries its host label as an accessible
 * name; the "+N" reflects the remainder). The Radix Tooltip hover/portal itself
 * isn't exercised — jsdom can't, and the label wiring is the regression risk.
 * Runs under jsdom via `test:dom`.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentIconCluster } from './AgentIconCluster.tsx';

function renderCluster(hosts: string[]) {
  return render(
    <TooltipProvider>
      <AgentIconCluster hosts={hosts} />
    </TooltipProvider>,
  );
}

describe('AgentIconCluster — labeled marks + "+N" list (PRD-7606)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('each shown mark carries its host label as an accessible name', () => {
    renderCluster(['claude', 'cursor']);
    // Editor ids resolve to their display label (from EDITOR_LABELS).
    expect(screen.getByLabelText('Claude')).toBeTruthy();
    expect(screen.getByLabelText('Cursor')).toBeTruthy();
  });

  test('the .agents hub mark reads ".agents", not the raw id', () => {
    renderCluster(['agents']);
    expect(screen.getByLabelText('.agents')).toBeTruthy();
  });

  test('more than the cap collapses the remainder into "+N"', () => {
    // cap is 2 → 4 hosts leaves +2.
    renderCluster(['claude', 'cursor', 'codex', 'opencode']);
    expect(screen.getByText('+2')).toBeTruthy();
  });

  test('at or below the cap shows no overflow', () => {
    renderCluster(['claude', 'cursor']);
    expect(screen.queryByText(/^\+\d/)).toBeNull();
  });
});
