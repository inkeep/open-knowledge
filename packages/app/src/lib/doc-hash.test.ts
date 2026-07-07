import { describe, expect, test } from 'bun:test';
import {
  anchorFromHash,
  assetPathFromHash,
  docNameFromHash,
  encodeShareTargetForHash,
  hashFromAssetPath,
  hashFromDocName,
  hashFromFolderPath,
  hashFromSkillFile,
  isContentRootHash,
  type SkillFileHashTarget,
  skillFileFromHash,
} from './doc-hash';
import { skillLiveDocName, templateDocName } from './managed-artifact-doc-name';

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

// Managed-artifact docs (skills/templates) open as ordinary editor tabs, so
// their `#/…` hashes resolve to their synthetic doc name like any document —
// `skillDocName`/`templateDocName` build the raw key, `hashFromDocName` builds
// the hash, and `docNameFromHash` decodes it back to the same key.
describe('managed-artifact doc names round-trip as documents', () => {
  test('skill doc name round-trips through the hash', () => {
    // A GLOBAL skill is the synthetic-doc form (`__skill__/global/<name>`);
    // a project skill is a content doc, never `__skill__/project/<name>`, so the
    // round-trip case uses the global form (the only real synthetic skill doc).
    const docName = skillLiveDocName('global', 'run-tests');
    expect(docName).toBe('__skill__/global/run-tests');
    expect(hashFromDocName(docName)).toBe('#/__skill__/global/run-tests');
    expect(docNameFromHash(hashFromDocName(docName))).toBe(docName);
  });

  test('template doc name (nested folder) round-trips through the hash', () => {
    const docName = templateDocName('a/b/c', 'deep');
    expect(docName).toBe('__template__/a/b/c/deep');
    expect(hashFromDocName(docName)).toBe('#/__template__/a/b/c/deep');
    expect(docNameFromHash(hashFromDocName(docName))).toBe(docName);
  });

  test('template at the project root', () => {
    expect(templateDocName('', 'daily')).toBe('__template__/daily');
    expect(docNameFromHash('#/__template__/daily')).toBe('__template__/daily');
  });

  test('a percent-encoded URL hash decodes back to the raw doc name', () => {
    // The browser percent-encodes the URL hash; docNameFromHash decodes per
    // segment so the key matches the raw doc name the tab/provider uses.
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
