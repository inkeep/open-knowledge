import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ShareTargetStatusResponse } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { pendingReceiveNavStore } from '@/lib/share/pending-receive-nav-store';

// The changed-locally cell's "Enable auto-sync" CTA enables in place via the
// project-local config binding (through useSyncEnabledWriter). Capture the
// writes so the guarded off → on flow is assertable without a live binding.
// Mocked at the module boundary so the dynamic import below picks it up.
let autoSyncWrites: boolean[] = [];
mock.module('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    projectLocalBinding: {
      patch: (value: { autoSync?: { enabled?: boolean } }) => {
        if (value.autoSync?.enabled !== undefined) autoSyncWrites.push(value.autoSync.enabled);
        return { ok: true };
      },
    },
  }),
}));

const { ShareReceiveMissPanel } = await import('./ShareReceiveMissPanel');

type FetchTargetStatus = (req: {
  projectPath: string;
  branch: string;
  path: string;
  kind: 'doc' | 'folder';
}) => Promise<ShareTargetStatusResponse | null>;

function installBridge(fetchTargetStatus: FetchTargetStatus): void {
  (window as { okDesktop?: unknown }).okDesktop = {
    config: { projectPath: '/project' },
    project: { fetchTargetStatus },
  };
}

function stubVerdict(response: ShareTargetStatusResponse | null): FetchTargetStatus {
  return () => Promise.resolve(response);
}

const DOC_NAV = { kind: 'doc' as const, path: 'notes/plan', branch: 'feature' };

async function renderResolved(nav: typeof DOC_NAV = DOC_NAV): Promise<HTMLElement> {
  render(<ShareReceiveMissPanel nav={nav} />);
  const panel = await screen.findByTestId('share-receive-miss-panel');
  // Wait for the fetch to resolve out of the pending phase.
  await screen.findByText((_, el) => el?.getAttribute('data-phase') === 'resolved');
  return panel;
}

beforeEach(() => {
  cleanup();
  window.location.hash = '';
  pendingReceiveNavStore.clear();
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'okDesktop');
  window.location.hash = '';
  pendingReceiveNavStore.clear();
  autoSyncWrites = [];
});

describe('ShareReceiveMissPanel verdict surfaces', () => {
  test('renamed verdict offers to open the redirect target', async () => {
    installBridge(stubVerdict({ verdict: 'renamed', renamedTo: 'knowledge/new-plan' }));
    const panel = await renderResolved();

    expect(panel.getAttribute('data-verdict')).toBe('renamed');
    expect(panel.textContent).toContain('moved to');
    expect(panel.textContent).toContain('knowledge/new-plan');
    expect(screen.getByTestId('share-receive-miss-open-renamed')).toBeTruthy();
    expect(screen.getByTestId('share-receive-miss-browse')).toBeTruthy();
  });

  test('accepting the rename navigates to the redirect and re-arms the miss guard', async () => {
    installBridge(stubVerdict({ verdict: 'renamed', renamedTo: 'knowledge/new-plan' }));
    await renderResolved();

    fireEvent.click(screen.getByTestId('share-receive-miss-open-renamed'));

    expect(window.location.hash).toBe('#/knowledge/new-plan');
    // Re-armed so the redirect target, if also missing locally, renders the
    // panel again rather than the create-mode editor.
    expect(pendingReceiveNavStore.getSnapshot()).toEqual({
      kind: 'doc',
      path: 'knowledge/new-plan',
      branch: 'feature',
    });
  });

  // The verdict fetch must query the real repo file — a stripped docName makes
  // git report `never-on-branch` for every `.md` share miss regardless of cause.
  test('the verdict fetch preserves the share target file extension', async () => {
    let captured: { path: string; branch: string; kind: string } | null = null;
    installBridge((req) => {
      captured = { path: req.path, branch: req.branch, kind: req.kind };
      return Promise.resolve({ verdict: 'deleted' });
    });
    await renderResolved({ kind: 'doc', path: 'docs/moved.md', branch: 'main' });

    expect(captured).toEqual({ path: 'docs/moved.md', branch: 'main', kind: 'doc' });
  });

  test('deleted verdict shows an honest removed message with a browse escape', async () => {
    installBridge(stubVerdict({ verdict: 'deleted' }));
    const panel = await renderResolved();

    expect(panel.getAttribute('data-verdict')).toBe('deleted');
    expect(panel.textContent).toContain('was removed from branch');
    expect(panel.textContent).toContain('feature');
    expect(screen.queryByTestId('share-receive-miss-open-renamed')).toBeNull();
    expect(screen.getByTestId('share-receive-miss-browse')).toBeTruthy();
  });

  // A path that never existed on the branch must never be messaged as "removed".
  test('never-on-branch verdict is not messaged as removed', async () => {
    installBridge(stubVerdict({ verdict: 'never-on-branch' }));
    const panel = await renderResolved();

    expect(panel.getAttribute('data-verdict')).toBe('never-on-branch');
    expect(panel.textContent).toContain("isn't on branch");
    expect(panel.textContent).toContain('may not have been pushed yet');
    expect(panel.textContent).not.toContain('was removed');
  });

  test('on-origin verdict shows the stale-local pull guidance', async () => {
    installBridge(stubVerdict({ verdict: 'on-origin' }));
    const panel = await renderResolved();

    expect(panel.getAttribute('data-verdict')).toBe('on-origin');
    expect(panel.textContent).toContain('is behind');
    expect(panel.textContent).toContain('Pull the latest changes');
  });

  // A local uncommitted change (rm/mv of the target the receiver never synced)
  // is NOT "behind — pull"; it gets its own honest copy plus an in-place
  // Enable auto-sync recovery CTA (the guarded off → on flow).
  test('changed-locally verdict shows the local-change message and enables auto-sync in place', async () => {
    installBridge(stubVerdict({ verdict: 'changed-locally' }));
    const panel = await renderResolved();

    expect(panel.getAttribute('data-verdict')).toBe('changed-locally');
    expect(panel.textContent).toContain('has been moved, renamed, or deleted');
    expect(panel.textContent).not.toContain('Pull the latest changes');
    expect(screen.getByTestId('share-receive-miss-browse')).toBeTruthy();

    // The CTA opens the off → on confirmation gate; nothing is written until the
    // user confirms, and confirming enables auto-sync in place (no navigation).
    fireEvent.click(screen.getByTestId('share-receive-miss-enable-sync'));
    const dialog = screen.getByRole('dialog');
    expect(autoSyncWrites).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enable auto-sync' }));
    expect(autoSyncWrites).toEqual([true]);
    // The in-tab surface has no modal to close, so a successful enable clears it
    // by navigating to the parent folder (DOC_NAV path 'notes/plan' → 'notes').
    expect(window.location.hash).toBe('#/notes/');
  });

  // Fail-open (Pattern B): a transport failure surfaces as `null` from the proxy;
  // the panel degrades to today's pull guidance, never a stuck spinner or throw.
  test('a failed target-status fetch falls back to pull guidance', async () => {
    installBridge(stubVerdict(null));
    const panel = await renderResolved();

    expect(panel.getAttribute('data-verdict')).toBe('unknown');
    expect(panel.textContent).toContain('Pull the latest changes');
  });

  test('a rejected target-status fetch falls back to pull guidance', async () => {
    installBridge(() => Promise.reject(new Error('ipc closed')));
    const panel = await renderResolved();

    expect(panel.getAttribute('data-verdict')).toBe('unknown');
    expect(panel.textContent).toContain('Pull the latest changes');
  });

  test('no desktop bridge (web host) falls back to pull guidance without fetching', async () => {
    Reflect.deleteProperty(window, 'okDesktop');
    const panel = await renderResolved();

    expect(panel.getAttribute('data-verdict')).toBe('unknown');
    expect(panel.textContent).toContain('Pull the latest changes');
  });

  test('the browse-folder escape navigates to the parent folder view', async () => {
    installBridge(stubVerdict({ verdict: 'deleted' }));
    await renderResolved();

    fireEvent.click(screen.getByTestId('share-receive-miss-browse'));
    expect(window.location.hash).toBe('#/notes/');
  });

  test('folder-share copy substitutes the folder noun', async () => {
    installBridge(stubVerdict({ verdict: 'deleted' }));
    const panel = await renderResolved({ kind: 'folder', path: 'knowledge', branch: 'feature' });

    expect(panel.textContent).toContain('folder');
  });

  // A11y: the terminal surface is a status region and its icon is decorative —
  // the message text (not color) carries the meaning, and controls have names.
  test('exposes an accessible status region with a decorative icon', async () => {
    installBridge(stubVerdict({ verdict: 'deleted' }));
    const panel = await renderResolved();

    expect(panel.getAttribute('role')).toBe('status');
    expect(panel.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByTestId('share-receive-miss-browse').textContent).toContain('Browse folder');
  });

  test('moves focus to the primary action when the verdict resolves', async () => {
    installBridge(stubVerdict({ verdict: 'renamed', renamedTo: 'knowledge/new-plan' }));
    await renderResolved();
    // The rename redirect is the primary action; keyboard users land on it.
    expect(document.activeElement).toBe(screen.getByTestId('share-receive-miss-open-renamed'));
  });
});
