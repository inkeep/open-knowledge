import { expect, test } from 'vitest';
import {
  createVersionFor,
  makeReleaseWindow,
  notificationMarkerUrl,
  runWriteBack,
  unavailableNotificationVersions,
} from './write-back.mjs';

const origin = 'https://github.com/inkeep/open-knowledge/issues/1428';
const pull = 'https://github.com/inkeep/agents-private/pull/4879';
const oldVersion = '0.78.0-beta.0';
const version = '0.78.0-beta.6';
const oldMarker = notificationMarkerUrl({ version: oldVersion, originUrl: origin });

function recoveryHarness(overrides = {}) {
  const attachments = [origin, pull, oldMarker];
  const posts = [];
  const marked = [];
  const logs = [];
  const deps = {
    channel: 'beta',
    selfRepo: 'inkeep/open-knowledge',
    live: true,
    listCandidates: async () => [
      {
        id: 'ticket',
        identifier: 'PRD-8413',
        stateType: 'completed',
        attachmentUrls: [...attachments],
      },
    ],
    listChildren: async () => [],
    versionFor: async () => version,
    stableVersionFor: async () => null,
    isPublishedVersion: (v) => v === version,
    classifyRelease: makeReleaseWindow({ releaseTag: 'v0.78.0-beta.99' }),
    readChangesetProse: async () => ({ title: 'Fix the reported behavior' }),
    recordNotification: async (marker) => {
      attachments.push(marker.url);
      marked.push(marker);
    },
    postReply: async (target, text) => posts.push({ target, text }),
    log: (line) => logs.push(line),
    ...overrides,
  };
  return { deps, attachments, posts, marked, logs, run: () => runWriteBack(deps) };
}

test('a failed or skipped release produces one correction when a containing build actually publishes', async () => {
  const h = recoveryHarness();
  const first = await h.run();
  expect(first.errored).toEqual([]);
  expect(h.posts).toHaveLength(1);
  expect(h.posts[0].text).toContain('Correction to our earlier update');
  expect(h.posts[0].text).toContain('v0.78.0-beta.0');
  expect(h.posts[0].text).toContain('/releases/tag/v0.78.0-beta.6');
  expect(h.posts[0].text).not.toContain('finished uploading');
  expect(h.attachments).toContain(oldMarker);
  expect(h.marked[0].url).toBe(notificationMarkerUrl({ version, originUrl: origin }));
  const second = await h.run();
  expect(second.skipped).toContainEqual({ identifier: 'PRD-8413', reason: 'already-notified' });
  expect(h.posts).toHaveLength(1);
});

test('later corrective fixes do not repeat a recovery correction already delivered', async () => {
  const later = '0.78.0-beta.9';
  const h = recoveryHarness({ isPublishedVersion: (v) => [version, later].includes(v) });
  await h.run();
  h.deps.versionFor = async () => later;
  await h.run();
  expect(h.posts).toHaveLength(2);
  expect(h.posts.filter((p) => p.text.includes('Correction to our earlier update'))).toHaveLength(
    1,
  );
  expect(h.posts[1].text).toContain(later);
  expect(h.attachments).toContain(oldMarker);
});

test('one correction lists multiple unavailable announcements with plural wording', async () => {
  const h = recoveryHarness();
  h.attachments.push(notificationMarkerUrl({ version: '0.78.0-beta.1', originUrl: origin }));
  await h.run();
  expect(h.posts[0].text).toContain(
    'releases we linked (v0.78.0-beta.0, v0.78.0-beta.1) are not available',
  );
});

test('both channels reuse successful PR, commit-message and mirrored-history lookups within a run', () => {
  const counts = { pr: 0, message: 0, mirror: 0 };
  const sha = 'a'.repeat(40);
  const resolve = createVersionFor({
    selfRepo: 'inkeep/open-knowledge',
    stableTags: ['v0.78.0-beta.6', 'v0.78.0'],
    resolvePrMergeSha: () => {
      counts.pr++;
      return 'b'.repeat(40);
    },
    readCommitMessage: () => {
      counts.message++;
      return `GitOrigin-RevId: ${sha}`;
    },
    findMirroredCommits: () => {
      counts.mirror++;
      return [{ sha: 'c'.repeat(40), message: `GitOrigin-RevId: ${sha}` }];
    },
    contains: () => true,
  });
  const node = { attachmentUrls: ['https://github.com/inkeep/open-knowledge/pull/1500'] };
  expect(resolve(node, 'beta')).toBe('0.78.0-beta.6');
  expect(resolve(node, 'stable')).toBe('0.78.0');
  expect(resolve(node, 'beta')).toBe('0.78.0-beta.6');
  expect(counts).toEqual({ pr: 1, message: 1, mirror: 1 });
});

test('a dry-run previews the correction without changing receipts or posting', async () => {
  const h = recoveryHarness({ live: false });
  await h.run();
  expect(h.posts).toEqual([]);
  expect(h.marked).toEqual([]);
  expect(h.logs.some((l) => l.includes('[dry run] recovery correction:'))).toBe(true);
});

test('resolution caches keep distinct PR numbers and SHAs separate', () => {
  const counts = { pr: 0, message: 0, mirror: 0 };
  const resolve = createVersionFor({
    selfRepo: 'inkeep/open-knowledge',
    stableTags: ['v0.78.0-beta.6', 'v0.78.0-beta.9', 'v0.78.0'],
    resolvePrMergeSha: ({ number }) => {
      counts.pr++;
      return (number === 1500 ? 'a' : 'b').repeat(40);
    },
    readCommitMessage: (sha) => {
      counts.message++;
      return `GitOrigin-RevId: ${sha}`;
    },
    findMirroredCommits: (sha) => {
      counts.mirror++;
      return [{ sha, message: `GitOrigin-RevId: ${sha}` }];
    },
    contains: (tag, sha) => sha === 'a'.repeat(40) || tag !== 'v0.78.0-beta.6',
  });
  const first = { attachmentUrls: ['https://github.com/inkeep/open-knowledge/pull/1500'] };
  const second = { attachmentUrls: ['https://github.com/inkeep/open-knowledge/pull/1501'] };
  expect(resolve(first, 'beta')).toBe('0.78.0-beta.6');
  expect(resolve(second, 'beta')).toBe('0.78.0-beta.9');
  expect(resolve(first, 'stable')).toBe('0.78.0');
  expect(resolve(second, 'stable')).toBe('0.78.0');
  expect(counts).toEqual({ pr: 2, message: 2, mirror: 2 });
});

test.each(['pr', 'message', 'mirror'])(
  'a failed %s lookup is retried, not cached as a result',
  (failureAt) => {
    const counts = { pr: 0, message: 0, mirror: 0 };
    const sha = 'a'.repeat(40);
    const read = (name, value) => {
      counts[name]++;
      if (name === failureAt && counts[name] === 1) throw new Error('transient ' + name);
      return value;
    };
    const resolve = createVersionFor({
      selfRepo: 'inkeep/open-knowledge',
      stableTags: ['v0.78.0-beta.6', 'v0.78.0'],
      resolvePrMergeSha: () => read('pr', sha),
      readCommitMessage: () => read('message', `GitOrigin-RevId: ${sha}`),
      findMirroredCommits: () => read('mirror', [{ sha, message: `GitOrigin-RevId: ${sha}` }]),
      contains: () => true,
    });
    const node = { attachmentUrls: ['https://github.com/inkeep/open-knowledge/pull/1500'] };
    expect(() => resolve(node, 'beta')).toThrow('transient ' + failureAt);
    expect(resolve(node, 'beta')).toBe('0.78.0-beta.6');
    expect(resolve(node, 'stable')).toBe('0.78.0');
    expect(counts[failureAt]).toBe(2);
    for (const name of ['pr', 'message', 'mirror'].filter((name) => name !== failureAt))
      expect(counts[name]).toBe(1);
  },
);

test('backfilling an older release does not notify an origin already told about a newer available build', async () => {
  const h = recoveryHarness({ isPublishedVersion: () => true });
  h.attachments.push(notificationMarkerUrl({ version: '0.78.0-beta.9', originUrl: origin }));
  const r = await h.run();
  expect(h.posts).toEqual([]);
  expect(r.skipped).toContainEqual({ identifier: 'PRD-8413', reason: 'already-notified' });
});

test('a genuinely later corrective fix still gets an update after an earlier published notification', async () => {
  const h = recoveryHarness({ isPublishedVersion: () => true });
  await h.run();
  expect(h.posts).toHaveLength(1);
  expect(h.posts[0].text).not.toContain('Correction to our earlier update');
});

test('only unavailable receipts for this origin and channel trigger a correction', () => {
  const other = notificationMarkerUrl({ version: oldVersion, originUrl: origin + '0' });
  const stable = notificationMarkerUrl({ version: '0.77.9', originUrl: origin });
  expect(
    unavailableNotificationVersions({
      attachmentUrls: [oldMarker, oldMarker, other, stable, 'invalid'],
      originUrl: origin,
      channel: 'beta',
      isPublishedVersion: () => false,
    }),
  ).toEqual([oldVersion]);
  expect(
    unavailableNotificationVersions({
      attachmentUrls: [oldMarker],
      originUrl: origin,
      channel: 'beta',
      isPublishedVersion: () => true,
    }),
  ).toEqual([]);
});

test('a missed beta notice is suppressed once all required work is available in stable', async () => {
  const h = recoveryHarness({ stableVersionFor: async () => '0.78.0' });
  const r = await h.run();
  expect(h.posts).toEqual([]);
  expect(r.skipped).toContainEqual({ identifier: 'PRD-8413', reason: 'stable-covers-it' });
});

test('one stable child does not suppress beta availability for the remaining required work', async () => {
  const h = recoveryHarness({
    listChildren: async () =>
      ['a', 'b'].map((id) => ({
        id,
        identifier: id,
        stateType: 'completed',
        attachmentUrls: [pull],
      })),
    stableVersionFor: async (node) => (node.id === 'a' ? '0.78.0' : null),
  });
  await h.run();
  expect(h.posts).toHaveLength(1);
});

test('a corrected beta receipt does not suppress the later stable follow-up', async () => {
  const h = recoveryHarness();
  await h.run();
  h.deps.channel = 'stable';
  h.deps.versionFor = async () => '0.78.0';
  h.deps.classifyRelease = makeReleaseWindow({ releaseTag: 'v0.78.0' });
  await h.run();
  expect(h.posts).toHaveLength(2);
  expect(h.posts[1].text).toContain('This shipped in Open Knowledge v0.78.0');
  expect(h.posts[1].text).not.toContain('Correction');
});
