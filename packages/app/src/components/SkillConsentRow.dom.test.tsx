/**
 * RTL tests for the shared built-in-skill row (Settings + first launch). They
 * assert the truthful trio: the skill's own description, its reach through the
 * existing agent-icon cluster (including a custom-root path shown verbatim, and
 * the zero-hosts copy that replaces the cluster), and the compact cost subset
 * (always-on + on-trigger only, never a sum). The reach cluster runs for real —
 * only the Lingui macros are shimmed to their English passthrough.
 */
import type { SkillCostTiers } from '@inkeep/open-knowledge-core';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import * as linguiShim from '../../tests/lingui-macro-shim';

vi.doMock('@lingui/react/macro', () => linguiShim);

const { SkillConsentRow } = await import('./SkillConsentRow');

function renderRow(props: Partial<Parameters<typeof SkillConsentRow>[0]> = {}) {
  return render(
    <TooltipProvider>
      <SkillConsentRow
        name="open-knowledge-discovery"
        description="Helps your agent recognize OpenKnowledge projects."
        hosts={['claude', 'cursor']}
        {...props}
      />
    </TooltipProvider>,
  );
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('SkillConsentRow', () => {
  test('shows the skill name and its own frontmatter description', () => {
    renderRow();
    expect(screen.getByText('open-knowledge-discovery')).toBeTruthy();
    expect(screen.getByText('Helps your agent recognize OpenKnowledge projects.')).toBeTruthy();
  });

  test('renders reach through the agent-icon cluster with each host labeled', () => {
    renderRow({ hosts: ['claude', 'cursor'] });
    expect(screen.getByLabelText('Claude')).toBeTruthy();
    expect(screen.getByLabelText('Cursor')).toBeTruthy();
    expect(screen.queryByTestId('skill-consent-row-no-hosts')).toBeNull();
  });

  test('a custom-root host renders as a mark whose accessible name is the path verbatim', () => {
    renderRow({ hosts: ['claude', '/Users/me/.myagent/skills'] });
    expect(screen.getByLabelText('/Users/me/.myagent/skills')).toBeTruthy();
  });

  test('with zero hosts the cluster is replaced by explanatory copy', () => {
    renderRow({ hosts: [] });
    expect(screen.getByTestId('skill-consent-row-no-hosts')).toBeTruthy();
    // No agent marks at all — nothing claims a reach that does not exist.
    expect(screen.queryByLabelText('Claude')).toBeNull();
  });

  test('the cost line shows the always-on and on-trigger subset, never on-demand or a sum', () => {
    const size: SkillCostTiers = { alwaysOn: 156, onTrigger: 3218, onDemand: 916 };
    renderRow({ size });
    const cost = screen.getByTestId('skill-cost-value');
    const text = cost.textContent ?? '';
    expect(text).toContain('~156');
    expect(text).toContain('always-on');
    expect(text).toContain('~3.2k');
    expect(text).toContain('on trigger');
    // On-demand is omitted from the compact row — not folded into another tier.
    expect(text).not.toContain('on demand');
    expect(text).not.toContain('~916');
  });

  test('no cost line when size is absent', () => {
    renderRow({ size: undefined });
    expect(screen.queryByTestId('skill-cost-value')).toBeNull();
  });

  test('marks a tier over its published budget without touching the reach marks', () => {
    const size: SkillCostTiers = { alwaysOn: 250, onTrigger: 6000, onDemand: 0 };
    renderRow({ size });
    // Both shown tiers are over budget; each carries an accessible over-budget
    // reason. Scoped to the cost value so cluster icons can't skew the count.
    const marks = within(screen.getByTestId('skill-cost-value')).getAllByRole('img');
    expect(marks).toHaveLength(2);
    for (const mark of marks) {
      expect(mark.getAttribute('aria-label')).toMatch(/over the .* token budget/);
    }
  });

  test('the body is a preview affordance that fires onActivate', () => {
    const onActivate = vi.fn();
    renderRow({ onActivate });
    fireEvent.click(screen.getByTestId('skill-consent-row-preview'));
    expect(onActivate).toHaveBeenCalledOnce();
  });

  test('renders a surface-supplied control', () => {
    renderRow({ control: <span data-testid="stub-control">install</span> });
    expect(screen.getByTestId('stub-control')).toBeTruthy();
  });
});
