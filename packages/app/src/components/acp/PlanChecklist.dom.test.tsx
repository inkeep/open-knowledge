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
