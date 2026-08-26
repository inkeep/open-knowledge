import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { PlanChecklist } from './PlanChecklist';

const p = (content: string, status?: string) => ({ content, status });

describe('PlanChecklist', () => {
  afterEach(cleanup);

  test('starts collapsed — the toggle reads `Plan (0/3)`, no list visible', () => {
    const { queryByTestId, getByTestId, container } = render(
      <PlanChecklist plan={[p('one'), p('two'), p('three')]} />,
    );
    const toggle = getByTestId('agent-thread-plan-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(queryByTestId('agent-thread-plan-list')).toBeNull();
    expect(container.textContent).toContain('Plan (0/3)');
  });

  test('clicking the toggle expands then collapses — aria-expanded and list mount both track', () => {
    const { queryByTestId, getByTestId } = render(
      <PlanChecklist plan={[p('one'), p('two', 'completed'), p('three')]} />,
    );
    const toggle = getByTestId('agent-thread-plan-toggle');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const list = getByTestId('agent-thread-plan-list');
    expect(list.querySelectorAll('li')).toHaveLength(3);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(queryByTestId('agent-thread-plan-list')).toBeNull();
  });

  test('expanded state survives a plan-prop update — stream ticks do not close the drawer', () => {
    const initial = [p('one'), p('two'), p('three')];
    const { getByTestId, queryByTestId, rerender } = render(<PlanChecklist plan={initial} />);
    const toggle = getByTestId('agent-thread-plan-toggle');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    const next = [p('one', 'completed'), p('two'), p('three')];
    rerender(<PlanChecklist plan={next} />);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(queryByTestId('agent-thread-plan-list')).not.toBeNull();
    expect(toggle.textContent).toContain('Plan (1/3)');
  });

  describe('approval row (PRD-8022)', () => {
    const handlers = {
      onApprove: () => {},
      onAskChanges: () => {},
      onReject: () => {},
    };

    test('hidden without approval, hidden when every item is completed', () => {
      // No approval prop: buttons hidden.
      const a = render(<PlanChecklist plan={[p('one')]} />);
      expect(a.queryByTestId('agent-thread-plan-approval')).toBeNull();
      cleanup();
      // approval prop but all items completed: nothing to approve.
      const c = render(<PlanChecklist plan={[p('one', 'completed')]} approval={handlers} />);
      expect(c.queryByTestId('agent-thread-plan-approval')).toBeNull();
    });

    test('shown when approval provided and at least one item is pending, with all three buttons', () => {
      const { getByTestId } = render(
        <PlanChecklist
          plan={[p('one'), p('two', 'in_progress'), p('three', 'completed')]}
          approval={handlers}
        />,
      );
      expect(getByTestId('agent-thread-plan-approval')).not.toBeNull();
      expect(getByTestId('agent-thread-plan-approval-approve')).not.toBeNull();
      expect(getByTestId('agent-thread-plan-approval-ask-changes')).not.toBeNull();
      expect(getByTestId('agent-thread-plan-approval-reject')).not.toBeNull();
    });

    test('Ask changes label carries a trailing ellipsis to signal further input', () => {
      const { getByTestId } = render(<PlanChecklist plan={[p('one')]} approval={handlers} />);
      expect(getByTestId('agent-thread-plan-approval-ask-changes').textContent).toBe(
        'Ask changes…',
      );
    });

    test('each button fires its own handler exactly once', () => {
      let approve = 0;
      let ask = 0;
      let reject = 0;
      const { getByTestId } = render(
        <PlanChecklist
          plan={[p('one')]}
          approval={{
            onApprove: () => {
              approve += 1;
            },
            onAskChanges: () => {
              ask += 1;
            },
            onReject: () => {
              reject += 1;
            },
          }}
        />,
      );
      fireEvent.click(getByTestId('agent-thread-plan-approval-approve'));
      fireEvent.click(getByTestId('agent-thread-plan-approval-ask-changes'));
      fireEvent.click(getByTestId('agent-thread-plan-approval-reject'));
      expect(approve).toBe(1);
      expect(ask).toBe(1);
      expect(reject).toBe(1);
    });

    test('the approval row auto-expands the checklist so the user sees what they are approving', () => {
      // Approving a plan whose items are hidden trains click-through — the
      // component opens itself the first time the approval buttons appear.
      const { getByTestId } = render(<PlanChecklist plan={[p('one')]} approval={handlers} />);
      expect(getByTestId('agent-thread-plan-toggle').getAttribute('aria-expanded')).toBe('true');
      expect(getByTestId('agent-thread-plan-list')).not.toBeNull();
      expect(getByTestId('agent-thread-plan-approval')).not.toBeNull();
    });
  });

  test('completed entries render with a checked glyph and line-through', () => {
    const { getByTestId } = render(
      <PlanChecklist plan={[p('one'), p('two', 'completed'), p('three')]} />,
    );
    fireEvent.click(getByTestId('agent-thread-plan-toggle'));
    const items = getByTestId('agent-thread-plan-list').querySelectorAll('li');
    expect(items[0]?.textContent).toContain('☐');
    expect(items[1]?.textContent).toContain('☑');
    expect(items[1]?.className).toContain('line-through');
    expect(items[2]?.textContent).toContain('☐');
  });
});
