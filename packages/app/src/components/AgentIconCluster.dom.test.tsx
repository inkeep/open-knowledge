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
    expect(screen.getByLabelText('Claude')).toBeTruthy();
    expect(screen.getByLabelText('Cursor')).toBeTruthy();
  });

  test('the .agents hub mark reads ".agents", not the raw id', () => {
    renderCluster(['agents']);
    expect(screen.getByLabelText('.agents')).toBeTruthy();
  });

  test('more than the cap collapses the remainder into "+N"', () => {
    renderCluster(['claude', 'cursor', 'codex', 'opencode']);
    expect(screen.getByText('+2')).toBeTruthy();
  });

  test('at or below the cap shows no overflow', () => {
    renderCluster(['claude', 'cursor']);
    expect(screen.queryByText(/^\+\d/)).toBeNull();
  });
});
