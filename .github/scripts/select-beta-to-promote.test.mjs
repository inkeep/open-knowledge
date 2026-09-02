import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { computeStablePromotion } from '../../scripts/compute-stable-version.mjs';
import { gitCleanEnv } from '../../scripts/git-clean-env.mjs';
import {
  evaluateFastTier,
  makeResolveChangesetPrUrl,
  makeResolveIssuesForUrl,
  parseBetaTags,
  resolveTier,
  selectPromotion,
} from './select-beta-to-promote.mjs';

const NOW = Date.parse('2026-07-08T20:00:00Z');
const SOAK = 86400;
const SOAKED = '2026-07-07T14:00:00Z';
const FRESH = '2026-07-08T17:00:00Z';

function meta({ isDraft = false, publishedAt = SOAKED, dmg = true, manifest = true } = {}) {
  const assets = [];
  if (dmg) assets.push({ name: 'OpenKnowledge-universal.dmg' });
  if (manifest) assets.push({ name: 'beta-mac.yml' });
  return { isDraft, publishedAt, assets };
}

function fetcher(map) {
  return (tag) => {
    if (!(tag in map)) return null;
    if (map[tag] === 'THROW') throw new Error('simulated non-404 infra error');
    return map[tag];
  };
}

const shippedNone = () => false;
const shippedIn = (...tags) => {
  const set = new Set(tags);
  return (t) => set.has(t);
};

const select = (over) =>
  selectPromotion({ isAlreadyShipped: shippedNone, soakSeconds: SOAK, nowMs: NOW, ...over });

describe('parseBetaTags', () => {
  test('filters to conforming beta tags, preserving order', () => {
    const raw = 'v0.10.0-beta.6\nv0.10.0\nrandomtag\n\nv0.10.0-beta.5\nv0.9.0-beta.12\n';
    expect(parseBetaTags(raw)).toEqual(['v0.10.0-beta.6', 'v0.10.0-beta.5', 'v0.9.0-beta.12']);
  });
  test('empty input yields no tags', () => {
    expect(parseBetaTags('')).toEqual([]);
  });
});

describe('selectPromotion', () => {
  test('reaches back to the latest soaked beta when the head is under-soaked', () => {
    const r = select({
      betaTags: ['v0.10.0-beta.6', 'v0.10.0-beta.5'],
      fetchReleaseMeta: fetcher({
        'v0.10.0-beta.6': meta({ publishedAt: FRESH }),
        'v0.10.0-beta.5': meta({ publishedAt: SOAKED }),
      }),
    });
    expect(r).toEqual({ kind: 'select', target: 'v0.10.0-beta.5', tier: 'soak' });
  });

  test('selects the head when the head itself is soaked', () => {
    const r = select({
      betaTags: ['v0.10.0-beta.6', 'v0.10.0-beta.5'],
      fetchReleaseMeta: fetcher({
        'v0.10.0-beta.6': meta({ publishedAt: SOAKED }),
        'v0.10.0-beta.5': meta({ publishedAt: SOAKED }),
      }),
    });
    expect(r).toEqual({ kind: 'select', target: 'v0.10.0-beta.6', tier: 'soak' });
  });

  test('selects the newest soaked UNSHIPPED beta, even across a version boundary', () => {
    const r = select({
      betaTags: ['v0.31.0-beta.1', 'v0.31.0-beta.0', 'v0.30.1-beta.8'],
      fetchReleaseMeta: fetcher({
        'v0.31.0-beta.1': meta({ publishedAt: FRESH }),
        'v0.31.0-beta.0': meta({ publishedAt: SOAKED }),
        'v0.30.1-beta.8': meta({ publishedAt: SOAKED }),
      }),
    });
    expect(r).toEqual({ kind: 'select', target: 'v0.31.0-beta.0', tier: 'soak' });
  });

  test('stops at the first already-shipped beta and never reaches an older cycle', () => {
    const r = select({
      betaTags: ['v0.10.0-beta.6', 'v0.9.0-beta.3'],
      isAlreadyShipped: shippedIn('v0.10.0-beta.6'),
      fetchReleaseMeta: fetcher({
        'v0.9.0-beta.3': meta({ publishedAt: SOAKED }),
      }),
    });
    expect(r).toEqual({ kind: 'none' });
  });

  test('skips a draft head and promotes the older soaked beta', () => {
    const r = select({
      betaTags: ['v0.10.0-beta.6', 'v0.10.0-beta.5'],
      fetchReleaseMeta: fetcher({
        'v0.10.0-beta.6': meta({ isDraft: true, publishedAt: SOAKED }),
        'v0.10.0-beta.5': meta({ publishedAt: SOAKED }),
      }),
    });
    expect(r).toEqual({ kind: 'select', target: 'v0.10.0-beta.5', tier: 'soak' });
  });

  test('skips a head missing the DMG asset', () => {
    const r = select({
      betaTags: ['v0.10.0-beta.6', 'v0.10.0-beta.5'],
      fetchReleaseMeta: fetcher({
        'v0.10.0-beta.6': meta({ dmg: false }),
        'v0.10.0-beta.5': meta(),
      }),
    });
    expect(r.target).toBe('v0.10.0-beta.5');
  });

  test('skips a head missing the mac.yml manifest', () => {
    const r = select({
      betaTags: ['v0.10.0-beta.6', 'v0.10.0-beta.5'],
      fetchReleaseMeta: fetcher({
        'v0.10.0-beta.6': meta({ manifest: false }),
        'v0.10.0-beta.5': meta(),
      }),
    });
    expect(r.target).toBe('v0.10.0-beta.5');
  });

  test('treats a 404 (null) as no-release-yet and considers the next-older beta', () => {
    const r = select({
      betaTags: ['v0.10.0-beta.6', 'v0.10.0-beta.5'],
      fetchReleaseMeta: fetcher({
        'v0.10.0-beta.5': meta(),
      }),
    });
    expect(r.target).toBe('v0.10.0-beta.5');
  });

  test('returns none when nothing is soaked', () => {
    const r = select({
      betaTags: ['v0.10.0-beta.2', 'v0.10.0-beta.1'],
      fetchReleaseMeta: fetcher({
        'v0.10.0-beta.2': meta({ publishedAt: FRESH }),
        'v0.10.0-beta.1': meta({ publishedAt: FRESH }),
      }),
    });
    expect(r).toEqual({ kind: 'none' });
  });

  test('propagates a non-404 infra error instead of skipping the candidate (fail loud)', () => {
    expect(() =>
      select({
        betaTags: ['v0.10.0-beta.6', 'v0.10.0-beta.5'],
        fetchReleaseMeta: fetcher({
          'v0.10.0-beta.6': 'THROW',
          'v0.10.0-beta.5': meta(),
        }),
      }),
    ).toThrow(/infra error/);
  });
});

describe('fast tier (FR5a) — DMG-smoke-gated early promotion', () => {
  const TAGS = ['v0.10.0-beta.6', 'v0.10.0-beta.5', 'v0.10.0-beta.4'];
  const metas = fetcher({
    'v0.10.0-beta.6': meta({ publishedAt: FRESH }),
    'v0.10.0-beta.5': meta({ publishedAt: FRESH }),
    'v0.10.0-beta.4': meta({ publishedAt: SOAKED }),
  });
  const fastTierOn = () => true;

  function run(over = {}) {
    const logs = [];
    const smokeCalls = [];
    const result = select({
      betaTags: TAGS,
      fetchReleaseMeta: metas,
      log: (m) => logs.push(m),
      ...over,
      smokeBeta: over.smokeBeta
        ? (tag) => {
            smokeCalls.push(tag);
            return over.smokeBeta(tag);
          }
        : undefined,
    });
    return { result, logs, smokeCalls };
  }

  test('is inert by default: same selection as today, and the smoke is never invoked', () => {
    const { result, smokeCalls } = run({ smokeBeta: () => 'pass' });
    expect(result).toEqual({ kind: 'select', target: 'v0.10.0-beta.4', tier: 'soak' });
    expect(smokeCalls).toEqual([]);
  });

  test('a passing DMG smoke promotes the under-soaked head on the fast tier', () => {
    const { result, smokeCalls } = run({
      qualifiesForFastTier: fastTierOn,
      smokeBeta: () => 'pass',
    });
    expect(result).toEqual({ kind: 'select', target: 'v0.10.0-beta.6', tier: 'fast' });
    expect(smokeCalls).toEqual(['v0.10.0-beta.6']);
  });

  test('a failing DMG smoke refuses the fast tier and leaves the 24h outcome untouched', () => {
    const { result, logs } = run({
      qualifiesForFastTier: fastTierOn,
      smokeBeta: () => 'fail',
    });
    const withoutFastTier = select({ betaTags: TAGS, fetchReleaseMeta: metas });
    expect(result).toEqual(withoutFastTier);
    expect(result).toEqual({ kind: 'select', target: 'v0.10.0-beta.4', tier: 'soak' });
    expect(logs.join('\n')).toContain('failed the smoke subset');
  });

  test('an infrastructure error refuses the fast tier and is distinguishable from a fail', () => {
    const failLogs = run({ qualifiesForFastTier: fastTierOn, smokeBeta: () => 'fail' }).logs;
    const errorLogs = run({ qualifiesForFastTier: fastTierOn, smokeBeta: () => 'error' }).logs;
    expect(errorLogs.join('\n')).toContain('infrastructure error');
    expect(errorLogs.join('\n')).not.toContain('failed the smoke subset');
    expect(failLogs.join('\n')).not.toContain('infrastructure error');
  });

  test('a thrown smoke never fails the job — it degrades to an error refusal', () => {
    const { result, logs } = run({
      qualifiesForFastTier: fastTierOn,
      smokeBeta: () => {
        throw new Error('runner exploded');
      },
    });
    expect(result).toEqual({ kind: 'select', target: 'v0.10.0-beta.4', tier: 'soak' });
    expect(logs.join('\n')).toContain('runner exploded');
  });

  test('an unrecognised verdict is treated as an error, never as a pass', () => {
    const { result } = run({ qualifiesForFastTier: fastTierOn, smokeBeta: () => 'probably fine' });
    expect(result.tier).toBe('soak');
  });

  test('the predicate can qualify one beta and not another', () => {
    const { result, smokeCalls } = run({
      qualifiesForFastTier: (tag) => tag === 'v0.10.0-beta.5',
      smokeBeta: () => 'pass',
    });
    expect(result).toEqual({ kind: 'select', target: 'v0.10.0-beta.5', tier: 'fast' });
    expect(smokeCalls).toEqual(['v0.10.0-beta.5']);
  });

  test('the fast tier never reaches back across an already-shipped boundary', () => {
    const { result, smokeCalls } = run({
      isAlreadyShipped: shippedIn('v0.10.0-beta.6'),
      qualifiesForFastTier: fastTierOn,
      smokeBeta: () => 'pass',
    });
    expect(result).toEqual({ kind: 'none' });
    expect(smokeCalls).toEqual([]);
  });
});

const FAST_CANDIDATE = 'v0.30.2-beta.3';
const STANDARD_TARGET = 'v0.30.1-beta.9';
const PR_URL = 'https://github.com/inkeep/agents-private/pull/2767';
const SHA_BETA = 'a'.repeat(40);
const SHA_STABLE = 'b'.repeat(40);

function deltaOf({ bump = 'patch', deltaIds = ['fix-a'] } = {}) {
  return {
    skip: false,
    stableVersion: '0.30.2',
    stableTag: 'v0.30.2',
    bump,
    deltaIds,
    deltaCount: deltaIds.length,
    betaSha: SHA_BETA,
    latestStableSha: SHA_STABLE,
  };
}

function prUrls(map) {
  return (id) => {
    if (map[id] === 'THROW') throw new Error('simulated git failure');
    return map[id] ?? null;
  };
}

function issueResolver(map) {
  return async (url) => {
    const entry = map[url];
    if (entry === 'THROW') {
      throw new Error('Linear GraphQL error (HTTP 400, RATELIMITED): too many requests');
    }
    if (entry === 'UNRESOLVABLE') return { unresolvable: 'no-linear-api-key' };
    return { issues: entry ?? [] };
  };
}

const BUG_ISSUE = [{ identifier: 'PRD-7490', labels: ['Bug', 'Performance'] }];

const soakTier = (over) =>
  evaluateFastTier({
    candidate: FAST_CANDIDATE,
    computeDelta: () => deltaOf(),
    resolveChangesetPrUrl: prUrls({ 'fix-a': PR_URL }),
    resolveIssuesForUrl: issueResolver({ [PR_URL]: BUG_ISSUE }),
    ...over,
  });

const armedTier = (verdict) =>
  resolveTier({ armed: true, verdict, standardTarget: STANDARD_TARGET, fastTarget: FAST_CANDIDATE })
    .tier;

describe('evaluateFastTier (soak tier)', () => {
  test('patch-only delta whose changeset resolves to a bug-labelled issue would take the fast tier', async () => {
    const r = await soakTier();
    expect(r.qualifies).toBe(true);
    expect(r.reason).toBe('patch-only-and-bug-linked');
    expect(r.bump).toBe('patch');
    expect(r.bugLinked).toBe(true);
    expect(r.linkedIssues).toEqual(['PRD-7490']);
    expect(r.warnings).toEqual([]);
    expect(armedTier(r)).toBe('fast');
  });

  test('a minor changeset in the delta stays on the standard tier even with a linked bug', async () => {
    const r = await soakTier({ computeDelta: () => deltaOf({ bump: 'minor' }) });
    expect(r.qualifies).toBe(false);
    expect(r.reason).toBe('bump-not-patch');
    expect(r.bump).toBe('minor');
    expect(armedTier(r)).toBe('standard');
  });

  test('a patch-only delta with no changeset resolving to any issue stays on the standard tier', async () => {
    const r = await soakTier({ resolveIssuesForUrl: issueResolver({}) });
    expect(r.qualifies).toBe(false);
    expect(r.reason).toBe('not-bug-linked');
    expect(r.bugLinked).toBe(false);
    expect(armedTier(r)).toBe('standard');
  });

  test('an issue without the bug label does not make the cut bug-linked', async () => {
    const r = await soakTier({
      resolveIssuesForUrl: issueResolver({
        [PR_URL]: [{ identifier: 'PRD-1', labels: ['Feature', 'Docs'] }],
      }),
    });
    expect(r.qualifies).toBe(false);
    expect(r.reason).toBe('not-bug-linked');
  });

  test('an unresolvable lookup degrades to standard with a warning naming the cause', async () => {
    const r = await soakTier({ resolveIssuesForUrl: issueResolver({ [PR_URL]: 'UNRESOLVABLE' }) });
    expect(r.qualifies).toBe(false);
    expect(r.reason).toBe('not-bug-linked');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/issues-unresolvable/);
    expect(r.warnings[0]).toMatch(/no-linear-api-key/);
  });

  test('a throwing lookup degrades to standard with a warning and lets nothing escape', async () => {
    const r = await soakTier({ resolveIssuesForUrl: issueResolver({ [PR_URL]: 'THROW' }) });
    expect(r.qualifies).toBe(false);
    expect(r.reason).toBe('not-bug-linked');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/issues-error/);
    expect(r.warnings[0]).toMatch(/RATELIMITED/);
  });

  test('a throwing changeset-to-PR resolution degrades rather than failing the tick', async () => {
    const r = await soakTier({ resolveChangesetPrUrl: prUrls({ 'fix-a': 'THROW' }) });
    expect(r.qualifies).toBe(false);
    expect(r.warnings[0]).toMatch(/changeset-pr-error fix-a/);
  });

  test('a major bump in the delta stays on the standard tier', async () => {
    const r = await soakTier({ computeDelta: () => deltaOf({ bump: 'major' }) });
    expect(r.qualifies).toBe(false);
    expect(r.reason).toBe('bump-not-patch');
    expect(armedTier(r)).toBe('standard');
  });

  test('no fast candidate at all yields a distinguishable reason', async () => {
    const r = await soakTier({ candidate: '' });
    expect(r.qualifies).toBe(false);
    expect(r.reason).toBe('no-fast-candidate');
    expect(r.candidate).toBeNull();
    expect(r.bump).toBeNull();
  });

  test('one URL resolving to several issues is bug-linked when any one carries the label', async () => {
    const r = await soakTier({
      resolveIssuesForUrl: issueResolver({
        [PR_URL]: [
          { identifier: 'PRD-1', labels: ['Feature'] },
          { identifier: 'PRD-2', labels: ['Bug'] },
          { identifier: 'PRD-3', labels: [] },
        ],
      }),
    });
    expect(r.qualifies).toBe(true);
    expect(r.linkedIssues).toEqual(['PRD-2']);
  });

  test('a changeset whose adding commit carries no PR reference contributes no link and does not throw', async () => {
    const r = await soakTier({ resolveChangesetPrUrl: prUrls({}) });
    expect(r.qualifies).toBe(false);
    expect(r.reason).toBe('not-bug-linked');
    expect(r.warnings).toEqual(['changeset-pr-unresolved fix-a']);
  });

  test('a skipped delta stays on the standard tier without crashing', async () => {
    const r = await soakTier({ computeDelta: () => ({ skip: true, reason: 'already shipped' }) });
    expect(r.qualifies).toBe(false);
    expect(r.reason).toBe('delta-skipped');
  });

  test('a bootstrap delta stays on the standard tier without crashing', async () => {
    const r = await soakTier({
      computeDelta: () => ({ skip: false, bootstrap: true, bump: null }),
    });
    expect(r.qualifies).toBe(false);
    expect(r.reason).toBe('delta-bootstrap');
  });

  test('a throwing delta computation degrades rather than failing the tick', async () => {
    const r = await soakTier({
      computeDelta: () => {
        throw new Error('git rev-parse failed');
      },
    });
    expect(r.qualifies).toBe(false);
    expect(r.reason).toBe('delta-error');
    expect(r.warnings[0]).toMatch(/delta-error/);
  });

  test('resolving several changesets collects links across all of them', async () => {
    const otherUrl = 'https://github.com/inkeep/agents-private/pull/2800';
    const r = await soakTier({
      computeDelta: () => deltaOf({ deltaIds: ['fix-a', 'fix-b'] }),
      resolveChangesetPrUrl: prUrls({ 'fix-a': PR_URL, 'fix-b': otherUrl }),
      resolveIssuesForUrl: issueResolver({
        [PR_URL]: [{ identifier: 'PRD-1', labels: ['Feature'] }],
        [otherUrl]: [{ identifier: 'PRD-2', labels: ['bug'] }],
      }),
    });
    expect(r.deltaCount).toBe(2);
    expect(r.qualifies).toBe(true);
    expect(r.linkedIssues).toEqual(['PRD-2']);
  });

  test('consumes computeStablePromotion output directly, so no second delta implementation exists', async () => {
    const fakeGit = {
      revParse: (ref) => (ref.startsWith('v0.30.2-beta') ? SHA_BETA : SHA_STABLE),
      newestStableTag: () => 'v0.30.1',
      changesetIds: (sha) =>
        sha === SHA_BETA ? ['already-shipped', 'fix-a'] : ['already-shipped'],
      isAncestor: () => false,
      bumpTypeOf: () => 'patch',
    };
    const r = await soakTier({ computeDelta: (tag) => computeStablePromotion(tag, fakeGit) });
    expect(r.bump).toBe('patch');
    expect(r.deltaCount).toBe(1);
    expect(r.qualifies).toBe(true);
    expect(armedTier(r)).toBe('fast');
  });
});

describe('resolveTier (soak tier)', () => {
  test('an unarmed workflow reports standard and the 24h target even when the predicate qualifies', async () => {
    const verdict = await soakTier();
    expect(verdict.qualifies).toBe(true);
    expect(
      resolveTier({
        armed: false,
        verdict,
        standardTarget: STANDARD_TARGET,
        fastTarget: FAST_CANDIDATE,
      }),
    ).toEqual({ tier: 'standard', target: STANDARD_TARGET, candidate: '' });
  });

  test('no verdict shape can reach the fast tier while unarmed', () => {
    const verdicts = [
      { qualifies: true },
      { qualifies: false },
      { qualifies: 'true' },
      { qualifies: 1 },
      {},
      null,
    ];
    for (const verdict of verdicts) {
      expect(
        resolveTier({
          armed: false,
          verdict,
          standardTarget: STANDARD_TARGET,
          fastTarget: FAST_CANDIDATE,
        }),
      ).toEqual({ tier: 'standard', target: STANDARD_TARGET, candidate: '' });
    }
  });

  test('an armed workflow nominates the fast candidate only on a strict qualifying verdict', () => {
    expect(
      resolveTier({
        armed: true,
        verdict: { qualifies: true },
        standardTarget: STANDARD_TARGET,
        fastTarget: FAST_CANDIDATE,
      }),
    ).toEqual({ tier: 'fast', target: STANDARD_TARGET, candidate: FAST_CANDIDATE });
    expect(
      resolveTier({
        armed: true,
        verdict: { qualifies: 'yes' },
        standardTarget: STANDARD_TARGET,
        fastTarget: FAST_CANDIDATE,
      }),
    ).toEqual({ tier: 'standard', target: STANDARD_TARGET, candidate: '' });
  });

  test('a qualifying verdict never moves the direct-dispatch target off the 24h selection', () => {
    const { target, candidate } = resolveTier({
      armed: true,
      verdict: { qualifies: true },
      standardTarget: '',
      fastTarget: FAST_CANDIDATE,
    });
    expect(target).toBe('');
    expect(candidate).toBe(FAST_CANDIDATE);
  });
});

const tempRepos = [];
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  while (tempRepos.length > 0) {
    rmSync(tempRepos.pop(), { recursive: true, force: true });
  }
});

function makeRepoWithChangesets(commits) {
  const dir = mkdtempSync(join(tmpdir(), 'ok-fast-tier-'));
  tempRepos.push(dir);
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitCleanEnv() },
    );
  git('init', '--quiet', '--initial-branch=main');
  execFileSync('mkdir', ['-p', join(dir, '.changeset')]);
  for (const { id, subject } of commits) {
    writeFileSync(
      join(dir, '.changeset', `${id}.md`),
      `---\n'@inkeep/open-knowledge': patch\n---\n\n${id}\n`,
    );
    git('add', '--all');
    git('commit', '--quiet', '-m', subject);
  }
  return dir;
}

describe('makeResolveChangesetPrUrl (real git)', () => {
  test('resolves a changeset to the pull request named by its adding commit', () => {
    const dir = makeRepoWithChangesets([
      { id: 'older-change', subject: 'feat(ok): something earlier (#1000)' },
      { id: 'fix-the-thing', subject: 'fix(ok): stop the crash (#2767)' },
    ]);
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const resolve = makeResolveChangesetPrUrl('inkeep/agents-private');
      expect(resolve('fix-the-thing')).toBe('https://github.com/inkeep/agents-private/pull/2767');
      expect(resolve('older-change')).toBe('https://github.com/inkeep/agents-private/pull/1000');
    } finally {
      process.chdir(cwd);
    }
  });

  test('returns null rather than throwing when the subject carries no PR reference', () => {
    const dir = makeRepoWithChangesets([
      { id: 'hand-authored', subject: 'chore: hand-authored commit with no pull request' },
      { id: 'mid-subject', subject: 'fix: handle (#12) in prose but land without a reference' },
    ]);
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const resolve = makeResolveChangesetPrUrl('inkeep/agents-private');
      expect(resolve('hand-authored')).toBeNull();
      expect(resolve('mid-subject')).toBeNull();
      expect(resolve('never-existed')).toBeNull();
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('makeResolveIssuesForUrl (real HTTP handling)', () => {
  const URL_UNDER_TEST = 'https://github.com/inkeep/agents-private/pull/2767';

  function stubFetch(handler) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    };
    return calls;
  }

  const jsonResponse = (status, body) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  test('reports unresolvable without touching the network when no key is configured', async () => {
    const calls = stubFetch(() => {
      throw new Error('the resolver must not make a request without a key');
    });
    await expect(makeResolveIssuesForUrl(undefined)(URL_UNDER_TEST)).resolves.toEqual({
      unresolvable: 'no-linear-api-key',
    });
    await expect(makeResolveIssuesForUrl('')(URL_UNDER_TEST)).resolves.toEqual({
      unresolvable: 'no-linear-api-key',
    });
    expect(calls).toHaveLength(0);
  });

  test('sends the raw key as Authorization, with no Bearer prefix', async () => {
    const calls = stubFetch(() =>
      jsonResponse(200, { data: { attachmentsForURL: { nodes: [] } } }),
    );
    await makeResolveIssuesForUrl('lin_api_secret')(URL_UNDER_TEST);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers.authorization).toBe('lin_api_secret');
    expect(JSON.parse(calls[0].init.body).variables).toEqual({ url: URL_UNDER_TEST });
  });

  test('parses issues and their labels out of a well-formed response', async () => {
    stubFetch(() =>
      jsonResponse(200, {
        data: {
          attachmentsForURL: {
            nodes: [
              {
                issue: {
                  identifier: 'PRD-7490',
                  labels: { nodes: [{ name: 'Bug' }, { name: 'Performance' }] },
                },
              },
              { issue: { identifier: 'PRD-7491', labels: { nodes: [] } } },
              { issue: null },
            ],
          },
        },
      }),
    );
    await expect(makeResolveIssuesForUrl('key')(URL_UNDER_TEST)).resolves.toEqual({
      issues: [
        { identifier: 'PRD-7490', labels: ['Bug', 'Performance'] },
        { identifier: 'PRD-7491', labels: [] },
      ],
    });
  });

  test('throws on a rate-limit, which arrives as HTTP 400 rather than 429', async () => {
    stubFetch(() =>
      jsonResponse(400, {
        errors: [{ message: 'rate limited', extensions: { code: 'RATELIMITED' } }],
      }),
    );
    await expect(makeResolveIssuesForUrl('key')(URL_UNDER_TEST)).rejects.toThrow(/RATELIMITED/);
  });

  test('throws on a non-JSON body', async () => {
    stubFetch(() => new Response('<html>gateway timeout</html>', { status: 504 }));
    await expect(makeResolveIssuesForUrl('key')(URL_UNDER_TEST)).rejects.toThrow(/non-JSON/);
  });

  test('throws on a plain HTTP failure that carries no GraphQL errors', async () => {
    stubFetch(() => jsonResponse(401, { data: null }));
    await expect(makeResolveIssuesForUrl('key')(URL_UNDER_TEST)).rejects.toThrow(/HTTP 401/);
  });

  test('reports unresolvable on a 200 whose shape is unrecognized', async () => {
    stubFetch(() => jsonResponse(200, { data: {} }));
    await expect(makeResolveIssuesForUrl('key')(URL_UNDER_TEST)).resolves.toEqual({
      unresolvable: 'malformed-response',
    });
  });

  test('a degrading real resolver still leaves the predicate on the standard tier', async () => {
    stubFetch(() =>
      jsonResponse(400, { errors: [{ message: 'nope', extensions: { code: 'RATELIMITED' } }] }),
    );
    const dir = makeRepoWithChangesets([{ id: 'fix-a', subject: 'fix(ok): a real fix (#2767)' }]);
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const r = await evaluateFastTier({
        candidate: FAST_CANDIDATE,
        computeDelta: () => deltaOf(),
        resolveChangesetPrUrl: makeResolveChangesetPrUrl('inkeep/agents-private'),
        resolveIssuesForUrl: makeResolveIssuesForUrl('key'),
      });
      expect(r.qualifies).toBe(false);
      expect(r.warnings[0]).toMatch(/issues-error .*RATELIMITED/);
      expect(armedTier(r)).toBe('standard');
    } finally {
      process.chdir(cwd);
    }
  });
});
