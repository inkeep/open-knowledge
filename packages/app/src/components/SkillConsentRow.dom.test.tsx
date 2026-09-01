import { fireEvent, render, screen } from '@testing-library/react';
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
    expect(screen.queryByLabelText('Claude')).toBeNull();
  });

  test('never renders a token-cost line', () => {
    renderRow();
    expect(screen.queryByTestId('skill-cost-value')).toBeNull();
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
