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

function browserNormalizedHash(builtHash: string): string {
  const url = new URL('file:///app/index.html');
  url.hash = builtHash;
  return url.hash;
}

describe('doc and folder hashes round-trip through the browser', () => {
  function roundTripDoc(docName: string): string | null {
    return docNameFromHash(browserNormalizedHash(hashFromDocName(docName)));
  }

  function roundTripFolder(folderPath: string): string | null {
    return docNameFromHash(browserNormalizedHash(hashFromFolderPath(folderPath)));
  }

  test('a spaced name round-trips (control — the already-working common path)', () => {
    expect(roundTripDoc('My Notes/Ideas')).toBe('My Notes/Ideas');
    expect(roundTripFolder('My Notes')).toBe('My Notes/');
  });

  test('a doc named with a leading `# ` round-trips', () => {
    expect(roundTripDoc('# 2 - Tokens')).toBe('# 2 - Tokens');
  });

  test('a doc named with a leading `#` and no space round-trips', () => {
    expect(roundTripDoc('#Heading')).toBe('#Heading');
  });

  test('a doc with a mid-name `#` round-trips', () => {
    expect(roundTripDoc('A # B')).toBe('A # B');
  });

  test('a `#` doc inside a folder resolves to the doc, not to its folder', () => {
    expect(roundTripDoc('My Notes/# 2 - Tokens')).toBe('My Notes/# 2 - Tokens');
  });

  test('the separator survives as a separator, not as an escape', () => {
    expect(hashFromDocName('My Notes/Ideas')).toBe('#/My%20Notes/Ideas');
    expect(hashFromFolderPath('My Notes/Ideas')).toBe('#/My%20Notes/Ideas/');
  });

  test('a doc with a `?` round-trips', () => {
    expect(roundTripDoc('What now?')).toBe('What now?');
  });

  test('a doc with a `%` round-trips', () => {
    expect(roundTripDoc('100% done')).toBe('100% done');
  });

  test('an anchor stays separable from a `#` in the doc name', () => {
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
    const lone = 'note-\ud800-x';
    expect(() => hashFromDocName(lone)).not.toThrow();
    expect(() => hashFromFolderPath(lone)).not.toThrow();
    expect(() => hashFromDocName(`folder/${lone}`)).not.toThrow();
    expect(hashFromDocName(`My Notes/${lone}`)).toContain('My%20Notes/');
  });

  test('the anchor is sanitized on the same terms as the name', () => {
    expect(() => hashFromDocName('doc', 'head-\ud800')).not.toThrow();
    expect(() => hashFromFolderPath('folder', 'head-\ud800')).not.toThrow();
    expect(hashFromDocName('doc', 'a b\ud800')).toBe('#/doc#a%20b%EF%BF%BD');
  });

  test('a route metacharacter beside a lone surrogate is still escaped', () => {
    const hash = browserNormalizedHash(hashFromDocName('#Heading\ud800'));
    expect(hash).not.toContain('/#');
    expect(docNameFromHash(hash)).not.toBeNull();
    expect(docNameFromHash(hash)).toBe('#Heading\uFFFD');
  });

  test('the same names round-trip through the share-target encoder', () => {
    for (const docName of ['# 2 - Tokens', '#Heading', 'A # B', 'What now?', '100% done']) {
      const hash = browserNormalizedHash(encodeShareTargetForHash('doc', docName));
      expect(docNameFromHash(hash)).toBe(docName);
    }
  });
});

describe('isSameHash', () => {
  test('matches the browser form of a spaced name, which the builder now emits verbatim', () => {
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
    expect(isSameHash('#/My Notes/Ideas', hashFromDocName('My Notes/Ideas'))).toBe(true);
    expect(isSameHash('#/consolidated ux/', hashFromFolderPath('consolidated ux'))).toBe(true);
  });

  test('still conflates a "#" in a name with the anchor delimiter (known limit)', () => {
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

describe('skill and template doc names round-trip as documents', () => {
  test('skill doc name round-trips through the hash', () => {
    const docName = skillLiveDocName('global', 'run-tests');
    expect(docName).toBe('__skill__/global/run-tests');
    expect(hashFromDocName(docName)).toBe('#/__skill__/global/run-tests');
    expect(docNameFromHash(hashFromDocName(docName))).toBe(docName);
  });

  test('template CONTENT doc name (nested folder) round-trips through the hash', () => {
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
    const docName = templateContentDocName('My Notes', 'plan');
    expect(docName).toBe('My Notes/.ok/templates/plan');
    expect(docNameFromHash('#/My%20Notes/.ok/templates/plan')).toBe(docName);
    expect(docNameFromHash(hashFromDocName(docName))).toBe(docName);
  });

  test('a legacy `__template__/…` hash still decodes (input to the navigation redirect)', () => {
    expect(docNameFromHash('#/__template__/My%20Notes/plan')).toBe('__template__/My Notes/plan');
  });
});

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
    expect(skillFileFromHash('#/__skill-file__/global/trip-log')).toBeNull();
  });

  test('rejects an unknown scope segment (hash is untrusted/editable)', () => {
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
      {
        flavor: 'detected',
        source: '/x/1on1',
        name: '1on1',
        subtitle: 'claude',
        path: 'references/notes.md',
      },
      {
        flavor: 'detected',
        source: '/x/1on1',
        name: '1on1',
        subtitle: 'claude',
        level: 'global',
        path: 'references/sub/deep.md',
      },
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
