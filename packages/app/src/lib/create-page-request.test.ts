import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPageRequest, nextUntitledDocName, openCreatedPage } from './create-page-request';

describe('nextUntitledDocName', () => {
  it('starts at bare "untitled" at the content root', () => {
    expect(nextUntitledDocName('', new Set())).toBe('untitled');
  });

  it('prefixes the directory', () => {
    expect(nextUntitledDocName('notes/daily', new Set())).toBe('notes/daily/untitled');
  });

  it('skips taken names, numbering from 2', () => {
    expect(nextUntitledDocName('', new Set(['untitled']))).toBe('untitled-2');
    expect(nextUntitledDocName('', new Set(['untitled', 'untitled-2']))).toBe('untitled-3');
  });

  it('fills the first gap rather than appending past the highest', () => {
    expect(nextUntitledDocName('', new Set(['untitled', 'untitled-3']))).toBe('untitled-2');
  });

  it('scopes taken-ness to the directory', () => {
    // An `untitled` at the root does not push the one in `notes/` to -2.
    expect(nextUntitledDocName('notes', new Set(['untitled']))).toBe('notes/untitled');
  });
});

describe('createPageRequest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetch(impl: () => Promise<Response>) {
    vi.stubGlobal('fetch', vi.fn(impl));
  }

  it('returns the server docName on a 2xx success body', async () => {
    stubFetch(async () => new Response(JSON.stringify({ docName: 'untitled' }), { status: 200 }));
    const result = await createPageRequest({ path: 'untitled.md', kind: 'file' });
    expect(result).toEqual({ ok: true, docName: 'untitled' });
  });

  it('surfaces the RFC 9457 title on a server rejection', async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            type: 'urn:ok:error:doc-already-exists',
            title: 'A file named untitled already exists',
          }),
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
    );
    const result = await createPageRequest({ path: 'untitled.md', kind: 'file' });
    expect(result).toEqual({ ok: false, error: 'A file named untitled already exists' });
  });

  it('reports a kind-specific failure when a 2xx body is missing docName', async () => {
    // The server committed something the client cannot read back.
    stubFetch(async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
    expect(await createPageRequest({ path: 'untitled.md', kind: 'file' })).toEqual({
      ok: false,
      error: 'Failed to create file',
    });
    expect(await createPageRequest({ path: 'notes', kind: 'folder' })).toEqual({
      ok: false,
      error: 'Failed to create folder',
    });
  });

  it('comes back as a result rather than throwing when fetch rejects', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(async () => {
      throw new Error('offline');
    });
    const result = await createPageRequest({ path: 'untitled.md', kind: 'file' });
    expect(result).toEqual({ ok: false, error: 'Network error — please try again' });
  });
});

describe('openCreatedPage', () => {
  const realWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    // This tier has no DOM. Restore rather than delete: leaving a stub behind
    // makes later files in the same worker believe they are in a browser.
    if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = realWindow;
  });

  function harness(docName: string): string {
    const stub = {
      location: { hash: '' },
      dispatchEvent: () => true,
    };
    (globalThis as { window?: unknown }).window = stub;
    openCreatedPage(docName, () => {});
    return stub.location.hash;
  }

  it('percent-encodes the created doc name', () => {
    expect(harness('My Notes')).toBe('#/My%20Notes');
  });

  it('encodes a name containing a route metacharacter so the new page opens', () => {
    // Creating is the path the bug was reported through: the name is legal to
    // create, and left raw the "#" reads as the anchor delimiter, so the parser
    // resolves no document and the app opens a New Tab over the new page.
    expect(harness('# 2 - Tokens')).toBe('#/%23%202%20-%20Tokens');
    expect(harness('What now?')).toBe('#/What%20now%3F');
  });

  it('keeps the slash a route separator for a nested name', () => {
    expect(harness('My Notes/# 2 - Tokens')).toBe('#/My%20Notes/%23%202%20-%20Tokens');
  });
});
