import { templateContentDocName } from '@inkeep/open-knowledge-core';
import { describe, expect, test, vi } from 'vitest';
import {
  anchorFromHash,
  assetPathFromHash,
  docNameFromHash,
  encodeShareTargetForHash,
  encodeSkillPreviewSegments,
  hashFromAssetPath,
  hashFromDocName,
  hashFromFolderPath,
  hashFromSkillFile,
  hashFromSkillPreview,
  isContentRootHash,
  isManagedHashHistoryState,
  isSameHash,
  markCurrentHashHistoryEntry,
  pushHashWithoutNavigation,
  replaceHashWithoutNavigation,
  type SkillFileHashTarget,
  type SkillPreviewHashTarget,
  selectedPathForSkillPreview,
  skillFileFromHash,
  skillPreviewFromHash,
} from './doc-hash';
import { skillLiveDocName } from './managed-artifact-doc-name';

describe('docNameFromHash', () => {
  test('returns null for empty hash', () => {
    expect(docNameFromHash('')).toBeNull();
  });

  test('returns null for bare #/', () => {
    expect(docNameFromHash('#/')).toBeNull();
  });

  test('returns null for non-#/ hash', () => {
    expect(docNameFromHash('#heading')).toBeNull();
  });

  test('parses simple doc name', () => {
    expect(docNameFromHash('#/README')).toBe('README');
  });

  test('parses nested path', () => {
    expect(docNameFromHash('#/folder/sub/page')).toBe('folder/sub/page');
  });

  test('preserves trailing slash for folder intent', () => {
    expect(docNameFromHash('#/folder/sub/')).toBe('folder/sub/');
  });

  test('strips query string', () => {
    expect(docNameFromHash('#/doc?branch=feature')).toBe('doc');
  });

  test('strips browser-style anchor fragment', () => {
    expect(docNameFromHash('#/doc#heading')).toBe('doc');
  });

  test('strips query string from nested path', () => {
    expect(docNameFromHash('#/folder/doc?branch=feature&foo=bar')).toBe('folder/doc');
  });

  test('strips browser-style anchor fragment from nested path', () => {
    expect(docNameFromHash('#/folder/doc#heading')).toBe('folder/doc');
  });

  test('decodes percent-encoded spaces', () => {
    expect(docNameFromHash('#/My%20Notes/draft')).toBe('My Notes/draft');
  });

  test('decodes non-ASCII (em dash)', () => {
    expect(docNameFromHash('#/Ideas%20%E2%80%94%202026/draft')).toBe('Ideas — 2026/draft');
  });

  test('falls back on malformed encoding', () => {
    expect(docNameFromHash('#/bad%ZZpath')).toBe('bad%ZZpath');
  });

  test('malformed segment falls back to entire raw string', () => {
    expect(docNameFromHash('#/good%20segment/%ZZ/other')).toBe('good%20segment/%ZZ/other');
  });
});

describe('anchorFromHash', () => {
  test('returns null for hashes outside document routing', () => {
    expect(anchorFromHash('')).toBeNull();
    expect(anchorFromHash('#heading')).toBeNull();
    expect(anchorFromHash('#/doc')).toBeNull();
  });

  test('ignores query-param anchors', () => {
    expect(anchorFromHash('#/doc?anchor=heading')).toBeNull();
    expect(anchorFromHash('#/doc?foo=bar&anchor=heading')).toBeNull();
  });

  test('parses browser-style anchor fragment', () => {
    expect(anchorFromHash('#/ARCHITECTURE#the-problem')).toBe('the-problem');
  });

  test('decodes browser-style anchor fragment', () => {
    expect(anchorFromHash('#/doc#hello%20world')).toBe('hello world');
  });

  test('returns null for empty browser-style fragment', () => {
    expect(anchorFromHash('#/doc#')).toBeNull();
  });

  test('falls back to raw string on malformed fragment encoding', () => {
    expect(anchorFromHash('#/doc#bad%ZZencoding')).toBe('bad%ZZencoding');
  });

  test('uses fragment anchor when query params are also present', () => {
    expect(anchorFromHash('#/doc?anchor=query-anchor#fragment-anchor')).toBe('fragment-anchor');
  });

  test('asset hashes do not parse as anchor hashes', () => {
    expect(anchorFromHash(hashFromAssetPath('docs/photo.png'))).toBeNull();
  });
});

describe('hashFromDocName', () => {
  test('no anchor', () => {
    expect(hashFromDocName('README')).toBe('#/README');
  });

  test('with anchor', () => {
    expect(hashFromDocName('docs/guide', 'install')).toBe('#/docs/guide#install');
  });

  test('encodes anchor with special characters', () => {
    expect(hashFromDocName('doc', 'hello world')).toBe('#/doc#hello%20world');
  });

  test('null anchor produces no fragment', () => {
    expect(hashFromDocName('doc', null)).toBe('#/doc');
  });
});

describe('hashFromFolderPath', () => {
  test('adds a trailing slash', () => {
    expect(hashFromFolderPath('docs/guide')).toBe('#/docs/guide/');
  });

  test('does not duplicate a trailing slash', () => {
    expect(hashFromFolderPath('docs/guide/')).toBe('#/docs/guide/');
  });

  test('encodes anchor with special characters', () => {
    expect(hashFromFolderPath('docs/guide', 'hello world')).toBe('#/docs/guide/#hello%20world');
  });
});

/**
 * What `window.location.hash` actually holds once the app assigns a built hash:
 * the WHATWG fragment percent-encode set, applied by a real URL parser rather
 * than by a literal written here.
 *
 * Deliberately NOT a hand-written encoded literal. A literal would bake this
 * file's own belief about which characters the browser escapes into the
 * assertion, so the test would still pass if that belief were wrong — and the
 * encode set is precisely what these round-trips turn on (a space is escaped, a
 * `#`, `?` or `%` is not, so those three reach the parser intact and are re-read
 * as routing syntax). Pushing the built hash through a real `URL` keeps the
 * encode set an input to the test rather than a constant inside it.
 */
function browserNormalizedHash(builtHash: string): string {
  const url = new URL('file:///app/index.html');
  url.hash = builtHash;
  return url.hash;
}

/**
 * The builders are one half of a round trip: the app assigns `hashFromDocName`
 * / `hashFromFolderPath` to `window.location.hash`, the browser normalizes it,
 * and `docNameFromHash` reads the name back out. A name carrying a route
 * metacharacter has to survive that trip unchanged, exactly as a name carrying
 * a space already does.
 *
 * `hashFromAssetPath` is the in-repo reference implementation of this
 * contract: it percent-encodes per segment, so `/` stays a route separator.
 * (`encodeShareTargetForHash` also encodes, but whole-path by design, so a
 * deep link's `/` becomes `%2F` — a different contract, not a model for this
 * one.) These pin the per-segment contract for the two builders every in-app
 * navigation goes through.
 */
describe('doc and folder hashes round-trip through the browser', () => {
  function roundTripDoc(docName: string): string | null {
    return docNameFromHash(browserNormalizedHash(hashFromDocName(docName)));
  }

  function roundTripFolder(folderPath: string): string | null {
    // A folder hash reads back with its trailing slash — that slash is the
    // folder signal `tabIdFromHash` strips to recover the folder path.
    return docNameFromHash(browserNormalizedHash(hashFromFolderPath(folderPath)));
  }

  test('a spaced name round-trips (control — the already-working common path)', () => {
    expect(roundTripDoc('My Notes/Ideas')).toBe('My Notes/Ideas');
    expect(roundTripFolder('My Notes')).toBe('My Notes/');
  });

  test('a doc named with a leading `# ` round-trips', () => {
    // The reported document. A markdown heading pasted in as a title is an
    // ordinary name to the user; `#` only means "anchor" to the router.
    expect(roundTripDoc('# 2 - Tokens')).toBe('# 2 - Tokens');
  });

  test('a doc named with a leading `#` and no space round-trips', () => {
    expect(roundTripDoc('#Heading')).toBe('#Heading');
  });

  test('a doc with a mid-name `#` round-trips', () => {
    expect(roundTripDoc('A # B')).toBe('A # B');
  });

  test('a `#` doc inside a folder resolves to the doc, not to its folder', () => {
    // The dangerous shape: truncating at the `#` yields a still-valid folder
    // hash, so the navigation silently succeeds at the wrong target instead of
    // failing loudly.
    expect(roundTripDoc('My Notes/# 2 - Tokens')).toBe('My Notes/# 2 - Tokens');
  });

  test('the separator survives as a separator, not as an escape', () => {
    // No round trip above can see this. `docNameFromHash` decodes per segment
    // too, so a whole-string `encodeURIComponent` in the builders round-trips
    // every name here perfectly while emitting `#/My%20Notes%2FIdeas` — a hash
    // with no route structure left in it, which the folder arm of
    // `tabIdFromHash` and every href in the app read as one flat name. The
    // built string is the only place the difference shows, so assert on it.
    expect(hashFromDocName('My Notes/Ideas')).toBe('#/My%20Notes/Ideas');
    expect(hashFromFolderPath('My Notes/Ideas')).toBe('#/My%20Notes/Ideas/');
  });

  test('a doc with a `?` round-trips', () => {
    // `?` is the other route delimiter `firstRouteDelimiterIndex` looks for,
    // and the browser leaves it unescaped in a fragment just like `#`.
    expect(roundTripDoc('What now?')).toBe('What now?');
  });

  test('a doc with a `%` round-trips', () => {
    // A raw `%` is not a percent-escape but is read as the start of one. It
    // must reach the parser already escaped (`%25`), so the decode returns the
    // literal `%` rather than throwing and falling back to the raw string.
    expect(roundTripDoc('100% done')).toBe('100% done');
  });

  test('an anchor stays separable from a `#` in the doc name', () => {
    // Both halves have to survive: the name must not swallow the anchor, and
    // the anchor delimiter must remain the FIRST unescaped `#`, which is what
    // both parsers look for. Encoding the name's own `#` is what makes the
    // first unescaped one the anchor's.
    const hash = browserNormalizedHash(hashFromDocName('# 2 - Tokens', 'intro'));
    expect(docNameFromHash(hash)).toBe('# 2 - Tokens');
    expect(anchorFromHash(hash)).toBe('intro');
  });

  test('folder paths carrying route metacharacters round-trip', () => {
    expect(roundTripFolder('# Notes')).toBe('# Notes/');
    expect(roundTripFolder('A # B')).toBe('A # B/');
    expect(roundTripFolder('What now?')).toBe('What now?/');
    expect(roundTripFolder('100% done')).toBe('100% done/');
  });

  test('a name carrying a lone surrogate does not throw', () => {
    // encodeURIComponent throws URIError on an unpaired surrogate, which a
    // docName can carry because it comes from a filename. Raw interpolation
    // never threw, and these builders run inside render paths, so a throw
    // would take out the surrounding tree instead of breaking one link.
    const lone = 'note-\ud800-x';
    expect(() => hashFromDocName(lone)).not.toThrow();
    expect(() => hashFromFolderPath(lone)).not.toThrow();
    expect(() => hashFromDocName(`folder/${lone}`)).not.toThrow();
    // The encodable siblings of an unencodable segment are still encoded.
    expect(hashFromDocName(`My Notes/${lone}`)).toContain('My%20Notes/');
  });

  test('the anchor is sanitized on the same terms as the name', () => {
    // A heading slug is derived from user text, so it reaches the encoder from
    // the same kind of source the name does. Every value this module escapes
    // goes through one helper for that reason; without it the anchor argument
    // was the one bare `encodeURIComponent` left on the headline builders.
    expect(() => hashFromDocName('doc', 'head-\ud800')).not.toThrow();
    expect(() => hashFromFolderPath('folder', 'head-\ud800')).not.toThrow();
    expect(hashFromDocName('doc', 'a b\ud800')).toBe('#/doc#a%20b%EF%BF%BD');
  });

  test('a route metacharacter beside a lone surrogate is still escaped', () => {
    // encodeURIComponent has no partial result: it throws for the whole call.
    // Catching that and passing the segment through would hand the `#` to the
    // router raw, which is the misparse this whole contract exists to stop, so
    // the unpairable code unit is substituted before encoding instead.
    const hash = browserNormalizedHash(hashFromDocName('#Heading\ud800'));
    expect(hash).not.toContain('/#');
    expect(docNameFromHash(hash)).not.toBeNull();
    // Round-trips to the sanitized name, not to the original bad code unit.
    expect(docNameFromHash(hash)).toBe('#Heading\uFFFD');
  });

  test('the same names round-trip through the share-target encoder', () => {
    // `encodeShareTargetForHash` encodes whole-path, not per segment; the names
    // here are slash-free, which is why the two agree. What it pins is that
    // escaping, not the parser, is what carries a route metacharacter across
    // the trip, so a change to the parser has to keep this passing too.
    for (const docName of ['# 2 - Tokens', '#Heading', 'A # B', 'What now?', '100% done']) {
      const hash = browserNormalizedHash(encodeShareTargetForHash('doc', docName));
      expect(docNameFromHash(hash)).toBe(docName);
    }
  });
});

describe('isSameHash', () => {
  // Note on this group: now that the builders percent-encode, a builder hash
  // and the browser's own form of the same target are byte-identical, so these
  // pairs settle on the `===` fast path and no longer exercise the decode. The
  // decode is covered by the legacy-raw-hash case below, which is the only
  // input shape that still needs it. These are kept as the equality cases they
  // have become: they still pin that the builder's output IS the browser form.

  test('matches the browser form of a spaced name, which the builder now emits verbatim', () => {
    // `window.location.hash` for a folder named `consolidated ux`, versus what
    // `hashFromFolderPath` emits. A raw `===` between these was once false,
    // which left such a folder permanently expanded in the sidebar: the file
    // tree read "not the current page", swallowed the click, and never toggled
    // the row. It is true now because the builder encodes.
    expect(isSameHash('#/consolidated%20ux/', hashFromFolderPath('consolidated ux'))).toBe(true);
    expect(isSameHash('#/My%20Notes/Ideas', hashFromDocName('My Notes/Ideas'))).toBe(true);
  });

  test('matches non-ASCII names, which the builder encodes the same way', () => {
    expect(isSameHash('#/notes/caf%C3%A9', hashFromDocName('notes/café'))).toBe(true);
  });

  test('matches identical hashes needing no decode', () => {
    expect(isSameHash('#/docs/guide/', hashFromFolderPath('docs/guide'))).toBe(true);
  });

  test('still separates genuinely different targets', () => {
    expect(isSameHash('#/consolidated%20ux/', hashFromFolderPath('consolidated ui'))).toBe(false);
    expect(isSameHash('#/alpha/', hashFromFolderPath('beta'))).toBe(false);
  });

  test('commutes: either side may be the browser-encoded one', () => {
    expect(isSameHash(hashFromFolderPath('consolidated ux'), '#/consolidated%20ux/')).toBe(true);
  });

  test('matches a raw hash persisted by an older build against the encoded form', () => {
    // The builders encode now, so every other positive case here settles on the
    // `===` fast path and the decode branch would go untested. This is the case
    // that still needs it: a history entry or bookmark written when the
    // builders emitted the path raw, compared against what they emit today.
    // Without the tolerance, restoring such an entry reads as a different
    // target and re-navigates.
    expect(isSameHash('#/My Notes/Ideas', hashFromDocName('My Notes/Ideas'))).toBe(true);
    expect(isSameHash('#/consolidated ux/', hashFromFolderPath('consolidated ux'))).toBe(true);
  });

  test('still conflates a "#" in a name with the anchor delimiter (known limit)', () => {
    // Pinning a limitation, not an intent. The builders now emit these two
    // targets as DIFFERENT strings, where before they emitted the same one, so
    // this is narrower than it was. It survives because the decode is
    // whole-string: `%23` collapses back to a structural `#`. Separating them
    // means decoding path and anchor independently, which changes the guard
    // for every caller. Change this expectation only alongside that.
    const anchorOnDocA = hashFromDocName('a', 'b');
    const docNamedAHashB = hashFromDocName('a#b');
    expect(anchorOnDocA).not.toBe(docNamedAHashB);
    expect(isSameHash(anchorOnDocA, docNamedAHashB)).toBe(true);
  });

  test('falls back to raw comparison on malformed escapes', () => {
    expect(isSameHash('#/100%zz', '#/100%zz')).toBe(true);
    expect(isSameHash('#/100%zz', '#/200%zz')).toBe(false);
  });
});

describe('pushHashWithoutNavigation', () => {
  function installWindow(hash: string) {
    const pushState = vi.fn();
    const replaceState = vi.fn();
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: {
          hash,
          pathname: '/app',
          search: '?workspace=ok',
        },
        history: {
          pushState,
          replaceState,
          state: { preserved: 'value' },
        },
      },
    });
    return {
      pushState,
      replaceState,
      restore: () => {
        if (previousWindow === undefined) {
          Reflect.deleteProperty(globalThis, 'window');
          return;
        }
        Object.defineProperty(globalThis, 'window', {
          configurable: true,
          value: previousWindow,
        });
      },
    };
  }

  test('pushes a distinct hash while preserving the current path and query', () => {
    const { pushState, restore } = installWindow('#/old');
    try {
      pushHashWithoutNavigation('#/new');
    } finally {
      restore();
    }

    expect(pushState).toHaveBeenCalledOnce();
    expect(pushState).toHaveBeenCalledWith(
      expect.objectContaining({ preserved: 'value' }),
      '',
      '/app?workspace=ok#/new',
    );
    expect(isManagedHashHistoryState(pushState.mock.calls[0]?.[0])).toBe(true);
  });

  test('does not push when the hash is already current', () => {
    const { pushState, restore } = installWindow('#/current');
    try {
      pushHashWithoutNavigation('#/current');
    } finally {
      restore();
    }

    expect(pushState).not.toHaveBeenCalled();
  });

  test('marks the current entry while preserving existing history state', () => {
    const { replaceState, restore } = installWindow('#/current');
    try {
      markCurrentHashHistoryEntry();
    } finally {
      restore();
    }

    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenCalledWith(expect.objectContaining({ preserved: 'value' }), '');
    expect(isManagedHashHistoryState(replaceState.mock.calls[0]?.[0])).toBe(true);
  });

  test('does not mark an entry that is already managed', () => {
    const { replaceState, restore } = installWindow('#/current');
    try {
      markCurrentHashHistoryEntry();
      const managedState = replaceState.mock.calls[0]?.[0];
      Object.defineProperty(window.history, 'state', {
        configurable: true,
        value: managedState,
      });
      replaceState.mockClear();

      markCurrentHashHistoryEntry();
    } finally {
      restore();
    }

    expect(replaceState).not.toHaveBeenCalled();
  });

  test('replaces the current hash while preserving managed history state', () => {
    const { replaceState, restore } = installWindow('#/current');
    try {
      replaceHashWithoutNavigation('');
    } finally {
      restore();
    }

    expect(replaceState).toHaveBeenCalledWith(
      expect.objectContaining({ preserved: 'value' }),
      '',
      '/app?workspace=ok',
    );
    expect(isManagedHashHistoryState(replaceState.mock.calls[0]?.[0])).toBe(true);
  });
});

describe('encodeShareTargetForHash', () => {
  test('doc target → #/<doc> with no branch', () => {
    expect(encodeShareTargetForHash('doc', 'intro.md')).toBe('#/intro.md');
  });

  test('doc target → #/<doc>?branch=<branch> when branch present', () => {
    expect(encodeShareTargetForHash('doc', 'intro.md', 'main')).toBe('#/intro.md?branch=main');
  });

  test('doc target URL-encodes nested doc names (slash → %2F)', () => {
    expect(encodeShareTargetForHash('doc', 'notes/meeting')).toBe('#/notes%2Fmeeting');
  });

  test('doc target encodes slashed branch names', () => {
    expect(encodeShareTargetForHash('doc', 'docs/page.md', 'feat/foo')).toBe(
      '#/docs%2Fpage.md?branch=feat%2Ffoo',
    );
  });

  test('doc target treats null / empty branch as absent (back-compat)', () => {
    expect(encodeShareTargetForHash('doc', 'intro.md', null)).toBe('#/intro.md');
    expect(encodeShareTargetForHash('doc', 'intro.md', '')).toBe('#/intro.md');
  });

  test('folder target → trailing-slash folder hash', () => {
    expect(encodeShareTargetForHash('folder', 'docs/sub')).toBe('#/docs/sub/');
  });

  test('content-root folder target (empty path) → root hash #/', () => {
    expect(encodeShareTargetForHash('folder', '')).toBe('#/');
  });

  test('folder target ignores branch (no ?branch= appended)', () => {
    // The branch-switch decision resolves upstream before navigation, so the
    // folder hash carries no branch query — matching in-app folder nav.
    expect(encodeShareTargetForHash('folder', 'docs/sub', 'main')).toBe('#/docs/sub/');
    expect(encodeShareTargetForHash('folder', '', 'main')).toBe('#/');
  });
});

describe('isContentRootHash', () => {
  test('true for the bare root sentinel #/', () => {
    expect(isContentRootHash('#/')).toBe(true);
  });

  test('true for #/ with a trailing query', () => {
    expect(isContentRootHash('#/?anchor=x')).toBe(true);
  });

  test('false for an empty hash (clear, not root)', () => {
    expect(isContentRootHash('')).toBe(false);
  });

  test('false for a folder hash with a path segment', () => {
    expect(isContentRootHash('#/docs/sub/')).toBe(false);
  });

  test('false for a doc hash', () => {
    expect(isContentRootHash('#/intro.md')).toBe(false);
  });

  test('round-trips with hashFromFolderpath of the root', () => {
    expect(isContentRootHash(hashFromFolderPath(''))).toBe(true);
  });
});

describe('asset hash helpers', () => {
  test('round-trips nested asset paths', () => {
    const hash = hashFromAssetPath('docs/My Photo.png');
    expect(hash).toBe('#/__asset__/docs/My%20Photo.png');
    expect(assetPathFromHash(hash)).toBe('docs/My Photo.png');
  });

  test('asset hashes do not parse as doc hashes', () => {
    expect(docNameFromHash(hashFromAssetPath('docs/photo.png'))).toBeNull();
  });
});

// A global skill's synthetic doc name and a template's content-relative doc name
// both open as ordinary editor tabs, so their `#/…` hashes round-trip like any
// document: the builder makes the raw key, `hashFromDocName` builds the hash, and
// `docNameFromHash` decodes it back to the same key.
describe('skill and template doc names round-trip as documents', () => {
  test('skill doc name round-trips through the hash', () => {
    // A GLOBAL skill is the synthetic-doc form (`__skill__/global/<name>`);
    // a project skill is a content doc, never `__skill__/project/<name>`, so the
    // round-trip case uses the global form (the only real synthetic skill doc).
    const docName = skillLiveDocName('global', 'run-tests');
    expect(docName).toBe('__skill__/global/run-tests');
    expect(hashFromDocName(docName)).toBe('#/__skill__/global/run-tests');
    expect(docNameFromHash(hashFromDocName(docName))).toBe(docName);
  });

  test('template CONTENT doc name (nested folder) round-trips through the hash', () => {
    // Templates are content docs now; the doc name is the content-relative path.
    const docName = templateContentDocName('a/b/c', 'deep');
    expect(docName).toBe('a/b/c/.ok/templates/deep');
    expect(hashFromDocName(docName)).toBe('#/a/b/c/.ok/templates/deep');
    expect(docNameFromHash(hashFromDocName(docName))).toBe(docName);
  });

  test('template CONTENT doc at the project root round-trips', () => {
    const docName = templateContentDocName('', 'daily');
    expect(docName).toBe('.ok/templates/daily');
    expect(docNameFromHash(hashFromDocName(docName))).toBe(docName);
  });

  test('a spaced-folder template content name rides the generic hash round-trip', () => {
    // The synthetic namespace percent-encoded segments; the content name is RAW
    // and round-trips the hash like any other spaced doc name (the browser encodes
    // the space, docNameFromHash decodes it per segment).
    const docName = templateContentDocName('My Notes', 'plan');
    expect(docName).toBe('My Notes/.ok/templates/plan');
    expect(docNameFromHash('#/My%20Notes/.ok/templates/plan')).toBe(docName);
    expect(docNameFromHash(hashFromDocName(docName))).toBe(docName);
  });

  test('a legacy `__template__/…` hash still decodes (input to the navigation redirect)', () => {
    // docNameFromHash decodes the stale synthetic name so resolveNavigationTarget
    // can redirect it to the content doc; new templates never use this form.
    expect(docNameFromHash('#/__template__/My%20Notes/plan')).toBe('__template__/My Notes/plan');
  });
});

// Skill bundle files are a viewer route, not a doc — their hash round-trips the
// three coordinates (`scope` / `name` / `path`) the scope-aware `/api/skill-file`
// read needs, and must NOT be mis-read as a docName or asset path.
describe('skill-file hash', () => {
  test('round-trips scope / name / nested path', () => {
    const target = {
      scope: 'global',
      name: 'trip-log',
      path: 'references/guide.md',
    } satisfies SkillFileHashTarget;
    const hash = hashFromSkillFile(target);
    expect(hash).toBe('#/__skill-file__/global/trip-log/references/guide.md');
    expect(skillFileFromHash(hash)).toEqual(target);
  });

  test('round-trips a script path', () => {
    const target = {
      scope: 'project',
      name: 'my-skill',
      path: 'scripts/run.sh',
    } satisfies SkillFileHashTarget;
    expect(skillFileFromHash(hashFromSkillFile(target))).toEqual(target);
  });

  test('round-trips the host that separates two same-named skills', () => {
    const target = {
      scope: 'project',
      name: 'review',
      path: 'references/guide.md',
      host: 'codex',
    } satisfies SkillFileHashTarget;
    const hash = hashFromSkillFile(target);
    expect(skillFileFromHash(hash)).toEqual(target);
    // Distinct from the same file in the same-named skill next door.
    expect(hash).not.toBe(hashFromSkillFile({ ...target, host: 'claude' }));
  });

  test('a hash written before hosts existed still parses (by-name default)', () => {
    expect(skillFileFromHash('#/__skill-file__/global/trip-log/references/guide.md')).toEqual({
      scope: 'global',
      name: 'trip-log',
      path: 'references/guide.md',
    });
  });

  test('a skill-file hash is not read as a docName or asset path', () => {
    const hash = hashFromSkillFile({ scope: 'global', name: 'x', path: 'scripts/run.sh' });
    expect(docNameFromHash(hash)).toBeNull();
    expect(assetPathFromHash(hash)).toBeNull();
  });

  test('returns null for a non-skill-file hash', () => {
    expect(skillFileFromHash('#/some/doc')).toBeNull();
    expect(skillFileFromHash('#/__asset__/images/x.png')).toBeNull();
    // Missing the path tail (scope + name only) is not a valid bundle file.
    expect(skillFileFromHash('#/__skill-file__/global/trip-log')).toBeNull();
  });

  test('rejects an unknown scope segment (hash is untrusted/editable)', () => {
    // The first segment must be a real skill scope (`project` | `global`) — a
    // hand-edited or stale hash with a bogus scope must not become a target.
    expect(skillFileFromHash('#/__skill-file__/bogus/trip-log/references/x.md')).toBeNull();
    expect(skillFileFromHash('#/__skill-file__/personal/trip-log/references/x.md')).toBeNull();
  });
});

describe('skill-preview hash', () => {
  test('preserves a file selection only for the same preview identity', () => {
    const alpha = {
      flavor: 'explore',
      source: 'owner/a',
      name: 'alpha',
      subtitle: 'owner/a',
      path: 'references/details.md',
    } satisfies SkillPreviewHashTarget;
    const beta = {
      flavor: 'explore',
      source: 'owner/b',
      name: 'beta',
      subtitle: 'owner/b',
    } satisfies SkillPreviewHashTarget;

    expect(selectedPathForSkillPreview(hashFromSkillPreview(alpha), alpha)).toBe(
      'references/details.md',
    );
    expect(selectedPathForSkillPreview(hashFromSkillPreview(alpha), beta)).toBeUndefined();
  });

  test('round-trips explore + detected targets, defaulting an absent level', () => {
    // A level-less target comes back AT the default rather than level-less: the
    // identity carries exactly one spelling, so two callers who disagree about
    // passing a level cannot open two tabs for one preview.
    const cases: SkillPreviewHashTarget[] = [
      { flavor: 'explore', source: 'owner/repo', name: 'ai-sdk', subtitle: 'owner/repo' },
      { flavor: 'detected', source: '/Users/me/.ok/skills/1on1', name: '1on1', subtitle: 'claude' },
    ];
    for (const target of cases) {
      expect(skillPreviewFromHash(hashFromSkillPreview(target))).toEqual({
        ...target,
        level: 'project',
      });
    }
    // An EXPLICIT level survives untouched.
    const global = {
      flavor: 'explore',
      source: 'owner/repo',
      name: 'ai-sdk',
      subtitle: 'owner/repo',
      level: 'global',
    } satisfies SkillPreviewHashTarget;
    expect(skillPreviewFromHash(hashFromSkillPreview(global))).toEqual(global);
  });

  test('a level-less and a project-level target share ONE identity', () => {
    // The duplicate-tab bug: same skill, same source, two tab ids.
    const withoutLevel = {
      flavor: 'explore',
      source: 'open.feishu.cn',
      name: 'lark-doc',
      subtitle: 'open.feishu.cn',
    } satisfies SkillPreviewHashTarget;
    const withLevel = { ...withoutLevel, level: 'project' } satisfies SkillPreviewHashTarget;
    expect(encodeSkillPreviewSegments(withoutLevel)).toBe(encodeSkillPreviewSegments(withLevel));
  });

  test('round-trips a selected-file path (with and without a level)', () => {
    const cases: SkillPreviewHashTarget[] = [
      // path, no level → the level defaults, so path stays the 6th segment.
      {
        flavor: 'detected',
        source: '/x/1on1',
        name: '1on1',
        subtitle: 'claude',
        path: 'references/notes.md',
      },
      // path + level.
      {
        flavor: 'detected',
        source: '/x/1on1',
        name: '1on1',
        subtitle: 'claude',
        level: 'global',
        path: 'references/sub/deep.md',
      },
      // a scripts path.
      { flavor: 'explore', source: 'o/r', name: 'x', subtitle: 'o/r', path: 'scripts/run.sh' },
    ];
    for (const target of cases) {
      expect(skillPreviewFromHash(hashFromSkillPreview(target))).toEqual({
        level: 'project',
        ...target,
      });
    }
  });

  test('path is NOT part of the tab-identity encoding (one tab, body switches)', () => {
    // encodeSkillPreviewSegments drives the persisted tab id; adding a path must
    // NOT change it, or every file click would spawn a separate preview tab.
    const base: SkillPreviewHashTarget = {
      flavor: 'detected',
      source: '/x/1on1',
      name: '1on1',
      subtitle: 'claude',
      level: 'global',
    };
    expect(encodeSkillPreviewSegments({ ...base, path: 'references/notes.md' })).toBe(
      encodeSkillPreviewSegments(base),
    );
  });

  test('rejects an unknown flavor', () => {
    expect(skillPreviewFromHash('#/__skill-preview__/bogus/owner%2Frepo/x/y')).toBeNull();
  });

  test('docNameFromHash ignores the skill-preview route', () => {
    const hash = hashFromSkillPreview({
      flavor: 'explore',
      source: 'o/r',
      name: 'x',
      subtitle: 'o/r',
    });
    expect(docNameFromHash(hash)).toBeNull();
  });
});
