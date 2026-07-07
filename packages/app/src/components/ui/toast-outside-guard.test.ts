import { describe, expect, mock, test } from 'bun:test';
import { ignoreToastInteractOutside } from './toast-outside-guard';

// The guard's only DOM touch is `event.target.closest('[data-sonner-toaster]')`,
// so a fake event with a stubbed `closest` exercises both branches without a DOM.
type GuardEvent = Parameters<ReturnType<typeof ignoreToastInteractOutside>>[0];

function makeEvent(insideToaster: boolean) {
  const preventDefault = mock(() => {});
  const event = {
    target: {
      closest: (selector: string) =>
        insideToaster && selector === '[data-sonner-toaster]' ? ({} as Element) : null,
    },
    preventDefault,
  } as unknown as GuardEvent;
  return { event, preventDefault };
}

describe('ignoreToastInteractOutside', () => {
  test('interaction inside the toaster is neutralized and does not reach the consumer', () => {
    const consumer = mock(() => {});
    const { event, preventDefault } = makeEvent(true);

    ignoreToastInteractOutside(consumer)(event);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(consumer).not.toHaveBeenCalled();
  });

  test('interaction outside the toaster falls through to the consumer untouched', () => {
    const consumer = mock(() => {});
    const { event, preventDefault } = makeEvent(false);

    ignoreToastInteractOutside(consumer)(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer).toHaveBeenCalledWith(event);
  });

  test('a toast interaction with no consumer still prevents dismissal without throwing', () => {
    const { event, preventDefault } = makeEvent(true);

    expect(() => ignoreToastInteractOutside()(event)).not.toThrow();
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  test('a non-toast interaction with no consumer is a no-op without throwing', () => {
    const { event, preventDefault } = makeEvent(false);

    expect(() => ignoreToastInteractOutside()(event)).not.toThrow();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
