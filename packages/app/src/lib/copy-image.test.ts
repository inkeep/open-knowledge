import type { CopyImageResult } from '@inkeep/open-knowledge-core/desktop-bridge';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { type CopyImageEnv, copyImage } from './copy-image.ts';

const REQUEST = { src: 'http://localhost:5173/assets/pic.jpg' };

class FakeClipboardItem {
  constructor(readonly items: Record<string, Blob>) {}
}

function env(overrides: Partial<CopyImageEnv> = {}): CopyImageEnv {
  return {
    desktopCopyImage: null,
    writeClipboard: vi.fn(async () => {}),
    createClipboardItem: (items) => new FakeClipboardItem(items) as unknown as ClipboardItem,
    fetch: vi.fn(
      async () => new Response(new Blob([new Uint8Array([0xff, 0xd8])]), { status: 200 }),
    ),
    ...overrides,
  };
}

function writtenItems(write: CopyImageEnv['writeClipboard']): Record<string, Blob> {
  const calls = (write as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls).toHaveLength(1);
  const [items] = calls[0] as [FakeClipboardItem[]];
  expect(items).toHaveLength(1);
  return items[0].items;
}

describe('copyImage — desktop first', () => {
  test('a desktop success does not touch the browser clipboard', async () => {
    const e = env({
      desktopCopyImage: vi.fn(async (): Promise<CopyImageResult> => ({ ok: true })),
    });
    await expect(copyImage(REQUEST, e)).resolves.toEqual({ ok: true, via: 'desktop' });
    expect(e.desktopCopyImage).toHaveBeenCalledWith(REQUEST);
    expect(e.writeClipboard).not.toHaveBeenCalled();
    expect(e.fetch).not.toHaveBeenCalled();
  });

  test('a declined desktop write falls back to the browser and reports why', async () => {
    const e = env({
      desktopCopyImage: vi.fn(
        async (): Promise<CopyImageResult> => ({ ok: false, reason: 'empty-image', detail: 'svg' }),
      ),
    });
    await expect(copyImage(REQUEST, e)).resolves.toEqual({
      ok: true,
      via: 'browser',
      desktopFailure: { ok: false, reason: 'empty-image', detail: 'svg' },
    });
    expect(writtenItems(e.writeClipboard)['image/png'].type).toBe('image/png');
  });

  test('a throwing desktop bridge falls back to the browser', async () => {
    const e = env({
      desktopCopyImage: vi.fn(async (): Promise<CopyImageResult> => {
        throw new Error('ipc gone');
      }),
    });
    await expect(copyImage(REQUEST, e)).resolves.toEqual({
      ok: true,
      via: 'browser',
      desktopFailure: { ok: false, reason: 'bridge-threw', detail: 'ipc gone' },
    });
  });
});

describe('copyImage — browser clipboard', () => {
  test('writes the fetched image under image/png', async () => {
    const e = env();
    await expect(copyImage(REQUEST, e)).resolves.toEqual({ ok: true, via: 'browser' });
    expect(e.fetch).toHaveBeenCalledWith(
      REQUEST.src,
      expect.objectContaining({ signal: expect.anything() }),
    );
    const written = writtenItems(e.writeClipboard);
    expect(Object.keys(written)).toEqual(['image/png']);
    const png = written['image/png'];
    expect(png.type).toBe('image/png');
    expect(Buffer.from(await png.arrayBuffer())).toEqual(Buffer.from([0xff, 0xd8]));
  });

  test('no clipboard API is reported, not thrown', async () => {
    const e = env({ writeClipboard: null });
    await expect(copyImage(REQUEST, e)).resolves.toMatchObject({
      ok: false,
      reason: 'clipboard-unavailable',
    });
    expect(e.fetch).not.toHaveBeenCalled();
  });

  test('a non-2xx fetch is a fetch-failed outcome', async () => {
    const e = env({ fetch: vi.fn(async () => new Response(null, { status: 404 })) });
    await expect(copyImage(REQUEST, e)).resolves.toEqual({
      ok: false,
      reason: 'fetch-failed',
      detail: 'HTTP 404',
    });
    expect(e.writeClipboard).not.toHaveBeenCalled();
  });

  test('a rejected fetch is a fetch-failed outcome with no clipboard write', async () => {
    const e = env({
      fetch: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    });
    await expect(copyImage(REQUEST, e)).resolves.toEqual({
      ok: false,
      reason: 'fetch-failed',
      detail: 'Failed to fetch',
    });
    expect(e.writeClipboard).not.toHaveBeenCalled();
  });

  test('a throwing ClipboardItem constructor is a write-error outcome', async () => {
    const e = env({
      createClipboardItem: () => {
        throw new TypeError('ClipboardItem is not defined');
      },
    });
    await expect(copyImage(REQUEST, e)).resolves.toEqual({
      ok: false,
      reason: 'write-error',
      detail: 'ClipboardItem is not defined',
    });
    expect(e.writeClipboard).not.toHaveBeenCalled();
  });

  test('a rejected clipboard write is a write-error outcome', async () => {
    const e = env({
      writeClipboard: vi.fn(async () => {
        throw new Error('NotAllowedError');
      }),
    });
    await expect(copyImage(REQUEST, e)).resolves.toEqual({
      ok: false,
      reason: 'write-error',
      detail: 'NotAllowedError',
    });
  });
});

describe('copyImage — default environment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubBrowser(clipboard: { write?: (items: ClipboardItem[]) => Promise<void> }) {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { clipboard });
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob([new Uint8Array([0x89, 0x50])]), { status: 200 })),
    );
  }

  test('uses the desktop bridge on window.okDesktop when it is present', async () => {
    const copy = vi.fn(async (): Promise<CopyImageResult> => ({ ok: true }));
    const write = vi.fn(async () => {});
    stubBrowser({ write });
    vi.stubGlobal('window', { okDesktop: { clipboard: { copyImage: copy } } });
    await expect(copyImage(REQUEST)).resolves.toEqual({ ok: true, via: 'desktop' });
    expect(copy).toHaveBeenCalledWith(REQUEST);
    expect(write).not.toHaveBeenCalled();
  });

  test('writes only image/png through navigator.clipboard without a desktop bridge', async () => {
    const write = vi.fn(async (_items: ClipboardItem[]) => {});
    stubBrowser({ write });
    await expect(copyImage(REQUEST)).resolves.toEqual({ ok: true, via: 'browser' });
    expect(fetch).toHaveBeenCalledWith(REQUEST.src, expect.anything());
    expect(writtenItems(write)['image/png'].type).toBe('image/png');
  });

  test('reports a browser with no clipboard write as clipboard-unavailable', async () => {
    stubBrowser({});
    await expect(copyImage(REQUEST)).resolves.toMatchObject({
      ok: false,
      reason: 'clipboard-unavailable',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
