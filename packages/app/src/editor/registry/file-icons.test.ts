import { FileText, Film, FolderOpen, Image, Volume2 } from 'lucide-react';
import { describe, expect, test } from 'vitest';
import { getFileIcon, mentionPathToDescriptor } from './file-icons.ts';

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
    expect(getFileIcon({ kind: 'asset', mediaKind: 'pdf' })).toBe(FileText);
    expect(getFileIcon({ kind: 'asset', mediaKind: 'text' })).toBe(FileText);
  });

  test('asset falls back to assetExt when mediaKind is absent', () => {
    expect(getFileIcon({ kind: 'asset', assetExt: 'png' })).toBe(Image);
    expect(getFileIcon({ kind: 'asset', assetExt: 'mp4' })).toBe(Film);
    expect(getFileIcon({ kind: 'asset', assetExt: 'mp3' })).toBe(Volume2);
    expect(getFileIcon({ kind: 'asset', assetExt: 'csv' })).toBe(FileText);
  });

  test('mediaKind wins over assetExt when both are present', () => {
    expect(getFileIcon({ kind: 'asset', mediaKind: null, assetExt: 'png' })).toBe(FileText);
  });

  test('extension casing and a leading dot are tolerated', () => {
    expect(getFileIcon({ kind: 'asset', assetExt: '.PNG' })).toBe(Image);
  });
});

describe('mentionPathToDescriptor', () => {
  test('no basename extension → folder', () => {
    expect(mentionPathToDescriptor('specs/foo')).toEqual({ kind: 'folder' });
    expect(mentionPathToDescriptor('specs')).toEqual({ kind: 'folder' });
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
