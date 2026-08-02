import { describe, expect, test } from 'vitest';
import {
  getFileExtension,
  hasSupportedDocumentExtension,
  replaceFileExtension,
  validateAndCoerceRenameDestination,
} from './file-tree-rename-validation';

describe('getFileExtension', () => {
  test('returns .md for a bare basename with .md', () => {
    expect(getFileExtension('foo.md')).toBe('.md');
  });

  test('returns .mdx for a bare basename with .mdx', () => {
    expect(getFileExtension('foo.mdx')).toBe('.mdx');
  });

  test('returns the empty string when there is no extension', () => {
    expect(getFileExtension('foo')).toBe('');
  });

  test('strips the directory before parsing extension', () => {
    expect(getFileExtension('meetings/2026/q1/notes.md')).toBe('.md');
  });

  test('handles a path with no slash and no dot', () => {
    expect(getFileExtension('README')).toBe('');
  });

  test('returns the empty string for a dotfile (leading dot is part of the name)', () => {
    expect(getFileExtension('.gitignore')).toBe('');
  });

  test('returns the empty string for a dotfile inside a directory', () => {
    expect(getFileExtension('project/.env')).toBe('');
  });

  test('returns the LAST extension for a multi-dot basename', () => {
    expect(getFileExtension('report.2026.md')).toBe('.md');
  });

  test('returns the case-preserved extension', () => {
    expect(getFileExtension('foo.MD')).toBe('.MD');
  });

  test('returns a non-md extension when present (e.g. .tx)', () => {
    expect(getFileExtension('foo.tx')).toBe('.tx');
  });

  test('returns the extension when a directory segment contains a dot but the basename does not', () => {
    expect(getFileExtension('docs.v1/draft')).toBe('');
  });

  test('returns the empty string for an empty input', () => {
    expect(getFileExtension('')).toBe('');
  });
});

describe('replaceFileExtension', () => {
  test('replaces a .tx extension with .md', () => {
    expect(replaceFileExtension('foo.tx', '.md')).toBe('foo.md');
  });

  test('appends the extension when basename has none', () => {
    expect(replaceFileExtension('foo', '.md')).toBe('foo.md');
  });

  test('preserves the directory portion verbatim', () => {
    expect(replaceFileExtension('a/b/foo.tx', '.md')).toBe('a/b/foo.md');
  });

  test('preserves a deep directory path', () => {
    expect(replaceFileExtension('meetings/2026/q1/foo.tx', '.md')).toBe('meetings/2026/q1/foo.md');
  });

  test('keeps multi-dot basename intact, only swaps the LAST extension', () => {
    expect(replaceFileExtension('report.2026.tx', '.md')).toBe('report.2026.md');
  });

  test('treats a dotfile as having no extension (appends, not replaces)', () => {
    expect(replaceFileExtension('.gitignore', '.md')).toBe('.gitignore.md');
  });

  test('normalizes extension casing to the new ext (preserves source-of-truth casing)', () => {
    expect(replaceFileExtension('foo.MD', '.md')).toBe('foo.md');
  });

  test('round-trips a same-extension path to itself', () => {
    expect(replaceFileExtension('foo.md', '.md')).toBe('foo.md');
  });

  test('replaces with .mdx', () => {
    expect(replaceFileExtension('foo.md', '.mdx')).toBe('foo.mdx');
  });
});

describe('validateAndCoerceRenameDestination — allow paths', () => {
  test('matching extension allows the rename', () => {
    expect(validateAndCoerceRenameDestination('foo.md', 'bar.md', false)).toEqual({
      kind: 'allow',
      destinationPath: 'bar.md',
    });
  });

  test('user omitted the extension → coerce destination back to the source extension', () => {
    // Basename-only commits can still happen if the user deletes the visible
    // suffix. This path preserves the source extension on disk.
    expect(validateAndCoerceRenameDestination('foo.md', 'bar', false)).toEqual({
      kind: 'allow',
      destinationPath: 'bar.md',
    });
  });

  test('basename-only destination preserves source extension on commit', () => {
    const source = 'specs/RELEASES.md';
    const userTypedBasename = 'specs/RELEASES-v2';
    const result = validateAndCoerceRenameDestination(source, userTypedBasename, false);
    expect(result).toEqual({
      kind: 'allow',
      destinationPath: 'specs/RELEASES-v2.md',
    });
  });

  test('user used a different casing of the same supported extension → preserve typed casing', () => {
    expect(validateAndCoerceRenameDestination('foo.md', 'bar.MD', false)).toEqual({
      kind: 'allow',
      destinationPath: 'bar.MD',
    });
  });

  test('matching extension at depth is preserved', () => {
    expect(validateAndCoerceRenameDestination('meetings/foo.md', 'meetings/bar.md', false)).toEqual(
      {
        kind: 'allow',
        destinationPath: 'meetings/bar.md',
      },
    );
  });

  test('source has no extension → allow as-is (nothing to preserve)', () => {
    expect(validateAndCoerceRenameDestination('Configuration', 'Configuration.md', false)).toEqual({
      kind: 'allow',
      destinationPath: 'Configuration.md',
    });
  });

  test('source is a dotfile (.gitignore) → allow as-is (no extension to preserve)', () => {
    expect(validateAndCoerceRenameDestination('.gitignore', '.gitkeep', false)).toEqual({
      kind: 'allow',
      destinationPath: '.gitkeep',
    });
  });

  test('multi-dot basename matches source extension → allow with coerced ext', () => {
    expect(validateAndCoerceRenameDestination('foo.md', 'report.2026.md', false)).toEqual({
      kind: 'allow',
      destinationPath: 'report.2026.md',
    });
  });

  test('.mdx source preserves .mdx when user retypes it', () => {
    expect(validateAndCoerceRenameDestination('foo.mdx', 'bar.mdx', false)).toEqual({
      kind: 'allow',
      destinationPath: 'bar.mdx',
    });
  });

  test('.mdx source with basename-only destination coerces to .mdx', () => {
    expect(validateAndCoerceRenameDestination('foo.mdx', 'bar', false)).toEqual({
      kind: 'allow',
      destinationPath: 'bar.mdx',
    });
  });

  test('user changes document extension .md → .mdx explicitly', () => {
    expect(validateAndCoerceRenameDestination('foo.md', 'bar.mdx', false)).toEqual({
      kind: 'allow',
      destinationPath: 'bar.mdx',
    });
  });

  test('user changes document extension .mdx → .md explicitly', () => {
    expect(validateAndCoerceRenameDestination('foo.mdx', 'bar.md', false)).toEqual({
      kind: 'allow',
      destinationPath: 'bar.md',
    });
  });

  test('user types an arbitrary document extension (.md → .tx) → allow as-is', () => {
    expect(validateAndCoerceRenameDestination('foo.md', 'bar.tx', false)).toEqual({
      kind: 'allow',
      destinationPath: 'bar.tx',
    });
  });

  test('arbitrary extension allowance is independent of directory depth', () => {
    expect(
      validateAndCoerceRenameDestination('meetings/2026/foo.md', 'meetings/2026/foo.notes', false),
    ).toEqual({
      kind: 'allow',
      destinationPath: 'meetings/2026/foo.notes',
    });
  });

  test('user adds a multi-dot suffix that looks like a different extension → allow as-is', () => {
    expect(validateAndCoerceRenameDestination('foo.md', 'report.2026', false)).toEqual({
      kind: 'allow',
      destinationPath: 'report.2026',
    });
  });

  test('arbitrary extension allowance preserves typed casing', () => {
    expect(validateAndCoerceRenameDestination('foo.md', 'bar.TX', false)).toEqual({
      kind: 'allow',
      destinationPath: 'bar.TX',
    });
  });
});

describe('hasSupportedDocumentExtension', () => {
  test('recognizes managed markdown extensions case-insensitively', () => {
    expect(hasSupportedDocumentExtension('foo.md')).toBe(true);
    expect(hasSupportedDocumentExtension('foo.MDX')).toBe(true);
  });

  test('returns false for arbitrary file extensions', () => {
    expect(hasSupportedDocumentExtension('foo.txt')).toBe(false);
    expect(hasSupportedDocumentExtension('foo')).toBe(false);
  });
});

describe('validateAndCoerceRenameDestination — folder short-circuit', () => {
  test('folder rename always allows the destination as-is (no extension to preserve)', () => {
    expect(validateAndCoerceRenameDestination('meetings', 'archived-meetings', true)).toEqual({
      kind: 'allow',
      destinationPath: 'archived-meetings',
    });
  });

  test('folder rename with trailing slash passes through verbatim', () => {
    expect(validateAndCoerceRenameDestination('meetings/2026/', 'meetings/2027/', true)).toEqual({
      kind: 'allow',
      destinationPath: 'meetings/2027/',
    });
  });

  test('folder named "something.md" still treated as folder (isFolder wins)', () => {
    expect(validateAndCoerceRenameDestination('docs/notes.md/', 'docs/renamed.md/', true)).toEqual({
      kind: 'allow',
      destinationPath: 'docs/renamed.md/',
    });
  });
});

describe('validateAndCoerceRenameDestination — asset paths', () => {
  test('asset rename allows extension changes as-is', () => {
    expect(validateAndCoerceRenameDestination('media/image.png', 'media/image.jpg', false)).toEqual(
      {
        kind: 'allow',
        destinationPath: 'media/image.jpg',
      },
    );
  });

  test('asset rename preserves the source extension when omitted', () => {
    expect(validateAndCoerceRenameDestination('media/image.png', 'media/image', false)).toEqual({
      kind: 'allow',
      destinationPath: 'media/image.png',
    });
  });
});

describe('validateAndCoerceRenameDestination — doubled document extension', () => {
  // Pierre pre-selects only the stem and leaves the extension in place, so a
  // user who types a whole filename ending in `.md` commits `name.md` plus the
  // retained `.md`. `name.md.md` on disk carries docName `name.md`, which maps
  // back to the tree path of a DIFFERENT file — two files, one tree path.
  test('typed name already ending in .md collapses the retained extension', () => {
    expect(
      validateAndCoerceRenameDestination(
        'brain/research/Untitled.md',
        'brain/research/codebase-audit-backlog-v2.md.md',
        false,
      ),
    ).toEqual({
      kind: 'allow',
      destinationPath: 'brain/research/codebase-audit-backlog-v2.md',
    });
  });

  test('typed name already ending in .mdx collapses the retained extension', () => {
    expect(validateAndCoerceRenameDestination('foo.mdx', 'bar.mdx.mdx', false)).toEqual({
      kind: 'allow',
      destinationPath: 'bar.mdx',
    });
  });

  test('typed .md over an .mdx source keeps the typed extension', () => {
    expect(validateAndCoerceRenameDestination('foo.mdx', 'bar.md.mdx', false)).toEqual({
      kind: 'allow',
      destinationPath: 'bar.md',
    });
  });

  test('typed .mdx over a .md source keeps the typed extension', () => {
    expect(validateAndCoerceRenameDestination('foo.md', 'bar.mdx.md', false)).toEqual({
      kind: 'allow',
      destinationPath: 'bar.mdx',
    });
  });

  test('collapse preserves the casing the user typed', () => {
    expect(validateAndCoerceRenameDestination('foo.md', 'bar.MD.md', false)).toEqual({
      kind: 'allow',
      destinationPath: 'bar.MD',
    });
  });

  test('collapse preserves the directory portion', () => {
    expect(
      validateAndCoerceRenameDestination(
        'meetings/2026/foo.md',
        'meetings/2026/notes.md.md',
        false,
      ),
    ).toEqual({
      kind: 'allow',
      destinationPath: 'meetings/2026/notes.md',
    });
  });

  test('a multi-dot basename whose stem is not a document extension is left alone', () => {
    expect(validateAndCoerceRenameDestination('foo.md', 'v1.2.md', false)).toEqual({
      kind: 'allow',
      destinationPath: 'v1.2.md',
    });
  });

  test('a dotted name that merely looks like a version suffix is left alone', () => {
    expect(validateAndCoerceRenameDestination('foo.md', 'report.2026.md', false)).toEqual({
      kind: 'allow',
      destinationPath: 'report.2026.md',
    });
  });

  test('an asset source is left alone even when the typed name carries a document extension', () => {
    // Collapsing here would retitle an image to `notes.md`.
    expect(
      validateAndCoerceRenameDestination('media/image.png', 'media/notes.md.png', false),
    ).toEqual({
      kind: 'allow',
      destinationPath: 'media/notes.md.png',
    });
  });

  test('a doubled asset extension is left alone (no docName round-trip to break)', () => {
    expect(
      validateAndCoerceRenameDestination('media/photo.png', 'media/photo.png.png', false),
    ).toEqual({
      kind: 'allow',
      destinationPath: 'media/photo.png.png',
    });
  });

  test('an uppercase source extension still collapses its retained suffix', () => {
    // Guard 1 case-folds; guard 2 matches the retained suffix verbatim, which
    // is exactly the string sliced off the source. Lowercasing the retained
    // suffix anywhere in that chain would silently stop collapse from firing.
    expect(validateAndCoerceRenameDestination('foo.MD', 'bar.MD.MD', false)).toEqual({
      kind: 'allow',
      destinationPath: 'bar.MD',
    });
  });

  test('only the one retained layer comes off a deliberately doubled typed name', () => {
    expect(validateAndCoerceRenameDestination('foo.md', 'v1.md.md.md', false)).toEqual({
      kind: 'allow',
      destinationPath: 'v1.md.md',
    });
  });

  test('a stem-less destination is left alone (docName `.md` still resolves to its own file)', () => {
    expect(validateAndCoerceRenameDestination('foo.md', '.md.md', false)).toEqual({
      kind: 'allow',
      destinationPath: '.md.md',
    });
  });
});
