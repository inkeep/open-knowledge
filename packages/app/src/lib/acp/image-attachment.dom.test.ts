import { i18n } from '@lingui/core';
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import {
  ALLOWED_IMAGE_MIMES,
  type AttachmentRefusal,
  collectImageFiles,
  describeAttachmentRefusals,
  describeImageError,
  fileToAttachment,
  fileToImageAttachment,
  fitImageToBytes,
  type ImageShrinker,
  logAttachmentRejection,
  MAX_EMBEDDED_FILE_BYTES,
  MAX_IMAGE_BYTES,
  shrinkImageToFit,
} from './image-attachment.ts';
import { stubImageCanvas } from './image-canvas.test-helper.ts';

i18n.load('en', {});
i18n.activate('en');

function makeFile(bytes: Uint8Array, name: string, type: string): File {
  return new File([bytes], name, { type });
}

describe('fileToImageAttachment', () => {
  test('accepts a small PNG and returns an image AttachmentPart', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const file = makeFile(bytes, 'shot.png', 'image/png');
    const result = await fileToImageAttachment(file);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.part.kind).toBe('image');
      if (result.part.kind === 'image') {
        expect(result.part.mimeType).toBe('image/png');
        expect(result.part.name).toBe('shot.png');
        expect(result.part.data).toBe('AQIDBA==');
        expect(result.part.sizeBytes).toBe(4);
      }
    }
  });

  test('refuses SVG (not in the allowlist)', async () => {
    const file = makeFile(new Uint8Array([1]), 'evil.svg', 'image/svg+xml');
    const result = await fileToImageAttachment(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('unsupported-type');
    }
  });

  test('refuses a file whose mime is empty (drag-into-Chrome corner)', async () => {
    const file = makeFile(new Uint8Array([1]), 'noext', '');
    const result = await fileToImageAttachment(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('unsupported-type');
    }
  });

  test('refuses an image over the per-image cap when nothing here can shrink it', async () => {
    const bytes = new Uint8Array(MAX_IMAGE_BYTES + 1);
    const file = makeFile(bytes, 'huge.png', 'image/png');
    const result = await fileToImageAttachment(file);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'too-large', sizeBytes: bytes.length, limitBytes: MAX_IMAGE_BYTES },
    });
  });

  test('an image over the cap is sent as a copy shrunk to fit', async () => {
    const file = makeFile(new Uint8Array(MAX_IMAGE_BYTES * 3), 'photo.png', 'image/png');
    const shrink = vi.fn<ImageShrinker>(async () => ({
      blob: new Blob([new Uint8Array([7, 8, 9])], { type: 'image/webp' }),
      width: 2048,
      height: 1536,
    }));

    const result = await fileToImageAttachment(file, { shrink });

    expect(shrink).toHaveBeenCalledWith(file, [MAX_IMAGE_BYTES]);
    expect(result).toEqual({
      ok: true,
      part: {
        kind: 'image',
        data: 'BwgJ',
        mimeType: 'image/webp',
        name: 'photo.png',
        sizeBytes: 3,
      },
    });
  });

  test('an image over the cap that cannot shrink to fit is refused', async () => {
    const file = makeFile(new Uint8Array(MAX_IMAGE_BYTES * 3), 'photo.png', 'image/png');

    const result = await fileToImageAttachment(file, { shrink: async () => null });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('too-large');
  });

  test('an image over the cap that the browser cannot decode is refused as too large', async () => {
    stubImageCanvas();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => {
      warn.mockRestore();
      vi.unstubAllGlobals();
    });
    const bytes = new Uint8Array(MAX_IMAGE_BYTES * 2);

    const result = await fileToImageAttachment(makeFile(bytes, 'broken.png', 'image/png'));

    expect(result).toEqual({
      ok: false,
      error: { kind: 'too-large', sizeBytes: bytes.length, limitBytes: MAX_IMAGE_BYTES },
    });
  });

  test('a GIF over the cap is refused without shrinking, which would drop its animation', async () => {
    const file = makeFile(new Uint8Array(MAX_IMAGE_BYTES + 1), 'loop.gif', 'image/gif');
    const shrink = vi.fn<ImageShrinker>(async () => null);

    const result = await fileToImageAttachment(file, { shrink });

    expect(shrink).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  test('an image within what is left of the message is sent as it is', async () => {
    const file = makeFile(new Uint8Array([1, 2, 3, 4]), 'shot.png', 'image/png');
    const shrink = vi.fn<ImageShrinker>(async () => null);

    const result = await fileToImageAttachment(file, { budgetBytes: 10, shrink });

    expect(shrink).not.toHaveBeenCalled();
    expect(result.ok && result.part.kind === 'image' && result.part.mimeType).toBe('image/png');
  });

  test('an image that fits the cap but not what is left is shrunk to what is left', async () => {
    const file = makeFile(new Uint8Array(1000), 'second.png', 'image/png');
    const shrink = vi.fn<ImageShrinker>(async () => ({
      blob: new Blob([new Uint8Array(400)], { type: 'image/webp' }),
      width: 600,
      height: 400,
    }));

    const result = await fileToImageAttachment(file, { budgetBytes: 500, shrink });

    expect(shrink).toHaveBeenCalledWith(file, [500]);
    expect(result.ok && result.part.kind === 'image' && result.part.sizeBytes).toBe(400);
  });

  test('an image that fits the cap but cannot shrink into what is left is sent as it is, for the caller to budget', async () => {
    const file = makeFile(new Uint8Array(1000), 'second.png', 'image/png');
    const shrink = vi.fn<ImageShrinker>(async () => null);

    const result = await fileToImageAttachment(file, { budgetBytes: 500, shrink });

    expect(shrink).toHaveBeenCalledTimes(1);
    expect(result.ok && result.part.kind === 'image' && result.part.sizeBytes).toBe(1000);
  });

  test('an image over the cap that cannot shrink into what is left is shrunk to the cap, for the caller to budget', async () => {
    const file = makeFile(new Uint8Array(MAX_IMAGE_BYTES * 2), 'photo.png', 'image/png');
    const shrink = vi.fn<ImageShrinker>(async () => ({
      blob: new Blob([new Uint8Array(900)], { type: 'image/webp' }),
      width: 900,
      height: 600,
    }));

    const result = await fileToImageAttachment(file, { budgetBytes: 100, shrink });

    expect(shrink).toHaveBeenCalledWith(file, [100, MAX_IMAGE_BYTES]);
    expect(result.ok && result.part.kind === 'image' && result.part.sizeBytes).toBe(900);
  });

  test('an image over the cap is decoded once, however many sizes it is fitted to', async () => {
    stubImageCanvas({ width: 4000, height: 3000 });
    onTestFinished(() => vi.unstubAllGlobals());
    const file = makeFile(new Uint8Array(MAX_IMAGE_BYTES * 2), 'photo.png', 'image/png');

    const result = await fileToImageAttachment(file, { budgetBytes: 100 });

    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, part: { kind: 'image', mimeType: 'image/webp' } });
  });

  test('ALLOWED_IMAGE_MIMES intentionally excludes svg + bmp + tiff (agent-verified formats only)', () => {
    expect(ALLOWED_IMAGE_MIMES.has('image/png')).toBe(true);
    expect(ALLOWED_IMAGE_MIMES.has('image/jpeg')).toBe(true);
    expect(ALLOWED_IMAGE_MIMES.has('image/gif')).toBe(true);
    expect(ALLOWED_IMAGE_MIMES.has('image/webp')).toBe(true);
    expect(ALLOWED_IMAGE_MIMES.has('image/svg+xml')).toBe(false);
    expect(ALLOWED_IMAGE_MIMES.has('image/bmp')).toBe(false);
    expect(ALLOWED_IMAGE_MIMES.has('image/tiff')).toBe(false);
  });
});

describe('fitImageToBytes', () => {
  const byArea = (bytesPerPixel: number) =>
    vi.fn(
      async (width: number, height: number) =>
        new Blob([new Uint8Array(Math.round(width * height * bytesPerPixel))]),
    );

  test('caps the long edge first, then shrinks until the encoding fits', async () => {
    const encode = byArea(0.2);

    const fitted = await fitImageToBytes({ width: 4000, height: 3000 }, 300_000, encode);

    expect(encode.mock.calls[0]).toEqual([2048, 1536]);
    expect(fitted).not.toBeNull();
    expect(fitted?.blob.size).toBeLessThanOrEqual(300_000);
    expect(fitted?.width).toBeLessThan(2048);
    expect((fitted?.width ?? 0) / (fitted?.height ?? 1)).toBeCloseTo(4 / 3, 1);
  });

  test('re-encodes a smaller image at its own size first', async () => {
    const encode = byArea(0.1);

    const fitted = await fitImageToBytes({ width: 1000, height: 800 }, 1_000_000, encode);

    expect(encode).toHaveBeenCalledTimes(1);
    expect(fitted).toMatchObject({ width: 1000, height: 800 });
  });

  test('gives up rather than shrink below a readable size', async () => {
    const encode = byArea(1);

    expect(await fitImageToBytes({ width: 4000, height: 3000 }, 10, encode)).toBeNull();
    for (const [width, height] of encode.mock.calls) {
      expect(Math.max(width, height)).toBeGreaterThanOrEqual(512);
    }
  });
});

describe('shrinkImageToFit', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('encodes WebP where the browser can, and releases the decoded image', async () => {
    const { close } = stubImageCanvas({ width: 3000, height: 2000, bytesPerPixel: 0.05 });
    const file = makeFile(new Uint8Array(10), 'shot.png', 'image/png');

    const shrunk = await shrinkImageToFit(file, [150_000]);

    expect(shrunk?.blob.type).toBe('image/webp');
    expect(shrunk?.blob.size).toBeLessThanOrEqual(150_000);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('falls back to JPEG on white where the browser cannot encode WebP', async () => {
    const canvas = stubImageCanvas({
      encodes: (type) => (type === 'image/webp' ? 'image/png' : type),
    });
    const file = makeFile(new Uint8Array(10), 'shot.png', 'image/png');

    const shrunk = await shrinkImageToFit(file, [150_000]);

    expect(shrunk?.blob.type).toBe('image/jpeg');
    expect(shrunk && canvas.encodedCanvas(shrunk.blob)).toEqual({
      imageVisible: true,
      transparentAreaColor: '#ffffff',
    });
  });

  test('declines where there is no canvas to draw on', async () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    const file = makeFile(new Uint8Array(10), 'shot.png', 'image/png');

    expect(await shrinkImageToFit(file, [150_000])).toBeNull();
  });
});

describe('logAttachmentRejection', () => {
  test('records why, how big and what type, but not the file name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = makeFile(new Uint8Array(5), 'private-name.png', 'image/png');

    logAttachmentRejection('composer', file, { kind: 'total-too-large', limitBytes: 700 });

    expect(warn).toHaveBeenCalledWith('[acp-attachment] refused', {
      surface: 'composer',
      reason: 'total-too-large',
      sizeBytes: 5,
      mimeType: 'image/png',
      limitBytes: 700,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-name');
    warn.mockRestore();
  });
});

describe('describeImageError', () => {
  test('unsupported-type calls out the mime it saw', () => {
    expect(describeImageError({ kind: 'unsupported-type', mimeType: 'image/svg+xml' })).toContain(
      'image/svg+xml',
    );
  });

  test('too-large states the observed size and the per-attachment cap in the same unit, plus a remedy', () => {
    const message = describeImageError({
      kind: 'too-large',
      sizeBytes: 8_000_000,
      limitBytes: 5 * 1024 * 1024,
    });
    expect(message).toContain('too large');
    expect(message).toContain('7813 KB');
    expect(message).not.toContain('MB');
    expect(message).toContain('each attachment is capped at 5120 KB');
    expect(message).toContain('Crop or resize');
  });
});

describe('collectImageFiles', () => {
  function dataTransfer(files: File[], asItems = false): DataTransfer {
    if (asItems) {
      return {
        items: files.map((file) => ({
          kind: 'file' as const,
          type: file.type,
          getAsFile: () => file,
        })),
        files: [] as unknown as FileList,
      } as unknown as DataTransfer;
    }
    return {
      items: null as unknown as DataTransferItemList,
      files: {
        length: files.length,
        item: (i: number) => files[i] ?? null,
        [Symbol.iterator]: files[Symbol.iterator].bind(files),
        ...Object.fromEntries(files.map((f, i) => [i, f])),
      } as unknown as FileList,
    } as unknown as DataTransfer;
  }

  test('returns image files from `items` (paste path)', () => {
    const png = makeFile(new Uint8Array([1]), 'a.png', 'image/png');
    const jpg = makeFile(new Uint8Array([1]), 'b.jpg', 'image/jpeg');
    const out = collectImageFiles(dataTransfer([png, jpg], true));
    expect(out.map((f) => f.name)).toEqual(['a.png', 'b.jpg']);
  });

  test('skips non-image files (a text drop next to a picture)', () => {
    const png = makeFile(new Uint8Array([1]), 'a.png', 'image/png');
    const txt = makeFile(new Uint8Array([1]), 'a.txt', 'text/plain');
    const out = collectImageFiles(dataTransfer([png, txt], true));
    expect(out.map((f) => f.name)).toEqual(['a.png']);
  });

  function pastedOnBothAccessors(fromItems: File, fromFiles: File): DataTransfer {
    return {
      items: [{ kind: 'file' as const, type: fromItems.type, getAsFile: () => fromItems }],
      files: {
        length: 1,
        item: (i: number) => (i === 0 ? fromFiles : null),
        0: fromFiles,
      } as unknown as FileList,
    } as unknown as DataTransfer;
  }

  test('reads one payload once: items wins and the files mirror is not consulted', () => {
    const at = (lastModified: number) =>
      new File([new Uint8Array([1])], 'a.png', { type: 'image/png', lastModified });
    const fromItems = at(1_700_000_000_000);
    const fromFiles = at(1_700_000_000_000);
    const out = collectImageFiles(pastedOnBothAccessors(fromItems, fromFiles));
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(fromItems);
  });

  test('one payload stays one file even when the two reads disagree on lastModified', () => {
    const at = (lastModified: number) =>
      new File([new Uint8Array([1])], 'image.png', { type: 'image/png', lastModified });
    const fromItems = at(1_787_337_196_630);
    const out = collectImageFiles(pastedOnBothAccessors(fromItems, at(1_787_337_196_629)));
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(fromItems);
  });

  test('falls back to files when items yields nothing', () => {
    const png = makeFile(new Uint8Array([1]), 'a.png', 'image/png');
    expect(collectImageFiles(dataTransfer([png])).map((f) => f.name)).toEqual(['a.png']);
  });

  test('falls back to files when every items entry yields a null File', () => {
    const png = makeFile(new Uint8Array([1]), 'a.png', 'image/png');
    const dt = {
      items: [{ kind: 'file' as const, type: 'image/png', getAsFile: () => null }],
      files: {
        length: 1,
        item: (i: number) => (i === 0 ? png : null),
        0: png,
      } as unknown as FileList,
    } as unknown as DataTransfer;
    expect(collectImageFiles(dt).map((f) => f.name)).toEqual(['a.png']);
  });

  test('does not top up from files when only some items entries yield null', () => {
    const good = makeFile(new Uint8Array([1]), 'good.png', 'image/png');
    const mirrored = makeFile(new Uint8Array([2]), 'mirrored.png', 'image/png');
    const dt = {
      items: [
        { kind: 'string' as const, type: 'text/html', getAsFile: () => null },
        { kind: 'file' as const, type: 'image/png', getAsFile: () => null },
        { kind: 'file' as const, type: 'image/png', getAsFile: () => good },
      ],
      files: {
        length: 2,
        item: (i: number) => [mirrored, good][i] ?? null,
        0: mirrored,
        1: good,
      } as unknown as FileList,
    } as unknown as DataTransfer;
    expect(collectImageFiles(dt).map((f) => f.name)).toEqual(['good.png']);
  });

  test('null DataTransfer returns []', () => {
    expect(collectImageFiles(null)).toEqual([]);
  });
});

describe('fileToAttachment — workspace containment (security-critical)', () => {
  const TXT = 'text/plain';
  const makeTxt = (name: string) => makeFile(new Uint8Array([65, 66, 67]), name, TXT);
  const embeddedText = (name: string) => ({
    kind: 'blob',
    data: 'ABC',
    textPayload: true,
    mimeType: TXT,
    name,
    sizeBytes: 3,
  });

  test('POSIX: file directly inside the workspace root → file part with the workspace-relative path', async () => {
    const file = makeTxt('notes.md');
    const outcome = await fileToAttachment(file, {
      absPathOf: () => '/work/project/notes.md',
      workspaceContentDir: '/work/project',
      pathSeparator: '/',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.part).toEqual({ kind: 'file', path: 'notes.md', name: 'notes.md' });
    }
  });

  test('POSIX: file in a nested subdirectory → workspace-relative path preserved', async () => {
    const file = makeTxt('spec.md');
    const outcome = await fileToAttachment(file, {
      absPathOf: () => '/work/project/docs/2026/spec.md',
      workspaceContentDir: '/work/project',
      pathSeparator: '/',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.part.kind === 'file') {
      expect(outcome.part.path).toBe('docs/2026/spec.md');
    }
  });

  test('POSIX: a sibling-prefix path is never referenced by path — /work/project-evil vs /work/project', async () => {
    const file = makeTxt('secrets.md');
    const outcome = await fileToAttachment(file, {
      absPathOf: () => '/work/project-evil/secrets.md',
      workspaceContentDir: '/work/project',
      pathSeparator: '/',
    });
    expect(outcome.ok && outcome.part).toEqual(embeddedText('secrets.md'));
  });

  test('POSIX: a file outside the workspace travels with the message instead of by path', async () => {
    const file = makeTxt('personal.md');
    const outcome = await fileToAttachment(file, {
      absPathOf: () => '/home/user/Documents/personal.md',
      workspaceContentDir: '/work/project',
      pathSeparator: '/',
    });
    expect(outcome.ok && outcome.part).toEqual(embeddedText('personal.md'));
  });

  test('POSIX: trailing-slash root is tolerated', async () => {
    const outcome = await fileToAttachment(makeTxt('a.md'), {
      absPathOf: () => '/work/project/a.md',
      workspaceContentDir: '/work/project/',
      pathSeparator: '/',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.part.kind === 'file') {
      expect(outcome.part.path).toBe('a.md');
    }
  });

  test('POSIX: absPath == workspace root itself (dropped folder) → empty relative path', async () => {
    const outcome = await fileToAttachment(makeTxt('root'), {
      absPathOf: () => '/work/project',
      workspaceContentDir: '/work/project',
      pathSeparator: '/',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.part.kind === 'file') {
      expect(outcome.part.path).toBe('');
    }
  });

  test('Windows: file inside root normalizes backslashes to forward slashes', async () => {
    const outcome = await fileToAttachment(makeTxt('notes.md'), {
      absPathOf: () => 'C:\\Work\\Project\\docs\\notes.md',
      workspaceContentDir: 'C:\\Work\\Project',
      pathSeparator: '\\',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.part.kind === 'file') {
      expect(outcome.part.path).toBe('docs/notes.md');
    }
  });

  test('Windows: case-insensitive comparison — mixed-case abs matches lower-case root', async () => {
    const outcome = await fileToAttachment(makeTxt('a.md'), {
      absPathOf: () => 'c:\\WORK\\Project\\a.md',
      workspaceContentDir: 'C:\\work\\project',
      pathSeparator: '\\',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.part.kind === 'file') {
      expect(outcome.part.path).toBe('a.md');
    }
  });

  test('Windows: a sibling-prefix path is never referenced by path (case-insensitive)', async () => {
    const outcome = await fileToAttachment(makeTxt('bad.md'), {
      absPathOf: () => 'C:\\Work\\Project-Evil\\bad.md',
      workspaceContentDir: 'C:\\Work\\Project',
      pathSeparator: '\\',
    });
    expect(outcome.ok && outcome.part).toEqual(embeddedText('bad.md'));
  });

  test('with no path resolver (web host) the file travels with the message', async () => {
    const outcome = await fileToAttachment(makeTxt('a.md'), {
      workspaceContentDir: '/work/project',
      pathSeparator: '/',
    });
    expect(outcome.ok && outcome.part).toEqual(embeddedText('a.md'));
  });

  test('when the resolver gives up the file travels with the message', async () => {
    const outcome = await fileToAttachment(makeTxt('a.md'), {
      absPathOf: () => null,
      workspaceContentDir: '/work/project',
      pathSeparator: '/',
    });
    expect(outcome.ok && outcome.part).toEqual(embeddedText('a.md'));
  });

  test('a binary file with no path is refused by name and told to use @ once it is in the project', async () => {
    const outcome = await fileToAttachment(
      makeFile(new Uint8Array([0, 1, 2, 255]), 'receipt.pdf', 'application/pdf'),
      {},
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toEqual({ kind: 'not-text', name: 'receipt.pdf', location: 'unknown' });
      expect(describeImageError(outcome.error)).toBe(
        "receipt.pdf isn't a text file, so it can't be sent with the message. Mention it with @ once it's in your project.",
      );
    }
  });

  test('a binary file outside the project is told to add it to the project first', async () => {
    const outcome = await fileToAttachment(
      makeFile(new Uint8Array([0, 1, 2, 255]), 'receipt.pdf', 'application/pdf'),
      {
        absPathOf: () => '/home/user/Downloads/receipt.pdf',
        workspaceContentDir: '/work/project',
        pathSeparator: '/',
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toEqual({
        kind: 'not-text',
        name: 'receipt.pdf',
        location: 'outside-project',
      });
      expect(describeImageError(outcome.error)).toBe(
        "receipt.pdf isn't a text file, so it can't be sent with the message. Add it to your project, then mention it with @.",
      );
    }
  });

  test('text is recognised by its bytes, so a source file the OS mislabels still travels as text', async () => {
    const source = new TextEncoder().encode('export const x = 1;\n');
    const outcome = await fileToAttachment(makeFile(source, 'x.ts', 'video/mp2t'), {});
    expect(outcome.ok && outcome.part).toMatchObject({
      kind: 'blob',
      data: 'export const x = 1;\n',
      textPayload: true,
      mimeType: 'text/plain',
    });
    const invalidUtf8 = await fileToAttachment(
      makeFile(new Uint8Array([0xc3, 0x28]), 'y.txt', TXT),
      {},
    );
    expect(invalidUtf8.ok).toBe(false);
  });

  test('a file over the per-attachment cap is refused with its name', async () => {
    const big = makeFile(new Uint8Array(MAX_EMBEDDED_FILE_BYTES + 1), 'huge.log', TXT);
    const outcome = await fileToAttachment(big, {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toEqual({
        kind: 'file-too-large',
        name: 'huge.log',
        location: 'unknown',
        limitBytes: MAX_EMBEDDED_FILE_BYTES,
      });
      expect(describeImageError(outcome.error)).toContain('huge.log');
    }
  });

  test('image files still short-circuit through the image path, ignoring workspace deps', async () => {
    const png = makeFile(new Uint8Array([1, 2, 3]), 'shot.png', 'image/png');
    const outcome = await fileToAttachment(png, {});
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.part.kind).toBe('image');
  });
});

describe('describeAttachmentRefusals', () => {
  const capKb = Math.round(MAX_EMBEDDED_FILE_BYTES / 1024);
  const notText = (name: string, location: 'outside-project' | 'unknown'): AttachmentRefusal => ({
    kind: 'not-text',
    name,
    location,
  });

  test('refusals of one kind become one notice that names every file', () => {
    expect(
      describeAttachmentRefusals([notText('a.pdf', 'unknown'), notText('b.zip', 'unknown')]),
    ).toEqual([
      "a.pdf and b.zip aren't text files, so they can't be sent with the message. Mention them with @ once they're in your project.",
    ]);
  });

  test('each kind and location gets its own notice, in the order first seen', () => {
    expect(
      describeAttachmentRefusals([
        {
          kind: 'file-too-large',
          name: 'big.log',
          location: 'outside-project',
          limitBytes: MAX_EMBEDDED_FILE_BYTES,
        },
        notText('a.pdf', 'outside-project'),
        notText('b.pdf', 'unknown'),
        notText('c.pdf', 'outside-project'),
      ]),
    ).toEqual([
      `big.log is larger than ${capKb} KB, so it can't be sent with the message. Add it to your project, then mention it with @.`,
      "a.pdf and c.pdf aren't text files, so they can't be sent with the message. Add them to your project, then mention them with @.",
      "b.pdf isn't a text file, so it can't be sent with the message. Mention it with @ once it's in your project.",
    ]);
  });

  test('three refusals are all named', () => {
    const [message] = describeAttachmentRefusals(
      ['a.pdf', 'b.pdf', 'c.pdf'].map((name) => notText(name, 'unknown')),
    );
    expect(message).toBe(
      "a.pdf, b.pdf, and c.pdf aren't text files, so they can't be sent with the message. Mention them with @ once they're in your project.",
    );
  });

  test('the file list is joined the way the active language joins lists', () => {
    i18n.load('es', {});
    i18n.activate('es');
    try {
      const [message] = describeAttachmentRefusals(
        ['a.pdf', 'b.pdf', 'c.pdf'].map((name) => notText(name, 'unknown')),
      );
      expect(message?.startsWith('a.pdf, b.pdf y c.pdf ')).toBe(true);
    } finally {
      i18n.activate('en');
    }
  });

  test('a long list names the first files and counts the rest', () => {
    const [message] = describeAttachmentRefusals(
      ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf'].map((name) => notText(name, 'unknown')),
    );
    expect(message).toBe(
      "a.pdf, b.pdf, and 3 others aren't text files, so they can't be sent with the message. Mention them with @ once they're in your project.",
    );
  });
});
