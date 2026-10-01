import { describe, expect, test, vi } from 'vitest';
import { type CopyImageToClipboardDeps, copyImageToClipboard } from './copy-image-clipboard.ts';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

class FakeClipboardItem {
  readonly types: string[];
  constructor(readonly items: Record<string, Blob>) {
    this.types = Object.keys(items);
  }
}

function baseDeps(overrides: Partial<CopyImageToClipboardDeps> = {}): CopyImageToClipboardDeps {
  return {
    projectPath: '/proj',
    platform: 'darwin',
    assetOrigin: 'http://localhost:5173',
    clipboard: { write: vi.fn(async () => {}) },
    ClipboardItem: FakeClipboardItem as unknown as CopyImageToClipboardDeps['ClipboardItem'],
    nativeImage: {
      createFromBuffer: () => ({ isEmpty: () => false, toPNG: () => PNG_BYTES }),
    },
    fetch: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
    resolveCanonical: (p) => p,
    ...overrides,
  };
}

describe('copyImageToClipboard — same-origin path handling', () => {
  test('refuses %-encoded ../ traversal with path-escape', async () => {
    const write = vi.fn(async () => {});
    const result = await copyImageToClipboard(
      baseDeps({
        clipboard: { write },
        resolveCanonical: () => '/etc/passwd',
      }),
      { src: 'http://localhost:5173/%2E%2E/%2E%2E/etc/passwd' },
    );
    expect(result).toEqual({
      ok: false,
      reason: 'path-escape',
      detail: expect.stringContaining('outside project'),
    });
    expect(write).not.toHaveBeenCalled();
  });

  test('windows drive-letter after decode triggers the isAbsolute guard', async () => {
    const write = vi.fn(async () => {});
    const resolveCanonical = vi.fn((p: string) => p);
    const result = await copyImageToClipboard(
      baseDeps({
        platform: 'win32',
        clipboard: { write },
        resolveCanonical,
      }),
      { src: 'http://localhost:5173/C:/Windows/System32/passwd' },
    );
    expect(result).toEqual({
      ok: false,
      reason: 'path-escape',
      detail: expect.stringContaining('absolute rel path'),
    });
    expect(resolveCanonical).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  test('realpath ENOENT surfaces as read-error (missing file along the chain)', async () => {
    const write = vi.fn(async () => {});
    const result = await copyImageToClipboard(
      baseDeps({
        clipboard: { write },
        resolveCanonical: () => {
          throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
        },
      }),
      { src: 'http://localhost:5173/assets/missing.png' },
    );
    expect(result).toEqual({
      ok: false,
      reason: 'read-error',
      detail: expect.stringContaining('no such file'),
    });
    expect(write).not.toHaveBeenCalled();
  });

  test('readFile EACCES surfaces as read-error (permission denied)', async () => {
    const write = vi.fn(async () => {});
    const result = await copyImageToClipboard(
      baseDeps({
        clipboard: { write },
        readFile: async () => {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        },
      }),
      { src: 'http://localhost:5173/assets/logo.png' },
    );
    expect(result).toEqual({
      ok: false,
      reason: 'read-error',
      detail: expect.stringContaining('permission denied'),
    });
    expect(write).not.toHaveBeenCalled();
  });

  test('non-image extension is refused at the disk-read gate (extension whitelist)', async () => {
    const write = vi.fn(async () => {});
    const readFile = vi.fn();
    const result = await copyImageToClipboard(
      baseDeps({
        clipboard: { write },
        readFile,
      }),
      { src: 'http://localhost:5173/.ok/config.yml' },
    );
    expect(result).toEqual({
      ok: false,
      reason: 'path-escape',
      detail: expect.stringContaining('unsupported ext'),
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  test('realpath refuses a symlink escape (containment on canonical path, not lexical)', async () => {
    const write = vi.fn(async () => {});
    const result = await copyImageToClipboard(
      baseDeps({
        clipboard: { write },
        resolveCanonical: () => '/etc/passwd',
      }),
      { src: 'http://localhost:5173/assets/logo.png' },
    );
    expect(result).toEqual({
      ok: false,
      reason: 'path-escape',
      detail: expect.stringContaining('outside project'),
    });
    expect(write).not.toHaveBeenCalled();
  });
});

describe('copyImageToClipboard — cross-origin fetch', () => {
  test('4xx / 5xx response resolves fetch-failed with HTTP status', async () => {
    const write = vi.fn(async () => {});
    const result = await copyImageToClipboard(
      baseDeps({
        clipboard: { write },
        fetch: vi.fn(async () => new Response('', { status: 404 })),
      }),
      { src: 'https://cdn.example.com/missing.png' },
    );
    expect(result).toEqual({
      ok: false,
      reason: 'fetch-failed',
      detail: 'HTTP 404',
    });
    expect(write).not.toHaveBeenCalled();
  });

  test('fetch throw (network error, timeout) surfaces as fetch-failed', async () => {
    const write = vi.fn(async () => {});
    const result = await copyImageToClipboard(
      baseDeps({
        clipboard: { write },
        fetch: vi.fn(async () => {
          throw new Error('boom');
        }),
      }),
      { src: 'https://cdn.example.com/foo.png' },
    );
    expect(result).toEqual({
      ok: false,
      reason: 'fetch-failed',
      detail: 'boom',
    });
    expect(write).not.toHaveBeenCalled();
  });
});

describe('copyImageToClipboard — decode + write', () => {
  test('empty-image branch when nativeImage.createFromBuffer decodes empty (SVG / AVIF / WebP)', async () => {
    const write = vi.fn(async () => {});
    const result = await copyImageToClipboard(
      baseDeps({
        clipboard: { write },
        nativeImage: {
          createFromBuffer: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
        },
      }),
      { src: 'https://cdn.example.com/x.svg' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('empty-image');
    }
    expect(write).not.toHaveBeenCalled();
  });

  test('happy path: writes the image to the clipboard as PNG', async () => {
    const write = vi.fn(async () => {});
    const result = await copyImageToClipboard(baseDeps({ clipboard: { write } }), {
      src: 'https://cdn.example.com/pic.jpg',
    });
    expect(result).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
    const [items] = write.mock.calls[0] as unknown as [FakeClipboardItem[]];
    expect(items).toHaveLength(1);
    expect(items[0].types).toEqual(['image/png']);
    const blob = items[0].items['image/png'];
    expect(blob.type).toBe('image/png');
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(PNG_BYTES);
  });

  test('clipboard write rejection surfaces as write-error (defends against NSPasteboard flakes)', async () => {
    const write = vi.fn(async () => {
      throw new Error('NSPasteboard write failed');
    });
    const result = await copyImageToClipboard(baseDeps({ clipboard: { write } }), {
      src: 'https://cdn.example.com/pic.png',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'write-error',
      detail: 'NSPasteboard write failed',
    });
  });
});
