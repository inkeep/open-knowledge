import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useInstalledClis } from './use-installed-clis';

function Probe() {
  const map = useInstalledClis();
  return <div data-testid="map" data-map={JSON.stringify(map)} />;
}

function readMap(): Record<string, boolean> {
  return JSON.parse(screen.getByTestId('map').getAttribute('data-map') ?? '{}');
}

function setBridge(bridge: unknown) {
  (window as { okDesktop?: unknown }).okDesktop = bridge;
}

describe('useInstalledClis', () => {
  afterEach(() => {
    cleanup();
    delete (window as { okDesktop?: unknown }).okDesktop;
  });

  test('capability guard: no terminal surface → empty map, never throws', async () => {
    setBridge({});
    render(<Probe />);
    await act(async () => {});
    expect(readMap()).toEqual({});
  });

  test('capability guard: no desktop bridge at all (web host) → empty map', async () => {
    delete (window as { okDesktop?: unknown }).okDesktop;
    render(<Probe />);
    await act(async () => {});
    expect(readMap()).toEqual({});
  });

  test('success: the resolved installed map surfaces', async () => {
    setBridge({
      terminal: {
        cliInstalledMap: async () => ({
          claude: true,
          codex: false,
          opencode: false,
          cursor: true,
        }),
      },
    });
    render(<Probe />);
    await act(async () => {});
    expect(readMap()).toEqual({ claude: true, codex: false, opencode: false, cursor: true });
  });

  test('degradation: a rejected probe leaves the map empty and warns', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setBridge({
      terminal: {
        cliInstalledMap: async () => {
          throw new Error('probe failed');
        },
      },
    });
    render(<Probe />);
    await act(async () => {});
    expect(readMap()).toEqual({});
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
