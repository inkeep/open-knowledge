/**
 * Behavioral tests for `useNoPushPermissionToast` — the one-time toast hook.
 *
 * Mounts the hook through a trivial test component and observes the mocked
 * Sonner toast spy across renders to verify:
 *   - The toast fires on the leading-edge transition into `'no-push-permission'`.
 *   - It does NOT fire on subsequent updates carrying the same reason.
 *   - It does NOT fire for other `pausedReason` values.
 *   - It does NOT fire when the hook mounts with `undefined`.
 *
 * Substrate: jsdom via `bun run test:dom`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';

// Spy on the toast surface. Pre-import-mock — sets up before the hook
// module evaluates its `import { toast } from 'sonner'`.
const toastInfoCalls: string[] = [];
mock.module('sonner', () => ({
  toast: {
    info: (msg: string) => {
      toastInfoCalls.push(msg);
    },
    success: () => {},
    error: () => {},
    warn: () => {},
  },
}));

// `useLingui` macro reaches for an i18n context the DOM test harness doesn't
// provide. Stub the macro so `t\`...\`` evaluates to the literal English
// (the macro normally compiles the template into a `t(...)` call wrapping
// the source string + a hash; the stub keeps things readable in assertions).
mock.module('@lingui/react/macro', () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray) => strings.join(''),
  }),
}));

const { useNoPushPermissionToast } = await import('./use-no-push-permission-toast');

// Minimal test harness: a button that flips `pausedReason` between two
// supplied values on click. Lets each test drive the controlled prop the
// hook reads without re-importing React internals.
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
    // The harness's button click sets `reason` to the same `next` value
    // repeatedly. React's setState short-circuits on Object.is equality
    // so subsequent clicks don't re-render — but the useEffect dep list
    // includes pausedReason, so even if React DID re-render the effect
    // body would re-check the dedup ref. Either way: only the first
    // leading-edge transition produces a toast. (A true "transition
    // away and back" within one session would need a richer harness;
    // the dedup-ref invariant — set once, never cleared — makes that
    // case structurally equivalent to repeated-same-value.)
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
    // The dedup ref is per-mount, so each new EditorPane lifecycle gets a
    // fresh shot. (Production has one EditorPane per project session — so
    // "one toast per session" is satisfied.)
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
