import { cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const toastNodes: ReactNode[] = [];
const toast = vi.fn((node: ReactNode) => {
  toastNodes.push(node);
});
vi.doMock('sonner', () => ({ toast }));

import * as actualLinguiMacro from '@lingui/react/macro';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

let ctx: {
  projectLocalConfig: unknown;
  projectLocalSynced: boolean;
  projectLocalBinding: { patch: ReturnType<typeof mock> } | null;
};
vi.doMock('@/lib/config-provider', () => ({ useConfigContext: () => ctx }));

// Import the hook AFTER the mocks register so it binds to the mocked
// config-provider / sonner rather than the real modules.
const { useWorktreeAutoSyncNotice } = await import('./use-worktree-autosync-notice');

function Probe() {
  useWorktreeAutoSyncNotice();
  return null;
}

/** Render the most recent captured toast node and read its text. */
function lastToastText(): string {
  const node = toastNodes[toastNodes.length - 1];
  const { container } = render(node);
  return container.textContent ?? '';
}

const patch = vi.fn(() => ({ ok: true }));

beforeEach(() => {
  cleanup();
  toast.mockClear();
  patch.mockClear();
  toastNodes.length = 0;
  ctx = { projectLocalConfig: null, projectLocalSynced: true, projectLocalBinding: { patch } };
});

describe('useWorktreeAutoSyncNotice', () => {
  test('fires one toast for an inherited worktree and clears the flag', async () => {
    ctx.projectLocalConfig = {
      autoSync: { mode: 'full', inheritedNoticePending: true, inheritedFrom: 'my-repo' },
    };
    render(<Probe />);
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    // Clears the one-shot flag so it never repeats.
    expect(patch).toHaveBeenCalledWith({ autoSync: { inheritedNoticePending: null } });
  });

  test('phrases the notice for an inherited pull-only worktree', async () => {
    ctx.projectLocalConfig = {
      autoSync: { mode: 'follow', inheritedNoticePending: true, inheritedFrom: 'my-repo' },
    };
    render(<Probe />);
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(lastToastText()).toContain('Follow is on for this worktree, inherited from my-repo');
  });

  test('phrases the notice for an inherited off worktree via the legacy enabled seed', async () => {
    ctx.projectLocalConfig = {
      autoSync: { enabled: false, inheritedNoticePending: true, inheritedFrom: 'my-repo' },
    };
    render(<Probe />);
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(lastToastText()).toContain('Auto-sync is off for this worktree');
  });

  test('does nothing when the flag is not set', () => {
    ctx.projectLocalConfig = { autoSync: { mode: 'full' } };
    render(<Probe />);
    expect(toast).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  test('waits for the project-local binding to sync before firing', () => {
    ctx.projectLocalSynced = false;
    ctx.projectLocalConfig = {
      autoSync: { mode: 'off', inheritedNoticePending: true, inheritedFrom: 'my-repo' },
    };
    render(<Probe />);
    expect(toast).not.toHaveBeenCalled();
  });
});
