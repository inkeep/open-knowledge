import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { formatShortcut, formatShortcutLabel } from '@/lib/keyboard-shortcuts';
import {
  __resetLocalMenuActionBusForTests,
  subscribeLocalMenuAction,
} from '@/lib/local-menu-action-bus';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

class MockNavigationHistory extends EventTarget {
  canGoBack = false;
  canGoForward = false;
}

const navigationDescriptor = Object.getOwnPropertyDescriptor(window, 'navigation');

function setNavigationHistory(navigation: MockNavigationHistory): void {
  Object.defineProperty(window, 'navigation', {
    configurable: true,
    value: navigation,
  });
}

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${part}${values[index] ?? ''}`, ''),
  }),
}));

async function renderControls() {
  const { NavigationHistoryControls } = await import('./NavigationHistoryControls');
  return render(
    <TooltipProvider delayDuration={0}>
      <NavigationHistoryControls />
    </TooltipProvider>,
  );
}

describe('NavigationHistoryControls', () => {
  afterEach(() => {
    cleanup();
    __resetLocalMenuActionBusForTests();
    if (navigationDescriptor) {
      Object.defineProperty(window, 'navigation', navigationDescriptor);
    } else {
      Reflect.deleteProperty(window, 'navigation');
    }
  });

  test('exposes localized button names, hidden directional icons, and shortcut tooltips', async () => {
    const navigation = new MockNavigationHistory();
    navigation.canGoBack = true;
    navigation.canGoForward = true;
    setNavigationHistory(navigation);
    const user = userEvent.setup();
    await renderControls();

    const group = screen.getByRole('group', { name: 'Navigation history' });
    const back = screen.getByRole('button', { name: 'Back' });
    const forward = screen.getByRole('button', { name: 'Forward' });
    expect(group.getAttribute('data-slot')).toBe('button-group');
    expect(group.contains(back)).toBe(true);
    expect(group.contains(forward)).toBe(true);
    expect(back.getAttribute('data-variant')).toBe('ghost');
    expect(back.getAttribute('data-size')).toBe('icon-sm');
    expect(forward.getAttribute('data-variant')).toBe('ghost');
    expect(forward.getAttribute('data-size')).toBe('icon-sm');
    expect(back.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(forward.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    await user.hover(back);
    const backTooltip = await screen.findByRole('tooltip', {
      name: `Back ${formatShortcutLabel('navigate-back')}`,
    });
    expect(backTooltip.querySelector('[data-slot="kbd"]')?.textContent).toBe(
      formatShortcut('navigate-back'),
    );
    cleanup();
    await renderControls();
    const rerenderedForward = screen.getByRole('button', { name: 'Forward' });
    await user.hover(rerenderedForward);
    const forwardTooltip = await screen.findByRole('tooltip', {
      name: `Forward ${formatShortcutLabel('navigate-forward')}`,
    });
    expect(forwardTooltip.querySelector('[data-slot="kbd"]')?.textContent).toBe(
      formatShortcut('navigate-forward'),
    );
  });

  test('emits navigation actions and keeps the controls out of the drag region', async () => {
    const actions: string[] = [];
    const unsubscribe = subscribeLocalMenuAction((action) => actions.push(action));
    await renderControls();

    const root = screen.getByTestId('navigation-history-controls');
    const back = screen.getByRole('button', { name: 'Back' });
    const forward = screen.getByRole('button', { name: 'Forward' });
    expectVisualClassTokens(root.className, ['[-webkit-app-region:no-drag]']);
    expectVisualClassTokensAbsent(root.className, ['[-webkit-app-region:drag]']);

    fireEvent.click(back);
    fireEvent.click(forward);
    expect(actions).toEqual(['navigate-back', 'navigate-forward']);
    unsubscribe();
  });

  test('disables pointer interaction for unavailable directions and follows history changes', async () => {
    const navigation = new MockNavigationHistory();
    navigation.canGoForward = true;
    setNavigationHistory(navigation);
    const actions: string[] = [];
    const unsubscribe = subscribeLocalMenuAction((action) => actions.push(action));
    await renderControls();

    const back = screen.getByRole('button', { name: 'Back' });
    const forward = screen.getByRole('button', { name: 'Forward' });
    expect((back as HTMLButtonElement).disabled).toBe(true);
    expect((forward as HTMLButtonElement).disabled).toBe(false);
    expectVisualClassTokens(back.className, ['disabled:pointer-events-none']);
    expectVisualClassTokensAbsent(back.className, ['disabled:pointer-events-auto']);

    fireEvent.click(back);
    fireEvent.click(forward);
    expect(actions).toEqual(['navigate-forward']);

    act(() => {
      navigation.canGoBack = true;
      navigation.canGoForward = false;
      navigation.dispatchEvent(new Event('currententrychange'));
    });

    await waitFor(() => {
      expect((back as HTMLButtonElement).disabled).toBe(false);
      expect((forward as HTMLButtonElement).disabled).toBe(true);
    });
    unsubscribe();
  });
});
