import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  CANDIDATE_QUERY,
  changesetDirFor,
  DEFAULT_BETA_LOOKBACK,
  DEFAULT_RELEASE_LOOKBACK,
  deriveChannel,
  deriveVersionForFixRefs,
  findChangesetPath,
  isFixRepoInRemit,
  isRetryableNetworkError,
  isSelfRepoPr,
  isRetryableStatus,
  isStableVersion,
  LINEAR_RETRY_ATTEMPTS,
  LINEAR_RETRY_CAP_MS,
  linearGraphql,
  makeReleaseWindow,
  notificationMarkerUrl,
  parseChangeset,
  parseMergeShaOutput,
  parseRetryAfterSeconds,
  retryDelayMs,
  runFailureMessage,
  runWriteBack,
  selectGhToken,
} from './write-back.mjs';

const GH_ISSUE = 'https://github.com/inkeep/open-knowledge/issues/769';
const GH_PULL = 'https://github.com/inkeep/agents-private/pull/2844';
const SLACK_ARCHIVE = 'https://inkeep.slack.com/archives/C016VCYCL74/p1727122965001469';
const LINEAR_UPLOAD = 'https://uploads.linear.app/abc/def/diagnostics.zip';
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
    selfRepo: 'inkeep/open-knowledge',
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

  test('no label narrows the enumeration, because a label was never what a reply depends on', () => {
    // The Bug label used to be the filter, and it silently excluded every
    // community feature request from ever being told its fix shipped. Whether a
    // reporter hears back must not depend on how triage classified them, so the
    // query narrows on nothing but completion and the real preconditions (an
    // origin, a fix reference) are checked against the data it returns.
    expect(CANDIDATE_QUERY).not.toMatch(/labels\s*:/);
    expect(CANDIDATE_QUERY).not.toContain('Bug');
    expect(CANDIDATE_QUERY).toContain('state: { type: { eq: "completed" } }');
  });

  test('the not-yet-notified condition is not expressed inside the query', () => {
    expect(CANDIDATE_QUERY).not.toMatch(/notified/i);
    expect(CANDIDATE_QUERY).toContain('attachments');
  });

  test('the tag list comes from the shared boundary, never a private copy of it', () => {
    // A private `realStableTags` here filtered the list to bare vX.Y.Z, so no
    // prerelease ever reached the channel-aware resolver and the beta channel
    // resolved nothing in production. Every beta test injects its own tag list,
    // so the unit suite could not see it; this is what stands in for that.
    const source = readFileSync(new URL('./write-back.mjs', import.meta.url), 'utf8');
    expect(source).toMatch(/import \{[^}]*\brealReleaseTags\b[^}]*\} from '\.\/resolve-shipped-version\.mjs'/s);
    expect(source).not.toMatch(/^function real(?:Stable|Release)Tags/m);
    // The list reaches the resolver exactly as git gave it. Narrowing it here,
    // at the definition or at the call site, is the whole failure.
    expect(source).toMatch(/const stableTags = realReleaseTags\(\);/);
    expect(source).not.toMatch(/Tags[^\n]*\.filter\([^\n]*STABLE_TAG_RE/);
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

  test('the beta channel threads through to the resolver and answers with the beta', () => {
    // The seam this whole feature hangs off: deriveVersionForFixRefs ->
    // resolveShippedVersion with a channel. Same fix, same inputs, two answers.
    const shared = {
      fixReferences: [{ channel: 'pull-request', url: GH_PULL }],
      stableTags: [...STABLE_TAGS, 'v0.37.0-beta.0', 'v0.37.0-beta.1'],
      contains: containsFrom({ [MIRRORED_SHA]: ['v0.37.0-beta.0', 'v0.37.0-beta.1'] }),
    };
    expect(derive({ ...shared, channel: 'beta' })).toBe('0.37.0-beta.0');
    // No stable carries it yet, so the stable channel correctly has no answer.
    expect(derive(shared)).toBeNull();
  });

  test('the beta channel still yields nothing for a fix that is in no tag at all', () => {
    expect(
      derive({
        fixReferences: [{ channel: 'pull-request', url: GH_PULL }],
        contains: () => false,
        channel: 'beta',
      }),
    ).toBeNull();
  });

  test('the mirror-PR containment fallback honours the channel it was given', () => {
    // A mirror merge commit with no usable origin trailer falls back to direct
    // containment, which is a second place the tag list has to be channel-aware.
    const mirrorMain = 'd'.repeat(40);
    expect(
      deriveVersionForFixRefs({
        fixReferences: [{ channel: 'pull-request', url: 'https://github.com/inkeep/open-knowledge/pull/928' }],
        stableTags: [...STABLE_TAGS, 'v0.37.0-beta.0'],
        selfRepo: 'inkeep/open-knowledge',
        resolvePrMergeSha: () => mirrorMain,
        readCommitMessage: () => 'subject carrying no trailer at all',
        findMirroredCommits: () => [],
        contains: (tag, sha) => sha === mirrorMain && tag === 'v0.37.0-beta.0',
        channel: 'beta',
      }),
    ).toBe('0.37.0-beta.0');
  });

  test('a mirror pull request in this repo resolves through its merge commit trailer', () => {
    // The Copybara mirror lands every export through a short-lived PR in this
    // repo, and Linear's linkback attaches it to the ticket. Its merge commit
    // IS the mirrored copy, so the resolvable identity is the origin SHA in
    // its own trailer — which also finds the cherry-picked copy a point
    // release carries when the main-line copy is in no stable yet.
    const mirrorMain = 'd'.repeat(40);
    const cherryPick = 'e'.repeat(40);
    expect(
      deriveVersionForFixRefs({
        fixReferences: [{ channel: 'pull-request', url: 'https://github.com/inkeep/open-knowledge/pull/928' }],
        stableTags: STABLE_TAGS,
        selfRepo: 'inkeep/open-knowledge',
        resolvePrMergeSha: () => mirrorMain,
        readCommitMessage: (sha) => (sha === mirrorMain ? `subject\n\nGitOrigin-RevId: ${PRIVATE_SHA}\n` : null),
        findMirroredCommits: (sha) =>
          sha === PRIVATE_SHA
            ? [
                { sha: mirrorMain, message: `GitOrigin-RevId: ${PRIVATE_SHA}` },
                { sha: cherryPick, message: `GitOrigin-RevId: ${PRIVATE_SHA}` },
              ]
            : [],
        contains: containsFrom({ [cherryPick]: ['v0.35.6', 'v0.36.0'] }),
      }),
    ).toBe('0.35.6');
  });

  test('a private fix reference still derives with the mirror PR echo attached beside it', () => {
    // Regression: the echo used to be trailer-searched as a private SHA, find
    // nothing, and null the whole ticket — every ticket whose fix PR title
    // carried an identifier became permanently underivable.
    const mirrorEcho = 'f'.repeat(40);
    expect(
      deriveVersionForFixRefs({
        fixReferences: [
          { channel: 'pull-request', url: GH_PULL },
          { channel: 'pull-request', url: 'https://github.com/inkeep/open-knowledge/pull/928' },
        ],
        stableTags: STABLE_TAGS,
        selfRepo: 'inkeep/open-knowledge',
        resolvePrMergeSha: ({ repo }) => (repo === 'agents-private' ? PRIVATE_SHA : mirrorEcho),
        readCommitMessage: (sha) => (sha === mirrorEcho ? `subject\n\nGitOrigin-RevId: ${PRIVATE_SHA}\n` : null),
        findMirroredCommits: (sha) =>
          sha === PRIVATE_SHA ? [{ sha: MIRRORED_SHA, message: `GitOrigin-RevId: ${PRIVATE_SHA}` }] : [],
        contains: containsFrom({ [MIRRORED_SHA]: ['v0.36.0'] }),
      }),
    ).toBe('0.36.0');
  });

  test('a mirror pull request with no trailer falls back to containment of its merge commit', () => {
    const directSha = 'a1'.repeat(20);
    expect(
      deriveVersionForFixRefs({
        fixReferences: [{ channel: 'pull-request', url: 'https://github.com/inkeep/open-knowledge/pull/500' }],
        stableTags: STABLE_TAGS,
        selfRepo: 'inkeep/open-knowledge',
        resolvePrMergeSha: () => directSha,
        readCommitMessage: () => 'subject with no trailer\n',
        findMirroredCommits: () => {
          throw new Error('a trailerless self-repo merge must not be trailer-searched');
        },
        contains: containsFrom({ [directSha]: ['v0.36.0'] }),
      }),
    ).toBe('0.36.0');
  });

  test('a mirror merge commit with more than one origin trailer is ambiguous and falls back to containment', () => {
    // A message can embed someone else's footer; picking either trailer would
    // be a guess, so the merge commit's own containment is the answer.
    const otherSha = '9'.repeat(40);
    const mergeSha = 'c3'.repeat(20);
    const logs = [];
    expect(
      deriveVersionForFixRefs({
        fixReferences: [{ channel: 'pull-request', url: 'https://github.com/inkeep/open-knowledge/pull/502' }],
        stableTags: STABLE_TAGS,
        selfRepo: 'inkeep/open-knowledge',
        resolvePrMergeSha: () => mergeSha,
        readCommitMessage: () => `GitOrigin-RevId: ${PRIVATE_SHA}\nGitOrigin-RevId: ${otherSha}\n`,
        findMirroredCommits: () => {
          throw new Error('an ambiguous trailer must not be trailer-searched');
        },
        contains: containsFrom({ [mergeSha]: ['v0.35.6'] }),
        log: (m) => logs.push(m),
      }),
    ).toBe('0.35.6');
    expect(logs.join(' ')).toContain('more than one origin trailer');
  });

  test('isSelfRepoPr is repo-identity plus a not-the-origin guard', () => {
    const pr = (owner, repo) => ({ kind: 'pr', owner, repo, number: 1 });
    expect(isSelfRepoPr(pr('inkeep', 'open-knowledge'), 'inkeep/open-knowledge')).toBe(true);
    expect(isSelfRepoPr(pr('inkeep', 'Open-Knowledge'), 'inkeep/open-knowledge')).toBe(true);
    expect(isSelfRepoPr(pr('inkeep', 'agents-private'), 'inkeep/open-knowledge')).toBe(false);
    expect(isSelfRepoPr({ kind: 'sha', sha: 'a'.repeat(40) }, 'inkeep/open-knowledge')).toBe(false);
    expect(isSelfRepoPr(pr('inkeep', 'open-knowledge'), undefined)).toBe(false);
    // A run inside the private monorepo: its own PRs are private references,
    // not mirror-side ones, even though repo identity matches selfRepo.
    expect(isSelfRepoPr(pr('inkeep', 'agents-private'), 'inkeep/agents-private')).toBe(false);
    expect(isSelfRepoPr(pr('inkeep', 'some-fork'), 'inkeep/some-fork', 'inkeep/some-fork')).toBe(false);
  });

  test('a mirror pull request contained in no stable yet yields no version', () => {
    const logs = [];
    expect(
      deriveVersionForFixRefs({
        fixReferences: [{ channel: 'pull-request', url: 'https://github.com/inkeep/open-knowledge/pull/501' }],
        stableTags: STABLE_TAGS,
        selfRepo: 'inkeep/open-knowledge',
        resolvePrMergeSha: () => 'b2'.repeat(20),
        readCommitMessage: () => 'subject with no trailer\n',
        findMirroredCommits: () => [],
        contains: () => false,
        log: (m) => logs.push(m),
      }),
    ).toBeNull();
    expect(logs.join(' ')).toContain('not-in-any-stable');
  });

  test('a fix reference naming a pull request that was closed unmerged is an answer, not a fault', () => {
    // Real shape: PRD-7539 still carries agents-private#2844, which was closed
    // in favour of #2864. A stale attachment is for a human to fix in Linear,
    // so it warns and skips rather than painting the run red.
    const logs = [];
    expect(
      derive({
        fixReferences: [{ channel: 'pull-request', url: GH_PULL }],
        resolvePrMergeSha: () => null,
        log: (m) => logs.push(m),
      }),
    ).toBeNull();
    expect(logs.join(' ')).toContain('closed without merging');
  });

  test('the merge-sha reply distinguishes "never merged" from "cannot be accounted for"', () => {
    const at = { owner: 'inkeep', repo: 'agents-private', number: 2844 };
    const sha = 'da71f0c698ccaac11da915169ca6c7d585d5eb97';

    // The real reply for agents-private#2844: closed, so merged_at is null.
    expect(parseMergeShaOutput('null\n', at)).toBeNull();
    expect(parseMergeShaOutput('\n', at)).toBeNull();
    expect(parseMergeShaOutput('2026-07-23T14:19:56Z\n' + sha, at)).toBe(sha);
    expect(parseMergeShaOutput('2026-07-23T14:19:56Z\n' + sha.toUpperCase(), at)).toBe(sha);

    // Merged but with no usable sha is neither a fix nor an answer.
    expect(() => parseMergeShaOutput('2026-07-23T14:19:56Z\nnot-a-sha', at)).toThrow(/merge_commit_sha/);
  });

  test('a fix reference in a repo this workflow cannot reach is skipped, not attempted', () => {
    // The Linear backlog carries pre-Open-Knowledge tickets whose fix references
    // point at other products' private repos. The cross-repo token is scoped to
    // agents-private, so those reads 404 permanently — attempting them turned
    // every run red on 39 candidates that will never resolve.
    const logs = [];
    expect(
      derive({
        fixReferences: [{ channel: 'pull-request', url: 'https://github.com/inkeep/management/pull/272' }],
        selfRepo: 'inkeep/open-knowledge',
        resolvePrMergeSha: () => {
          throw new Error('must not be attempted: this repo is out of remit');
        },
        log: (m) => logs.push(m),
      }),
    ).toBeNull();
    expect(logs.join(' ')).toContain('outside');
  });

  test('the two repos it CAN read are still attempted, so the 404 bug cannot come back', () => {
    // A blanket 404 suppression would have masked the missing-permission bug on
    // agents-private. These two must always reach the API. The self-repo PR
    // resolves through its merge commit's own trailer rather than a trailer
    // search for its SHA, but it is attempted all the same.
    for (const url of [
      'https://github.com/inkeep/agents-private/pull/2864',
      'https://github.com/inkeep/open-knowledge/pull/12',
    ]) {
      let attempted = false;
      expect(
        derive({
          fixReferences: [{ channel: 'pull-request', url }],
          selfRepo: 'inkeep/open-knowledge',
          resolvePrMergeSha: () => {
            attempted = true;
            return PRIVATE_SHA;
          },
          readCommitMessage: (sha) =>
            sha === PRIVATE_SHA ? `subject\n\nGitOrigin-RevId: ${PRIVATE_SHA}\n` : null,
        }),
      ).toBe('0.36.0');
      expect(attempted, `${url} must be attempted`).toBe(true);
    }
  });

  test('remit is decided by repo identity, and a bare commit SHA needs no repo at all', () => {
    const at = { defaultRepo: 'inkeep/agents-private', selfRepo: 'inkeep/open-knowledge' };
    expect(isFixRepoInRemit({ kind: 'pr', owner: 'inkeep', repo: 'agents-private' }, at)).toBe(true);
    expect(isFixRepoInRemit({ kind: 'pr', owner: 'InKeep', repo: 'Agents-Private' }, at)).toBe(true);
    expect(isFixRepoInRemit({ kind: 'pr', owner: 'inkeep', repo: 'open-knowledge' }, at)).toBe(true);
    expect(isFixRepoInRemit({ kind: 'pr', owner: 'inkeep', repo: 'management' }, at)).toBe(false);
    expect(isFixRepoInRemit({ kind: 'pr', owner: 'inkeep', repo: 'open-knowledge-legacy' }, at)).toBe(false);
    // Resolved against local git history rather than a repo API.
    expect(isFixRepoInRemit({ kind: 'sha', sha: PRIVATE_SHA }, at)).toBe(true);
  });

  test('an unreadable pull request still throws, because that one is not an answer', () => {
    // The 404 that broke the first live run was authorisation, not data. It
    // must stay loud; folding it in with the stale-attachment case would make
    // a repo-wide permission failure look like a tidy row of skips.
    expect(() =>
      derive({
        fixReferences: [{ channel: 'pull-request', url: GH_PULL }],
        resolvePrMergeSha: () => {
          throw new Error('gh api pulls/2844 failed: HTTP 404');
        },
      }),
    ).toThrow(/404/);
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
    expect(post.text).toContain(CHANGESET.body);
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
    const result = await h.run();
    // The at-most-once contract: no marker, therefore no reply. The failure is
    // carried out as an error rather than a skip so the run still goes red.
    expect(h.writes.filter((w) => w.kind === 'post')).toHaveLength(0);
    expect(result.errored).toHaveLength(1);
    expect(result.errored[0].message).toMatch(/attachmentCreate/);
    expect(result.skipped).toEqual([]);
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
    expect(h.logs.some((m) => m.startsWith('::warning::') && m.includes('no origin on it can be replied to'))).toBe(true);
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
describe('locating the changeset a fix shipped with', () => {
  // The real file list off the pull request the first live run choked on.
  const MONOREPO_FILES = [
    'public/open-knowledge/.changeset/default-theme-tile-own-colors.md',
    'public/open-knowledge/packages/app/src/components/ThemeTile.tsx',
  ];

  test('a monorepo pull request keeps its changeset under the subtree, not at the root', () => {
    expect(findChangesetPath(MONOREPO_FILES, { repo: 'agents-private' })).toBe(
      'public/open-knowledge/.changeset/default-theme-tile-own-colors.md',
    );
  });

  test('a pull request against the public mirror keeps it at the root, where that repo puts it', () => {
    expect(findChangesetPath(['.changeset/some-fix.md'], { repo: 'open-knowledge' })).toBe('.changeset/some-fix.md');
  });

  test("another product's changeset is never quoted to an Open Knowledge reporter", () => {
    // The monorepo has three .changeset dirs. Matching any `.changeset/` on the
    // path would put agents-platform release notes in front of an OK reporter,
    // and they would read plausibly enough that nobody would catch it.
    const foreign = ['public/agents/.changeset/some-agents-fix.md', '.changeset/a-stray-root-changeset.md'];
    expect(findChangesetPath(foreign, { repo: 'agents-private' })).toBeNull();
  });

  test('the changeset README is never mistaken for a changeset', () => {
    expect(findChangesetPath(['public/open-knowledge/.changeset/README.md'], { repo: 'agents-private' })).toBeNull();
  });

  test('a pull request that added no changeset yields nothing rather than a wrong file', () => {
    expect(findChangesetPath(['public/open-knowledge/packages/app/src/x.ts'], { repo: 'agents-private' })).toBeNull();
    expect(findChangesetPath([], { repo: 'agents-private' })).toBeNull();
  });

  test('the directory is chosen by repo, since only the mirror has it at the root', () => {
    expect(changesetDirFor('open-knowledge')).toBe('.changeset/');
    expect(changesetDirFor('agents-private')).toBe('public/open-knowledge/.changeset/');
  });
});

describe('cross-repo token selection', () => {
  const env = { CROSS_REPO_TOKEN: 'bridge-token', GITHUB_REPOSITORY: 'inkeep/open-knowledge' };

  test('a read against the private monorepo uses the bridge token', () => {
    expect(selectGhToken({ owner: 'inkeep', repo: 'agents-private', env })).toBe('bridge-token');
  });

  test('a read against this repo keeps the ambient token, which the bridge token cannot replace', () => {
    // The bridge token is scoped to agents-private, so handing it to a call
    // against this repo would 404 the very thing the ambient token can do.
    expect(selectGhToken({ owner: 'inkeep', repo: 'open-knowledge', env })).toBeNull();
    expect(selectGhToken({ owner: 'InKeep', repo: 'Open-Knowledge', env })).toBeNull();
  });

  test('with no bridge token configured every call falls back to the ambient one', () => {
    const bare = { GITHUB_REPOSITORY: 'inkeep/open-knowledge' };
    expect(selectGhToken({ owner: 'inkeep', repo: 'agents-private', env: bare })).toBeNull();
    expect(selectGhToken({ owner: 'inkeep', repo: 'agents-private', env: { ...bare, CROSS_REPO_TOKEN: '  ' } })).toBeNull();
  });
});

describe('one unreadable candidate does not silence the rest', () => {
  const two = (first, second) => ({
    listCandidates: async () => [
      candidate({ id: 'uuid-1', identifier: 'PRD-0001', attachmentUrls: [first, GH_ISSUE] }),
      candidate({ id: 'uuid-2', identifier: 'PRD-0002', attachmentUrls: [second, GH_ISSUE] }),
    ],
  });

  test('a candidate whose fix reference cannot be read is reported, and the next one still posts', async () => {
    const h = harness({
      ...two(GH_PULL, GH_PULL),
      versionFor: async (node) => {
        if (node.identifier === 'PRD-0001') throw new Error('gh api pulls/2844 failed: HTTP 404');
        return 'v0.36.0';
      },
    });
    const result = await h.run();

    expect(result.errored.map((e) => e.identifier)).toEqual(['PRD-0001']);
    expect(result.errored[0].message).toContain('404');
    expect(result.posted.map((p) => p.identifier)).toEqual(['PRD-0002']);
  });

  test('a failure is never filed as a skip, so a broken run cannot read as a quiet one', async () => {
    const h = harness({
      ...two(GH_PULL, GH_PULL),
      versionFor: async () => {
        throw new Error('gh api failed: HTTP 404');
      },
    });
    const result = await h.run();

    expect(result.errored).toHaveLength(2);
    expect(result.skipped).toEqual([]);
  });

  test('errors still turn the run red once the reachable reporters have been told', () => {
    // Surviving a bad candidate must not become a way of passing while broken.
    expect(runFailureMessage({ posted: [], skipped: [], errored: [] })).toBeNull();
    expect(runFailureMessage({ skipped: [{ identifier: 'PRD-1', reason: 'no-origin' }], errored: [] })).toBeNull();

    const message = runFailureMessage({
      errored: [
        { identifier: 'PRD-0001', message: 'HTTP 404' },
        { identifier: 'PRD-0002', message: 'HTTP 502' },
      ],
    });
    expect(message).toContain('2 of the candidates');
    expect(message).toContain('PRD-0001');
    expect(message).toContain('PRD-0002');
  });

  test('a reply that fails after its marker was written says so, because no run will retry it', async () => {
    const h = harness({
      live: true,
      postReply: async () => {
        throw new Error('notify endpoint returned HTTP 502');
      },
    });
    const result = await h.run();

    const [failure] = result.errored;
    expect(failure.message).toContain('marker');
    expect(failure.message).toContain('did NOT send');
    expect(failure.message).toContain('by hand');
    expect(failure.message).toContain('502');
    // The marker really was written; that is why the message says what it says.
    expect(h.writes.map((w) => w.kind)).toEqual(['mark']);
  });
});

describe('telling a failure that waits from a failure that needs a person', () => {
  test('a failure before the marker is filed as one the next run picks up', async () => {
    const h = harness({
      live: true,
      versionFor: async () => {
        throw new Error('Linear GraphQL returned HTTP 503');
      },
    });
    const result = await h.run();

    // No marker was written, so the ticket is enumerated again next release and
    // tried again by itself. Nobody has to do anything.
    expect(h.writes).toEqual([]);
    expect(result.errored[0].disposition).toBe('retried-next-run');
  });

  test('a reply lost after its marker was written is filed as one that needs a person', async () => {
    const h = harness({
      live: true,
      postReply: async () => {
        throw new Error('notify endpoint returned HTTP 502');
      },
    });
    const result = await h.run();

    expect(result.errored[0].disposition).toBe('needs-human');
    expect(h.logs.some((m) => m.includes('needs-human'))).toBe(true);
  });

  test('the run verdict names the tickets a person has to pick up, and stays quiet when none do', () => {
    const transient = runFailureMessage({
      errored: [{ identifier: 'PRD-0001', message: 'HTTP 503', disposition: 'retried-next-run' }],
    });
    expect(transient).toContain('next release run picks them up');
    expect(transient).not.toContain('ACTION REQUIRED');

    const needsHuman = runFailureMessage({
      errored: [
        { identifier: 'PRD-0001', message: 'HTTP 503', disposition: 'retried-next-run' },
        { identifier: 'PRD-0002', message: 'marker written, reply did NOT send', disposition: 'needs-human' },
      ],
    });
    // Both are red. Only one of them is a job for a person, and a verdict that
    // did not say which would read as one more flake.
    expect(needsHuman).toContain('ACTION REQUIRED');
    expect(needsHuman).toContain('PRD-0002');
    expect(needsHuman).not.toMatch(/ACTION REQUIRED[^.]*PRD-0001/);
  });
});

describe('a Linear call that failed for reasons unrelated to the request', () => {
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { get: () => null } });
  const fail = (status, body = 'upstream connect error', headers = {}) => ({
    ok: false,
    status,
    text: async () => body,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
  });

  // Every attempt is recorded and no wall-clock time passes: `sleep` only notes
  // what it was asked to wait, and `random` is fixed so the delay is exact.
  function callLinear(replies, overrides = {}) {
    const slept = [];
    const logs = [];
    let attempts = 0;
    const call = linearGraphql({
      apiKey: 'k',
      query: 'query {}',
      variables: {},
      fetchImpl: async (_url, init) => {
        const reply = replies[attempts];
        attempts += 1;
        if (typeof reply === 'function') return reply(init);
        return reply;
      },
      sleep: async (ms) => slept.push(ms),
      random: () => 0.5,
      log: (m) => logs.push(m),
      ...overrides,
    });
    return { call, slept, logs, attemptCount: () => attempts };
  }

  test('a 503 is asked again rather than failing the whole job', async () => {
    // The exact shape of the failure that broke the v0.45.0 run: an Envoy reply
    // raised before authentication, among hundreds of requests that worked.
    const h = callLinear([
      fail(503, 'upstream connect error or disconnect/reset before headers'),
      ok({ issues: { nodes: [] } }),
    ]);
    await expect(h.call).resolves.toEqual({ issues: { nodes: [] } });
    expect(h.attemptCount()).toBe(2);
    expect(h.slept).toHaveLength(1);
    expect(h.logs.join(' ')).toContain('retrying in');
  });

  test('a 401 is not asked again, because the answer would be the same', async () => {
    // Retrying a genuine credential failure only delays a correct verdict and
    // buries its message under attempts. The distinguishing detail must survive.
    const h = callLinear([fail(401, '{"errors":[{"type":"AUTHENTICATION_ERROR"}]}')]);
    await expect(h.call).rejects.toThrow(/HTTP 401/);
    await expect(h.call).rejects.toThrow(/AUTHENTICATION_ERROR/);
    expect(h.attemptCount()).toBe(1);
    expect(h.slept).toEqual([]);
  });

  test('every 4xx that is not 429 fails fast, and every 5xx is retried', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) expect(isRetryableStatus(status)).toBe(false);
    for (const status of [429, 500, 502, 503, 504]) expect(isRetryableStatus(status)).toBe(true);
    expect(isRetryableStatus(200)).toBe(false);
  });

  test('a 429 waits as long as Linear asked rather than as long as the backoff computed', async () => {
    const h = callLinear([fail(429, 'slow down', { 'retry-after': '2' }), ok({ issues: {} })]);
    await h.call;
    expect(h.slept).toEqual([2000]);
  });

  test('an outsized Retry-After is capped, so one reply cannot park the job', () => {
    expect(retryDelayMs({ attempt: 1, retryAfterSeconds: 3600 })).toBe(LINEAR_RETRY_CAP_MS);
    expect(parseRetryAfterSeconds('2')).toBe(2);
    // The HTTP-date form is not delta-seconds; it falls through to backoff.
    expect(parseRetryAfterSeconds('Wed, 30 Jul 2026 19:11:09 GMT')).toBeNull();
    expect(parseRetryAfterSeconds(null)).toBeNull();
    expect(parseRetryAfterSeconds('0')).toBeNull();
  });

  test('the wait grows between attempts and is never long enough to be unbounded', () => {
    const first = retryDelayMs({ attempt: 1, random: () => 0.5 });
    const second = retryDelayMs({ attempt: 2, random: () => 0.5 });
    expect(second).toBeGreaterThan(first);
    expect(retryDelayMs({ attempt: 20, random: () => 1 })).toBeLessThanOrEqual(LINEAR_RETRY_CAP_MS);
    // Half the window is fixed, so a retry is never a second helping of the
    // same hammering; the other half is where the jitter lives.
    expect(retryDelayMs({ attempt: 1, random: () => 0 })).toBeLessThan(retryDelayMs({ attempt: 1, random: () => 1 }));
    expect(retryDelayMs({ attempt: 1, random: () => 0 })).toBeGreaterThan(0);
  });

  test('a connection that never produced a reply is retried like a 5xx', async () => {
    // undici reports a reset as a bare `fetch failed` and hangs the reason off
    // `cause`, so the chain has to be walked rather than the message read.
    const reset = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });
    const h = callLinear([
      () => {
        throw reset;
      },
      ok({ issues: {} }),
    ]);
    await expect(h.call).resolves.toEqual({ issues: {} });
    expect(h.attemptCount()).toBe(2);
  });

  test('a throw with no sign the connection was at fault is not retried on a guess', async () => {
    const h = callLinear([
      () => {
        throw new TypeError('Invalid header value');
      },
    ]);
    await expect(h.call).rejects.toThrow(/before any reply/);
    expect(h.attemptCount()).toBe(1);
  });

  test('a reply that never arrives is given up on rather than allowed to eat the job', async () => {
    // The case the retry is otherwise blind to. undici leaves a connection that
    // was accepted and then went silent running for five minutes by default, so
    // two of them exceed the job's own budget: without a deadline on the request
    // the attempt below is never reached, and the run dies as an Actions timeout
    // carrying none of the disposition it would otherwise have reported.
    const h = callLinear(
      [
        (init) => {
          if (!init?.signal) throw new Error('the request carried no deadline');
          // What undici does when the signal fires: reject with its reason.
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          });
        },
        ok({ issues: {} }),
      ],
      { timeoutMs: 20 },
    );
    await expect(h.call).resolves.toEqual({ issues: {} });
    expect(h.attemptCount()).toBe(2);
  });

  test('a request given up on at its deadline is retried, but a deliberate cancellation is not', async () => {
    // Taken from the runtime rather than hand-rolled, because the shape is the
    // whole point: `AbortSignal.timeout` rejects with a DOMException whose
    // `code` is the numeric legacy 23 and not a string, so the code table cannot
    // recognise it and its name is the only thing that can.
    const signal = AbortSignal.timeout(1);
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    expect(signal.reason.name).toBe('TimeoutError');
    expect(isRetryableNetworkError(signal.reason)).toBe(true);
    // An abort nobody asked a clock for was somebody's decision, and repeating
    // the request would be overriding it.
    expect(isRetryableNetworkError(new DOMException('cancelled', 'AbortError'))).toBe(false);
  });

  test('the network classifier reads codes anywhere in the cause chain, and refuses the rest', () => {
    expect(isRetryableNetworkError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryableNetworkError(Object.assign(new Error('x'), { code: 'UND_ERR_SOCKET' }))).toBe(true);
    expect(isRetryableNetworkError(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryableNetworkError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableNetworkError(new Error('Unexpected token < in JSON'))).toBe(false);
    expect(isRetryableNetworkError(null)).toBe(false);
  });

  test('a 200 carrying GraphQL errors is a refusal, not a wobble, so it is not retried', async () => {
    const h = callLinear([
      {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ errors: [{ message: 'Unknown field: notified' }] }),
      },
    ]);
    await expect(h.call).rejects.toThrow(/Unknown field/);
    expect(h.attemptCount()).toBe(1);
  });

  test('a service that stays down surfaces its own failure rather than a retry-shaped one', async () => {
    const h = callLinear([fail(503), fail(503), fail(503), ok({ issues: {} })]);
    await expect(h.call).rejects.toThrow(/HTTP 503/);
    expect(h.attemptCount()).toBe(LINEAR_RETRY_ATTEMPTS);
  });

  test('a reply body that dies in transit is retried, since that is the connection failing a beat later', async () => {
    const truncated = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw Object.assign(new TypeError('terminated'), {
          cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
        });
      },
    };
    const h = callLinear([truncated, ok({ issues: {} })]);
    await expect(h.call).resolves.toEqual({ issues: {} });
    expect(h.attemptCount()).toBe(2);
  });

  test('a reply that arrived whole and simply is not JSON is not retried', async () => {
    const h = callLinear([
      {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      },
    ]);
    await expect(h.call).rejects.toThrow(/could not be read/);
    expect(h.attemptCount()).toBe(1);
  });

  test('an unreadable error body cannot cost the status that decides retryability', async () => {
    // The same dropped connection that produced the 5xx can drop again while
    // its body is being read. Losing the status there would turn a retryable
    // failure into an unclassifiable one.
    const h = callLinear([
      {
        ok: false,
        status: 503,
        headers: { get: () => null },
        text: async () => {
          throw new Error('aborted');
        },
      },
      ok({ issues: {} }),
    ]);
    await expect(h.call).resolves.toEqual({ issues: {} });
    expect(h.attemptCount()).toBe(2);
  });

  test('the marker mutation is retried too, since its url is what makes it idempotent', async () => {
    // The deterministic (origin, version) url is already what stops a SECOND
    // RUN re-replying, which is a stronger claim than repeating one call. Not
    // retrying it leaves the worse hole open: a marker that landed while its
    // reply was lost reads to the next run as already-notified.
    const h = callLinear([fail(503), ok({ attachmentCreate: { success: true } })]);
    await expect(h.call).resolves.toEqual({ attachmentCreate: { success: true } });
    expect(h.attemptCount()).toBe(2);
  });
});

describe('workflow shape', () => {
  const read = (name) => readFileSync(new URL(`../workflows/${name}`, import.meta.url), 'utf8');
  const workflow = read('write-back.yml');

  test('it triggers on the existing release dispatch rather than on release published', () => {
    expect(workflow).toMatch(/repository_dispatch:\s*\n\s*types:\s*\[desktop-release\]/);
    expect(workflow).not.toMatch(/^\s{2}release:/m);
    expect(workflow).not.toContain('types: [published]');
  });

  test('both release channels run, and a tag of neither shape runs nothing', () => {
    expect(workflow).toContain('^v[0-9]+\\.[0-9]+\\.[0-9]+$');
    expect(workflow).toContain('^v[0-9]+\\.[0-9]+\\.[0-9]+-beta\\.[0-9]+$');
    expect(workflow).toContain("echo \"channel=stable\"");
    expect(workflow).toContain("echo \"channel=beta\"");
    expect(workflow).toContain("echo \"channel=none\"");
    // Every step that does real work stays behind the gate, so a tag of neither
    // shape reaches nothing: no checkout, no token mint, no reply.
    expect(workflow).toMatch(/if:\s*steps\.tag\.outputs\.channel != 'none'/);
    expect(workflow).not.toMatch(/steps\.tag\.outputs\.stable/);
  });

  test('no working step is left outside the channel gate', () => {
    // A step that forgot the gate would run on a tag the script then refuses,
    // which reads as a red write-back on an ordinary release.
    const stepNames = [...workflow.matchAll(/^ {6}- (?:name:.*|uses:.*)$/gm)].length;
    const gated = [...workflow.matchAll(/if: steps\.tag\.outputs\.channel != 'none'/g)].length;
    // Every step but the channel decision itself is gated.
    expect(gated).toBe(stepNames - 1);
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

  test('the private monorepo is read with a bridge App token, not with this repo own token', () => {
    // The default token cannot see agents-private at all, so a run wired with
    // only `GH_TOKEN` 404s on every fix reference.
    expect(workflow).toContain('CROSS_REPO_TOKEN: ${{ steps.bridge-token.outputs.token }}');
    expect(workflow).toMatch(/uses: actions\/create-github-app-token@[0-9a-f]{40}/);
    expect(workflow).toContain('repositories: agents-private');
  });

  test('the bridge token is minted read-only, and for both scopes the reads need', () => {
    // Contents alone finds no changeset (the path comes from the PR file list);
    // pull-requests alone yields a version with nothing to quote.
    expect(workflow).toContain('permission-contents: read');
    expect(workflow).toContain('permission-pull-requests: read');
    expect(workflow).not.toMatch(/permission-\w+(-\w+)*: write/);
  });

  test('posting still uses this repo own token, which the scoped bridge token could not do', () => {
    expect(workflow).toContain('GH_TOKEN: ${{ github.token }}');
    expect(workflow).toContain('issues: write');
  });

  test('a missing bridge App degrades to a warning rather than failing the mint', () => {
    // Secrets are unreadable in `if:`, so the gate is an output from a step.
    expect(workflow).toMatch(/id: bridge-check/);
    expect(workflow).toMatch(/if:.*steps\.bridge-check\.outputs\.configured == 'true'/);
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
    for (const bad of [undefined, '', '   ', 'latest', 'v0.36.0-rc.1', 'v0.36']) {
      expect(() => makeReleaseWindow({ releaseTag: bad, stableTags: TAGS })).toThrow(/RELEASE_TAG/);
    }
  });

  test('a beta tag is a release this runs for, not a malformed one', () => {
    const window = makeReleaseWindow({
      releaseTag: 'v0.36.0-beta.1',
      stableTags: [...TAGS, 'v0.36.0-beta.0', 'v0.36.0-beta.1'],
    });
    expect(window('0.36.0-beta.0')).toBe('in-window');
    expect(window('0.36.0-beta.1')).toBe('in-window');
    // The stable of the same cycle supersedes the beta, so it has not shipped
    // yet from the beta run's point of view.
    expect(window('0.36.0')).toBe('not-yet-shipped');
  });

  test('a stable run counts stables, so the betas between them cannot eat the lookback', () => {
    // `git tag --list v*` hands over the betas too. If the stable window counted
    // them, three releases back would reach hours rather than weeks and the
    // catch-up the lookback exists for would stop happening.
    const dense = ['v0.33.0', 'v0.34.0', 'v0.35.0', 'v0.36.0'].flatMap((tag) => [
      `${tag}-beta.0`,
      `${tag}-beta.1`,
      tag,
    ]);
    const window = makeReleaseWindow({ releaseTag: 'v0.36.0', stableTags: dense });
    expect(window('0.33.0')).toBe('in-window');
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

describe('release channels', () => {
  test('the two tag shapes this repo cuts are the two channels, and nothing else is a release', () => {
    expect(deriveChannel('v0.36.0')).toBe('stable');
    expect(deriveChannel('v0.36.0-beta.3')).toBe('beta');
    for (const bad of [
      undefined,
      '',
      'v0.36.0-rc.1',
      '0.36.0',
      'v0.36',
      'latest',
      'v0.36.0-beta',
    ]) {
      expect(deriveChannel(bad)).toBeNull();
    }
  });

  test('a beta version is not a stable one, which is what keeps the two replies apart', () => {
    expect(isStableVersion('0.36.0')).toBe(true);
    expect(isStableVersion('v0.36.0')).toBe(true);
    expect(isStableVersion('0.36.0-beta.0')).toBe(false);
  });

  test('the beta lookback is wider than the stable one, because betas cut far more often', () => {
    // Three betas can span less than a day, so reusing the stable number would
    // age a reporter out of the window over a quiet weekend.
    expect(DEFAULT_BETA_LOOKBACK).toBeGreaterThan(DEFAULT_RELEASE_LOOKBACK);
  });
});

describe('origin remit', () => {
  const foreignIssue = 'https://github.com/inkeep/agents/issues/412';

  test('a report from another repo is passed over instead of attempted', async () => {
    // The reply is posted with this job's own token, which has no standing in
    // any other repository. Attempting it would 403 and turn a run that behaved
    // correctly red, on a ticket it was never meant to speak about.
    const h = harness({
      live: true,
      listCandidates: async () => [candidate({ attachmentUrls: [GH_PULL, foreignIssue] })],
    });
    const result = await h.run();
    expect(h.writes).toEqual([]);
    expect(result.skipped).toEqual([{ identifier: 'PRD-7539', reason: 'origin-elsewhere' }]);
    expect(result.errored).toEqual([]);
    expect(h.logs.some((m) => m.startsWith('::warning::'))).toBe(false);
  });

  test('a foreign origin costs no round trip, which is what makes the wider candidate list affordable', async () => {
    // The gate has to sit in front of the children query, not behind it. With
    // no label narrowing the enumeration, every completed ticket in the
    // workspace arrives here; one GraphQL call each would exhaust the API
    // budget long before the run finished.
    let childrenCalls = 0;
    const h = harness({
      live: true,
      listCandidates: async () => [candidate({ attachmentUrls: [GH_PULL, foreignIssue] })],
      listChildren: async () => {
        childrenCalls += 1;
        return [];
      },
      versionFor: async () => {
        throw new Error('a foreign-origin candidate must never reach version resolution');
      },
    });
    await h.run();
    expect(childrenCalls).toBe(0);
  });

  test('a ticket whose only extra attachment is an upload is passed over as having no origin', async () => {
    // `uploads.linear.app` is a screenshot or a diagnostic zip, which is most of
    // the workspace once no label narrows the enumeration. Reading it as an
    // origin both kept those tickets on the expensive path and warned that their
    // "only origin" had nowhere to post a reply, which was never true.
    let childrenCalls = 0;
    const h = harness({
      live: true,
      listCandidates: async () => [candidate({ attachmentUrls: [GH_PULL, LINEAR_UPLOAD] })],
      listChildren: async () => {
        childrenCalls += 1;
        return [];
      },
    });
    const result = await h.run();
    expect(h.writes).toEqual([]);
    expect(result.skipped).toEqual([{ identifier: 'PRD-7539', reason: 'no-origin' }]);
    expect(h.logs.some((m) => m.startsWith('::warning::'))).toBe(false);
    expect(childrenCalls).toBe(0);
  });

  test('the reachability warning names every origin that cannot be answered, not just one', async () => {
    // A ticket can carry both a foreign-repo issue and a Slack link. Calling the
    // Slack link its "only" origin would hide the other one from an operator.
    const h = harness({
      live: true,
      listCandidates: async () => [
        candidate({ attachmentUrls: [GH_PULL, 'https://github.com/inkeep/agents/issues/412', SLACK_ARCHIVE] }),
      ],
    });
    const result = await h.run();
    expect(result.skipped).toEqual([{ identifier: 'PRD-7539', reason: 'origin-unrepliable' }]);
    const warning = h.logs.find((m) => m.startsWith('::warning::'));
    expect(warning).toContain('inkeep/agents');
    expect(warning).toContain('slack-archive');
    expect(warning).not.toContain('only origin');
  });

  test('a Slack archive is still a real origin, so it still reports a reachability gap', async () => {
    // Someone IS waiting in that thread; this workflow simply cannot post there.
    // That distinction is the whole reason `unrepliable` stays on the full path.
    const h = harness({
      live: true,
      listCandidates: async () => [candidate({ attachmentUrls: [GH_PULL, SLACK_ARCHIVE] })],
    });
    const result = await h.run();
    expect(result.skipped).toEqual([{ identifier: 'PRD-7539', reason: 'origin-unrepliable' }]);
    expect(h.logs.some((m) => m.startsWith('::warning::') && m.includes('no origin on it can be replied to'))).toBe(true);
  });

  test('a Discord thread is repliable wherever it lives, because the bot is not repo-scoped', async () => {
    const h = harness({
      live: true,
      listCandidates: async () => [candidate({ attachmentUrls: [GH_PULL, DISCORD_THREAD] })],
    });
    await h.run();
    expect(h.writes.filter((w) => w.kind === 'post')).toHaveLength(1);
  });

  test('an unknown self repo refuses the run rather than skipping every candidate as foreign', async () => {
    // The dangerous reading of a missing GITHUB_REPOSITORY is the quiet one: no
    // origin matches, every candidate is skipped, and the run exits 0 looking
    // like a healthy release in which nobody happened to need telling.
    //
    // The env var is stubbed rather than left alone: `selfRepo: undefined` falls
    // through to the destructuring default, so under Actions the runner's own
    // GITHUB_REPOSITORY would satisfy a check this test exists to see fail.
    const previous = process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY;
    try {
      for (const missing of [undefined, '', '   ']) {
        const h = harness({ live: true, selfRepo: missing });
        await expect(h.run()).rejects.toThrow(/selfRepo|GITHUB_REPOSITORY/);
      }
    } finally {
      if (previous === undefined) delete process.env.GITHUB_REPOSITORY;
      else process.env.GITHUB_REPOSITORY = previous;
    }
  });

  test('a channel that is neither is refused at the entry point, before any round trip', async () => {
    // Every downstream decision is a `channel === 'beta'` ternary, so an
    // unexpected value would quietly behave as stable all the way to the reply.
    const h = harness({
      live: true,
      channel: 'nightly',
      listChildren: async () => {
        throw new Error('an invalid channel must be refused before the children query');
      },
    });
    await expect(h.run()).rejects.toThrow(/channel/);
  });
});

describe('a linked pull request, not a label, is what a reply depends on', () => {
  test('a ticket nobody linked a fix to is passed over quietly, not warned about', async () => {
    // This is the ordinary state of a completed ticket that carried no code
    // change, and with the label filter gone it is much the commonest outcome of
    // a run. Warning on it would bury the genuine broken-chain warning under it.
    const h = harness({
      live: true,
      listCandidates: async () => [candidate({ attachmentUrls: [GH_ISSUE] })],
      versionFor: async () => null,
    });
    const result = await h.run();
    expect(h.writes).toEqual([]);
    expect(result.skipped).toEqual([{ identifier: 'PRD-7539', reason: 'no-fix-reference' }]);
    expect(h.logs.some((m) => m.startsWith('::warning::'))).toBe(false);
  });

  test('a fix reference that exists and does not resolve still warns, because that is a broken chain', async () => {
    const h = harness({ live: true, versionFor: async () => null });
    const result = await h.run();
    expect(result.skipped).toEqual([{ identifier: 'PRD-7539', reason: 'version-underivable' }]);
    expect(h.logs.some((m) => m.startsWith('::warning::') && m.includes('could be derived'))).toBe(
      true,
    );
  });

  test('a sibling that resolved does not make an unlinked sibling look like a broken chain', async () => {
    // One child shipped, the other was closed with no pull request at all. The
    // warning must not name the child that is fine, and must not send an
    // operator looking for attachments the other one never had.
    const h = harness({
      live: true,
      listCandidates: async () => [candidate({ attachmentUrls: [GH_ISSUE] })],
      listChildren: async () => [
        { id: 'a', identifier: 'PRD-7398', stateType: 'completed', labels: [], attachmentUrls: [GH_PULL] },
        { id: 'b', identifier: 'PRD-7401', stateType: 'completed', labels: [], attachmentUrls: [] },
      ],
      versionFor: async (node) => (node.identifier === 'PRD-7398' ? '0.36.0' : null),
    });
    const result = await h.run();
    expect(h.writes).toEqual([]);
    expect(result.skipped).toEqual([{ identifier: 'PRD-7539', reason: 'no-fix-reference' }]);
    expect(h.logs.some((m) => m.startsWith('::warning::'))).toBe(false);
  });

  test('the broken-chain warning names only the tickets that actually carry a link', async () => {
    const h = harness({
      live: true,
      listCandidates: async () => [candidate({ attachmentUrls: [GH_ISSUE] })],
      listChildren: async () => [
        { id: 'a', identifier: 'PRD-7398', stateType: 'completed', labels: [], attachmentUrls: [GH_PULL] },
        { id: 'b', identifier: 'PRD-7401', stateType: 'completed', labels: [], attachmentUrls: [] },
      ],
      versionFor: async () => null,
    });
    const result = await h.run();
    expect(result.skipped).toEqual([{ identifier: 'PRD-7539', reason: 'version-underivable' }]);
    const warning = h.logs.find((m) => m.startsWith('::warning::') && m.includes('could be derived'));
    expect(warning).toContain('PRD-7398');
    expect(warning).not.toContain('PRD-7401');
  });

  test('a fix reference on a child counts for the parent that has none of its own', async () => {
    // A report that fanned out carries its links on the children. Looking only
    // at the parent would file every fanned-in report as unlinked.
    const h = harness({
      live: true,
      listCandidates: async () => [candidate({ attachmentUrls: [GH_ISSUE] })],
      listChildren: async () => [
        {
          id: 'a',
          identifier: 'PRD-7398',
          stateType: 'completed',
          labels: [],
          attachmentUrls: [GH_PULL],
        },
      ],
      versionFor: async () => null,
    });
    const result = await h.run();
    expect(result.skipped).toEqual([{ identifier: 'PRD-7539', reason: 'version-underivable' }]);
  });
});

describe('the beta leg', () => {
  const BETA_TAGS = [...STABLE_TAGS, 'v0.37.0-beta.0', 'v0.37.0-beta.1'];
  const betaHarness = (overrides = {}) =>
    harness({
      live: true,
      channel: 'beta',
      versionFor: async () => '0.37.0-beta.0',
      classifyRelease: makeReleaseWindow({ releaseTag: 'v0.37.0-beta.1', stableTags: BETA_TAGS }),
      ...overrides,
    });

  test('a fix whose earliest build is a beta is announced as a beta, with the stable promised', async () => {
    const h = betaHarness();
    await h.run();
    const post = h.writes.find((w) => w.kind === 'post');
    expect(post.text).toContain('v0.37.0-beta.0');
    expect(post.text).toContain('going out now on the Open Knowledge beta channel');
    expect(post.text).toContain('follow up here');
    expect(post.text).not.toContain('This shipped in');
    // The beta leg is first contact for most reporters, so it is the leg that
    // must always carry the changeset — a regression here would strip the
    // note from every reply, beta and stable, from then on.
    expect(post.text).toContain(CHANGESET.body);
  });

  test('the beta marker is not the stable one, so each channel is told at most once', async () => {
    const beta = betaHarness();
    await beta.run();
    const stable = harness({ live: true });
    await stable.run();
    const betaMark = beta.writes.find((w) => w.kind === 'mark').url;
    const stableMark = stable.writes.find((w) => w.kind === 'mark').url;
    expect(betaMark).not.toBe(stableMark);
    expect(betaMark).toContain('v0.37.0-beta.0');
  });

  test('a later beta of the same cycle re-reads the same marker and says nothing more', async () => {
    // The beta version is the FIRST tag containing the fix, so it does not move
    // as the cycle cuts beta.1, beta.2 and so on. That is what stops a reporter
    // being pinged once per beta.
    const marked = notificationMarkerUrl({ version: '0.37.0-beta.0', originUrl: GH_ISSUE });
    const h = betaHarness({
      listCandidates: async () => [candidate({ attachmentUrls: [GH_PULL, GH_ISSUE, marked] })],
      classifyRelease: makeReleaseWindow({
        releaseTag: 'v0.37.0-beta.5',
        stableTags: [...BETA_TAGS, 'v0.37.0-beta.5'],
      }),
    });
    const result = await h.run();
    expect(h.writes).toEqual([]);
    expect(result.skipped).toEqual([{ identifier: 'PRD-7539', reason: 'already-notified' }]);
  });

  test('a fix that only ever appeared in a stable is left to the stable leg', async () => {
    // A point release cherry-picks a fix straight onto the stable line, so its
    // earliest containing tag is a stable and there is no beta to point anyone
    // at. Announcing it here would name a stable version as a beta and promise a
    // follow-up that the stable leg has already made.
    const h = betaHarness({ versionFor: async () => '0.35.6' });
    const result = await h.run();
    expect(h.writes).toEqual([]);
    expect(result.skipped).toEqual([{ identifier: 'PRD-7539', reason: 'stable-covers-it' }]);
  });

  test('the stable leg still speaks in stable terms once the promotion happens', async () => {
    const h = harness({ live: true });
    await h.run();
    const post = h.writes.find((w) => w.kind === 'post');
    expect(post.text).toContain('This shipped in Open Knowledge v0.36.0');
    expect(post.text).not.toContain('beta');
  });

  test('the stable leg omits the changeset prose when a beta reply already quoted it on this origin', async () => {
    // The beta marker names v0.37.0-beta.0, a version the stable run is not
    // about to post about, so the exact-marker check does not fire — but the
    // presence of ANY marker for this origin means a beta reply ordinarily
    // already said everything the prose would say a second time.
    const betaMarker = notificationMarkerUrl({ version: '0.37.0-beta.0', originUrl: GH_ISSUE });
    const h = harness({
      live: true,
      listCandidates: async () => [candidate({ attachmentUrls: [GH_PULL, GH_ISSUE, betaMarker] })],
    });
    const result = await h.run();
    const post = h.writes.find((w) => w.kind === 'post');
    expect(post.text).toContain('This shipped in Open Knowledge v0.36.0');
    expect(post.text).not.toContain(CHANGESET.body);
    expect(result.posted.map((p) => p.identifier)).toEqual(['PRD-7539']);
    // Pins the live push site's `quoted` flag to what the reply actually did.
    // The dry-run push site and notice line get their own coverage below.
    expect(result.posted[0].quoted).toBe(false);
  });

  test('a dry run reports the same quote decision the live run would make', async () => {
    const betaMarker = notificationMarkerUrl({ version: '0.37.0-beta.0', originUrl: GH_ISSUE });
    const h = harness({
      listCandidates: async () => [candidate({ attachmentUrls: [GH_PULL, GH_ISSUE, betaMarker] })],
    });
    const result = await h.run();
    expect(result.posted[0].quoted).toBe(false);
    expect(h.logs.some((m) => m.includes('[dry run]') && m.includes('quoted=false'))).toBe(true);
  });

  test('the quote decision is made per origin, not once for the whole candidate', async () => {
    // One origin already carries a marker from an earlier version; the other
    // has never been notified. Hoisting `quotedBefore` out of the per-origin
    // loop would suppress the quote on the wrong origin without failing any
    // single-origin test.
    const betaMarker = notificationMarkerUrl({ version: '0.35.0', originUrl: GH_ISSUE });
    const h = harness({
      live: true,
      listCandidates: async () => [
        candidate({ attachmentUrls: [GH_PULL, GH_ISSUE, DISCORD_THREAD, betaMarker] }),
      ],
    });
    await h.run();
    const posts = h.writes.filter((w) => w.kind === 'post');
    const forIssue = posts.find((p) => p.origin === GH_ISSUE);
    const forDiscord = posts.find((p) => p.origin === DISCORD_THREAD);
    expect(forIssue.text).not.toContain(CHANGESET.body);
    expect(forDiscord.text).toContain(CHANGESET.body);
  });
});
