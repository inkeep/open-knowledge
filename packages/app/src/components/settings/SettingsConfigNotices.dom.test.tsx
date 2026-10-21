import type { DocNoticeWire } from '@inkeep/open-knowledge-core/schemas/api';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DocNoticesProvider } from '@/hooks/use-doc-notices';
import { SingleFileModeProvider } from '@/lib/single-file-mode';
import { SettingsConfigNotices } from './SettingsConfigNotices';

const AT = '2026-10-20T12:00:00.000Z';

function settingsNotice(
  id: string,
  docName: string,
  file: string,
  side: 'ours' | 'theirs',
  reason: 'outside-settings-applied' | 'outside-settings-invalid',
): Extract<DocNoticeWire, { kind: 'moved-to-history' }> {
  return {
    id,
    docName,
    file,
    kind: 'moved-to-history',
    side,
    reason,
    firstAt: AT,
    lastAt: AT,
    events: 1,
    entries: ['a'.repeat(40)],
  };
}

let serverNotices: DocNoticeWire[] = [];
let dismissBodies: unknown[] = [];
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  serverNotices = [];
  dismissBodies = [];
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/doc-notices/dismiss') {
      const body = JSON.parse(String(init?.body)) as { id: string };
      dismissBodies.push(body);
      serverNotices = serverNotices.filter((notice) => notice.id !== body.id);
      return Promise.resolve(Response.json({ dismissed: true }));
    }
    if (url === '/api/doc-notices') {
      return Promise.resolve(Response.json({ notices: serverNotices }));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  }) as never;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

const onDismissFocus = vi.fn();

function renderSettingsNotices() {
  return render(
    <SingleFileModeProvider>
      <DocNoticesProvider>
        <SettingsConfigNotices onDismissFocus={onDismissFocus} />
      </DocNoticesProvider>
    </SingleFileModeProvider>,
  );
}

describe('SettingsConfigNotices', () => {
  test('shows the notice of each settings file that changed outside, with no timeline to open', async () => {
    serverNotices = [
      settingsNotice(
        'n-project',
        '__config__/project',
        '.ok/config.yml',
        'ours',
        'outside-settings-applied',
      ),
      settingsNotice(
        'n-ignore',
        '__config__/okignore',
        '.okignore',
        'theirs',
        'outside-settings-invalid',
      ),
    ];
    renderSettingsNotices();

    const notices = await screen.findAllByRole('region', { name: 'File change notice' });
    expect(notices.map((notice) => notice.textContent)).toEqual([
      expect.stringContaining(
        "Settings in .ok/config.yml changed outside OpenKnowledge and now apply. A copy of the change you were making was kept in this project's history, which the app cannot show yet.",
      ),
      expect.stringContaining(
        "An outside change to .okignore was not valid settings, so your settings stayed. A copy of the outside version was kept in this project's history, which the app cannot show yet.",
      ),
    ]);
    expect(screen.queryByRole('button', { name: 'Open timeline' })).toBeNull();
  });

  test('names each settings file by its path, so the shared and the per-machine config.yml differ, and says where a backup went', async () => {
    serverNotices = [
      settingsNotice(
        'n-project',
        '__config__/project',
        '.ok/config.yml',
        'ours',
        'outside-settings-applied',
      ),
      {
        ...settingsNotice(
          'n-local',
          '__local__/project',
          '.ok/local/config.yml',
          'theirs',
          'outside-settings-invalid',
        ),
        kind: 'moved-to-backup',
        entries: [],
        backup: '~/.ok/edit-backups/discarded/__local____project/2026-10-21T10-00-00-000Z.yml',
      },
    ];
    renderSettingsNotices();

    const notices = await screen.findAllByRole('region', { name: 'File change notice' });
    expect(notices.map((notice) => notice.textContent)).toEqual([
      expect.stringContaining('Settings in .ok/config.yml changed outside OpenKnowledge'),
      expect.stringContaining(
        'An outside change to .ok/local/config.yml was not valid settings, so your settings stayed. A copy of the outside version was saved to ~/.ok/edit-backups/discarded/__local____project/2026-10-21T10-00-00-000Z.yml.',
      ),
    ]);
  });

  test('ignores notices for documents that are not settings files', async () => {
    serverNotices = [
      settingsNotice('n-doc', 'notes/plan', 'notes/plan.md', 'theirs', 'outside-settings-invalid'),
    ];
    renderSettingsNotices();

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'File change notice' })).toBeNull();
  });

  test('Dismiss removes the notice and tells the server which one it was', async () => {
    serverNotices = [
      settingsNotice(
        'n-user',
        '__user__/config.yml',
        '~/.ok/config.yml',
        'ours',
        'outside-settings-applied',
      ),
    ];
    renderSettingsNotices();

    const notice = await screen.findByRole('region', { name: 'File change notice' });
    fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss notice' }));

    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'File change notice' })).toBeNull(),
    );
    expect(dismissBodies).toEqual([{ docName: '__user__/config.yml', id: 'n-user' }]);
  });
});
