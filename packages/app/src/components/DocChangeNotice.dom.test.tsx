import type { DocNoticeWire } from '@inkeep/open-knowledge-core/schemas/api';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { subscribeToDocPanelTabRequests } from '@/components/doc-panel-events';
import { DocNoticesProvider } from '@/hooks/use-doc-notices';
import { emitDocumentsChanged } from '@/lib/documents-events';
import { SingleFileModeProvider } from '@/lib/single-file-mode';
import { DocChangeNotice } from './DocChangeNotice';

const AT = '2026-10-20T12:00:00.000Z';
const NO_BLOCKS = { duplicated: 0, restoredDeletedHere: 0, restoredDeletedOutside: 0 };

const WRITTEN = ['b'.repeat(40), 'c'.repeat(40)];

function bothKept(
  id: string,
  docName: string,
  kept = { ...NO_BLOCKS, duplicated: 1 },
  entries: string[] = WRITTEN,
) {
  return {
    id,
    docName,
    file: `${docName}.md`,
    kind: 'both-kept',
    kept,
    firstAt: AT,
    lastAt: AT,
    events: 1,
    entries,
  } satisfies DocNoticeWire;
}

function moved(id: string, docName: string, side: 'ours' | 'theirs') {
  return {
    id,
    docName,
    file: `${docName}.md`,
    kind: 'moved-to-history',
    side,
    reason: 'check-failed',
    firstAt: AT,
    lastAt: AT,
    events: 1,
    entries: ['a'.repeat(40)],
  } satisfies DocNoticeWire;
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

function renderNotice(docName: string, timelineAvailable = true) {
  return render(
    <SingleFileModeProvider>
      <DocNoticesProvider>
        <div data-editor-region="" tabIndex={-1} data-testid="editor-region">
          <DocChangeNotice docName={docName} timelineAvailable={timelineAvailable} />
        </div>
      </DocNoticesProvider>
    </SingleFileModeProvider>,
  );
}

async function findNotice(): Promise<HTMLElement> {
  return screen.findByRole('region', { name: 'File change notice' });
}

describe('DocChangeNotice', () => {
  test('a both-kept merge shows a notice naming the file, with no choice between versions', async () => {
    serverNotices = [bothKept('n-both', 'notes')];
    renderNotice('notes');

    const notice = await findNotice();
    expect(notice.textContent).toContain('Both versions were kept in notes.md.');
    expect(notice.textContent).toContain('the outside version is directly under this one');
    expect(
      within(notice)
        .getAllByRole('button')
        .map((button) => button.textContent || button.getAttribute('aria-label')),
    ).toEqual(['Open timeline', 'Dismiss notice']);
  });

  test('each case says what happened in its own words', async () => {
    const cases: Array<{ notice: DocNoticeWire; says: string }> = [
      {
        notice: bothKept('n-restored', 'folder/plan', { ...NO_BLOCKS, restoredDeletedHere: 1 }),
        says: 'A deletion in plan.md was undone because the same text was changed on the other side. The earlier versions are in the timeline.',
      },
      {
        notice: moved('n-theirs', 'folder/plan', 'theirs'),
        says: 'An outside change to plan.md could not be merged, so this version stayed. The outside version is in the timeline.',
      },
      {
        notice: moved('n-ours', 'folder/plan', 'ours'),
        says: "Edits to plan.md kept from the last time this branch was open could not be merged, so the file's version stayed.",
      },
    ];
    for (const { notice, says } of cases) {
      serverNotices = [notice];
      renderNotice('folder/plan');
      expect((await findNotice()).textContent).toContain(says);
      cleanup();
    }
  });

  test('a document with no notice shows nothing but keeps an empty status region ready', async () => {
    serverNotices = [bothKept('n-other', 'other')];
    renderNotice('notes');

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'File change notice' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  test('Dismiss removes the notice and tells the server which notice it was', async () => {
    serverNotices = [bothKept('n-dismiss', 'notes')];
    renderNotice('notes');

    fireEvent.click(within(await findNotice()).getByRole('button', { name: 'Dismiss notice' }));

    expect(screen.queryByRole('region', { name: 'File change notice' })).toBeNull();
    await waitFor(() => expect(dismissBodies).toEqual([{ docName: 'notes', id: 'n-dismiss' }]));
  });

  test('Escape inside the notice dismisses it and puts focus back on the editor, not the page', async () => {
    serverNotices = [bothKept('n-escape', 'notes')];
    renderNotice('notes');
    const dismiss = within(await findNotice()).getByRole('button', { name: 'Dismiss notice' });
    dismiss.focus();

    fireEvent.keyDown(dismiss, { key: 'Escape' });

    expect(screen.queryByRole('region', { name: 'File change notice' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('editor-region')));
  });

  test('Open timeline asks the document panel for its timeline tab', async () => {
    serverNotices = [moved('n-open', 'notes', 'theirs')];
    const requests: unknown[] = [];
    const unsubscribe = subscribeToDocPanelTabRequests((tab, request) =>
      requests.push({ tab, focus: request.focus }),
    );
    renderNotice('notes');

    fireEvent.click(within(await findNotice()).getByRole('button', { name: 'Open timeline' }));

    expect(requests).toEqual([{ tab: 'timeline', focus: 'panel' }]);
    expect(screen.getByRole('region', { name: 'File change notice' })).toBeTruthy();
    unsubscribe();
  });

  test('where there is no timeline to open, the notice offers only Dismiss and does not send the person there', async () => {
    const expectNoTimeline = async (says: string) => {
      const notice = await findNotice();
      expect(within(notice).queryByRole('button', { name: 'Open timeline' })).toBeNull();
      expect(notice.textContent).toContain(says);
      expect(notice.textContent).not.toContain('timeline');
      await waitFor(() => expect(screen.getByRole('status').textContent).toContain(says));
    };
    serverNotices = [moved('n-no-timeline', 'notes', 'theirs')];
    renderNotice('notes', false);
    await expectNoTimeline("The outside version was saved to the document's history.");
    cleanup();

    serverNotices = [
      moved('n-single-file', 'notes', 'ours'),
      bothKept('n-single-both', 'plan', NO_BLOCKS),
    ];
    const desktop = window.okDesktop;
    window.okDesktop = { config: { singleFile: true } } as never;
    try {
      renderNotice('notes');
      await expectNoTimeline("Those edits were saved to the document's history.");
      cleanup();
      renderNotice('plan');
      await expectNoTimeline("The earlier versions were saved to the document's history.");
    } finally {
      window.okDesktop = desktop;
    }
  });

  test('when no history entry was written, the notice claims none and offers no Open timeline', async () => {
    serverNotices = [
      bothKept('n-unsaved-restored', 'notes', { ...NO_BLOCKS, restoredDeletedOutside: 1 }, []),
      bothKept('n-unsaved-both', 'plan', undefined, []),
    ];
    renderNotice('notes');
    const restored = await findNotice();
    expect(restored.textContent).toContain(
      'A deletion in notes.md was undone because the same text was changed on the other side.',
    );
    expect(restored.textContent).not.toContain('timeline');
    expect(
      within(restored)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Dismiss notice']);
    cleanup();

    renderNotice('plan');
    const both = await findNotice();
    expect(both.textContent).toContain('Both versions were kept in plan.md.');
    expect(within(both).queryByRole('button', { name: 'Open timeline' })).toBeNull();
  });

  test('a notice for an .mdx document names the .mdx file', async () => {
    serverNotices = [{ ...bothKept('n-mdx', 'guides/intro'), file: 'guides/intro.mdx' }];
    renderNotice('guides/intro');

    expect((await findNotice()).textContent).toContain('Both versions were kept in intro.mdx.');
  });

  test('a notice is announced once; an update to it is not announced again, a new notice is', async () => {
    serverNotices = [bothKept('n-announce', 'notes')];
    renderNotice('notes');
    const status = screen.getByRole('status');
    await waitFor(() =>
      expect(status.textContent).toContain('Both versions were kept in notes.md.'),
    );

    serverNotices = [{ ...moved('n-announce', 'notes', 'theirs'), events: 2 }];
    act(() => emitDocumentsChanged(['sync-status']));
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'File change notice' }).textContent).toContain(
        'could not be merged',
      ),
    );
    expect(status.textContent).toContain('Both versions were kept in notes.md.');

    serverNotices = [moved('n-announce-next', 'notes', 'theirs')];
    act(() => emitDocumentsChanged(['sync-status']));
    await waitFor(() => expect(status.textContent).toContain('could not be merged'));
  });

  test('coming back to a document whose notice was already announced does not announce it again', async () => {
    serverNotices = [bothKept('n-first', 'notes'), moved('n-second', 'plan', 'theirs')];
    const view = render(
      <DocNoticesProvider>
        <DocChangeNotice docName="notes" timelineAvailable />
      </DocNoticesProvider>,
    );
    const status = screen.getByRole('status');
    await waitFor(() =>
      expect(status.textContent).toContain('Both versions were kept in notes.md.'),
    );

    for (const docName of ['plan', 'notes']) {
      view.rerender(
        <DocNoticesProvider>
          <DocChangeNotice docName={docName} timelineAvailable />
        </DocNoticesProvider>,
      );
      await findNotice();
    }

    expect(status.textContent).toContain('An outside change to plan.md could not be merged');
  });
});
