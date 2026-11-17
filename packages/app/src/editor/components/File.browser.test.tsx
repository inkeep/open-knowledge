import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { File } from './File';

const API_ORIGIN = 'http://127.0.0.1:4100';

afterEach(() => {
  (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
  vi.restoreAllMocks();
  cleanup();
});

function installBridge(openAsset: (relPath: string) => Promise<{ ok: true }>) {
  (window as unknown as { okDesktop?: unknown }).okDesktop = {
    config: { apiOrigin: API_ORIGIN },
    shell: { openAsset },
  };
}

describe('File attachment chip in the desktop app', () => {
  test('a click or middle-click opens a project file through okDesktop.shell.openAsset, not a new window', async () => {
    const openAsset = vi.fn(async (_relPath: string) => ({ ok: true }) as const);
    const openWindow = vi.spyOn(window, 'open').mockReturnValue(null);
    installBridge(openAsset);

    render(<File src="/notes/quarterly%20report.pdf" />);
    const chip = await screen.findByRole('link', { name: /quarterly report\.pdf/ });
    const clickProceeded = chip.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
    );
    const middleClickProceeded = chip.dispatchEvent(
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }),
    );

    expect(openAsset.mock.calls).toEqual([
      ['notes/quarterly report.pdf'],
      ['notes/quarterly report.pdf'],
    ]);
    expect(openWindow).not.toHaveBeenCalled();
    expect({ clickProceeded, middleClickProceeded }).toEqual({
      clickProceeded: false,
      middleClickProceeded: false,
    });
  });

  test('a middle-click on a chip whose address is not a project file keeps the browser default', async () => {
    const openAsset = vi.fn(async (_relPath: string) => ({ ok: true }) as const);
    const openWindow = vi.spyOn(window, 'open').mockReturnValue(null);
    installBridge(openAsset);

    render(<File src="https://example.com/report.pdf" name="Remote report" />);
    const chip = await screen.findByRole('link', { name: /Remote report/ });
    const middleClickProceeded = chip.dispatchEvent(
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }),
    );

    expect(middleClickProceeded).toBe(true);
    expect(openWindow).not.toHaveBeenCalled();
    expect(openAsset).not.toHaveBeenCalled();
  });

  test('a chip whose address is not a project file keeps opening as a new-tab request', async () => {
    const openAsset = vi.fn(async (_relPath: string) => ({ ok: true }) as const);
    const openWindow = vi.spyOn(window, 'open').mockReturnValue(null);
    installBridge(openAsset);

    render(<File src="https://example.com/report.pdf" name="Remote report" />);
    (await screen.findByRole('link', { name: /Remote report/ })).click();

    expect(openWindow).toHaveBeenCalledWith(
      'https://example.com/report.pdf',
      '_blank',
      'noopener,noreferrer',
    );
    expect(openAsset).not.toHaveBeenCalled();
  });
});

describe('File attachment chip in a browser', () => {
  test('a middle-click keeps the browser default and opens no window itself', async () => {
    const openWindow = vi.spyOn(window, 'open').mockReturnValue(null);

    render(<File src="/notes/quarterly%20report.pdf" />);
    const chip = await screen.findByRole('link', { name: /quarterly report\.pdf/ });
    const middleClickProceeded = chip.dispatchEvent(
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }),
    );

    expect(middleClickProceeded).toBe(true);
    expect(openWindow).not.toHaveBeenCalled();
  });
});
