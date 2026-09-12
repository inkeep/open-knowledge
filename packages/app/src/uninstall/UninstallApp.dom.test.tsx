import type {
  OkUninstallBridge,
  UninstallDispatchResult,
  UninstallScreenSpec,
} from '@inkeep/open-knowledge-core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { UninstallApp } from './UninstallApp';

function stubBridge(ready: () => Promise<UninstallDispatchResult>): void {
  window.okUninstall = {
    ready,
    send: (): Promise<UninstallDispatchResult> => Promise.resolve({ kind: 'accepted' }),
  } satisfies OkUninstallBridge;
}

const sendsScreen = (spec: UninstallScreenSpec) => (): Promise<UninstallDispatchResult> =>
  Promise.resolve({ kind: 'screen', screen: spec });

describe('UninstallApp routing', () => {
  afterEach(() => {
    cleanup();
    window.okUninstall = undefined;
  });

  test('mounts the picker for a picker screen', async () => {
    stubBridge(sendsScreen({ kind: 'picker', projects: [] }));
    render(<UninstallApp />);
    expect(await screen.findByRole('heading', { name: 'Uninstall OpenKnowledge?' })).toBeDefined();
  });

  test('mounts the survey for a survey screen', async () => {
    stubBridge(sendsScreen({ kind: 'survey' }));
    render(<UninstallApp />);
    expect(await screen.findByText('Before you go, mind sharing why?')).toBeDefined();
  });

  test('mounts the progress screen for a progress screen', async () => {
    stubBridge(sendsScreen({ kind: 'progress' }));
    render(<UninstallApp />);
    expect(
      await screen.findByRole('heading', { name: 'Removing OpenKnowledge files…' }),
    ).toBeDefined();
  });

  test('keeps progress mounted until cleanup supplies a result, then replaces it', async () => {
    let complete = false;
    const send = vi.fn(async (): Promise<UninstallDispatchResult> => ({ kind: 'accepted' }));
    window.okUninstall = {
      ready: async () => ({
        kind: 'screen',
        screen: complete
          ? {
              kind: 'notice',
              notice: {
                title: 'Cleanup didn’t finish',
                paragraphs: ['State retained.'],
                confirmLabel: 'Close',
              },
            }
          : { kind: 'progress', awaitResult: true },
      }),
      send,
    };
    render(<UninstallApp />);
    expect(await screen.findByRole('status')).toBeDefined();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ kind: 'progress-shown' }));
    expect(screen.queryByText('State retained.')).toBeNull();
    complete = true;
    expect(await screen.findByText('State retained.')).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('mounts a notice for a notice screen', async () => {
    stubBridge(
      sendsScreen({
        kind: 'notice',
        notice: { title: 'All done', paragraphs: ['Cleanup finished.'], confirmLabel: 'Close' },
      }),
    );
    render(<UninstallApp />);
    expect(await screen.findByText('Cleanup finished.')).toBeDefined();
  });

  test('shows a terminal notice when main refuses', async () => {
    stubBridge(() => Promise.resolve({ kind: 'refused', reason: 'unknown-window' }));
    render(<UninstallApp />);
    expect(await screen.findByText('Unable to show the cleanup result')).toBeDefined();
  });

  test('shows a terminal notice when the ready invoke rejects', async () => {
    stubBridge(() => Promise.reject(new Error('ipc channel closed')));
    render(<UninstallApp />);
    expect(await screen.findByText('Unable to show the cleanup result')).toBeDefined();
  });
});

test('a failed progress bridge becomes dismissible without claiming cleanup finished', async () => {
  const close = vi.spyOn(window, 'close').mockImplementation(() => {});
  const ready = vi
    .fn<() => Promise<UninstallDispatchResult>>()
    .mockResolvedValueOnce({ kind: 'screen', screen: { kind: 'progress', awaitResult: true } })
    .mockResolvedValue({ kind: 'refused', reason: 'unknown-window' });
  stubBridge(ready);
  try {
    render(<UninstallApp />);
    expect(await screen.findByText('Unable to show the cleanup result')).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(close).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    close.mockRestore();
    window.okUninstall = undefined;
  }
});

test('a progress result wait has a deadline even while main keeps answering progress', async () => {
  vi.useFakeTimers();
  stubBridge(sendsScreen({ kind: 'progress', awaitResult: true }));
  try {
    await act(async () => {
      render(<UninstallApp />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(screen.getByText('Unable to show the cleanup result')).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();
  } finally {
    cleanup();
    window.okUninstall = undefined;
    vi.useRealTimers();
  }
});

test('does not poll a progress window that will be closed by the original app', async () => {
  vi.useFakeTimers();
  const ready = vi.fn(sendsScreen({ kind: 'progress' }));
  stubBridge(ready);
  try {
    await act(async () => {
      render(<UninstallApp />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(ready).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    window.okUninstall = undefined;
    vi.useRealTimers();
  }
});

test('a transient progress timeout retries and still displays the completed result', async () => {
  vi.useFakeTimers();
  const ready = vi
    .fn<() => Promise<UninstallDispatchResult>>()
    .mockResolvedValueOnce({ kind: 'screen', screen: { kind: 'progress', awaitResult: true } })
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValue({ kind: 'screen', screen: { kind: 'result', outcome: 'success' } });
  stubBridge(ready);
  try {
    await act(async () => {
      render(<UninstallApp />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(screen.getByRole('heading', { name: 'OpenKnowledge files were removed' })).toBeDefined();
    expect(screen.queryByText('Unable to show the cleanup result')).toBeNull();
  } finally {
    cleanup();
    window.okUninstall = undefined;
    vi.useRealTimers();
  }
});

test('an unavailable result does not instruct the user to use a missing log action', async () => {
  stubBridge(() => Promise.resolve({ kind: 'refused', reason: 'unknown-window' }));
  try {
    render(<UninstallApp />);
    expect(await screen.findByText('Cleanup may still be running.')).toBeDefined();
    expect(screen.queryByText(/Check the cleanup log/)).toBeNull();
  } finally {
    cleanup();
    window.okUninstall = undefined;
  }
});

test('successful progress responses reset the transient failure budget', async () => {
  vi.useFakeTimers();
  const progress: UninstallDispatchResult = {
    kind: 'screen',
    screen: { kind: 'progress', awaitResult: true },
  };
  const ready = vi
    .fn<() => Promise<UninstallDispatchResult>>()
    .mockResolvedValueOnce(progress)
    .mockRejectedValueOnce(new Error('temporary'))
    .mockRejectedValueOnce(new Error('temporary'))
    .mockResolvedValueOnce(progress)
    .mockRejectedValueOnce(new Error('temporary'))
    .mockRejectedValueOnce(new Error('temporary'))
    .mockResolvedValue({ kind: 'screen', screen: { kind: 'result', outcome: 'success' } });
  stubBridge(ready);
  try {
    await act(async () => {
      render(<UninstallApp />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole('heading', { name: 'OpenKnowledge files were removed' })).toBeDefined();
  } finally {
    cleanup();
    window.okUninstall = undefined;
    vi.useRealTimers();
  }
});

test('a missing bridge is terminal immediately', async () => {
  window.okUninstall = undefined;
  try {
    await act(async () => {
      render(<UninstallApp />);
    });
    expect(screen.getByText('Unable to show the cleanup result')).toBeDefined();
  } finally {
    cleanup();
  }
});

test('three consecutive progress failures stop polling', async () => {
  vi.useFakeTimers();
  const ready = vi
    .fn<() => Promise<UninstallDispatchResult>>()
    .mockResolvedValueOnce({ kind: 'screen', screen: { kind: 'progress', awaitResult: true } })
    .mockRejectedValue(new Error('channel unavailable'));
  stubBridge(ready);
  try {
    await act(async () => {
      render(<UninstallApp />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText('Unable to show the cleanup result')).toBeDefined();
    expect(ready).toHaveBeenCalledTimes(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(ready).toHaveBeenCalledTimes(4);
  } finally {
    cleanup();
    window.okUninstall = undefined;
    vi.useRealTimers();
  }
});

test('an unexpected protocol response is terminal without retrying', async () => {
  const ready = vi
    .fn<() => Promise<UninstallDispatchResult>>()
    .mockResolvedValue({ kind: 'accepted' });
  stubBridge(ready);
  try {
    await act(async () => {
      render(<UninstallApp />);
    });
    expect(screen.getByText('Unable to show the cleanup result')).toBeDefined();
    expect(ready).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    window.okUninstall = undefined;
  }
});
