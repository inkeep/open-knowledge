import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const toastInfoCalls: string[] = [];

import * as actualLinguiMacro from '@lingui/react/macro';

vi.doMock('sonner', () => ({
  toast: {
    info: (msg: string) => {
      toastInfoCalls.push(msg);
    },
    success: () => {},
    error: () => {},
    warn: () => {},
  },
}));

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  useLingui: () => ({
    t: (strings: TemplateStringsArray) => strings.join(''),
  }),
}));

const { useNoPushPermissionToast } = await import('./use-no-push-permission-toast');

function TestComponent({
  initial,
  next,
}: {
  initial: string | undefined;
  next: string | undefined;
}) {
  const [reason, setReason] = useState<string | undefined>(initial);
  useNoPushPermissionToast(reason);
  return (
    <button type="button" data-testid="advance" onClick={() => setReason(next)}>
      advance
    </button>
  );
}

describe('useNoPushPermissionToast', () => {
  beforeEach(() => {
    toastInfoCalls.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  test('fires a single info toast on first render when pausedReason is already no-push-permission', () => {
    render(<TestComponent initial="no-push-permission" next={undefined} />);
    expect(toastInfoCalls).toEqual([
      "Sync paused — you don't have permission to push to this repo",
    ]);
  });

  test('does NOT fire on first render when pausedReason is undefined', () => {
    render(<TestComponent initial={undefined} next={undefined} />);
    expect(toastInfoCalls).toEqual([]);
  });

  test('does NOT fire on first render for an unrelated pausedReason', () => {
    render(<TestComponent initial="protected-branch" next={undefined} />);
    expect(toastInfoCalls).toEqual([]);
  });

  test('fires on the leading-edge transition undefined → no-push-permission', () => {
    const { getByTestId } = render(<TestComponent initial={undefined} next="no-push-permission" />);
    expect(toastInfoCalls).toEqual([]);
    act(() => {
      fireEvent.click(getByTestId('advance'));
    });
    expect(toastInfoCalls).toEqual([
      "Sync paused — you don't have permission to push to this repo",
    ]);
  });

  test('repeated re-renders with the same pausedReason do not re-fire the toast', () => {
    const { getByTestId } = render(<TestComponent initial={undefined} next="no-push-permission" />);
    act(() => {
      fireEvent.click(getByTestId('advance'));
    });
    act(() => {
      fireEvent.click(getByTestId('advance'));
    });
    act(() => {
      fireEvent.click(getByTestId('advance'));
    });
    expect(toastInfoCalls).toEqual([
      "Sync paused — you don't have permission to push to this repo",
    ]);
  });

  test('a fresh hook mount (new component instance) gets its own one-shot guard', () => {
    const first = render(<TestComponent initial="no-push-permission" next={undefined} />);
    first.unmount();
    expect(toastInfoCalls).toEqual([
      "Sync paused — you don't have permission to push to this repo",
    ]);

    render(<TestComponent initial="no-push-permission" next={undefined} />);
    expect(toastInfoCalls).toEqual([
      "Sync paused — you don't have permission to push to this repo",
      "Sync paused — you don't have permission to push to this repo",
    ]);
  });
});
