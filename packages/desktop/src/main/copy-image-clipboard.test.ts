import { describe, expect, test, vi } from 'vitest';
import { type CopyImageToClipboardDeps, copyImageToClipboard } from './copy-image-clipboard.ts';

function baseDeps(overrides: Partial<CopyImageToClipboardDeps> = {}): CopyImageToClipboardDeps {
  return {
    projectPath: '/proj',
    platform: 'darwin',
    assetOrigin: 'http://localhost:5173',
    clipboard: { writeImage: vi.fn() },
    nativeImage: {
      createFromBuffer: () => ({ isEmpty: () => false }),
    },
    fetch: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
    resolveCanonical: (p) => p,
    ...overrides,
  };
}

describe('copyImageToClipboard — same-origin path handling', () => {
  test('refuses %-encoded ../ traversal with path-escape', async () => {
    const writeImage = vi.fn();
    const result = await copyImageToClipboard(
      baseDeps({
        clipboard: { writeImage },
        resolveCanonical: () => '/etc/passwd',
      }),
      { src: 'http://localhost:5173/%2E%2E/%2E%2E/etc/passwd', alt: 'x' },
    );
    expect(result).toEqual({
      ok: false,
      reason: 'path-escape',
      detail: expect.stringContaining('outside project'),
    });
    expect(writeImage).not.toHaveBeenCalled();
  });

  test('windows drive-letter after decode triggers the isAbsolute guard', async () => {
    const writeImage = vi.fn();
    const resolveCanonical = vi.fn((p: string) => p);
    const result = await copyImageToClipboard(
      baseDeps({
        platform: 'win32',
        clipboard: { writeImage },
        resolveCanonical,
      }),
      { src: 'http://localhost:5173/C:/Windows/System32/passwd', alt: 'x' },
    );
    expect(result).toEqual({
      ok: false,
      reason: 'path-escape',
      detail: expect.stringContaining('absolute rel path'),
    });
    expect(resolveCanonical).not.toHaveBeenCalled();
    expect(writeImage).not.toHaveBeenCalled();
  });

  test('realpath ENOENT surfaces as read-error (missing file along the chain)', async () => {
    const writeImage = vi.fn();
    const result = await copyImageToClipboard(
      baseDeps({
        clipboard: { writeImage },
        resolveCanonical: () => {
          throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
        },
      }),
      { src: 'http://localhost:5173/assets/missing.png', alt: 'x' },
    );
    expect(result).toEqual({
      ok: false,
      reason: 'read-error',
      detail: expect.stringContaining('no such file'),
    });
    expect(writeImage).not.toHaveBeenCalled();
  });

  test('readFile EACCES surfaces as read-error (permission denied)', async () => {
    const writeImage = vi.fn();
    const result = await copyImageToClipboard(
      baseDeps({
        clipboard: { writeImage },
        readFile: async () => {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        },
      }),
      { src: 'http://localhost:5173/assets/logo.png', alt: 'x' },
    );
    expect(result).toEqual({
      ok: false,
      reason: 'read-error',
      detail: expect.stringContaining('permission denied'),
    });
    expect(writeImage).not.toHaveBeenCalled();
  });

  test('non-image extension is refused at the disk-read gate (extension whitelist)', async () => {
    const writeImage = vi.fn();
    const readFile = vi.fn();
    const result = await copyImageToClipboard(
      baseDeps({
        clipboard: { writeImage },
        readFile,
      }),
      { src: 'http://localhost:5173/.ok/config.yml', alt: 'x' },
    );
    expect(result).toEqual({
      ok: false,
      reason: 'path-escape',
      detail: expect.stringContaining('unsupported ext'),
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(writeImage).not.toHaveBeenCalled();
  });

  test('realpath refuses a symlink escape (containment on canonical path, not lexical)', async () => {
    const writeImage = vi.fn();
    const result = await copyImageToClipboard(
      baseDeps({
        clipboard: { writeImage },
        resolveCanonical: () => '/etc/passwd',
      }),
      { src: 'http://localhost:5173/assets/logo.png', alt: 'x' },
    );
    expect(result).toEqual({
      ok: false,
      reason: 'path-escape',
      detail: expect.stringContaining('outside project'),
    });
    expect(writeImage).not.toHaveBeenCalled();
  });
});

describe('copyImageToClipboard — cross-origin fetch', () => {
  test('4xx / 5xx response resolves fetch-failed with HTTP status', async () => {
    const writeImage = vi.fn();
    const result = await copyImageToClipboard(
      baseDeps({
        clipboard: { writeImage },
        fetch: vi.fn(async () => new Response('', { status: 404 })),
      }),
      { src: 'https://cdn.example.com/missing.png', alt: 'x' },
    );
    expect(result).toEqual({
      ok: false,
      reason: 'fetch-failed',
      detail: 'HTTP 404',
    });
    expect(writeImage).not.toHaveBeenCalled();
  });

  test('fetch throw (network error, timeout) surfaces as fetch-failed', async () => {
    const writeImage = vi.fn();
    const result = await copyImageToClipboard(
      baseDeps({
        clipboard: { writeImage },
        fetch: vi.fn(async () => {
          throw new Error('boom');
        }),
      }),
      { src: 'https://cdn.example.com/foo.png', alt: 'x' },
    );
    expect(result).toEqual({
      ok: false,
      reason: 'fetch-failed',
      detail: 'boom',
    });
    expect(writeImage).not.toHaveBeenCalled();
  });
});

describe('copyImageToClipboard — decode + write', () => {
  test('empty-image branch when nativeImage.createFromBuffer decodes empty (SVG / AVIF / WebP)', async () => {
    const writeImage = vi.fn();
    const result = await copyImageToClipboard(
      baseDeps({
        clipboard: { writeImage },
        nativeImage: {
          createFromBuffer: () => ({ isEmpty: () => true }),
        },
      }),
      { src: 'https://cdn.example.com/x.svg', alt: 'x' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('empty-image');
    }
    expect(writeImage).not.toHaveBeenCalled();
  });

  test('happy path: writeImage called, ok:true returned', async () => {
    const writeImage = vi.fn();
    const result = await copyImageToClipboard(baseDeps({ clipboard: { writeImage } }), {
      src: 'https://cdn.example.com/pic.png',
      alt: 'x',
    });
    expect(result).toEqual({ ok: true });
    expect(writeImage).toHaveBeenCalledTimes(1);
  });

  test('writeImage throw surfaces as write-error (defends against NSPasteboard flakes)', async () => {
    const writeImage = vi.fn(() => {
      throw new Error('NSPasteboard write failed');
    });
    const result = await copyImageToClipboard(baseDeps({ clipboard: { writeImage } }), {
      src: 'https://cdn.example.com/pic.png',
      alt: 'x',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'write-error',
      detail: 'NSPasteboard write failed',
    });
  });
});
