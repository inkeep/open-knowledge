/**
 * RTL behavioral tests for `DiffViewBoundary`.
 *
 * Pins:
 *   - Renders DiffView after the conflict-content fetch resolves (the
 *     network call uses `?source=ytext`).
 *   - Emits `editor-area-swap-to-diffview` / `editor-area-swap-from-diffview`
 *     structured log events on mount/unmount.
 *
 * Substrate: jsdom via `bun run test:dom`.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as Y from 'yjs';

// `sonner` toasts fire DOM portals; we don't need to render them here.
mock.module('sonner', () => ({
  toast: { error: () => {}, success: () => {}, info: () => {} },
}));

// `next-themes` is consumed by DiffView for the CM6 theme. Provide a no-op
// so the test mount doesn't require a ThemeProvider.
mock.module('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

// `subscribeToDocumentsChanged` is consumed by `useConflicts` (needed for the
// extension-aware file path lookup). The DOM tests don't need CC1 fan-out, so
// return a no-op unsubscriber.
mock.module('@/lib/documents-events', () => ({
  subscribeToDocumentsChanged: () => () => {},
}));

const { DiffViewBoundary } = await import('./DiffViewBoundary');

interface CapturedFetch {
  url: string;
  init?: RequestInit;
}

const fetchCalls: CapturedFetch[] = [];

function makeProvider(initialBody: string) {
  const doc = new Y.Doc();
  doc.getText('source').insert(0, initialBody);
  // Cast — DiffViewBoundary only uses provider.document, so a Y.Doc-bearing
  // stub is sufficient.
  return { document: doc } as unknown as Parameters<typeof DiffViewBoundary>[0]['provider'];
}

type ConflictKind = 'both-modified' | 'delete-modify' | 'modify-delete';

// Fetch stub for a single `foo.md` conflict of the given shape, capturing
// calls into the shared `fetchCalls`. `resolvePending`, when supplied, holds
// the resolve POST open so a test can observe in-flight button state.
function strategyFetch(kind: ConflictKind, resolvePending?: Promise<unknown>) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({ url, init });
    if (url === '/api/sync/conflicts') {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            conflicts: [{ file: 'foo.md', detectedAt: '2026-05-20T00:00:00.000Z' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    if (url.startsWith('/api/sync/conflict-content')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            file: 'foo.md',
            base: 'base content\n',
            ours: kind === 'delete-modify' ? '' : 'our modification\n',
            theirs: kind === 'modify-delete' ? '' : 'their modification\n',
            kind,
            lifecycleStatus: 'conflict',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    if (url === '/api/sync/resolve-conflict') {
      const ok = new Response('{}', { status: 200 });
      return resolvePending ? resolvePending.then(() => ok) : Promise.resolve(ok);
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
}

// Parse the captured resolve POST body so tests can assert the dispatched
// strategy — the button→strategy wiring is the data-loss-critical contract.
function lastResolveBody(): { file?: string; strategy?: string } {
  const call = fetchCalls.find((c) => c.url === '/api/sync/resolve-conflict');
  return JSON.parse(String(call?.init?.body ?? '{}'));
}

describe('DiffViewBoundary (Tier-3 mount)', () => {
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchCalls.length = 0;
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, init });
      // Default mock seeds the conflicts list with entries matching the
      // docNames used by the happy-path tests below. Tests that need to
      // exercise empty-conflicts (race window) or `.mdx` extension paths
      // override `globalThis.fetch` inside the test body.
      if (url === '/api/sync/conflicts') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              conflicts: [
                { file: 'docs/notes.md', detectedAt: '2026-05-20T00:00:00.000Z' },
                { file: 'logs/entry.md', detectedAt: '2026-05-20T00:00:00.000Z' },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.startsWith('/api/sync/conflict-content')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              file: 'docs/notes.md',
              base: '# Base\nbase paragraph\n',
              ours: '# Server-ours\nfrom-git-index\n', // deliberately differs from Y.Text below
              theirs: '# Theirs\nteam paragraph\n',
              lifecycleStatus: 'conflict',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url === '/api/sync/resolve-conflict') {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    };
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleWarnSpy.mockRestore();
  });

  test('fetches conflict-content with ?source=ytext and renders the diff', async () => {
    const provider = makeProvider('# My Y.Text bytes\nclient-side\n');
    render(<DiffViewBoundary docName="docs/notes" provider={provider} />);

    await waitFor(() => {
      const fetched = fetchCalls.find((c) => c.url.startsWith('/api/sync/conflict-content'));
      expect(fetched).toBeTruthy();
      expect(fetched?.url).toContain('source=ytext');
      expect(fetched?.url).toContain('file=docs%2Fnotes.md');
    });

    // After the fetch resolves, the diff view mounts (no error fallback).
    expect(screen.queryByText(/Couldn't load conflict content/i)).toBeNull();
  });

  test('emits editor-area-swap-to-diffview on mount and -from on unmount', async () => {
    const provider = makeProvider('seed\n');
    const { unmount } = render(<DiffViewBoundary docName="logs/entry" provider={provider} />);

    // swap-to fires synchronously inside the mount effect (post-commit).
    await waitFor(() => {
      const events = consoleWarnSpy.mock.calls.map((c) => c[0]);
      expect(
        events.some(
          (e: unknown) => typeof e === 'string' && e.includes('editor-area-swap-to-diffview'),
        ),
      ).toBe(true);
    });

    unmount();

    const eventsAfter = consoleWarnSpy.mock.calls.map((c) => c[0]);
    expect(
      eventsAfter.some(
        (e: unknown) => typeof e === 'string' && e.includes('editor-area-swap-from-diffview'),
      ),
    ).toBe(true);
  });

  // .mdx documents are also conflict-trackable. The wire-level file path
  // must reflect the on-disk extension — passing `.md` for an `.mdx` doc
  // produces a path mismatch against `/api/sync/conflicts`, which makes the
  // conflict-content fetch target a file that doesn't exist in the conflict
  // store.
  test('threads .mdx extension from useConflicts when the doc is .mdx', async () => {
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, init });
      if (url === '/api/sync/conflicts') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              conflicts: [{ file: 'docs/note.mdx', detectedAt: '2026-05-20T00:00:00.000Z' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.startsWith('/api/sync/conflict-content')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              file: 'docs/note.mdx',
              base: '',
              ours: '',
              theirs: '',
              lifecycleStatus: 'conflict',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url === '/api/sync/resolve-conflict') {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    };

    const provider = makeProvider('mdx body\n');
    render(<DiffViewBoundary docName="docs/note" provider={provider} />);

    // The conflict-content fetch must request the .mdx file path, NOT .md.
    await waitFor(() => {
      const fetched = fetchCalls.find((c) => c.url.startsWith('/api/sync/conflict-content'));
      expect(fetched?.url).toContain('file=docs%2Fnote.mdx');
    });
  });

  // When the conflict-content fetch fails (server 5xx, network outage,
  // wrong file path), DiffViewBoundary renders a visible error message and
  // hides the resolve action buttons. The structured warn log fires so
  // operators can correlate UI failures with server-side events.
  test('renders error fallback and hides actions when conflict-content fetch fails', async () => {
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, init });
      if (url === '/api/sync/conflicts') {
        // The conflicts list HAS our entry — the deferral lifts so the
        // conflict-content fetch fires. The failure being exercised is at
        // the conflict-content endpoint, not at the conflicts list.
        return Promise.resolve(
          new Response(
            JSON.stringify({
              conflicts: [{ file: 'docs/missing.md', detectedAt: '2026-05-20T00:00:00.000Z' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.startsWith('/api/sync/conflict-content')) {
        return Promise.resolve(new Response('not found', { status: 404 }));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    };

    const provider = makeProvider('# Anything\n');
    render(<DiffViewBoundary docName="docs/missing" provider={provider} />);

    // Error fallback text appears (mentions the file path).
    await screen.findByText(/Couldn't load conflict content for docs\/missing\.md/i);
    // Structured warn fires with the failure details so logs can pair with
    // the existing editor-area-swap-to/from events.
    const failureLog = consoleWarnSpy.mock.calls
      .map((c) => c[0])
      .find((e: unknown) => typeof e === 'string' && e.includes('conflict-content-fetch-failed'));
    expect(failureLog).toBeTruthy();
  });

  // Race window: lifecycle.status='conflict' propagates via CRDT faster than
  // the CC1 sync-status signal that triggers `useConflicts` to re-fetch.
  // DiffViewBoundary can mount while the conflicts list is still the
  // previous (empty) snapshot. Without deferral, an `.mdx` doc would fire
  // a wrong-extension `.md` request and flash the error fallback for the
  // ~100ms window until CC1 catches up. Pin the deferral: no
  // conflict-content fetch is issued while conflicts is empty.
  test('defers conflict-content fetch when conflicts list is empty (race window)', async () => {
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, init });
      if (url === '/api/sync/conflicts') {
        return Promise.resolve(
          new Response(JSON.stringify({ conflicts: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/sync/conflict-content')) {
        return Promise.resolve(
          new Response(JSON.stringify({ file: '', base: '', ours: '', theirs: '' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('', { status: 404 }));
    };

    const provider = makeProvider('# Anything\n');
    render(<DiffViewBoundary docName="docs/note" provider={provider} />);

    // Wait long enough that the initial conflicts fetch resolves and any
    // mount effects fire. With deferral active, the conflict-content fetch
    // must not have been issued during this window.
    await waitFor(() => {
      const conflictsFetch = fetchCalls.find((c) => c.url === '/api/sync/conflicts');
      expect(conflictsFetch).toBeTruthy();
    });
    // Loading copy stays on screen — the component shows "Loading conflict
    // for ..." until either conflicts repopulates (CC1) or the user reloads.
    expect(screen.queryByText(/Loading conflict for/i)).not.toBeNull();
    // Critical: NO conflict-content fetch was issued.
    const contentFetch = fetchCalls.find((c) => c.url.startsWith('/api/sync/conflict-content'));
    expect(contentFetch).toBeUndefined();
  });

  // ─── presence-aware render branching (delete-modify / modify-delete) ─
  // The UI has no escape hatch for missing-
  // stage conflicts: DiffViewBoundary unconditionally renders the unified
  // merge `DiffView` for every conflict shape. For DU (delete-modify), the
  // user has NO affordance to keep their deletion; for UD (modify-delete),
  // no affordance to accept theirs' deletion (the "reject all hunks + save"
  // path 500s with the misleading message).
  //
  // The fix carries a discriminator (`kind: 'delete-modify' |
  // 'modify-delete' | 'both-modified'`) from the server's
  // `/api/sync/conflict-content` response. DiffViewBoundary branches on
  // that field:
  //   - `delete-modify` → render "Keep deletion" + "Restore with remote
  //     changes" buttons (NOT the unified DiffView).
  //   - `modify-delete` → render "Keep my version" + "Accept their
  //     deletion" buttons.
  //   - `both-modified` → render the existing unified DiffView (regression-
  //     safe).
  //
  // Per UI primitives directive: the new
  // affordances MUST render via shadcn `<Button>` from `@/components/ui/*`
  // (the GritQL rule `no-raw-html-interactive-element.grit` enforces this
  // on the production code; the tests assert via role / accessible name).
  //
  // Tier choice: component (DOM) tier. The branching IS the UI contract;
  // a server-only integration test can't observe which DOM tree the user
  // sees. When the unit under test IS the UI component,
  // component tests replace unit tests.
  test('delete-modify (DU) renders Keep deletion + Restore affordances, not unified DiffView', async () => {
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, init });
      if (url === '/api/sync/conflicts') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              conflicts: [{ file: 'foo.md', detectedAt: '2026-05-20T00:00:00.000Z' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.startsWith('/api/sync/conflict-content')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              file: 'foo.md',
              base: 'base content\n',
              ours: '',
              theirs: 'their modification\n',
              lifecycleStatus: 'conflict',
              // The foundational-contract discriminator. Today the schema
              // omits this; the response shape is just {ours, theirs,
              // base, lifecycleStatus} and the UI can't tell DU from a
              // modify/modify where ours happens to be empty.
              kind: 'delete-modify',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url === '/api/sync/resolve-conflict') {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    };

    const provider = makeProvider('# Anything\n');
    render(<DiffViewBoundary docName="foo" provider={provider} />);

    // The DU render branch surfaces two affordances by accessible name.
    // Today neither exists — DiffViewBoundary renders the unified
    // DiffView unconditionally.
    const keepDeletion = await screen.findByRole('button', { name: /keep file deleted/i });
    expect(keepDeletion).toBeTruthy();

    const restore = await screen.findByRole('button', { name: /restore/i });
    expect(restore).toBeTruthy();
  });

  test('modify-delete (UD) renders Keep my version + Accept their deletion affordances', async () => {
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, init });
      if (url === '/api/sync/conflicts') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              conflicts: [{ file: 'foo.md', detectedAt: '2026-05-20T00:00:00.000Z' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.startsWith('/api/sync/conflict-content')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              file: 'foo.md',
              base: 'base content\n',
              ours: 'our modification\n',
              theirs: '',
              lifecycleStatus: 'conflict',
              kind: 'modify-delete',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url === '/api/sync/resolve-conflict') {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    };

    const provider = makeProvider('# Our version\n');
    render(<DiffViewBoundary docName="foo" provider={provider} />);

    const keepMine = await screen.findByRole('button', { name: /keep my version/i });
    expect(keepMine).toBeTruthy();

    const acceptDeletion = await screen.findByRole('button', { name: /accept their deletion/i });
    expect(acceptDeletion).toBeTruthy();
  });

  test('both-modified (regression) still renders the unified DiffView, NOT delete-prompt affordances', async () => {
    // Backward-compatibility check: the existing modify/modify happy path
    // must not regress when the discriminator is threaded through.
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, init });
      if (url === '/api/sync/conflicts') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              conflicts: [{ file: 'docs/notes.md', detectedAt: '2026-05-20T00:00:00.000Z' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.startsWith('/api/sync/conflict-content')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              file: 'docs/notes.md',
              base: 'base content\n',
              ours: 'our version\n',
              theirs: 'their version\n',
              lifecycleStatus: 'conflict',
              kind: 'both-modified',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url === '/api/sync/resolve-conflict') {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    };

    const provider = makeProvider('# Our version\n');
    render(<DiffViewBoundary docName="docs/notes" provider={provider} />);

    // Wait for the fetch to complete + the unified DiffView to mount.
    await waitFor(() => {
      const fetched = fetchCalls.find((c) => c.url.startsWith('/api/sync/conflict-content'));
      expect(fetched).toBeTruthy();
    });

    // The delete-prompt affordances MUST NOT appear in the both-modified
    // shape.
    expect(screen.queryByRole('button', { name: /keep file deleted/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /accept their deletion/i })).toBeNull();
  });

  // ─── Conflict footer height contract (DU/UD branches) ────────────────────
  // The DU/UD resolution footers live in DiffViewBoundary itself (not in
  // DiffView's conflictMode footer), so the boundary must publish
  // `--conflict-footer-height` for them — otherwise the floating Ask AI
  // composer anchors at bottom-0 and covers the resolution buttons, the
  // exact bug the var exists to prevent.
  test('delete-modify publishes --conflict-footer-height while mounted, removes on unmount', async () => {
    globalThis.fetch = strategyFetch('delete-modify') as typeof fetch;
    const { unmount } = render(<DiffViewBoundary docName="foo" provider={makeProvider('x\n')} />);

    await screen.findByRole('button', { name: /keep file deleted/i });
    // jsdom lifecycle pin — offsetHeight=0 (see DiffView.dom.test.tsx note).
    expect(document.documentElement.style.getPropertyValue('--conflict-footer-height')).toBe('0px');

    unmount();
    expect(document.documentElement.style.getPropertyValue('--conflict-footer-height')).toBe('');
  });

  test('modify-delete publishes --conflict-footer-height while mounted, removes on unmount', async () => {
    globalThis.fetch = strategyFetch('modify-delete') as typeof fetch;
    const { unmount } = render(<DiffViewBoundary docName="foo" provider={makeProvider('x\n')} />);

    await screen.findByRole('button', { name: /accept their deletion/i });
    // jsdom lifecycle pin — offsetHeight=0 (see DiffView.dom.test.tsx note).
    expect(document.documentElement.style.getPropertyValue('--conflict-footer-height')).toBe('0px');

    unmount();
    expect(document.documentElement.style.getPropertyValue('--conflict-footer-height')).toBe('');
  });

  // ─── Resolve dispatch wiring (data-loss guard) ────────────────────────────
  // The render tests above pin which buttons appear; these pin what each
  // button DOES. A swap of the dispatch functions (e.g. "Keep my version"
  // wired to `resolveConflictDelete`) would `git rm` a file the user
  // edited — a data-loss regression invisible to a presence-only assertion.
  // Each test clicks one affordance and asserts the resulting POST strategy.
  test('delete-modify: "Keep deletion" dispatches strategy: delete', async () => {
    globalThis.fetch = strategyFetch('delete-modify') as typeof fetch;
    render(<DiffViewBoundary docName="foo" provider={makeProvider('x\n')} />);
    fireEvent.click(await screen.findByRole('button', { name: /keep file deleted/i }));
    await waitFor(() =>
      expect(fetchCalls.some((c) => c.url === '/api/sync/resolve-conflict')).toBe(true),
    );
    expect(lastResolveBody()).toMatchObject({ file: 'foo.md', strategy: 'delete' });
  });

  test('delete-modify: "Restore with remote changes" dispatches strategy: theirs', async () => {
    globalThis.fetch = strategyFetch('delete-modify') as typeof fetch;
    render(<DiffViewBoundary docName="foo" provider={makeProvider('x\n')} />);
    fireEvent.click(await screen.findByRole('button', { name: /restore with remote changes/i }));
    await waitFor(() =>
      expect(fetchCalls.some((c) => c.url === '/api/sync/resolve-conflict')).toBe(true),
    );
    expect(lastResolveBody()).toMatchObject({ file: 'foo.md', strategy: 'theirs' });
  });

  test('modify-delete: "Keep my version" dispatches strategy: mine (never delete)', async () => {
    globalThis.fetch = strategyFetch('modify-delete') as typeof fetch;
    render(<DiffViewBoundary docName="foo" provider={makeProvider('x\n')} />);
    fireEvent.click(await screen.findByRole('button', { name: /keep my version/i }));
    await waitFor(() =>
      expect(fetchCalls.some((c) => c.url === '/api/sync/resolve-conflict')).toBe(true),
    );
    expect(lastResolveBody()).toMatchObject({ file: 'foo.md', strategy: 'mine' });
  });

  test('modify-delete: "Accept their deletion" dispatches strategy: delete', async () => {
    globalThis.fetch = strategyFetch('modify-delete') as typeof fetch;
    render(<DiffViewBoundary docName="foo" provider={makeProvider('x\n')} />);
    fireEvent.click(await screen.findByRole('button', { name: /accept their deletion/i }));
    await waitFor(() =>
      expect(fetchCalls.some((c) => c.url === '/api/sync/resolve-conflict')).toBe(true),
    );
    expect(lastResolveBody()).toMatchObject({ file: 'foo.md', strategy: 'delete' });
  });

  // Resolve buttons fire `git rm` + a commit; a double-click or a click on
  // the sibling strategy mid-request races the working tree. Pin that both
  // affordances disable for the duration of an in-flight dispatch.
  test('resolve buttons disable while a dispatch is in flight', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = strategyFetch('delete-modify', pending) as typeof fetch;
    render(<DiffViewBoundary docName="foo" provider={makeProvider('x\n')} />);

    const keep = (await screen.findByRole('button', {
      name: /keep file deleted/i,
    })) as HTMLButtonElement;
    const restore = screen.getByRole('button', {
      name: /restore with remote changes/i,
    }) as HTMLButtonElement;
    expect(keep.disabled).toBe(false);

    fireEvent.click(keep);

    // The dispatch is held open by `pending`; both buttons must stay
    // disabled until it settles.
    await waitFor(() => expect(keep.disabled).toBe(true));
    expect(restore.disabled).toBe(true);

    release?.();
  });

  // ─── Header / content / footer layout (DU/UD) ─────────────────────────────
  // Each missing-stage surface mounts the file content (the surviving side)
  // in a read-only CodeMirror surface, with the prompt header above and the
  // action buttons in a footer below. The previous collapsible-diff shape
  // was discarded because the diff-against-base added noise without
  // informing the keep-or-delete decision (especially when the local file
  // already contains stash-pop conflict markers, which render as line
  // additions in a base→ours diff). These tests pin the layout shape —
  // header text + buttons stay in the same DOM container as the content
  // pane so a regression that drops one of them surfaces immediately.
  test('delete-modify (DU) renders header / content / footer with no collapsible-preview chrome', async () => {
    globalThis.fetch = strategyFetch('delete-modify') as typeof fetch;
    render(<DiffViewBoundary docName="foo" provider={makeProvider('x\n')} />);
    // Header text + action buttons co-mount.
    // Explanatory text lives inline in the footer (`<p>`), beside the
    // action buttons. The previous header-banner shape was dropped to
    // keep context adjacent to the decision and dodge the parent's pt-14.
    expect(await screen.findByText(/you deleted/i, { exact: false, selector: 'p' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /keep file deleted/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /restore with remote changes/i })).toBeTruthy();
    // The collapsible-preview trigger is gone — the content is always
    // visible, not behind a Show toggle.
    expect(screen.queryByRole('button', { name: /show upstream changes/i })).toBeNull();
    expect(screen.queryByTestId('conflict-preview-trigger')).toBeNull();
  });

  test('modify-delete (UD) renders header / content / footer with no collapsible-preview chrome', async () => {
    globalThis.fetch = strategyFetch('modify-delete') as typeof fetch;
    render(<DiffViewBoundary docName="foo" provider={makeProvider('x\n')} />);
    expect(await screen.findByText(/you modified/i, { exact: false, selector: 'p' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /keep my version/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /accept their deletion/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /show your local changes/i })).toBeNull();
    expect(screen.queryByTestId('conflict-preview-trigger')).toBeNull();
  });

  // Multi-conflict race: other docs' entries are in the list, but THIS
  // doc's entry hasn't propagated yet. A list-level guard
  // (`conflicts.length === 0`) wouldn't defer — the effect would fire
  // with the hardcoded `.md` fallback, wrong for `.mdx`. The per-doc
  // guard (`conflictEntry === undefined`) defers correctly.
  test('defers conflict-content fetch when other conflicts loaded but this docs entry missing', async () => {
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, init });
      if (url === '/api/sync/conflicts') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              conflicts: [
                {
                  file: 'other/doc.md',
                  detectedAt: '2026-05-19T00:00:00Z',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.startsWith('/api/sync/conflict-content')) {
        return Promise.resolve(
          new Response(JSON.stringify({ file: '', base: '', ours: '', theirs: '' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('', { status: 404 }));
    };

    const provider = makeProvider('# Anything\n');
    render(<DiffViewBoundary docName="docs/mdx-note" provider={provider} />);

    await waitFor(() => {
      const conflictsFetch = fetchCalls.find((c) => c.url === '/api/sync/conflicts');
      expect(conflictsFetch).toBeTruthy();
    });
    expect(screen.queryByText(/Loading conflict for/i)).not.toBeNull();
    const contentFetch = fetchCalls.find((c) => c.url.startsWith('/api/sync/conflict-content'));
    expect(contentFetch).toBeUndefined();
  });
});
