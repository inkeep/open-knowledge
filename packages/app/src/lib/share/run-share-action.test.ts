
import { describe, expect, test } from 'bun:test';
import type {
  ShareConstructUrlErrorCode,
  ShareConstructUrlResponse,
} from '@inkeep/open-knowledge-core';
import { mapShareErrorToToast, requestShareConstructUrl, runShareAction } from './run-share-action';

interface MockDeps {
  fetchFn: typeof fetch;
  clipboardWrite: (text: string) => Promise<void>;
  toastSuccess: (msg: string) => void;
  toastError: (msg: string) => void;
  logEvent: (msg: string) => void;
  clipboardTexts: string[];
  successToasts: string[];
  errorToasts: string[];
  logs: string[];
  fetchCalls: Array<{ url: string; body: unknown }>;
}

function makeDeps(opts: {
  fetchResponse?: ShareConstructUrlResponse;
  fetchStatus?: number;
  fetchThrows?: Error;
  clipboardThrows?: Error;
}): MockDeps {
  const clipboardTexts: string[] = [];
  const successToasts: string[] = [];
  const errorToasts: string[] = [];
  const logs: string[] = [];
  const fetchCalls: Array<{ url: string; body: unknown }> = [];

  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (opts.fetchThrows) throw opts.fetchThrows;
    const status = opts.fetchStatus ?? 200;
    const json = opts.fetchResponse ?? { ok: false, error: 'no-remote' };
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return {
    fetchFn,
    clipboardWrite: async (text) => {
      if (opts.clipboardThrows) throw opts.clipboardThrows;
      clipboardTexts.push(text);
    },
    toastSuccess: (msg) => successToasts.push(msg),
    toastError: (msg) => errorToasts.push(msg),
    logEvent: (msg) => logs.push(msg),
    clipboardTexts,
    successToasts,
    errorToasts,
    logs,
    fetchCalls,
  };
}

describe('mapShareErrorToToast', () => {
  test('detached-head returns the branch-prompt copy', () => {
    expect(mapShareErrorToToast('detached-head')).toBe('Switch to a branch to share.');
  });

  test('branch-not-on-origin names the branch verbatim when provided', () => {
    expect(mapShareErrorToToast('branch-not-on-origin', 'feat/x')).toBe(
      'Push feat/x to GitHub before sharing.',
    );
  });

  test('branch-not-on-origin falls back to a generic phrase when branch missing', () => {
    expect(mapShareErrorToToast('branch-not-on-origin')).toBe(
      'Push this branch to GitHub before sharing.',
    );
  });

  test('non-github-remote returns the github-only copy', () => {
    expect(mapShareErrorToToast('non-github-remote')).toBe('Sharing supports GitHub remotes only.');
  });

  test('invalid-path returns the generic uncrossable copy', () => {
    expect(mapShareErrorToToast('invalid-path')).toBe("Can't share this path.");
  });

  test('no-remote returns the no-remote copy (kept for callers that map directly; runShareAction routes to the wizard)', () => {
    expect(mapShareErrorToToast('no-remote')).toBe('This project has no GitHub remote.');
  });

  test('every defined error code has a non-empty mapping', () => {
    const codes: ShareConstructUrlErrorCode[] = [
      'no-remote',
      'detached-head',
      'branch-not-on-origin',
      'non-github-remote',
      'invalid-path',
    ];
    for (const code of codes) {
      expect(mapShareErrorToToast(code).length).toBeGreaterThan(0);
    }
  });
});

describe('requestShareConstructUrl', () => {
  test('POSTs JSON body to /api/share/construct-url and returns parsed response', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const stubFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          shareUrl: 'https://openknowledge.ai/d/AaaXX',
          sharedUrl: 'https://github.com/o/r/blob/main/a.md',
          branch: 'main',
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await requestShareConstructUrl({ kind: 'doc', docPath: 'a.md' }, stubFetch);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/share/construct-url');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ kind: 'doc', docPath: 'a.md' });
    expect(result).toEqual({
      ok: true,
      shareUrl: 'https://openknowledge.ai/d/AaaXX',
      sharedUrl: 'https://github.com/o/r/blob/main/a.md',
      branch: 'main',
    });
  });

  test('POSTs the folder-variant body verbatim (folderPath, including the empty content-root sentinel)', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const stubFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          shareUrl: 'https://openknowledge.ai/d/BbbYY',
          sharedUrl: 'https://github.com/o/r/tree/main/guides',
          branch: 'main',
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await requestShareConstructUrl({ kind: 'folder', folderPath: 'guides' }, stubFetch);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      kind: 'folder',
      folderPath: 'guides',
    });

    await requestShareConstructUrl({ kind: 'folder', folderPath: '' }, stubFetch);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ kind: 'folder', folderPath: '' });
  });

  test('throws when transport returns non-2xx (so callers route to transport-error)', async () => {
    const stubFetch = (async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({ type: 'urn:ok:error:internal-server-error', detail: 'boom' }),
      }) as unknown as Response) as unknown as typeof fetch;

    await expect(
      requestShareConstructUrl({ kind: 'doc', docPath: 'a.md' }, stubFetch),
    ).rejects.toThrow(/construct-url transport 500/);
  });

  test('throws when response body fails schema validation', async () => {
    const stubFetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true /* missing shareUrl + sharedUrl + branch */ }),
      }) as unknown as Response) as unknown as typeof fetch;

    await expect(
      requestShareConstructUrl({ kind: 'doc', docPath: 'a.md' }, stubFetch),
    ).rejects.toThrow(/response shape mismatch/);
  });

  test('parses the branch field on a branch-not-on-origin error response', async () => {
    const stubFetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          ok: false,
          error: 'branch-not-on-origin',
          branch: 'feat/sharing-virality-flow',
        }),
      }) as unknown as Response) as unknown as typeof fetch;

    const result = await requestShareConstructUrl({ kind: 'doc', docPath: 'a.md' }, stubFetch);
    if (result.ok) throw new Error('expected error variant');
    expect(result.error).toBe('branch-not-on-origin');
    expect(result.branch).toBe('feat/sharing-virality-flow');
  });
});

describe('runShareAction — happy path', () => {
  test('hasRemote=true + 200 ok response → clipboard write + success toast + log', async () => {
    const okResponse: ShareConstructUrlResponse = {
      ok: true,
      shareUrl: 'https://openknowledge.ai/d/Aaa',
      sharedUrl: 'https://github.com/o/r/blob/main/a.md',
      branch: 'main',
    };
    const deps = makeDeps({ fetchResponse: okResponse });
    let wizardOpened = false;

    const result = await runShareAction(
      {
        kind: 'doc',
        docName: 'a',
        hasRemote: true,
        onClickWhenNoRemote: () => {
          wizardOpened = true;
        },
      },
      deps,
    );

    expect(result).toEqual({
      kind: 'copied',
      shareUrl: 'https://openknowledge.ai/d/Aaa',
      branch: 'main',
    });
    expect(deps.clipboardTexts).toEqual(['https://openknowledge.ai/d/Aaa']);
    expect(deps.successToasts).toEqual(['Link copied.']);
    expect(deps.errorToasts).toEqual([]);
    expect(deps.logs).toEqual(['[share] action=link-construct']);
    expect(wizardOpened).toBe(false);
  });

  test('converts docName "foo" to docPath "foo.md" before calling the endpoint', async () => {
    const okResponse: ShareConstructUrlResponse = {
      ok: true,
      shareUrl: 'https://openknowledge.ai/d/Aaa',
      sharedUrl: 'https://github.com/o/r/blob/main/foo.md',
      branch: 'main',
    };
    const deps = makeDeps({ fetchResponse: okResponse });

    await runShareAction(
      { kind: 'doc', docName: 'foo', hasRemote: true, onClickWhenNoRemote: () => {} },
      deps,
    );

    expect(deps.fetchCalls).toHaveLength(1);
    expect(deps.fetchCalls[0].body).toEqual({ kind: 'doc', docPath: 'foo.md' });
  });

  test('nested docName "docs/sub/page" maps to docPath "docs/sub/page.md"', async () => {
    const okResponse: ShareConstructUrlResponse = {
      ok: true,
      shareUrl: 'https://openknowledge.ai/d/Aaa',
      sharedUrl: 'https://github.com/o/r/blob/main/docs/sub/page.md',
      branch: 'main',
    };
    const deps = makeDeps({ fetchResponse: okResponse });

    await runShareAction(
      { kind: 'doc', docName: 'docs/sub/page', hasRemote: true, onClickWhenNoRemote: () => {} },
      deps,
    );

    expect(deps.fetchCalls[0].body).toEqual({ kind: 'doc', docPath: 'docs/sub/page.md' });
  });

  test('folder input POSTs {kind:folder, folderPath} verbatim + folder-specific success toast', async () => {
    const okResponse: ShareConstructUrlResponse = {
      ok: true,
      shareUrl: 'https://openknowledge.ai/d/Fff',
      sharedUrl: 'https://github.com/o/r/tree/main/guides/onboarding',
      branch: 'main',
    };
    const deps = makeDeps({ fetchResponse: okResponse });

    const result = await runShareAction(
      {
        kind: 'folder',
        folderRelativePath: 'guides/onboarding',
        hasRemote: true,
        onClickWhenNoRemote: () => {},
      },
      deps,
    );

    expect(result).toEqual({
      kind: 'copied',
      shareUrl: 'https://openknowledge.ai/d/Fff',
      branch: 'main',
    });
    expect(deps.fetchCalls[0].body).toEqual({ kind: 'folder', folderPath: 'guides/onboarding' });
    expect(deps.successToasts).toEqual(['Folder share link copied.']);
    expect(deps.clipboardTexts).toEqual(['https://openknowledge.ai/d/Fff']);
  });

  test('content-root folder input POSTs the empty folderPath sentinel', async () => {
    const okResponse: ShareConstructUrlResponse = {
      ok: true,
      shareUrl: 'https://openknowledge.ai/d/Root',
      sharedUrl: 'https://github.com/o/r/tree/main',
      branch: 'main',
    };
    const deps = makeDeps({ fetchResponse: okResponse });

    await runShareAction(
      { kind: 'folder', folderRelativePath: '', hasRemote: true, onClickWhenNoRemote: () => {} },
      deps,
    );

    expect(deps.fetchCalls[0].body).toEqual({ kind: 'folder', folderPath: '' });
    expect(deps.successToasts).toEqual(['Folder share link copied.']);
  });
});

describe('runShareAction — no-remote routing', () => {
  test('hasRemote=false skips the network call and fires onClickWhenNoRemote', async () => {
    const deps = makeDeps({});
    let wizardOpened = false;

    const result = await runShareAction(
      {
        kind: 'doc',
        docName: 'a',
        hasRemote: false,
        onClickWhenNoRemote: () => {
          wizardOpened = true;
        },
      },
      deps,
    );

    expect(result).toEqual({ kind: 'opened-wizard' });
    expect(wizardOpened).toBe(true);
    expect(deps.fetchCalls).toHaveLength(0);
    expect(deps.clipboardTexts).toEqual([]);
    expect(deps.successToasts).toEqual([]);
    expect(deps.errorToasts).toEqual([]);
  });

  test('server-side no-remote response also fires the wizard (worktree dev parity)', async () => {
    const deps = makeDeps({
      fetchResponse: { ok: false, error: 'no-remote' },
    });
    let wizardOpened = false;

    const result = await runShareAction(
      {
        kind: 'doc',
        docName: 'a',
        hasRemote: true,
        onClickWhenNoRemote: () => {
          wizardOpened = true;
        },
      },
      deps,
    );

    expect(result).toEqual({ kind: 'opened-wizard' });
    expect(wizardOpened).toBe(true);
    expect(deps.clipboardTexts).toEqual([]);
    expect(deps.successToasts).toEqual([]);
    expect(deps.errorToasts).toEqual([]);
  });
});

describe('runShareAction — business-error toasts', () => {
  test('detached-head response surfaces the branch-prompt toast', async () => {
    const deps = makeDeps({
      fetchResponse: { ok: false, error: 'detached-head' },
    });

    const result = await runShareAction(
      { kind: 'doc', docName: 'a', hasRemote: true, onClickWhenNoRemote: () => {} },
      deps,
    );

    expect(result).toEqual({
      kind: 'business-error',
      error: 'detached-head',
      branch: undefined,
    });
    expect(deps.errorToasts).toEqual(['Switch to a branch to share.']);
    expect(deps.clipboardTexts).toEqual([]);
    expect(deps.successToasts).toEqual([]);
  });

  test('branch-not-on-origin response surfaces the branch name in the toast', async () => {
    const deps = makeDeps({
      fetchResponse: {
        ok: false,
        error: 'branch-not-on-origin',
        branch: 'feat/sharing-virality-flow',
      },
    });

    const result = await runShareAction(
      { kind: 'doc', docName: 'a', hasRemote: true, onClickWhenNoRemote: () => {} },
      deps,
    );

    expect(result).toEqual({
      kind: 'business-error',
      error: 'branch-not-on-origin',
      branch: 'feat/sharing-virality-flow',
    });
    expect(deps.errorToasts).toEqual(['Push feat/sharing-virality-flow to GitHub before sharing.']);
  });

  test('non-github-remote response surfaces the github-only toast', async () => {
    const deps = makeDeps({
      fetchResponse: { ok: false, error: 'non-github-remote' },
    });

    await runShareAction(
      { kind: 'doc', docName: 'a', hasRemote: true, onClickWhenNoRemote: () => {} },
      deps,
    );

    expect(deps.errorToasts).toEqual(['Sharing supports GitHub remotes only.']);
  });

  test('invalid-path response surfaces the generic toast', async () => {
    const deps = makeDeps({
      fetchResponse: { ok: false, error: 'invalid-path' },
    });

    await runShareAction(
      { kind: 'doc', docName: 'a', hasRemote: true, onClickWhenNoRemote: () => {} },
      deps,
    );

    expect(deps.errorToasts).toEqual(["Can't share this path."]);
  });
});

describe('runShareAction — transport / clipboard failures', () => {
  test('fetch network error surfaces the transport-error toast', async () => {
    const deps = makeDeps({ fetchThrows: new Error('network down') });

    const result = await runShareAction(
      { kind: 'doc', docName: 'a', hasRemote: true, onClickWhenNoRemote: () => {} },
      deps,
    );

    expect(result).toEqual({ kind: 'transport-error' });
    expect(deps.errorToasts).toEqual(['Could not construct share URL.']);
    expect(deps.clipboardTexts).toEqual([]);
  });

  test('clipboard write failure surfaces clipboard-failed kind + distinct toast (URL was constructed)', async () => {
    const okResponse: ShareConstructUrlResponse = {
      ok: true,
      shareUrl: 'https://openknowledge.ai/d/Aaa',
      sharedUrl: 'https://github.com/o/r/blob/main/a.md',
      branch: 'main',
    };
    const deps = makeDeps({
      fetchResponse: okResponse,
      clipboardThrows: new Error('NotAllowedError: clipboard denied'),
    });

    const result = await runShareAction(
      { kind: 'doc', docName: 'a', hasRemote: true, onClickWhenNoRemote: () => {} },
      deps,
    );

    expect(result).toEqual({
      kind: 'clipboard-failed',
      shareUrl: 'https://openknowledge.ai/d/Aaa',
    });
    expect(deps.successToasts).toEqual([]);
    expect(deps.errorToasts).toEqual(['Link ready but could not copy to clipboard.']);
    expect(deps.logs).toEqual(['[share] action=link-construct result=clipboard-failed']);
  });

  test('5xx response from server (transport-shaped) surfaces transport-error', async () => {
    const deps = makeDeps({ fetchStatus: 500 });

    const result = await runShareAction(
      { kind: 'doc', docName: 'a', hasRemote: true, onClickWhenNoRemote: () => {} },
      deps,
    );

    expect(result).toEqual({ kind: 'transport-error' });
    expect(deps.errorToasts).toEqual(['Could not construct share URL.']);
  });
});
