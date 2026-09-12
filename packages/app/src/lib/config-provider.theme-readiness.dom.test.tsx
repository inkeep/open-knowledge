import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ConfigProvider } from './config-provider';
import { TRANSITION_ATTRIBUTE, TRANSITION_STYLE_ID } from './theme-color-transitions';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute(TRANSITION_ATTRIBUTE);
  document.getElementById(TRANSITION_STYLE_ID)?.remove();
});

test('registers and arms colors only after pending collaboration resolution settles', async () => {
  const registerProperty = vi.fn();
  vi.stubGlobal('CSS', { registerProperty });
  const view = render(
    <ConfigProvider collabUrl={null}>
      <span>Pending</span>
    </ConfigProvider>,
  );
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  expect(registerProperty).not.toHaveBeenCalled();
  expect(document.documentElement.hasAttribute(TRANSITION_ATTRIBUTE)).toBe(false);
  view.rerender(
    <ConfigProvider collabUrl={null} collabTerminal>
      <span>Offline</span>
    </ConfigProvider>,
  );
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  expect(registerProperty).toHaveBeenCalled();
  expect(document.documentElement.hasAttribute(TRANSITION_ATTRIBUTE)).toBe(true);
});
