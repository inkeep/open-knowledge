import { describe, expect, test } from 'vitest';
import {
  ALLOWED_IMAGE_MIMES,
  collectImageFiles,
  describeImageError,
  fileToAttachment,
  fileToImageAttachment,
  MAX_IMAGE_BYTES,
} from './image-attachment.ts';

// jsdom's File requires bytes as `BlobPart`. A plain Uint8Array works fine.
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
        // base64 of [1,2,3,4] = 'AQIDBA=='
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

  test('refuses a file above the per-image cap without reading its bytes', async () => {
    const bytes = new Uint8Array(MAX_IMAGE_BYTES + 1);
    const file = makeFile(bytes, 'huge.png', 'image/png');
    const result = await fileToImageAttachment(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('too-large');
      if (result.error.kind === 'too-large') {
        expect(result.error.sizeBytes).toBe(bytes.length);
        expect(result.error.limitBytes).toBe(MAX_IMAGE_BYTES);
      }
    }
  });

  test('ALLOWED_IMAGE_MIMES intentionally excludes svg + bmp + tiff (agent-verified formats only)', () => {
    expect(ALLOWED_IMAGE_MIMES.has('image/png')).toBe(true);
    expect(ALLOWED_IMAGE_MIMES.has('image/jpeg')).toBe(true);
    expect(ALLOWED_IMAGE_MIMES.has('image/gif')).toBe(true);
    expect(ALLOWED_IMAGE_MIMES.has('image/webp')).toBe(true);
    // Deliberate omissions — see the module doc.
    expect(ALLOWED_IMAGE_MIMES.has('image/svg+xml')).toBe(false);
    expect(ALLOWED_IMAGE_MIMES.has('image/bmp')).toBe(false);
    expect(ALLOWED_IMAGE_MIMES.has('image/tiff')).toBe(false);
  });
});

describe('describeImageError', () => {
  test('unsupported-type calls out the mime it saw', () => {
    expect(describeImageError({ kind: 'unsupported-type', mimeType: 'image/svg+xml' })).toContain(
      'image/svg+xml',
    );
  });

  test('too-large names the observed size + limit in MB', () => {
    const message = describeImageError({
      kind: 'too-large',
      sizeBytes: 8_000_000,
      limitBytes: 5 * 1024 * 1024,
    });
    expect(message).toContain('too large');
    expect(message).toContain('7.6 MB');
    expect(message).toContain('5.0 MB');
  });
});

describe('collectImageFiles', () => {
  /** Build a minimal DataTransfer-shaped object; jsdom's constructor is
   *  read-only, so a bespoke stub keeps this test dependency-free. */
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

  test('deduplicates a file that shows up on both items and files', () => {
    const png = makeFile(new Uint8Array([1]), 'a.png', 'image/png');
    const dt = {
      items: [{ kind: 'file' as const, type: 'image/png', getAsFile: () => png }],
      files: {
        length: 1,
        item: (i: number) => (i === 0 ? png : null),
        0: png,
      } as unknown as FileList,
    } as unknown as DataTransfer;
    const out = collectImageFiles(dt);
    expect(out).toHaveLength(1);
  });

  test('null DataTransfer returns []', () => {
    expect(collectImageFiles(null)).toEqual([]);
  });
});

describe('fileToAttachment — workspace containment (security-critical)', () => {
  const TXT = 'text/plain';
  const makeTxt = (name: string) => makeFile(new Uint8Array([65, 66, 67]), name, TXT);

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

  test('POSIX: sibling-prefix path is REFUSED — /work/project-evil vs /work/project', async () => {
    // This is the specific attack the sibling-guard defends against:
    // naive `startsWith(root)` would let `/work/project-evil/…` pass because
    // its prefix matches `/work/project`. The `startsWith(root + sep)` check
    // is what saves us.
    const file = makeTxt('secrets.md');
    const outcome = await fileToAttachment(file, {
      absPathOf: () => '/work/project-evil/secrets.md',
      workspaceContentDir: '/work/project',
      pathSeparator: '/',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe('outside-workspace');
    }
  });

  test('POSIX: file completely outside the workspace → refused', async () => {
    const file = makeTxt('personal.md');
    const outcome = await fileToAttachment(file, {
      absPathOf: () => '/home/user/Documents/personal.md',
      workspaceContentDir: '/work/project',
      pathSeparator: '/',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe('outside-workspace');
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
    // Empty rel is a valid workspace-relative address for the root itself.
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.part.kind === 'file') {
      expect(outcome.part.path).toBe('');
    }
  });

  test('Windows: file inside root normalizes backslashes to forward slashes', async () => {
    // Wire contract: workspace paths always POSIX-style on the wire even on
    // Windows, so the server + agent see a single canonical shape.
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

  test('Windows: sibling-prefix attack refused (case-insensitive)', async () => {
    const outcome = await fileToAttachment(makeTxt('bad.md'), {
      absPathOf: () => 'C:\\Work\\Project-Evil\\bad.md',
      workspaceContentDir: 'C:\\Work\\Project',
      pathSeparator: '\\',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe('outside-workspace');
  });

  test('no absPathOf resolver → unknown-path (web host without Electron)', async () => {
    const outcome = await fileToAttachment(makeTxt('a.md'), {
      workspaceContentDir: '/work/project',
      pathSeparator: '/',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe('unknown-path');
  });

  test('resolver returns null (Electron webUtils gave up) → unknown-path', async () => {
    const outcome = await fileToAttachment(makeTxt('a.md'), {
      absPathOf: () => null,
      workspaceContentDir: '/work/project',
      pathSeparator: '/',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe('unknown-path');
  });

  test('image files still short-circuit through the image path, ignoring workspace deps', async () => {
    // Images can come from anywhere (OS clipboard, downloads), so the
    // containment check MUST NOT gate them. This test pins that separation.
    const png = makeFile(new Uint8Array([1, 2, 3]), 'shot.png', 'image/png');
    const outcome = await fileToAttachment(png, {
      // Deliberately no absPathOf / contentDir — should not matter for images.
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.part.kind).toBe('image');
  });
});
