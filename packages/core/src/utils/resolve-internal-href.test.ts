import { describe, expect, test } from 'vitest';
import { skillFileLiveDocName } from '../constants/cc1.ts';
import {
  decodeHrefPathSegment,
  encodeHrefPath,
  encodeHrefPathSegment,
  resolveInternalHref,
} from './resolve-internal-href.ts';

describe('resolveInternalHref', () => {
  test('resolves same-directory relative links', () => {
    expect(resolveInternalHref('./other', 'notes')).toEqual({ docName: 'other', anchor: null });
    expect(resolveInternalHref('./other.md', 'notes')).toEqual({ docName: 'other', anchor: null });
    expect(resolveInternalHref('sibling.md', 'notes')).toEqual({
      docName: 'sibling',
      anchor: null,
    });
  });

  test('resolves links relative to nested source docs', () => {
    expect(resolveInternalHref('../overview.md', 'folder/page')).toEqual({
      docName: 'overview',
      anchor: null,
    });
    expect(resolveInternalHref('../sibling/other.md', 'folder/page')).toEqual({
      docName: 'sibling/other',
      anchor: null,
    });
  });

  test('preserves anchors while stripping query strings and .md extensions', () => {
    expect(resolveInternalHref('./page.md#section', 'notes')).toEqual({
      docName: 'page',
      anchor: 'section',
    });
    expect(resolveInternalHref('./page.md?q=1#frag', 'notes')).toEqual({
      docName: 'page',
      anchor: 'frag',
    });
  });

  test('resolves links with .mdx extension stripped', () => {
    expect(resolveInternalHref('./other.mdx', 'notes')).toEqual({
      docName: 'other',
      anchor: null,
    });
    expect(resolveInternalHref('../sibling/component.mdx', 'folder/page')).toEqual({
      docName: 'sibling/component',
      anchor: null,
    });
    expect(resolveInternalHref('./page.mdx#section', 'notes')).toEqual({
      docName: 'page',
      anchor: 'section',
    });
  });

  test('returns null for external and anchor-only hrefs', () => {
    expect(resolveInternalHref('https://example.com', 'notes')).toBeNull();
    expect(resolveInternalHref('mailto:foo@bar.com', 'notes')).toBeNull();
    expect(resolveInternalHref('//example.com/page', 'notes')).toBeNull();
    expect(resolveInternalHref('#section', 'notes')).toBeNull();
  });

  test('resolves root-absolute hrefs from the content root', () => {
    expect(resolveInternalHref('/absolute/path.md', 'notes')).toEqual({
      docName: 'absolute/path',
      anchor: null,
    });
    expect(resolveInternalHref('/absolute/path#intro', 'notes')).toEqual({
      docName: 'absolute/path',
      anchor: 'intro',
    });
  });

  test('returns null when relative traversal would escape the content root', () => {
    expect(resolveInternalHref('../../escape.md', 'folder/page')).toBeNull();
    expect(resolveInternalHref('../../../way-out.md', 'deep/a/b')).toBeNull();
  });

  // A CommonMark link destination is URI-shaped: a literal space cannot appear
  // in an unbracketed destination, so percent-escapes are the only valid way to
  // link a doc whose name needs them (RFC 3986). Resolving the encoded href of
  // a path must therefore yield the same docName as resolving the path itself.
  describe('percent-encoded hrefs', () => {
    test('decodes %20 in a relative href to reach the real doc', () => {
      expect(resolveInternalHref('./Agent%20Memory.md', 'blogs/drafts/index')).toEqual({
        docName: 'blogs/drafts/Agent Memory',
        anchor: null,
      });
    });

    test('decodes root-absolute encoded hrefs from the content root', () => {
      expect(resolveInternalHref('/blogs/drafts/Agent%20Memory.md', 'notes')).toEqual({
        docName: 'blogs/drafts/Agent Memory',
        anchor: null,
      });
    });

    test('preserves the anchor while decoding the path portion', () => {
      expect(resolveInternalHref('./Agent%20Memory.md#usage', 'blogs/drafts/index')).toEqual({
        docName: 'blogs/drafts/Agent Memory',
        anchor: 'usage',
      });
    });

    test('decodes parens, hash, and ampersand escapes in filenames', () => {
      expect(resolveInternalHref('./team%20plan%20%28draft%29%20%231.md', 'notes/index')).toEqual({
        docName: 'notes/team plan (draft) #1',
        anchor: null,
      });
      expect(resolveInternalHref('./R%26D%20notes.md', 'notes/index')).toEqual({
        docName: 'notes/R&D notes',
        anchor: null,
      });
    });

    test('decodes non-ASCII escapes', () => {
      expect(resolveInternalHref('./caf%C3%A9.md', 'notes/index')).toEqual({
        docName: 'notes/café',
        anchor: null,
      });
    });

    test('an escaped extension dot still refuses the href as an asset', () => {
      // The non-markdown-extension guard has to read the same bytes the
      // resolved docName is built from. `%2E` carries no literal dot, so a
      // guard that runs before decoding sees an extension-less path, admits
      // the asset as a doc, and the click dispatcher navigates the router to a
      // doc named `notes/file.pdf` that cannot exist.
      expect(resolveInternalHref('./file%2Epdf', 'notes/index')).toBeNull();
      expect(resolveInternalHref('/assets/photo%2Ejpg', 'notes/index')).toBeNull();
      // The escaped-dot form and the plain form must agree.
      expect(resolveInternalHref('./file.pdf', 'notes/index')).toBeNull();
    });

    test('an escaped dot in a markdown filename still resolves as a doc', () => {
      // Precision guard for the reorder above: the decoded extension decides,
      // so an escaped dot in front of `md` stays a doc rather than being
      // refused wholesale as an asset.
      expect(resolveInternalHref('./v1%2E2%20notes.md', 'notes/index')).toEqual({
        docName: 'notes/v1.2 notes',
        anchor: null,
      });
    });

    test('%2F never becomes a path separator', () => {
      // RFC 3986: an escaped slash inside a segment is data, not hierarchy.
      // Decoding it into a separator would let one segment become two.
      // Pinned by exact value: a variant that refuses the href outright
      // (returning null) is also wrong, and a negative assertion would miss it.
      expect(resolveInternalHref('./a%2Fb.md', 'blogs/drafts/index')).toEqual({
        docName: 'blogs/drafts/a%2Fb',
        anchor: null,
      });
    });

    test('%2F-bearing escapes cannot pop above the content root', () => {
      expect(resolveInternalHref('./..%2F..%2Fescape.md', 'blogs/drafts/index')).toEqual({
        docName: 'blogs/drafts/..%2F..%2Fescape',
        anchor: null,
      });
    });

    test('%5C never becomes a path separator', () => {
      // A backslash is a separator on Windows, so a decode that mints one is
      // the same hierarchy-minting the `%2F` refusal exists to prevent.
      expect(resolveInternalHref('./a%5Cb.md', 'blogs/drafts/index')).toEqual({
        docName: 'blogs/drafts/a%5Cb',
        anchor: null,
      });
      expect(resolveInternalHref('./..%5C..%5Cwin.md', 'docs/a/b')).toEqual({
        docName: 'docs/a/..%5C..%5Cwin',
        anchor: null,
      });
    });

    test('encoded dot-segments stay data — they never become traversal', () => {
      // The traversal check reads the DECODED segment, so the escape surviving
      // as data is `decodeHrefPathSegment`'s doing, not the walk's: it refuses
      // any decode whose result is `.` or `..`, so `%2E%2E` never becomes a
      // segment the pop could see. That refusal is the load-bearing dependency
      // here — if it ever softened, these hrefs would start traversing.
      expect(resolveInternalHref('./%2E%2E/secret.md', 'blogs/drafts/index')).toEqual({
        docName: 'blogs/drafts/%2E%2E/secret',
        anchor: null,
      });
      expect(resolveInternalHref('./%2E/secret.md', 'blogs/drafts/index')).toEqual({
        docName: 'blogs/drafts/%2E/secret',
        anchor: null,
      });
    });

    test('an encoded NUL stays literal', () => {
      expect(resolveInternalHref('./bad%00name.md', 'notes/index')).toEqual({
        docName: 'notes/bad%00name',
        anchor: null,
      });
    });

    // The guard reads the extension off decoded bytes, so the strip has to as
    // well — otherwise an escaped `.md` is admitted as a doc and then carried
    // into the docName, which is extension-less by contract.
    test('an escaped doc extension is stripped, not carried into the docName', () => {
      expect(resolveInternalHref('./meeting%2Emd', 'notes/index')).toEqual({
        docName: 'notes/meeting',
        anchor: null,
      });
      expect(resolveInternalHref('./meeting%2Emdx', 'notes/index')).toEqual({
        docName: 'notes/meeting',
        anchor: null,
      });
    });

    // What the extension strip leaves behind is still a path segment: `...md`
    // reduces to `..` and must pop, never land in the docName. A docName
    // carrying `.`/`..` is indexed, graphed, and offered for creation as a
    // wrong-doc resolution well before downstream containment sees it.
    test('a stripped extension that exposes a traversal segment traverses', () => {
      expect(resolveInternalHref('./...md', 'notes/index')).toBeNull();
      expect(resolveInternalHref('./...md', 'index')).toBeNull();
      expect(resolveInternalHref('./..md', 'notes/index')).toEqual({
        docName: 'notes',
        anchor: null,
      });
    });

    // The escaped spelling reduces to the same segment as the plain one, so it
    // has to reach the same verdict — `decodeHrefPathSegment` refuses a segment
    // that IS `.`/`..`, but `...md` is neither until the extension comes off.
    test('an escaped traversal-after-strip matches its plain spelling', () => {
      expect(resolveInternalHref('./%2E%2E%2Emd', 'notes/index')).toBeNull();
      expect(resolveInternalHref('./..%2Emd', 'notes/index')).toBeNull();
    });

    // A segment that is nothing BUT an extension contributes nothing, rather
    // than emptying the accumulated path.
    test('a bare extension segment resolves to its containing directory', () => {
      expect(resolveInternalHref('./.md', 'notes/index')).toEqual({
        docName: 'notes',
        anchor: null,
      });
      expect(resolveInternalHref('./sub/.md', 'notes/index')).toEqual({
        docName: 'notes/sub',
        anchor: null,
      });
    });

    // A colon decodes, drive-letter-shaped or not. Refusing the escaped spelling
    // would leave the plain one (`/D:foo.md`, which never reaches the decoder)
    // untouched, so it would not actually contain anything — while making
    // `D:plan`, a legal POSIX filename, permanently unresolvable through an
    // encoded link. Containment lives downstream, where it covers both spellings.
    test('a colon decodes rather than being refused', () => {
      expect(resolveInternalHref('./notes%3A2026.md', 'notes/index')).toEqual({
        docName: 'notes/notes:2026',
        anchor: null,
      });
      expect(resolveInternalHref('./D%3Aplan.md', 'notes/index')).toEqual({
        docName: 'notes/D:plan',
        anchor: null,
      });
    });

    test('escaped octets decode exactly once', () => {
      // RFC 3986 §2.4: `%2520` denotes the literal bytes `%20` in the filename.
      // A second decode pass would collapse it to a space and miss the doc.
      expect(resolveInternalHref('./100%2520done.md', 'notes/index')).toEqual({
        docName: 'notes/100%20done',
        anchor: null,
      });
    });

    test('malformed escapes fall back to the raw bytes without throwing', () => {
      // Hrefs are user-authored strings parsed out of markdown bytes; a stray
      // `%` must degrade to a literal lookup, never a URIError.
      expect(resolveInternalHref('./100%ZZ.md', 'notes/index')).toEqual({
        docName: 'notes/100%ZZ',
        anchor: null,
      });
      expect(resolveInternalHref('./50%.md', 'notes/index')).toEqual({
        docName: 'notes/50%',
        anchor: null,
      });
    });
  });

  // A skill's SKILL.md links to its references with skill-relative paths
  // (`references/setup.md`). With the file's own bundle doc as the base, those
  // resolve to the sibling reference doc instead of a nonexistent content path —
  // the fix for §8.3 (valid skill references rendering as broken links).
  describe('skill bundle relative references (§8.3)', () => {
    for (const scope of ['global', 'project'] as const) {
      test(`references/setup.md from a ${scope} SKILL.md → the reference doc`, () => {
        const base = skillFileLiveDocName(scope, 'demo', 'SKILL');
        expect(resolveInternalHref('references/setup.md', base)).toEqual({
          docName: skillFileLiveDocName(scope, 'demo', 'references/setup'),
          anchor: null,
        });
      });
      test(`a sibling link from a ${scope} reference resolves within references/`, () => {
        const base = skillFileLiveDocName(scope, 'demo', 'references/setup');
        expect(resolveInternalHref('anti-patterns.md', base)).toEqual({
          docName: skillFileLiveDocName(scope, 'demo', 'references/anti-patterns'),
          anchor: null,
        });
      });
    }
  });
});

describe('encodeHrefPathSegment', () => {
  // The encode/decode pair is the contract this whole module exists to hold:
  // every href OK emits must resolve back to the name it was built from.
  // Splitting the halves is what let an encoded link and a decoding resolver
  // disagree in the first place.
  const names = [
    'Agent Memory',
    'team plan (draft) #1',
    'R&D notes',
    "don't panic!",
    'café résumé',
    '100%20done',
    '..',
    '.',
    'plain',
  ];

  for (const name of names) {
    test(`round-trips ${JSON.stringify(name)}`, () => {
      expect(decodeHrefPathSegment(encodeHrefPathSegment(name))).toBe(name);
    });
  }

  test('does not round-trip a separator-bearing name — by design', () => {
    // The decoder refuses any decode that would mint hierarchy, so a name
    // containing `/` or `\` survives as its escaped form rather than decoding
    // back. Such a name cannot address a real file through an href; wiki links
    // are the escape hatch. This is the deliberate limit of the pair above.
    expect(decodeHrefPathSegment(encodeHrefPathSegment('a/b'))).toBe('a%2Fb');
    expect(decodeHrefPathSegment(encodeHrefPathSegment('a\\b'))).toBe('a%5Cb');
  });

  test('never emits a character that terminates a bare link destination', () => {
    for (const name of names) {
      if (name === '.' || name === '..') continue;
      expect(encodeHrefPathSegment(name)).not.toMatch(/[ ()#?]/);
    }
  });

  test('keeps `/` as hierarchy and leaves traversal markers structural', () => {
    expect(encodeHrefPath('../a b/c#d')).toBe('../a%20b/c%23d');
  });
});
