import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { useColorThemeEpoch } from './color-theme-epoch';

function Probe() {
  const epoch = useColorThemeEpoch();
  return <div data-testid="epoch">{epoch}</div>;
}

function epochOf(view: ReturnType<typeof render>): number {
  return Number(view.getByTestId('epoch').textContent);
}

async function setColorThemeAndFlush(value: string): Promise<void> {
  await act(async () => {
    document.documentElement.setAttribute('data-color-theme', value);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('useColorThemeEpoch', () => {
  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute('data-color-theme');
  });

  test('bumps when the data-color-theme attribute changes', async () => {
    const view = render(<Probe />);
    const before = epochOf(view);
    await setColorThemeAndFlush('dracula');
    expect(epochOf(view)).toBeGreaterThan(before);
  });

  test('tears the observer down when all subscribers leave and re-creates it on remount', async () => {
    const first = render(<Probe />);
    await setColorThemeAndFlush('dracula');
    first.unmount();

    const second = render(<Probe />);
    const before = epochOf(second);
    await setColorThemeAndFlush('monokai');
    expect(epochOf(second)).toBeGreaterThan(before);
  });
});
