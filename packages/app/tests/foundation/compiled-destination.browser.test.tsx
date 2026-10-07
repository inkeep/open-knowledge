import { act, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { ChangedOutsideBadge } from '@/components/ChangedOutsideBadge';
import { useFindInViewer } from '@/hooks/use-find-in-viewer';
import { dynamicActivate } from '@/lib/activate-locale';
import { renderWithI18n } from './render-with-i18n.test-helper';

type FindState = ReturnType<typeof useFindInViewer>;

function FindProbe({ pass, seen }: { pass: number; seen: FindState[] }) {
  const rootRef = useRef<HTMLDivElement>(null);
  seen.push(useFindInViewer(rootRef));
  return (
    <div ref={rootRef} data-pass={pass}>
      <button type="button">inside the viewer</button>
    </div>
  );
}

describe('the compiled browser destination', () => {
  afterEach(async () => {
    await act(() => dynamicActivate('en'));
  });

  test('a product hook compiled by the React Compiler returns the same object across a re-render that leaves its state unchanged', () => {
    const seen: FindState[] = [];
    const view = render(<FindProbe pass={0} seen={seen} />);
    view.rerender(<FindProbe pass={1} seen={seen} />);

    expect(seen).toHaveLength(2);
    expect(seen[1]?.findOpen).toBe(false);
    expect(seen[1]).toBe(seen[0]);
  });

  test('Ctrl+F inside the viewer opens find, and the compiled hook then returns a new object carrying it', async () => {
    const seen: FindState[] = [];
    const view = render(<FindProbe pass={0} seen={seen} />);
    const before = seen.at(-1);

    await userEvent.click(view.getByRole('button', { name: 'inside the viewer' }));
    await userEvent.keyboard('{Control>}f{/Control}');

    const after = seen.at(-1);
    expect(after?.findOpen).toBe(true);
    expect(after).not.toBe(before);
  });

  test('a product component renders its string from the real English catalog and from the real Spanish catalog once Spanish activates', async () => {
    const view = renderWithI18n(<ChangedOutsideBadge testId="changed-outside" />);
    const badge = view.getByTestId('changed-outside');
    expect(badge.textContent).toBe('changed outside');

    await act(() => dynamicActivate('es'));

    expect(badge.textContent).toBe('modificado fuera');
  });

  test('production CSS lays the component out in the real engine', () => {
    const view = renderWithI18n(<ChangedOutsideBadge testId="changed-outside" />);
    const badge = view.getByTestId('changed-outside');

    expect(getComputedStyle(badge).display).toBe('inline-flex');
    expect(badge.getBoundingClientRect().height).toBe(20);
  });
});
