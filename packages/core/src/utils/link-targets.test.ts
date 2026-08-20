import { describe, expect, test } from 'vitest';
import { skillFileLiveDocName } from '../constants/cc1.ts';
import {
  buildAbsoluteMarkdownHref,
  buildRelativeMarkdownHref,
  classifyMarkdownHref,
  classifyWikiLinkTarget,
  resolveAssetProjectPath,
} from './link-targets.ts';
import { resolveInternalHref } from './resolve-internal-href.ts';

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
      literal: false,
    });
  });

  test('an escaped extension dot still classifies as an asset', () => {
    // The extension is read off the decoded path. Reading it raw sees no
    // extension at all, and the href falls out of the classifier entirely —
    // neither doc nor asset — so nothing downstream can route the click.
    expect(classifyMarkdownHref('./meeting%2Epdf', 'docs/notes')).toEqual({
      kind: 'asset',
      url: './meeting%2Epdf',
      ext: 'pdf',
      literal: false,
    });
    // `url` stays the authored bytes: the asset resolver decodes it under
    // `literal: false`, so pre-decoding here would double-decode.
    expect(resolveAssetProjectPath('./meeting%2Epdf', 'docs/notes', { literal: false })).toBe(
      'docs/meeting.pdf',
    );
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
      literal: false,
    });
  });

  test('skill bundle ref from a SKILL doc resolves into the skill dir (§8.2)', () => {
    // Generic relative resolution would map `references/setup` to the content
    // root; the bundle overlay reaches the real ref doc under the skill dir.
    expect(classifyMarkdownHref('references/setup.md', '.ok/skills/demo/SKILL')).toEqual({
      kind: 'doc',
      docName: '.ok/skills/demo/references/setup',
      anchor: null,
    });
    expect(classifyMarkdownHref('references/setup#usage', '.ok/skills/demo/SKILL')).toEqual({
      kind: 'doc',
      docName: '.ok/skills/demo/references/setup',
      anchor: 'usage',
    });
    expect(classifyMarkdownHref('scripts/run', '.ok/skills/demo/SKILL')).toEqual({
      kind: 'doc',
      docName: '.ok/skills/demo/scripts/run',
      anchor: null,
    });
  });

  test('decodes percent-escapes in doc hrefs', () => {
    // Inherits the canonical resolver's RFC 3986 decoding — the doc kind must
    // carry the decoded docName, not the escaped bytes.
    expect(classifyMarkdownHref('./Agent%20Memory.md', 'blogs/drafts/index')).toEqual({
      kind: 'doc',
      docName: 'blogs/drafts/Agent Memory',
      anchor: null,
    });
  });

  test('malformed escapes classify as a doc with the raw bytes, without throwing', () => {
    expect(classifyMarkdownHref('./100%ZZ.md', 'docs/index')).toEqual({
      kind: 'doc',
      docName: 'docs/100%ZZ',
      anchor: null,
    });
  });

  test('bundle overlay is narrow: non-skill source is unaffected', () => {
    // `references/x` from a normal doc still resolves generically, not into a skill dir.
    expect(classifyMarkdownHref('references/setup.md', 'docs/index')?.docName).not.toBe(
      '.ok/skills/docs/references/setup',
    );
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
      literal: true,
    });
  });

  test('wiki asset targets carry literal: true so consumers inherit the plane', () => {
    // A consumer holding this target must not have to re-derive the plane from
    // context it may not have — the tag IS the answer it feeds to
    // `resolveAssetProjectPath`.
    const wiki = classifyWikiLinkTarget('100%20done.png', null);
    expect(wiki).toEqual({ kind: 'asset', url: '100%20done.png', ext: 'png', literal: true });
    const markdown = classifyMarkdownHref('./100%20done.png', 'notes/readme');
    expect(markdown).toEqual({
      kind: 'asset',
      url: './100%20done.png',
      ext: 'png',
      literal: false,
    });
    // The tags round-trip through the resolver to two different files.
    if (wiki?.kind !== 'asset' || markdown?.kind !== 'asset') throw new Error('expected assets');
    expect(resolveAssetProjectPath(wiki.url, 'notes/readme', { literal: wiki.literal })).toBe(
      'notes/100%20done.png',
    );
    expect(
      resolveAssetProjectPath(markdown.url, 'notes/readme', { literal: markdown.literal }),
    ).toBe('notes/100 done.png');
  });

  test('wiki targets are literal doc names — percent-escapes are never decoded', () => {
    // `[[Agent%20Memory]]` names a doc whose filename literally contains
    // `%20`; wiki targets are not URIs, so href decoding must not reach here.
    expect(classifyWikiLinkTarget('Agent%20Memory', null)).toEqual({
      kind: 'doc',
      docName: 'Agent%20Memory',
      anchor: null,
    });
  });
});

describe('resolveAssetProjectPath', () => {
  test('same-dir asset resolves to sourceDoc-dir/basename', () => {
    expect(resolveAssetProjectPath('./meeting.pdf', 'notes/readme', { literal: false })).toBe(
      'notes/meeting.pdf',
    );
  });

  test('parent-relative asset walks up one dir', () => {
    expect(resolveAssetProjectPath('../shared.pdf', 'notes/sub/readme', { literal: false })).toBe(
      'notes/shared.pdf',
    );
  });

  test('subdir-relative asset descends into sub', () => {
    expect(resolveAssetProjectPath('./assets/photo.png', 'docs/guide', { literal: false })).toBe(
      'docs/assets/photo.png',
    );
  });

  test('path escape above project root returns null', () => {
    expect(
      resolveAssetProjectPath('../../etc/passwd', 'notes/readme', { literal: false }),
    ).toBeNull();
  });

  test('strips anchor from returned path', () => {
    expect(
      resolveAssetProjectPath('./meeting.pdf#page=3', 'notes/readme', { literal: false }),
    ).toBe('notes/meeting.pdf');
  });

  test('server-absolute path is treated as project-root-relative (2026-04-24b)', () => {
    // Server-absolute
    // hrefs (`/`-leading) are emitted at drop time + post-roundtrip for
    // subdirectory docs so hash routing doesn't resolve them against the
    // wrong base. Treating them as external here breaks the asset-click
    // dispatcher for any asset that round-tripped through the server —
    // the click would fall through to external-URL handling rather than
    // reaching `shell.openAsset` in Electron.
    expect(resolveAssetProjectPath('/docs/file.pdf', 'notes/readme', { literal: false })).toBe(
      'docs/file.pdf',
    );
    expect(resolveAssetProjectPath('/vale_15.m4v', 'notes/readme', { literal: false })).toBe(
      'vale_15.m4v',
    );
    expect(resolveAssetProjectPath('/sub/dir/photo.png', 'docs/guide', { literal: false })).toBe(
      'sub/dir/photo.png',
    );
  });

  test('server-absolute path still refuses escape attempts', () => {
    // `..` in server-absolute paths is nonsensical (there's no relative
    // base) but a caller might construct `/../../etc/passwd` through a
    // URL parser. Containment is defense-in-depth — the main-process
    // `openAssetSafely` is the authoritative gate, but the renderer
    // shouldn't feed it escape attempts.
    expect(
      resolveAssetProjectPath('/../etc/passwd', 'notes/readme', { literal: false }),
    ).toBeNull();
    expect(
      resolveAssetProjectPath('/docs/../../../etc/passwd', 'notes/readme', { literal: false }),
    ).toBeNull();
  });

  test('HTTPS URL returns null', () => {
    expect(
      resolveAssetProjectPath('https://example.com/doc.pdf', 'notes/readme', { literal: false }),
    ).toBeNull();
  });

  test('source doc at root — `..` pop fails', () => {
    expect(resolveAssetProjectPath('../escape.pdf', 'readme', { literal: false })).toBeNull();
  });

  test('empty href returns null', () => {
    expect(resolveAssetProjectPath('', 'notes/readme', { literal: false })).toBeNull();
  });

  test('decodes percent-escapes in asset hrefs', () => {
    // Same RFC 3986 contract as the doc resolver: the returned value is a
    // filesystem location, so escaped bytes must decode to the real filename.
    expect(
      resolveAssetProjectPath('./design%20spec.pdf', 'blogs/drafts/index', { literal: false }),
    ).toBe('blogs/drafts/design spec.pdf');
  });

  // Asserted positively: a null return would satisfy any "not traversal" check
  // while quietly breaking every filename that legitimately carries the bytes.
  test('%2F in an asset href stays literal data under the source dir', () => {
    expect(
      resolveAssetProjectPath('..%2F..%2Fetc%2Fpasswd.pdf', 'notes/readme', { literal: false }),
    ).toBe('notes/..%2F..%2Fetc%2Fpasswd.pdf');
  });

  test('%5C in an asset href stays literal data under the source dir', () => {
    expect(
      resolveAssetProjectPath('..%5C..%5Cwindows.pdf', 'notes/readme', { literal: false }),
    ).toBe('notes/..%5C..%5Cwindows.pdf');
  });

  test('a literal asset target keeps its percent sequences undecoded', () => {
    expect(resolveAssetProjectPath('100%20done.png', 'notes/readme', { literal: true })).toBe(
      'notes/100%20done.png',
    );
  });

  test('a literal asset target never resolves to its decoded neighbour', () => {
    // The companion to the assertion above: `notes/100 done.png` is a
    // DIFFERENT file that may also exist. Decoding a literal target reports a
    // working link as dead and, worse, points Reveal/Open at the wrong file.
    expect(resolveAssetProjectPath('100%20done.png', 'notes/readme', { literal: true })).not.toBe(
      'notes/100 done.png',
    );
    // …and the markdown plane, given the same bytes, MUST reach that neighbour —
    // the two planes disagree by construction, which is why the option exists.
    expect(resolveAssetProjectPath('100%20done.png', 'notes/readme', { literal: false })).toBe(
      'notes/100 done.png',
    );
  });

  test('malformed escapes fall back to the raw asset path without throwing', () => {
    expect(resolveAssetProjectPath('./100%ZZ.pdf', 'notes/readme', { literal: false })).toBe(
      'notes/100%ZZ.pdf',
    );
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

  // An emitted destination must survive the resolver that reads it back. A bare
  // CommonMark destination cannot contain a literal space, so a doc name that
  // needs escaping has to be encoded here or the link does not parse at all.
  test('encodes a target name that cannot appear literally in a destination', () => {
    expect(buildRelativeMarkdownHref('blogs/drafts/index', 'blogs/drafts/Agent Memory')).toBe(
      './Agent%20Memory.md',
    );
  });

  test('keeps traversal markers structural while encoding the name', () => {
    expect(buildRelativeMarkdownHref('guides/nested/page', 'guides/Install Guide')).toBe(
      '../Install%20Guide.md',
    );
  });

  test('leaves the anchor byte-for-byte, matching the resolver', () => {
    expect(buildRelativeMarkdownHref('notes/index', 'notes/My Doc', 'a b')).toBe(
      './My%20Doc.md#a b',
    );
  });

  test.each([
    'Agent Memory',
    'team plan (draft) #1',
    'Q&A',
    'café',
    "it's here",
    '100% done',
  ])('round-trips %j back through the resolver', (name) => {
    const href = buildRelativeMarkdownHref('blogs/drafts/index', `blogs/drafts/${name}`);
    expect(resolveInternalHref(href, 'blogs/drafts/index')).toEqual({
      docName: `blogs/drafts/${name}`,
      anchor: null,
    });
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

  test('encodes each segment while keeping `/` as hierarchy', () => {
    expect(buildAbsoluteMarkdownHref('blogs/my drafts/Agent Memory')).toBe(
      '/blogs/my%20drafts/Agent%20Memory.md',
    );
  });

  test('round-trips a space-bearing name back through the resolver', () => {
    const href = buildAbsoluteMarkdownHref('blogs/drafts/Agent Memory');
    expect(resolveInternalHref(href, 'anywhere/else')).toEqual({
      docName: 'blogs/drafts/Agent Memory',
      anchor: null,
    });
  });
});

describe('/<skill-name> targets', () => {
  test('resolves to a sibling skill from a project skill body', () => {
    expect(classifyMarkdownHref('/graphics', '.agents/skills/brand/SKILL')).toEqual({
      kind: 'doc',
      docName: '.agents/skills/graphics/SKILL',
      anchor: null,
    });
  });

  test('resolves from a bundle reference too, against the skill root', () => {
    expect(classifyMarkdownHref('/gslides', '.claude/skills/brand/references/tone')).toEqual({
      kind: 'doc',
      docName: '.claude/skills/gslides/SKILL',
      anchor: null,
    });
  });

  test('a nested path is a path, not a skill name', () => {
    const target = classifyMarkdownHref('/a/b', '.agents/skills/brand/SKILL');
    expect(target?.kind === 'doc' ? target.docName : null).not.toBe('.agents/skills/a/SKILL');
  });

  test('a percent-encoded skill name still names the sibling skill', () => {
    expect(classifyMarkdownHref('/my%20skill', '.agents/skills/brand/SKILL')).toEqual({
      kind: 'doc',
      docName: '.agents/skills/my skill/SKILL',
      anchor: null,
    });
  });

  test('outside a skill it stays an ordinary path', () => {
    const target = classifyMarkdownHref('/graphics', 'notes/index');
    expect(target?.kind === 'doc' ? target.docName : null).not.toBe(
      '.agents/skills/graphics/SKILL',
    );
  });
});

describe('percent-encoded hrefs decode on every classify branch', () => {
  // `classifyMarkdownHref` dispatches to the skill-bundle resolver before the
  // generic one. An href is a URI on every branch, so a branch that skipped the
  // decode would keep resolving to a phantom doc.
  for (const scope of ['global', 'project'] as const) {
    test(`an encoded skill-bundle ref from a ${scope} SKILL.md decodes`, () => {
      const base = skillFileLiveDocName(scope, 'demo', 'SKILL');
      expect(classifyMarkdownHref('references/my%20ref.md', base)).toEqual({
        kind: 'doc',
        docName: skillFileLiveDocName(scope, 'demo', 'references/my ref'),
        anchor: null,
      });
    });
  }

  test('the anchor is returned verbatim, not decoded', () => {
    // Anchors feed heading-slug matching, whose byte contract is separate from
    // the path's. Pinned so a change to it is a deliberate decision, not drift.
    expect(classifyMarkdownHref('./Agent%20Memory.md#section%20two', 'blogs/drafts/index')).toEqual(
      { kind: 'doc', docName: 'blogs/drafts/Agent Memory', anchor: 'section%20two' },
    );
  });
});
