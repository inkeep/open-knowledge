import { describe, expect, test } from 'bun:test';
import {
  buildAbsoluteMarkdownHref,
  buildRelativeMarkdownHref,
  classifyMarkdownHref,
  classifyWikiLinkTarget,
  resolveAssetProjectPath,
} from './link-targets.ts';

describe('classifyMarkdownHref', () => {
  test('returns null for empty hrefs', () => {
    expect(classifyMarkdownHref('', 'docs/index')).toBeNull();
  });

  test('classifies internal document hrefs', () => {
    expect(classifyMarkdownHref('./guide.md#install', 'docs/index')).toEqual({
      kind: 'doc',
      docName: 'docs/guide',
      anchor: 'install',
    });
  });

  test('classifies anchor-only hrefs', () => {
    expect(classifyMarkdownHref('#intro', 'docs/index')).toEqual({
      kind: 'anchor',
      anchor: 'intro',
    });
  });

  test('returns null for empty anchor-only hrefs', () => {
    expect(classifyMarkdownHref('#', 'docs/index')).toBeNull();
  });

  test('classifies external hrefs', () => {
    expect(classifyMarkdownHref('https://example.com/docs', 'docs/index')).toEqual({
      kind: 'external',
      url: 'https://example.com/docs',
    });
  });

  test('classifies protocol-relative hrefs as external', () => {
    expect(classifyMarkdownHref('//cdn.example.com/lib.js', 'docs/index')).toEqual({
      kind: 'external',
      url: '//cdn.example.com/lib.js',
    });
  });

  test('classifies root-absolute document hrefs as internal docs', () => {
    expect(classifyMarkdownHref('/docs/guide.md#install', 'notes/readme')).toEqual({
      kind: 'doc',
      docName: 'docs/guide',
      anchor: 'install',
    });
  });

  test('classifies non-markdown relative paths as asset', () => {
    expect(classifyMarkdownHref('./meeting.pdf', 'docs/notes')).toEqual({
      kind: 'asset',
      url: './meeting.pdf',
      ext: 'pdf',
    });
  });

  test('strips .mdx extension when resolving doc-link', () => {
    expect(classifyMarkdownHref('./guide.mdx', 'docs/index')).toEqual({
      kind: 'doc',
      docName: 'docs/guide',
      anchor: null,
    });
  });

  test('HTTPS URL with asset extension stays external (not asset)', () => {
    expect(classifyMarkdownHref('https://example.com/doc.pdf', 'docs/index')).toEqual({
      kind: 'external',
      url: 'https://example.com/doc.pdf',
    });
  });

  test('root-absolute path with asset extension is an asset', () => {
    expect(classifyMarkdownHref('/docs/file.pdf', 'notes/readme')).toEqual({
      kind: 'asset',
      url: '/docs/file.pdf',
      ext: 'pdf',
    });
  });
});

describe('classifyWikiLinkTarget', () => {
  test('returns null for empty targets', () => {
    expect(classifyWikiLinkTarget('', 'anchor')).toBeNull();
  });

  test('classifies document wiki targets', () => {
    expect(classifyWikiLinkTarget('guides/install', 'intro')).toEqual({
      kind: 'doc',
      docName: 'guides/install',
      anchor: 'intro',
    });
  });

  test('classifies external wiki targets', () => {
    expect(classifyWikiLinkTarget('https://example.com/docs', 'section')).toEqual({
      kind: 'external',
      url: 'https://example.com/docs#section',
    });
  });

  test('classifies image wiki targets as assets', () => {
    expect(classifyWikiLinkTarget('/docs/public/Wide.png', null)).toEqual({
      kind: 'asset',
      url: '/docs/public/Wide.png',
      ext: 'png',
    });
  });
});

describe('resolveAssetProjectPath', () => {
  test('same-dir asset resolves to sourceDoc-dir/basename', () => {
    expect(resolveAssetProjectPath('./meeting.pdf', 'notes/readme')).toBe('notes/meeting.pdf');
  });

  test('parent-relative asset walks up one dir', () => {
    expect(resolveAssetProjectPath('../shared.pdf', 'notes/sub/readme')).toBe('notes/shared.pdf');
  });

  test('subdir-relative asset descends into sub', () => {
    expect(resolveAssetProjectPath('./assets/photo.png', 'docs/guide')).toBe(
      'docs/assets/photo.png',
    );
  });

  test('path escape above project root returns null', () => {
    expect(resolveAssetProjectPath('../../etc/passwd', 'notes/readme')).toBeNull();
  });

  test('strips anchor from returned path', () => {
    expect(resolveAssetProjectPath('./meeting.pdf#page=3', 'notes/readme')).toBe(
      'notes/meeting.pdf',
    );
  });

  test('server-absolute path is treated as project-root-relative (2026-04-24b)', () => {
    // Server-absolute
    // hrefs (`/`-leading) are emitted at drop time + post-roundtrip for
    // subdirectory docs so hash routing doesn't resolve them against the
    // wrong base. Treating them as external here breaks the asset-click
    // dispatcher for any asset that round-tripped through the server —
    // the click would fall through to external-URL handling rather than
    // reaching `shell.openAsset` in Electron.
    expect(resolveAssetProjectPath('/docs/file.pdf', 'notes/readme')).toBe('docs/file.pdf');
    expect(resolveAssetProjectPath('/vale_15.m4v', 'notes/readme')).toBe('vale_15.m4v');
    expect(resolveAssetProjectPath('/sub/dir/photo.png', 'docs/guide')).toBe('sub/dir/photo.png');
  });

  test('server-absolute path still refuses escape attempts', () => {
    // `..` in server-absolute paths is nonsensical (there's no relative
    // base) but a caller might construct `/../../etc/passwd` through a
    // URL parser. Containment is defense-in-depth — the main-process
    // `openAssetSafely` is the authoritative gate, but the renderer
    // shouldn't feed it escape attempts.
    expect(resolveAssetProjectPath('/../etc/passwd', 'notes/readme')).toBeNull();
    expect(resolveAssetProjectPath('/docs/../../../etc/passwd', 'notes/readme')).toBeNull();
  });

  test('HTTPS URL returns null', () => {
    expect(resolveAssetProjectPath('https://example.com/doc.pdf', 'notes/readme')).toBeNull();
  });

  test('source doc at root — `..` pop fails', () => {
    expect(resolveAssetProjectPath('../escape.pdf', 'readme')).toBeNull();
  });

  test('empty href returns null', () => {
    expect(resolveAssetProjectPath('', 'notes/readme')).toBeNull();
  });
});

describe('buildRelativeMarkdownHref', () => {
  test('builds same-directory hrefs with dot prefix', () => {
    expect(buildRelativeMarkdownHref('notes/index', 'notes/guide', 'intro')).toBe(
      './guide.md#intro',
    );
  });

  test('builds parent-relative hrefs across directories', () => {
    expect(buildRelativeMarkdownHref('guides/nested/page', 'guides/install', null)).toBe(
      '../install.md',
    );
  });

  test('honors a non-default extension for the target', () => {
    expect(buildRelativeMarkdownHref('docs/index', 'docs/guide', null, '.mdx')).toBe('./guide.mdx');
  });
});

describe('buildAbsoluteMarkdownHref', () => {
  test('builds a root-absolute href from an extension-less docName', () => {
    expect(buildAbsoluteMarkdownHref('wiki/modules/tasks')).toBe('/wiki/modules/tasks.md');
  });

  test('appends an anchor when given', () => {
    expect(buildAbsoluteMarkdownHref('docs/guide', '.md', 'install')).toBe(
      '/docs/guide.md#install',
    );
  });

  test('honors a non-default extension', () => {
    expect(buildAbsoluteMarkdownHref('guides/widget', '.mdx')).toBe('/guides/widget.mdx');
  });
});
