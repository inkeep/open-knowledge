import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import { type SharingMode, SharingModeField } from './SharingModeField';

mock.module('@lingui/core/macro', () => ({
  msg: renderLinguiTemplate,
}));

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

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
});
