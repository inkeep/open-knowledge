import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SingleFileModeProvider, useSingleFileMode } from './single-file-mode.tsx';

function Probe() {
  const singleFile = useSingleFileMode();
  return <div data-testid="probe">{singleFile ? 'single-file' : 'project'}</div>;
}

const originalDesktop = (globalThis as { window?: { okDesktop?: unknown } }).window?.okDesktop;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (typeof window !== 'undefined') {
    (window as { okDesktop?: unknown }).okDesktop = originalDesktop;
  }
});

describe('SingleFileModeProvider — desktop bridge channel', () => {
  beforeEach(() => {
    (window as { okDesktop?: unknown }).okDesktop = {
      config: {
        singleFile: true,
        initialDoc: 'todo',
        collabUrl: 'ws://x/collab',
        apiOrigin: 'http://x',
        mode: 'editor',
      },
      onProjectSwitched: () => () => {},
    };
  });

  test('reads singleFile synchronously from the bridge config (no fetch)', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(
      <SingleFileModeProvider>
        <Probe />
      </SingleFileModeProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('single-file');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('SingleFileModeProvider — browser /api/config channel', () => {
  beforeEach(() => {
    (window as { okDesktop?: unknown }).okDesktop = undefined;
  });

  test('resolves singleFile:true from /api/config', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          collabUrl: null,
          previewUrl: null,
          port: 0,
          singleFile: true,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    render(
      <SingleFileModeProvider>
        <Probe />
      </SingleFileModeProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('project');
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('single-file'));
  });

  test('stays project mode when /api/config reports singleFile:false', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          collabUrl: null,
          previewUrl: null,
          port: 0,
          singleFile: false,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    render(
      <SingleFileModeProvider>
        <Probe />
      </SingleFileModeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toBeTruthy());
    expect(screen.getByTestId('probe').textContent).toBe('project');
  });

  test('a /api/config error leaves project mode (no chrome stripped on a flaky endpoint)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    render(
      <SingleFileModeProvider>
        <Probe />
      </SingleFileModeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toBeTruthy());
    expect(screen.getByTestId('probe').textContent).toBe('project');
  });
});

describe('useSingleFileMode — outside a provider', () => {
  test('defaults to false (project mode) so chrome renders unchanged', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('project');
  });
});
