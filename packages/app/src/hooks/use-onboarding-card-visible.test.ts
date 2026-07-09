import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { evaluateFreshProject } from './use-onboarding-card-visible';

const CURRENT_PATH = '/Users/me/project';

function bridgeWith(
  recents: Array<{ path: string }>,
  config: { freshlyCreated?: boolean } = {},
): OkDesktopBridge {
  return {
    project: { listRecent: () => Promise.resolve(recents) },
    config: { projectPath: CURRENT_PATH, freshlyCreated: config.freshlyCreated ?? false },
  } as unknown as OkDesktopBridge;
}

function rejectingBridge(): OkDesktopBridge {
  return {
    project: { listRecent: () => Promise.reject(new Error('IPC down')) },
    config: { projectPath: CURRENT_PATH },
  } as unknown as OkDesktopBridge;
}

function mockDocumentsResponse(body: unknown, status = 200): void {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  ) as never;
}

const aDocument = { kind: 'document', docName: 'welcome', size: 0, modified: '2026-06-30' };

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('evaluateFreshProject', () => {
  test('fresh single project with zero entries → activates with baseline 0', async () => {
    mockDocumentsResponse({ documents: [] });
    expect(await evaluateFreshProject(bridgeWith([{ path: CURRENT_PATH }]))).toBe(0);
  });

  test('an empty recents list still counts as no-other-project → baseline 0 when empty', async () => {
    mockDocumentsResponse({ documents: [] });
    expect(await evaluateFreshProject(bridgeWith([]))).toBe(0);
  });

  test('a second switchable project → null (does not fetch documents)', async () => {
    const fetchSpy = mock(() => Promise.resolve(new Response('{}', { status: 200 })));
    globalThis.fetch = fetchSpy as never;
    expect(
      await evaluateFreshProject(bridgeWith([{ path: CURRENT_PATH }, { path: '/other/project' }])),
    ).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('project already has content (not freshly created) → null', async () => {
    mockDocumentsResponse({ documents: [aDocument] });
    expect(await evaluateFreshProject(bridgeWith([{ path: CURRENT_PATH }]))).toBeNull();
  });

  test('freshly created (starter-pack seed) → activates, returning the seed count as baseline', async () => {
    // A starter pack scaffolds content at create time; the `create-new` entry
    // point sets `freshlyCreated`, so the card activates despite the entries —
    // and the entry count becomes the file-step baseline so the seed's own
    // templates don't auto-complete "create your first file".
    mockDocumentsResponse({ documents: [aDocument, { ...aDocument, docName: 'guide' }] });
    expect(
      await evaluateFreshProject(bridgeWith([{ path: CURRENT_PATH }], { freshlyCreated: true })),
    ).toBe(2);
  });

  test('freshly created blank project (zero entries) → activates with baseline 0', async () => {
    // The primary happy path for a blank `create-new` open: freshlyCreated with
    // no content activates with baseline 0 (any first file then completes the
    // file step). Guards against a future narrowing like `freshlyCreated &&
    // entryCount > 0` silently suppressing the card for blank-project users.
    mockDocumentsResponse({ documents: [] });
    expect(
      await evaluateFreshProject(bridgeWith([{ path: CURRENT_PATH }], { freshlyCreated: true })),
    ).toBe(0);
  });

  test('freshly created but a second project exists → null (hasOtherProject wins)', async () => {
    const fetchSpy = mock(() => Promise.resolve(new Response('{}', { status: 200 })));
    globalThis.fetch = fetchSpy as never;
    expect(
      await evaluateFreshProject(
        bridgeWith([{ path: CURRENT_PATH }, { path: '/other/project' }], { freshlyCreated: true }),
      ),
    ).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('listRecent rejection is suppressed → null (fail-safe)', async () => {
    mockDocumentsResponse({ documents: [] });
    expect(await evaluateFreshProject(rejectingBridge())).toBeNull();
  });

  test('non-ok /api/documents response → null (fail-safe)', async () => {
    mockDocumentsResponse({ error: 'boom' }, 500);
    expect(await evaluateFreshProject(bridgeWith([{ path: CURRENT_PATH }]))).toBeNull();
  });

  test('schema-violating /api/documents body → null (fail-safe)', async () => {
    mockDocumentsResponse({ unexpected: 'shape' });
    expect(await evaluateFreshProject(bridgeWith([{ path: CURRENT_PATH }]))).toBeNull();
  });
});
