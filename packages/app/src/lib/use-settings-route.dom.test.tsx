import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const realStartTransition = React.startTransition;
const startTransitionMock = vi.fn((callback: React.TransitionFunction) => {
  realStartTransition(callback);
});

vi.doMock('react', () => ({
  ...React,
  startTransition: startTransitionMock,
}));

describe('useSettingsRoute runtime routing', () => {
  afterEach(() => {
    cleanup();
    startTransitionMock.mockClear();
    window.history.replaceState(null, '', '/');
  });

  async function renderProbe() {
    const { useSettingsRoute } = await import('./use-settings-route');

    function Probe() {
      const route = useSettingsRoute();
      return <output data-testid="settings-open">{route.open ? 'open' : 'closed'}</output>;
    }

    render(<Probe />);
  }

  test('hashchange open-state update is scheduled through startTransition', async () => {
    window.location.hash = '';
    await renderProbe();
    expect(screen.getByTestId('settings-open').textContent).toBe('closed');

    window.history.pushState(null, '', '#settings');
    fireEvent(window, new Event('hashchange'));

    expect(startTransitionMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('settings-open').textContent).toBe('open');
  });

  test('a hash set after the first render but before the route subscribes still opens settings', async () => {
    window.history.replaceState(null, '', '/');
    const { useSettingsRoute } = await import('./use-settings-route');
    let hashSet = false;

    function Probe() {
      const route = useSettingsRoute();
      return <output data-testid="settings-open">{route.open ? 'open' : 'closed'}</output>;
    }
    function SetHashDuringRender() {
      if (!hashSet) {
        hashSet = true;
        window.history.replaceState(null, '', '#settings');
      }
      return null;
    }

    render(
      <>
        <Probe />
        <SetHashDuringRender />
      </>,
    );

    expect(await screen.findByText('open')).toBeTruthy();
  });
});
