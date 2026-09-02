import { describe, expect, test } from 'vitest';
import {
  firstContainingStableTag,
  parseFixRef,
  parseGitOriginRevIds,
  parseTagLines,
  resolvePrivateSha,
  resolveShippedVersion,
  sortReleaseTagsAscending,
  sortStableTagsAscending,
} from './resolve-shipped-version.mjs';

const PRIVATE_SHA = 'da71f0c698ccaac11da915169ca6c7d585d5eb97';
const MIRRORED_SHA = 'eb52a625cd86859a8ec43ddc8f96e9b418d092a7';

const MIRRORED_MESSAGE = [
  'Increase detached server memory limit (#2767)',
  '',
  '* fix',
  '* fix(desktop): raise server heap ceiling to 16 GiB',
  '* lint(desktop): migrate spawn resolver test to vitest',
  '',
  `GitOrigin-RevId: ${PRIVATE_SHA}`,
  '',
].join('\n');

const STABLE_TAGS_SHUFFLED = [
  'v0.35.4',
  'v0.36.0',
  'v0.35.0',
  'v0.35.6',
  'v0.35.2',
  'v0.35.1',
  'v0.35.3',
  'v0.35.5',
];

const containsMirrored = (tag, sha) => {
  if (sha !== MIRRORED_SHA) return false;
  return tag === 'v0.36.0';
};

const finderFor = (commits) => () => commits;

describe('parseGitOriginRevIds', () => {
  test('extracts the trailer from a real mirrored commit message', () => {
    expect(parseGitOriginRevIds(MIRRORED_MESSAGE)).toEqual([PRIVATE_SHA]);
  });

  test('ignores a trailer that is not on its own line', () => {
    expect(parseGitOriginRevIds(`see GitOrigin-RevId: ${PRIVATE_SHA} for context`)).toEqual([]);
  });

  test('returns every trailer when a message embeds more than one', () => {
    const other = 'a'.repeat(40);
    const msg = `subject\n\nGitOrigin-RevId: ${other}\nGitOrigin-RevId: ${PRIVATE_SHA}\n`;
    expect(parseGitOriginRevIds(msg)).toEqual([other, PRIVATE_SHA]);
  });

  test('is case-insensitive on the key and normalizes the value', () => {
    expect(parseGitOriginRevIds(`gitorigin-revid: ${PRIVATE_SHA.toUpperCase()}`)).toEqual([PRIVATE_SHA]);
  });

  test('empty / missing message yields no trailers', () => {
    expect(parseGitOriginRevIds('')).toEqual([]);
    expect(parseGitOriginRevIds(undefined)).toEqual([]);
  });
});

describe('parseFixRef', () => {
  test('accepts a full 40-character SHA', () => {
    expect(parseFixRef(PRIVATE_SHA)).toEqual({ kind: 'sha', sha: PRIVATE_SHA });
  });

  test('lowercases an uppercase SHA', () => {
    expect(parseFixRef(PRIVATE_SHA.toUpperCase())).toEqual({ kind: 'sha', sha: PRIVATE_SHA });
  });

  test('accepts a PR URL and keeps its owner/repo', () => {
    expect(parseFixRef('https://github.com/inkeep/agents-private/pull/2767')).toEqual({
      kind: 'pr',
      owner: 'inkeep',
      repo: 'agents-private',
      number: 2767,
    });
  });

  test('accepts a PR URL with trailing path or query junk', () => {
    expect(parseFixRef('https://github.com/inkeep/agents-private/pull/2767/files').number).toBe(2767);
    expect(parseFixRef('https://github.com/inkeep/agents-private/pull/2767#issuecomment-1').number).toBe(2767);
  });

  test('resolves a bare #N / N against the default repo', () => {
    expect(parseFixRef('#2767')).toEqual({ kind: 'pr', owner: 'inkeep', repo: 'agents-private', number: 2767 });
    expect(parseFixRef('2767', { defaultRepo: 'acme/widgets' })).toEqual({
      kind: 'pr',
      owner: 'acme',
      repo: 'widgets',
      number: 2767,
    });
  });

  test('rejects an abbreviated SHA rather than expanding it', () => {
    expect(() => parseFixRef('eb52a62')).toThrow(/unrecognized fix reference/);
  });

  test('rejects an empty or missing ref', () => {
    expect(() => parseFixRef('')).toThrow(/missing fix reference/);
    expect(() => parseFixRef(undefined)).toThrow(/missing fix reference/);
  });
});

describe('sortStableTagsAscending', () => {
  test('sorts numerically, not lexically, and drops non-stable refs', () => {
    const raw = ['v0.9.0', 'v0.36.0', 'v0.35.10', 'v0.35.2', 'v0.35.2-beta.4', 'main', '', 'v1.0.0'];
    expect(sortStableTagsAscending(raw)).toEqual(['v0.9.0', 'v0.35.2', 'v0.35.10', 'v0.36.0', 'v1.0.0']);
  });

  test('tolerates surrounding whitespace from raw git output', () => {
    expect(sortStableTagsAscending(['  v0.2.0  ', '\tv0.1.0'])).toEqual(['v0.1.0', 'v0.2.0']);
  });

  test('empty input yields no tags', () => {
    expect(sortStableTagsAscending([])).toEqual([]);
  });
});

describe('firstContainingStableTag', () => {
  test('returns the lowest tag whose history contains the commit', () => {
    const tag = firstContainingStableTag({
      sortedStableTags: sortStableTagsAscending(STABLE_TAGS_SHUFFLED),
      sha: MIRRORED_SHA,
      contains: containsMirrored,
    });
    expect(tag).toBe('v0.36.0');
  });

  test('returns null when no tag contains the commit', () => {
    const tag = firstContainingStableTag({
      sortedStableTags: ['v0.35.0', 'v0.35.1'],
      sha: MIRRORED_SHA,
      contains: containsMirrored,
    });
    expect(tag).toBeNull();
  });

  test('does not bisect: a lower tag that contains the commit wins over a higher one', () => {
    const contains = (tag) => tag === 'v0.35.7' || tag === 'v0.36.0';
    const tag = firstContainingStableTag({
      sortedStableTags: ['v0.35.6', 'v0.35.7', 'v0.36.0'],
      sha: MIRRORED_SHA,
      contains,
    });
    expect(tag).toBe('v0.35.7');
  });

  test('propagates an infra error instead of reading it as not-contained', () => {
    expect(() =>
      firstContainingStableTag({
        sortedStableTags: ['v0.35.0'],
        sha: MIRRORED_SHA,
        contains: () => {
          throw new Error('git merge-base failed (exit 128)');
        },
      }),
    ).toThrow(/exit 128/);
  });
});

describe('resolveShippedVersion', () => {
  const resolve = (over) =>
    resolveShippedVersion({
      privateSha: PRIVATE_SHA,
      stableTags: STABLE_TAGS_SHUFFLED,
      findMirroredCommits: finderFor([{ sha: MIRRORED_SHA, message: MIRRORED_MESSAGE }]),
      contains: containsMirrored,
      ...over,
    });

  test('pinned fixture: the memory-limit fix resolves to v0.36.0', () => {
    expect(resolve()).toEqual({
      shipped: true,
      privateSha: PRIVATE_SHA,
      mirroredSha: MIRRORED_SHA,
      mirroredShas: [MIRRORED_SHA],
      tag: 'v0.36.0',
      version: '0.36.0',
    });
  });

  test('pinned fixture: it is contained in NONE of v0.35.0 through v0.35.6', () => {
    for (const tag of ['v0.35.0', 'v0.35.1', 'v0.35.2', 'v0.35.3', 'v0.35.4', 'v0.35.5', 'v0.35.6']) {
      expect(containsMirrored(tag, MIRRORED_SHA)).toBe(false);
    }
    const withoutTarget = resolve({ stableTags: STABLE_TAGS_SHUFFLED.filter((t) => t !== 'v0.36.0') });
    expect(withoutTarget).toMatchObject({ shipped: false, reason: 'not-in-any-stable' });
  });

  test('no mirrored commit yet is an answer, not an error', () => {
    expect(resolve({ findMirroredCommits: finderFor([]) })).toEqual({
      shipped: false,
      reason: 'not-mirrored',
      privateSha: PRIVATE_SHA,
      mirroredShas: [],
    });
  });

  test('discards a candidate whose message only quotes the trailer', () => {
    const quoted = { sha: 'f'.repeat(40), message: `chore: cite GitOrigin-RevId: ${PRIVATE_SHA} inline` };
    expect(resolve({ findMirroredCommits: finderFor([quoted]) })).toMatchObject({
      shipped: false,
      reason: 'not-mirrored',
    });
  });

  test('keeps a candidate whose message carries the trailer alongside another', () => {
    const other = 'b'.repeat(40);
    const msg = `subject\n\nGitOrigin-RevId: ${other}\nGitOrigin-RevId: ${PRIVATE_SHA}\n`;
    const r = resolve({ findMirroredCommits: finderFor([{ sha: MIRRORED_SHA, message: msg }]) });
    expect(r).toMatchObject({ shipped: true, tag: 'v0.36.0' });
  });

  test('a cherry-picked point release wins over the main-line commit', () => {
    const pointReleaseSha = 'c'.repeat(40);
    const r = resolve({
      stableTags: ['v0.35.6', 'v0.35.7', 'v0.36.0'],
      findMirroredCommits: finderFor([
        { sha: MIRRORED_SHA, message: MIRRORED_MESSAGE },
        { sha: pointReleaseSha, message: MIRRORED_MESSAGE },
      ]),
      contains: (tag, sha) => {
        if (sha === MIRRORED_SHA) return tag === 'v0.36.0';
        if (sha === pointReleaseSha) return tag === 'v0.35.7';
        return false;
      },
    });
    expect(r).toMatchObject({ shipped: true, tag: 'v0.35.7', version: '0.35.7', mirroredSha: pointReleaseSha });
    expect(r.mirroredShas).toEqual([MIRRORED_SHA, pointReleaseSha]);
  });

  test('mirrored but not yet in any stable is an answer, not an error', () => {
    expect(resolve({ contains: () => false })).toEqual({
      shipped: false,
      reason: 'not-in-any-stable',
      privateSha: PRIVATE_SHA,
      mirroredShas: [MIRRORED_SHA],
    });
  });

  test('no stable tags at all (bootstrap repo) is not-in-any-stable', () => {
    expect(resolve({ stableTags: [] })).toMatchObject({ shipped: false, reason: 'not-in-any-stable' });
  });

  test('propagates an infra error from the containment boundary (fail loud)', () => {
    expect(() =>
      resolve({
        contains: () => {
          throw new Error('gh/git infra error');
        },
      }),
    ).toThrow(/infra error/);
  });

  test('propagates an infra error from the mirror lookup (fail loud)', () => {
    expect(() =>
      resolve({
        findMirroredCommits: () => {
          throw new Error('git log infra error');
        },
      }),
    ).toThrow(/infra error/);
  });

  test('rejects a non-SHA privateSha rather than searching for it', () => {
    expect(() => resolve({ privateSha: 'eb52a62' })).toThrow(/full 40-character commit SHA/);
    expect(() => resolve({ privateSha: '' })).toThrow(/full 40-character commit SHA/);
  });

  test('accepts an uppercase privateSha and matches the lowercase trailer', () => {
    expect(resolve({ privateSha: PRIVATE_SHA.toUpperCase() })).toMatchObject({
      shipped: true,
      privateSha: PRIVATE_SHA,
    });
  });
});

describe('resolvePrivateSha', () => {
  test('passes a SHA ref straight through without touching the API', () => {
    const sha = resolvePrivateSha(
      { kind: 'sha', sha: PRIVATE_SHA },
      {
        resolvePrMergeSha: () => {
          throw new Error('must not be called for a SHA ref');
        },
      },
    );
    expect(sha).toBe(PRIVATE_SHA);
  });

  test('resolves a PR ref through the injected boundary', () => {
    const seen = [];
    const sha = resolvePrivateSha(
      { kind: 'pr', owner: 'inkeep', repo: 'agents-private', number: 2767 },
      {
        resolvePrMergeSha: (ref) => {
          seen.push(ref);
          return PRIVATE_SHA;
        },
      },
    );
    expect(sha).toBe(PRIVATE_SHA);
    expect(seen).toEqual([{ kind: 'pr', owner: 'inkeep', repo: 'agents-private', number: 2767 }]);
  });

  test('propagates an unmerged-PR failure instead of returning nothing', () => {
    expect(() =>
      resolvePrivateSha(
        { kind: 'pr', owner: 'inkeep', repo: 'agents-private', number: 1 },
        {
          resolvePrMergeSha: () => {
            throw new Error('is not merged; there is no fix commit to resolve.');
          },
        },
      ),
    ).toThrow(/not merged/);
  });
});

describe('release tags across both channels', () => {
  const MIXED = ['v0.36.0', 'v0.35.0-beta.10', 'v0.35.0', 'v0.35.0-beta.2', 'not-a-tag', 'v0.35.6'];

  test('a beta sorts below the stable it becomes, and betas order numerically', () => {
    expect(sortReleaseTagsAscending(MIXED)).toEqual([
      'v0.35.0-beta.2',
      'v0.35.0-beta.10',
      'v0.35.0',
      'v0.35.6',
      'v0.36.0',
    ]);
  });

  test('the stable sorter still refuses every prerelease', () => {
    expect(sortStableTagsAscending(MIXED)).toEqual(['v0.35.0', 'v0.35.6', 'v0.36.0']);
  });
});

describe('resolving against a channel', () => {
  const PRIVATE = 'a'.repeat(40);
  const MIRRORED = 'b'.repeat(40);
  const TAGS = ['v0.35.0', 'v0.36.0-beta.0', 'v0.36.0-beta.1', 'v0.36.0'];
  const findMirrored = (sha) =>
    sha === PRIVATE ? [{ sha: MIRRORED, message: `subject\n\nGitOrigin-RevId: ${PRIVATE}\n` }] : [];
  const contains = (tag, sha) =>
    sha === MIRRORED && ['v0.36.0-beta.0', 'v0.36.0-beta.1', 'v0.36.0'].includes(tag);

  test('the beta channel answers with the first build of any kind that carried it', () => {
    const result = resolveShippedVersion({
      privateSha: PRIVATE,
      stableTags: TAGS,
      findMirroredCommits: findMirrored,
      contains,
      channel: 'beta',
    });
    expect(result).toMatchObject({
      shipped: true,
      tag: 'v0.36.0-beta.0',
      version: '0.36.0-beta.0',
    });
  });

  test('the stable channel ignores the betas entirely and answers with the stable', () => {
    const result = resolveShippedVersion({
      privateSha: PRIVATE,
      stableTags: TAGS,
      findMirroredCommits: findMirrored,
      contains,
    });
    expect(result).toMatchObject({ shipped: true, tag: 'v0.36.0', version: '0.36.0' });
  });

  test('a fix that reached a beta but no stable is unshipped on the stable channel and shipped on the beta one', () => {
    const betaOnly = (tag, sha) => sha === MIRRORED && tag === 'v0.36.0-beta.1';
    expect(
      resolveShippedVersion({
        privateSha: PRIVATE,
        stableTags: TAGS,
        findMirroredCommits: findMirrored,
        contains: betaOnly,
      }),
    ).toMatchObject({ shipped: false, reason: 'not-in-any-stable' });
    expect(
      resolveShippedVersion({
        privateSha: PRIVATE,
        stableTags: TAGS,
        findMirroredCommits: findMirrored,
        contains: betaOnly,
        channel: 'beta',
      }),
    ).toMatchObject({ shipped: true, version: '0.36.0-beta.1' });
  });

  test('a fix in no tag at all reports the channel it failed against', () => {
    expect(
      resolveShippedVersion({
        privateSha: PRIVATE,
        stableTags: TAGS,
        findMirroredCommits: findMirrored,
        contains: () => false,
        channel: 'beta',
      }),
    ).toMatchObject({ shipped: false, reason: 'not-in-any-release' });
  });
});


describe('the tag boundary', () => {
  test('prereleases survive it, because the channel decides what counts and not this', () => {
    expect(parseTagLines('v0.36.0\nv0.37.0-beta.1\n\n  v0.37.0  \n')).toEqual([
      'v0.36.0',
      'v0.37.0-beta.1',
      'v0.37.0',
    ]);
  });

  test('a fix that only a stable contains resolves to that stable even on the beta channel', () => {
    const PRIVATE = 'a'.repeat(40);
    const MIRRORED = 'b'.repeat(40);
    expect(
      resolveShippedVersion({
        privateSha: PRIVATE,
        stableTags: ['v0.35.0', 'v0.36.0-beta.0', 'v0.36.0'],
        findMirroredCommits: (sha) =>
          sha === PRIVATE ? [{ sha: MIRRORED, message: `GitOrigin-RevId: ${PRIVATE}` }] : [],
        contains: (tag, sha) => sha === MIRRORED && tag === 'v0.36.0',
        channel: 'beta',
      }),
    ).toMatchObject({ shipped: true, tag: 'v0.36.0', version: '0.36.0' });
  });
});
