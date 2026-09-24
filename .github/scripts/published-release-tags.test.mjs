import { expect, test } from 'vitest';
import {
  previousPublishedRelease,
  publishedReleaseTags,
  requirePublishedRelease,
} from './published-release-tags.mjs';
import { deriveVersionForFixRefs, makeReleaseWindow } from './write-back.mjs';

const release = (tag_name, over = {}) => ({
  tag_name,
  draft: false,
  published_at: '2026-09-24T22:00:00Z',
  assets: [{ name: 'OpenKnowledge-arm64.dmg' }, { name: 'beta-mac.yml' }],
  ...over,
});

test('drafts, missing publication timestamps and metadata-only records are not shipped releases', () => {
  expect(
    publishedReleaseTags([
      release('v0.77.8'),
      release('v0.77.9', { draft: true }),
      release('v0.78.0-beta.1', { published_at: null }),
      release('v0.78.0-beta.2', { assets: [] }),
      release('v0.78.0-beta.4', { assets: [{ name: 'OpenKnowledge-arm64.dmg' }] }),
      release('v0.78.0-beta.5', { assets: [{ name: 'beta-mac.yml' }] }),
      release('v0.78.0-beta.3'),
    ]),
  ).toEqual(['v0.77.8', 'v0.78.0-beta.3']);
  expect(() => requirePublishedRelease('v0.77.9', ['v0.77.8'])).toThrow(
    'refusing release writeback',
  );
});

test('a recovered cumulative beta includes fixes first tagged across twelve unpublished drafts', () => {
  const pending = [
    ...Array.from({ length: 5 }, (_, i) => `v0.77.9-beta.${i + 1}`),
    ...Array.from({ length: 7 }, (_, i) => `v0.78.0-beta.${i}`),
  ];
  const tags = publishedReleaseTags([
    release('v0.77.8'),
    release('v0.77.9'),
    ...pending.map((tag) =>
      release(tag, {
        draft: tag !== 'v0.78.0-beta.6',
        published_at: tag === 'v0.78.0-beta.6' ? '2026-09-24T22:00:00Z' : null,
      }),
    ),
  ]);
  const privateSha = 'a'.repeat(40);
  const version = deriveVersionForFixRefs({
    fixReferences: [{ channel: 'commit', sha: privateSha }],
    stableTags: tags,
    channel: 'beta',
    findMirroredCommits: () => [{ sha: 'b'.repeat(40), message: `GitOrigin-RevId: ${privateSha}` }],
    contains: (tag) => tag === 'v0.78.0-beta.6',
    resolvePrMergeSha: () => privateSha,
  });
  expect(version).toBe('0.78.0-beta.6');
  expect(
    makeReleaseWindow({ releaseTag: 'v0.78.0-beta.6', stableTags: tags, channel: 'beta' })(version),
  ).toBe('in-window');
  expect(previousPublishedRelease('v0.78.0-beta.6', tags)).toBe('v0.77.9');
});
