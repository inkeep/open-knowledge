import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import type { SharingMode } from './SharingModeField';

vi.doMock('@lingui/core/macro', () => ({ ...actualLinguiMacro, msg: renderLinguiTemplate }));

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

const { SharingModeField } = await import('./SharingModeField');

/** Controlled wrapper so clicks actually move the selection. */
function Harness({
  initial = 'shared',
  disabled = false,
}: {
  initial?: SharingMode;
  disabled?: boolean;
}) {
  const [value, setValue] = useState<SharingMode>(initial);
  return (
    <SharingModeField
      idPrefix="t"
      testIdPrefix="t-sharing"
      value={value}
      onValueChange={setValue}
      disabled={disabled}
    />
  );
}

describe('SharingModeField', () => {
  afterEach(cleanup);

  test('renders both cards as a radiogroup with Shared selected by default', () => {
    render(<Harness />);

    expect(screen.getByRole('radiogroup')).not.toBeNull();
    const shared = screen.getByTestId('t-sharing-shared');
    const local = screen.getByTestId('t-sharing-local-only');
    expect(shared.getAttribute('role')).toBe('radio');
    expect(local.getAttribute('role')).toBe('radio');
    expect(shared.getAttribute('aria-checked')).toBe('true');
    expect(local.getAttribute('aria-checked')).toBe('false');
  });

  test('"Only me" leads the pair in DOM order', async () => {
    // The default is Only me, so it reads first. DOM order is also the tab and
    // screen-reader order, and the visual order via the two-column grid, so
    // asserting it here pins the invariant one place.
    render(<Harness />);

    const radios = screen.getAllByRole('radio');
    expect(radios[0]).toBe(screen.getByTestId('t-sharing-local-only'));
    expect(radios[1]).toBe(screen.getByTestId('t-sharing-shared'));
  });

  test('clicking Local only moves the selection', async () => {
    render(<Harness />);

    await userEvent.click(screen.getByTestId('t-sharing-local-only'));

    expect(screen.getByTestId('t-sharing-local-only').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('t-sharing-shared').getAttribute('aria-checked')).toBe('false');
  });

  test('disabled disables both options (whole-group busy state)', () => {
    render(<Harness disabled />);

    expect(screen.getByTestId('t-sharing-shared').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('t-sharing-local-only').hasAttribute('disabled')).toBe(true);
  });

  test('exposes the config-sharing info tooltip trigger next to the legend', () => {
    render(<Harness />);

    expect(screen.getByTestId('config-sharing-info')).not.toBeNull();
  });

  test('renders the sharing docs link outside the radiogroup accessible name', () => {
    render(<Harness />);

    const link = screen.getByTestId('t-sharing-docs-link');
    // Config sharing, NOT docs/features/share — that page is the Share-links
    // feature (doc deep links), which does not explain this choice at all.
    expect(link.getAttribute('href')).toBe(
      'https://openknowledge.ai/docs/reference/what-open-knowledge-writes',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    // A screen reader's links list enumerates links with no surrounding
    // context, so the accessible name has to name the destination. It still
    // contains the visible text, per WCAG 2.5.3 Label in Name.
    const accessibleName = link.getAttribute('aria-label') ?? '';
    expect(accessibleName).toBe('Learn more about config sharing');
    expect(accessibleName).toContain(link.textContent ?? '');
    // The radiogroup's name comes from aria-labelledby → the label span only;
    // the link lives outside both the labelled span and the radiogroup, so
    // its text can't leak into the group's accessible name.
    const group = screen.getByRole('radiogroup');
    const labelId = group.getAttribute('aria-labelledby') ?? '';
    const label = document.getElementById(labelId);
    expect(label?.textContent).toBe('Share this setup with your team?');
    expect(label?.contains(link)).toBe(false);
    expect(group.contains(link)).toBe(false);
  });
});
