import { describe, expect, test } from 'bun:test';
import { FileText, Film, FolderOpen, Image, Volume2 } from 'lucide-react';
import { getFileIcon, mentionPathToDescriptor } from './file-icons.ts';

/**
 * Icon-parity contract: `getFileIcon` maps a workspace entry to the same lucide
 * glyph the sidebar shows. Asserts the resolved component identity so a future
 * mapping change is caught.
 */
describe('getFileIcon', () => {
  test('folder → FolderOpen', () => {
    expect(getFileIcon({ kind: 'folder' })).toBe(FolderOpen);
  });

  test('markdown page → FileText', () => {
    expect(getFileIcon({ kind: 'page' })).toBe(FileText);
  });

  test('name-only file with no media kind → FileText', () => {
    expect(getFileIcon({ kind: 'file' })).toBe(FileText);
    expect(getFileIcon({ kind: 'file', mediaKind: null })).toBe(FileText);
  });

  test('asset mediaKind drives the glyph', () => {
    expect(getFileIcon({ kind: 'asset', mediaKind: 'image' })).toBe(Image);
    expect(getFileIcon({ kind: 'asset', mediaKind: 'video' })).toBe(Film);
    expect(getFileIcon({ kind: 'asset', mediaKind: 'audio' })).toBe(Volume2);
    // pdf / text have no dedicated sidebar glyph → document icon.
    expect(getFileIcon({ kind: 'asset', mediaKind: 'pdf' })).toBe(FileText);
    expect(getFileIcon({ kind: 'asset', mediaKind: 'text' })).toBe(FileText);
  });

  test('asset falls back to assetExt when mediaKind is absent', () => {
    expect(getFileIcon({ kind: 'asset', assetExt: 'png' })).toBe(Image);
    expect(getFileIcon({ kind: 'asset', assetExt: 'mp4' })).toBe(Film);
    expect(getFileIcon({ kind: 'asset', assetExt: 'mp3' })).toBe(Volume2);
    // Unknown / document-class extension → document icon.
    expect(getFileIcon({ kind: 'asset', assetExt: 'csv' })).toBe(FileText);
  });

  test('mediaKind wins over assetExt when both are present', () => {
    // A null mediaKind is an explicit "no viewer" answer and must not fall
    // through to the assetExt branch — that would re-derive a glyph the entry
    // already declared absent.
    expect(getFileIcon({ kind: 'asset', mediaKind: null, assetExt: 'png' })).toBe(FileText);
  });

  test('extension casing and a leading dot are tolerated', () => {
    expect(getFileIcon({ kind: 'asset', assetExt: '.PNG' })).toBe(Image);
  });
});

/**
 * `mentionPathToDescriptor` is the single path→descriptor derivation shared by
 * the `@`-picker row, the top-row context chip, and the inline mention chip, so
 * all three resolve the SAME glyph for a given path. Mirrors how each kind
 * serializes its path (folder = bare path; page = `.md`; asset = real ext).
 */
describe('mentionPathToDescriptor', () => {
  test('no basename extension → folder', () => {
    expect(mentionPathToDescriptor('specs/foo')).toEqual({ kind: 'folder' });
    expect(mentionPathToDescriptor('specs')).toEqual({ kind: 'folder' });
    // A dot in a DIRECTORY segment (not the basename) is still a folder.
    expect(mentionPathToDescriptor('a.b/foo')).toEqual({ kind: 'folder' });
  });

  test('.md / .mdx basename → page', () => {
    expect(mentionPathToDescriptor('notes.md')).toEqual({ kind: 'page' });
    expect(mentionPathToDescriptor('specs/foo/SPEC.md')).toEqual({ kind: 'page' });
    expect(mentionPathToDescriptor('doc.mdx')).toEqual({ kind: 'page' });
  });

  test('any other extension → asset carrying the lowercased ext', () => {
    expect(mentionPathToDescriptor('docs/diagram.PNG')).toEqual({ kind: 'asset', assetExt: 'png' });
    expect(mentionPathToDescriptor('clip.mp4')).toEqual({ kind: 'asset', assetExt: 'mp4' });
  });

  test('round-trips through getFileIcon to the right glyph', () => {
    expect(getFileIcon(mentionPathToDescriptor('specs/foo'))).toBe(FolderOpen);
    expect(getFileIcon(mentionPathToDescriptor('notes.md'))).toBe(FileText);
    expect(getFileIcon(mentionPathToDescriptor('docs/diagram.png'))).toBe(Image);
    expect(getFileIcon(mentionPathToDescriptor('clip.mp4'))).toBe(Film);
    expect(getFileIcon(mentionPathToDescriptor('song.mp3'))).toBe(Volume2);
  });
});
