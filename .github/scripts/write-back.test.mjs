import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  CANDIDATE_QUERY,
  DEFAULT_RELEASE_LOOKBACK,
  deriveVersionForFixRefs,
  makeReleaseWindow,
  notificationMarkerUrl,
  parseChangeset,
  runWriteBack,
} from './write-back.mjs';

const GH_ISSUE = 'https://github.com/inkeep/open-knowledge/issues/769';
const GH_PULL = 'https://github.com/inkeep/agents-private/pull/2844';
const SLACK_ARCHIVE = 'https://inkeep.slack.com/archives/C016VCYCL74/p1727122965001469';
const DISCORD_THREAD = 'https://discord.com/channels/1514363990740828223/1528881792063508610';
const CHANGESET = { title: 'Honor backslash escapes', body: 'Honor backslash escapes in the markdown promoters.' };

// The real chain off the mirror: a private merge commit, its mirrored copy, and
// the stable tag that first contains it.
const PRIVATE_SHA = 'da71f0c698ccaac11da915169ca6c7d585d5eb97';
const MIRRORED_SHA = 'eb52a625cd86859a8ec43ddc8f96e9b418d092a7';
const STABLE_TAGS = ['v0.35.0', 'v0.35.2', 'v0.35.6', 'v0.36.0'];

const candidate = (overrides = {}) => ({
  id: 'uuid-7539',
  identifier: 'PRD-7539',
  stateType: 'completed',
  labels: ['Bug', 'ok:platform'],
  attachmentUrls: [GH_PULL, GH_ISSUE],
  ...overrides,
});

// Every boundary is a plain closure. `writes` is the ledger the dry-run test
// asserts stays empty.
function harness(overrides = {}) {
  const logs = [];
  const writes = [];
  const deps = {
    listCandidates: async () => [candidate()],
    listChildren: async () => [],
    versionFor: async () => 'v0.36.0',
    readChangesetProse: async () => CHANGESET,
    postReply: async (origin, text) => writes.push({ kind: 'post', origin: origin.url, text }),
    recordNotification: async (marker) => writes.push({ kind: 'mark', url: marker.url }),
    // Every candidate in these fixtures ships in v0.36.0; the window tests
    // below drive the scoping itself.
    classifyRelease: makeReleaseWindow({ releaseTag: 'v0.36.0', stableTags: STABLE_TAGS }),
    log: (m) => logs.push(m),
    ...overrides,
  };
  return { deps, logs, writes, run: () => runWriteBack(deps) };
}

describe('candidate enumeration', () => {
  test('candidates come from a Linear ticket query, never from a walk over release commits', () => {
    expect(CANDIDATE_QUERY).toContain('issues(');
    expect(CANDIDATE_QUERY).toContain('state: { type: { eq: "completed" } }');
    expect(CANDIDATE_QUERY).not.toMatch(/commits?\s*\(/);
  });

  test('the label filter matches any label, so a Bug ticket carrying a platform label is still enumerated', () => {
    expect(CANDIDATE_QUERY).toContain('labels: { name: { eq: "Bug" } }');
    // `labels: { every: ... }` reads almost the same and would drop every
    // multi-labelled ticket, which in practice is nearly all of them.
    expect(CANDIDATE_QUERY).not.toContain('every');
  });

  test('the not-yet-notified condition is not expressed inside the query', () => {
    expect(CANDIDATE_QUERY).not.toMatch(/notified/i);
    expect(CANDIDATE_QUERY).toContain('attachments');
  });

  test('the module imports the shared shipped-version resolver rather than reimplementing containment', () => {
    const source = readFileSync(new URL('./write-back.mjs', import.meta.url), 'utf8');
    expect(source).toMatch(/from '\.\/resolve-shipped-version\.mjs'/);
    expect(source).toContain('resolveShippedVersion');
    // The one place tag containment may be spelled out is the injected git
    // boundary it hands to that resolver.
    expect(source.match(/merge-base/g)?.length ?? 0).toBeLessThanOrEqual(2);
  });
});

describe('version derivation', () => {
  const findMirrored = (sha) =>
    sha === PRIVATE_SHA ? [{ sha: MIRRORED_SHA, message: `subject\n\nGitOrigin-RevId: ${PRIVATE_SHA}\n` }] : [];
  const containsFrom = (map) => (tag, sha) => (map[sha] ?? []).includes(tag);

  const derive = (overrides = {}) =>
    deriveVersionForFixRefs({
      stableTags: STABLE_TAGS,
      findMirroredCommits: findMirrored,
      contains: containsFrom({ [MIRRORED_SHA]: ['v0.36.0'] }),
      resolvePrMergeSha: () => PRIVATE_SHA,
      ...overrides,
    });

  test('a pull-request fix reference resolves through tag containment', () => {
    expect(derive({ fixReferences: [{ channel: 'pull-request', url: GH_PULL }] })).toBe('0.36.0');
  });

  test('a commit fix reference resolves without needing a pull request', () => {
    expect(
      derive({
        fixReferences: [{ channel: 'commit', url: 'https://github.com/x/y/commit/' + PRIVATE_SHA, sha: PRIVATE_SHA }],
        resolvePrMergeSha: () => {
          throw new Error('a commit reference must not need the pull-request hop');
        },
      }),
    ).toBe('0.36.0');
  });

  test('across several fix references the answer is the highest, so the build contains all of them', () => {
    const otherSha = 'b'.repeat(40);
    const otherMirrored = 'c'.repeat(40);
    expect(
      deriveVersionForFixRefs({
        fixReferences: [
          { channel: 'commit', url: 'u1', sha: PRIVATE_SHA },
          { channel: 'commit', url: 'u2', sha: otherSha },
        ],
        stableTags: STABLE_TAGS,
        findMirroredCommits: (sha) =>
          sha === PRIVATE_SHA
            ? [{ sha: MIRRORED_SHA, message: `GitOrigin-RevId: ${PRIVATE_SHA}` }]
            : [{ sha: otherMirrored, message: `GitOrigin-RevId: ${otherSha}` }],
        contains: containsFrom({
          [MIRRORED_SHA]: ['v0.35.2', 'v0.35.6', 'v0.36.0'],
          [otherMirrored]: ['v0.36.0'],
        }),
        resolvePrMergeSha: () => PRIVATE_SHA,
      }),
    ).toBe('0.36.0');
  });

  test('a fix reference that has not reached a stable release yields no version at all', () => {
    expect(
      derive({
        fixReferences: [{ channel: 'commit', url: 'u', sha: PRIVATE_SHA }],
        contains: () => false,
      }),
    ).toBeNull();
  });

  test('a ticket with no fix references yields no version rather than throwing', () => {
    expect(derive({ fixReferences: [] })).toBeNull();
  });

  test('an infra failure in the git boundary propagates rather than reading as not-shipped', () => {
    expect(() =>
      derive({
        fixReferences: [{ channel: 'commit', url: 'u', sha: PRIVATE_SHA }],
        contains: () => {
          throw new Error('git exploded');
        },
      }),
    ).toThrow(/git exploded/);
  });
});

describe('idempotency marker', () => {
  test('the marker url is deterministic in the origin and the version', () => {
    const a = notificationMarkerUrl({ version: '0.36.0', originUrl: GH_ISSUE });
    const b = notificationMarkerUrl({ version: 'v0.36.0', originUrl: GH_ISSUE });
    expect(a).toBe(b);
    expect(a).toContain('/releases/tag/v0.36.0');
    expect(a).toContain(encodeURIComponent(GH_ISSUE));
  });

  test('a different origin or a different version yields a different marker', () => {
    const base = notificationMarkerUrl({ version: '0.36.0', originUrl: GH_ISSUE });
    expect(notificationMarkerUrl({ version: '0.36.1', originUrl: GH_ISSUE })).not.toBe(base);
    expect(notificationMarkerUrl({ version: '0.36.0', originUrl: `${GH_ISSUE}0` })).not.toBe(base);
  });
});

describe('write-back run', () => {
  test('with no explicit live mode it composes and logs but performs no writes at all', async () => {
    const h = harness();
    const result = await h.run();
    expect(result.dryRun).toBe(true);
    expect(h.writes).toEqual([]);
    expect(result.posted).toHaveLength(1);
    expect(h.logs.some((m) => m.includes('[dry run]'))).toBe(true);
  });

  test('in live mode it records the notification before posting to the origin', async () => {
    const h = harness({ live: true });
    await h.run();
    // The order is the at-most-once guarantee, not an incidental detail. Were
    // the reply to land first, a crash before the marker was written would
    // re-send a reply the reporter had already read on the next run.
    expect(h.writes.map((w) => w.kind)).toEqual(['mark', 'post']);
    const post = h.writes.find((w) => w.kind === 'post');
    const mark = h.writes.find((w) => w.kind === 'mark');
    expect(post.origin).toBe(GH_ISSUE);
    expect(post.text).toContain('v0.36.0');
    expect(mark.url).toBe(notificationMarkerUrl({ version: '0.36.0', originUrl: GH_ISSUE }));
  });

  test('a discord-thread origin is composed for Discord, not just classified as one', async () => {
    const h = harness({
      live: true,
      listCandidates: async () => [candidate({ attachmentUrls: [GH_PULL, DISCORD_THREAD] })],
    });
    await h.run();
    const post = h.writes.find((w) => w.kind === 'post');
    // The gate's own tests pin the two formattings; what this pins is the
    // wiring between them, which a rename anywhere along
    // classify -> origin.channel -> composeReply would sever silently while
    // every unit test still passed.
    expect(post.origin).toBe(DISCORD_THREAD);
    expect(post.text).toContain('<https://github.com/inkeep/open-knowledge/releases>');
  });

  test('a failure while recording the marker leaves the reporter unmessaged', async () => {
    const h = harness({
      live: true,
      recordNotification: async () => {
        throw new Error('Linear attachmentCreate reported failure');
      },
    });
    await expect(h.run()).rejects.toThrow(/attachmentCreate/);
    expect(h.writes.filter((w) => w.kind === 'post')).toHaveLength(0);
  });

  test('running twice against the same release posts exactly once', async () => {
    const marker = notificationMarkerUrl({ version: '0.36.0', originUrl: GH_ISSUE });
    const first = harness({ live: true });
    await first.run();
    expect(first.writes.filter((w) => w.kind === 'post')).toHaveLength(1);

    // The second run sees the marker the first one recorded, exactly as a
    // re-read of the ticket would.
    const second = harness({
      live: true,
      listCandidates: async () => [candidate({ attachmentUrls: [GH_PULL, GH_ISSUE, marker] })],
    });
    const result = await second.run();
    expect(second.writes).toEqual([]);
    expect(result.skipped).toEqual([{ identifier: 'PRD-7539', reason: 'already-notified' }]);
  });

  test('a candidate whose version cannot be derived posts nothing and warns distinguishably', async () => {
    const h = harness({ live: true, versionFor: async () => null });
    const result = await h.run();
    expect(h.writes).toEqual([]);
    expect(result.skipped).toEqual([{ identifier: 'PRD-7539', reason: 'version-underivable' }]);
    expect(h.logs.some((m) => m.startsWith('::warning::') && m.includes('no stable release could be derived'))).toBe(
      true,
    );
  });

  test('a candidate whose only origin cannot be replied to posts nothing and warns', async () => {
    const h = harness({
      live: true,
      listCandidates: async () => [candidate({ attachmentUrls: [GH_PULL, SLACK_ARCHIVE] })],
    });
    const result = await h.run();
    expect(h.writes).toEqual([]);
    expect(result.skipped).toEqual([{ identifier: 'PRD-7539', reason: 'origin-unrepliable' }]);
    expect(h.logs.some((m) => m.startsWith('::warning::') && m.includes('nowhere to post'))).toBe(true);
  });

  test('a candidate with no origin at all is skipped quietly, because not every fix has a reporter', async () => {
    const h = harness({ live: true, listCandidates: async () => [candidate({ attachmentUrls: [GH_PULL] })] });
    const result = await h.run();
    expect(h.writes).toEqual([]);
    expect(result.skipped).toEqual([{ identifier: 'PRD-7539', reason: 'no-origin' }]);
    expect(h.logs.some((m) => m.startsWith('::warning::'))).toBe(false);
  });

  test('an outstanding descendant withholds the whole reply', async () => {
    const h = harness({
      live: true,
      listChildren: async () => [
        { id: 'a', identifier: 'PRD-7398', stateType: 'completed', labels: ['Bug'], attachmentUrls: [] },
        { id: 'b', identifier: 'PRD-7401', stateType: 'unstarted', labels: [], attachmentUrls: [] },
      ],
    });
    const result = await h.run();
    expect(h.writes).toEqual([]);
    expect(result.skipped).toEqual([{ identifier: 'PRD-7539', reason: 'fan-in-withheld' }]);
  });

  test('a candidate with no changeset prose posts nothing rather than a bare version', async () => {
    const h = harness({ live: true, readChangesetProse: async () => null });
    const result = await h.run();
    expect(h.writes).toEqual([]);
    expect(result.skipped).toEqual([{ identifier: 'PRD-7539', reason: 'no-prose' }]);
    expect(h.logs.some((m) => m.startsWith('::warning::') && m.includes('no changeset prose'))).toBe(true);
  });

  test('an infra failure throws out of the run rather than being folded into silence', async () => {
    const h = harness({
      live: true,
      listCandidates: async () => {
        throw new Error('Linear GraphQL returned HTTP 500');
      },
    });
    await expect(h.run()).rejects.toThrow(/HTTP 500/);
  });

  test('the coverage of a fanned-in report reaches the reply', async () => {
    const h = harness({
      live: true,
      listChildren: async () => [
        { id: 'a', identifier: 'PRD-7398', stateType: 'completed', labels: ['Bug'], attachmentUrls: [] },
        { id: 'b', identifier: 'PRD-7403', stateType: 'completed', labels: [], attachmentUrls: [] },
      ],
    });
    await h.run();
    expect(h.writes.find((w) => w.kind === 'post').text).toContain('Covers PRD-7398, PRD-7403.');
  });
});

describe('changeset parsing', () => {
  test('the bump block is stripped and the release note is what remains', () => {
    const parsed = parseChangeset(
      ['---', "'@inkeep/open-knowledge': patch", '---', '', 'Honor backslash escapes in the promoters.', ''].join(
        '\n',
      ),
    );
    expect(parsed).toEqual({
      title: 'Honor backslash escapes in the promoters.',
      body: 'Honor backslash escapes in the promoters.',
    });
  });

  test('a multi-line note keeps its first line as the title and its whole text as the body', () => {
    const parsed = parseChangeset(['---', "'x': patch", '---', '', 'Short subject', '', 'More detail.'].join('\n'));
    expect(parsed.title).toBe('Short subject');
    expect(parsed.body).toContain('More detail.');
  });

  test('a changeset with no prose yields nothing rather than an empty reply', () => {
    expect(parseChangeset(['---', "'x': patch", '---', ''].join('\n'))).toBeNull();
    expect(parseChangeset('')).toBeNull();
  });
});

// The properties that keep a reporter-facing side effect from ever touching a
// release: its own trigger, its own concurrency group, and no edit to any of
// the three publish workflows.
describe('workflow shape', () => {
  const read = (name) => readFileSync(new URL(`../workflows/${name}`, import.meta.url), 'utf8');
  const workflow = read('write-back.yml');

  test('it triggers on the existing release dispatch rather than on release published', () => {
    expect(workflow).toMatch(/repository_dispatch:\s*\n\s*types:\s*\[desktop-release\]/);
    expect(workflow).not.toMatch(/^\s{2}release:/m);
    expect(workflow).not.toContain('types: [published]');
  });

  test('only a bare stable tag runs the write-back', () => {
    expect(workflow).toContain('^v[0-9]+\\.[0-9]+\\.[0-9]+$');
    expect(workflow).toMatch(/if:\s*steps\.tag\.outputs\.stable == 'true'/);
  });

  test('it carries its own concurrency group so a release can never queue behind it', () => {
    const group = /concurrency:\s*\n(?:\s*#.*\n)*\s*group:\s*(.+)/.exec(workflow)?.[1] ?? '';
    expect(group).toContain('reporter-write-back');
    for (const other of ['release.yml', 'promote-stable.yml', 'linear-release.yml']) {
      const otherGroup = /concurrency:\s*\n(?:\s*#.*\n)*\s*group:\s*(.+)/.exec(read(other))?.[1] ?? '';
      expect(group.trim()).not.toBe(otherGroup.trim());
    }
  });

  test('the checkout provides full history and tags so containment can be computed', () => {
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('fetch-tags: true');
  });

  test('no release workflow references the write-back, so it cannot fail a release', () => {
    for (const name of ['release.yml', 'promote-stable.yml', 'desktop-release.yml']) {
      expect(read(name)).not.toMatch(/write-back/i);
    }
  });

  test('live posting needs an explicit mode on top of the credential', () => {
    expect(workflow).toContain('WRITE_BACK_MODE');
    expect(workflow).toContain('LINEAR_API_KEY');
  });
});

describe('release window', () => {
  // A longer history than the lookback, so "outside the window" is reachable.
  const TAGS = ['v0.34.0', 'v0.35.0', 'v0.35.1', 'v0.35.2', 'v0.36.0', 'v0.37.0'];
  const windowFor = (releaseTag, lookback) =>
    makeReleaseWindow({ releaseTag, stableTags: TAGS, lookback });

  test('the release being processed is in window', () => {
    expect(windowFor('v0.36.0')('0.36.0')).toBe('in-window');
  });

  test('a version above the release has not reached anyone yet', () => {
    expect(windowFor('v0.36.0')('0.37.0')).toBe('not-yet-shipped');
  });

  test('the lookback keeps recent releases reachable so a missed run self-heals', () => {
    const classify = windowFor('v0.36.0', 3);
    // v0.36.0 plus the three before it.
    for (const v of ['0.36.0', '0.35.2', '0.35.1', '0.35.0']) {
      expect(classify(v)).toBe('in-window');
    }
  });

  test('anything older than the lookback is left alone', () => {
    expect(windowFor('v0.36.0', 3)('0.34.0')).toBe('shipped-earlier');
  });

  test('a narrower lookback excludes more of the history', () => {
    const classify = windowFor('v0.36.0', 1);
    expect(classify('0.35.2')).toBe('in-window');
    expect(classify('0.35.1')).toBe('shipped-earlier');
  });

  test('a zero lookback degenerates to the exact release and nothing else', () => {
    const classify = windowFor('v0.36.0', 0);
    expect(classify('0.36.0')).toBe('in-window');
    expect(classify('0.35.2')).toBe('shipped-earlier');
  });

  test('too little history to reach back keeps everything at or below the release', () => {
    // Fewer known tags than the lookback wants leaves no floor at all, so the
    // ceiling is the only bound. Pinned because it is a distinct branch from
    // the one every other case here exercises.
    const classify = makeReleaseWindow({ releaseTag: 'v0.36.0', stableTags: ['v0.36.0'] });
    expect(classify('0.36.0')).toBe('in-window');
    expect(classify('0.35.0')).toBe('in-window');
    expect(classify('0.37.0')).toBe('not-yet-shipped');
  });

  test('the v prefix is accepted on both sides', () => {
    expect(windowFor('0.36.0')('v0.36.0')).toBe('in-window');
  });

  test('an underivable version is reported as such rather than silently admitted', () => {
    expect(windowFor('v0.36.0')(null)).toBe('unversioned');
  });

  test('a missing or malformed release tag refuses rather than admitting all of history', () => {
    for (const bad of [undefined, '', '   ', 'v0.36.0-beta.1', 'latest']) {
      expect(() => makeReleaseWindow({ releaseTag: bad, stableTags: TAGS })).toThrow(/RELEASE_TAG/);
    }
  });

  test('the default lookback is three', () => {
    expect(DEFAULT_RELEASE_LOOKBACK).toBe(3);
  });
});

describe('release window applied to a run', () => {
  // The fixture candidate ships in v0.36.0 throughout.
  test('a candidate that shipped before the window is skipped, not replied to', async () => {
    const h = harness({
      live: true,
      classifyRelease: makeReleaseWindow({
        releaseTag: 'v0.41.0',
        stableTags: ['v0.36.0', 'v0.38.0', 'v0.39.0', 'v0.40.0', 'v0.41.0'],
      }),
    });
    const result = await h.run();
    expect(result.skipped).toContainEqual({ identifier: 'PRD-7539', reason: 'shipped-earlier' });
    expect(h.writes).toHaveLength(0);
  });

  test('a candidate whose fix is not in this release yet is skipped, not replied to', async () => {
    const h = harness({
      live: true,
      classifyRelease: makeReleaseWindow({
        releaseTag: 'v0.35.0',
        stableTags: ['v0.35.0', 'v0.36.0'],
      }),
    });
    const result = await h.run();
    expect(result.skipped).toContainEqual({ identifier: 'PRD-7539', reason: 'not-yet-shipped' });
    expect(h.writes).toHaveLength(0);
  });

  test('a candidate inside the window still gets its reply', async () => {
    const h = harness({
      live: true,
      classifyRelease: makeReleaseWindow({ releaseTag: 'v0.36.0', stableTags: STABLE_TAGS }),
    });
    await h.run();
    expect(h.writes.filter((w) => w.kind === 'post')).toHaveLength(1);
  });

  test('runWriteBack refuses to run unscoped', async () => {
    const h = harness({ live: true, classifyRelease: undefined });
    await expect(h.run()).rejects.toThrow(/classifyRelease/);
  });
});
