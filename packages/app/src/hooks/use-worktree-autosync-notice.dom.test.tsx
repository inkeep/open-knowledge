import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import { useWorktreeAutoSyncNotice } from './use-worktree-autosync-notice';

const toast = mock((_node: unknown) => {});
mock.module('sonner', () => ({ toast }));

let ctx: {
  projectLocalConfig: unknown;
  projectLocalSynced: boolean;
  projectLocalBinding: { patch: ReturnType<typeof mock> } | null;
};
mock.module('@/lib/config-provider', () => ({ useConfigContext: () => ctx }));

function Probe() {
  useWorktreeAutoSyncNotice();
  return null;
}

const patch = mock(() => ({ ok: true }));

beforeEach(() => {
  cleanup();
  toast.mockClear();
  patch.mockClear();
  ctx = { projectLocalConfig: null, projectLocalSynced: true, projectLocalBinding: { patch } };
});

describe('useWorktreeAutoSyncNotice', () => {
  test('fires one toast for an inherited worktree and clears the flag', async () => {
    ctx.projectLocalConfig = {
      autoSync: { enabled: true, inheritedNoticePending: true, inheritedFrom: 'my-repo' },
    };
    render(<Probe />);
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    // Clears the one-shot flag so it never repeats.
    expect(patch).toHaveBeenCalledWith({ autoSync: { inheritedNoticePending: null } });
  });

  test('does nothing when the flag is not set', () => {
    ctx.projectLocalConfig = { autoSync: { enabled: true } };
    render(<Probe />);
    expect(toast).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  test('waits for the project-local binding to sync before firing', () => {
    ctx.projectLocalSynced = false;
    ctx.projectLocalConfig = {
      autoSync: { enabled: false, inheritedNoticePending: true, inheritedFrom: 'my-repo' },
    };
    render(<Probe />);
    expect(toast).not.toHaveBeenCalled();
  });
});
