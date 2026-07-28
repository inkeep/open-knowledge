import { describe, expect, test } from 'vitest';
import {
  classifyAttachment,
  compareVersions,
  composeReply,
  evaluateFanIn,
  highestVersion,
  partitionAttachments,
} from './write-back-gate.mjs';

// Attachment shapes taken off live tickets rather than invented: PRD-7539 (a
// fix PR plus a GitHub issue origin), PRD-7394 (nothing but an uploaded
// diagnostic bundle), PRD-7399 (seven commit URLs and no PR at all), and
// PRD-7490 (a fix PR, a Discord thread, and a Slack archive link).
const GH_ISSUE = 'https://github.com/inkeep/open-knowledge/issues/769';
const GH_PULL = 'https://github.com/inkeep/agents-private/pull/2844';
const GH_COMMIT = 'https://github.com/inkeep/agents-private/commit/da71f0c698ccaac11da915169ca6c7d585d5eb97';
const DISCORD_THREAD = 'https://discord.com/channels/1234567890/9876543210/1122334455';
const SLACK_ARCHIVE = 'https://inkeep.slack.com/archives/C016VCYCL74/p1727122965001469';
const LINEAR_UPLOAD = 'https://uploads.linear.app/abc/def/diagnostics.zip';

describe('attachment classification', () => {
  test('a GitHub issue is a repliable origin', () => {
    const c = classifyAttachment(GH_ISSUE);
    expect(c.kind).toBe('repliable-origin');
    expect(c.channel).toBe('github-issue');
    expect(c).toMatchObject({ owner: 'inkeep', repo: 'open-knowledge', number: 769 });
  });

  test('a Discord thread permalink is a repliable origin carrying the thread id', () => {
    const c = classifyAttachment(DISCORD_THREAD);
    expect(c.kind).toBe('repliable-origin');
    expect(c.channel).toBe('discord-thread');
    expect(c.threadId).toBe('9876543210');
  });

  test('a Discord permalink with no message segment still yields the thread', () => {
    const c = classifyAttachment('https://discord.com/channels/1234567890/9876543210');
    expect(c.channel).toBe('discord-thread');
    expect(c.threadId).toBe('9876543210');
  });

  test('a Slack archive link is an origin with nowhere to reply, so the caller can skip and warn', () => {
    const c = classifyAttachment(SLACK_ARCHIVE);
    expect(c.kind).toBe('unrepliable-origin');
    expect(c.channel).toBe('slack-archive');
  });

  test('a Linear diagnostic bundle is an origin with nowhere to reply', () => {
    const c = classifyAttachment(LINEAR_UPLOAD);
    expect(c.kind).toBe('unrepliable-origin');
    expect(c.channel).toBe('linear-upload');
  });

  test('a GitHub pull request is a fix reference and never an origin', () => {
    const c = classifyAttachment(GH_PULL);
    expect(c.kind).toBe('fix-reference');
    expect(c.channel).toBe('pull-request');
    expect(c.number).toBe(2844);
  });

  test('a GitHub commit is a fix reference and never an origin', () => {
    const c = classifyAttachment(GH_COMMIT);
    expect(c.kind).toBe('fix-reference');
    expect(c.channel).toBe('commit');
    expect(c.sha).toBe('da71f0c698ccaac11da915169ca6c7d585d5eb97');
  });

  test('an unrecognized link is unknown rather than guessed at', () => {
    expect(classifyAttachment('https://example.com/whatever').kind).toBe('unknown');
    expect(classifyAttachment('').kind).toBe('unknown');
    expect(classifyAttachment(null).kind).toBe('unknown');
  });

  test('a ticket carrying only fix-side links produces no origin at all', () => {
    const { origins, fixReferences } = partitionAttachments([GH_PULL, GH_COMMIT]);
    expect(origins).toEqual([]);
    expect(fixReferences.map((f) => f.channel)).toEqual(['pull-request', 'commit']);
  });

  test('a ticket carrying only commit attachments still yields a usable fix reference', () => {
    const commits = Array.from(
      { length: 7 },
      (_, i) => `https://github.com/inkeep/agents-private/commit/${String(i + 1).repeat(40)}`,
    );
    const { fixReferences } = partitionAttachments(commits);
    expect(fixReferences.length).toBe(7);
    expect(fixReferences[0].channel).toBe('commit');
  });

  test('pull requests sort ahead of commits so the merge-commit hop is preferred', () => {
    const { fixReferences } = partitionAttachments([GH_COMMIT, GH_PULL]);
    expect(fixReferences.map((f) => f.channel)).toEqual(['pull-request', 'commit']);
  });

  test('a mixed ticket separates the repliable origin from the unrepliable one', () => {
    const { origins, unrepliable, fixReferences } = partitionAttachments([
      GH_PULL,
      DISCORD_THREAD,
      SLACK_ARCHIVE,
    ]);
    expect(origins.map((o) => o.channel)).toEqual(['discord-thread']);
    expect(unrepliable.map((o) => o.channel)).toEqual(['slack-archive']);
    expect(fixReferences.map((f) => f.channel)).toEqual(['pull-request']);
  });
});

describe('version ordering', () => {
  test('versions compare numerically, not as strings', () => {
    expect(compareVersions('v0.36.0', 'v0.35.2')).toBeGreaterThan(0);
    expect(compareVersions('0.9.0', '0.36.0')).toBeLessThan(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
  });

  test('the highest of a set is returned without its leading v', () => {
    expect(highestVersion(['v0.35.2', 'v0.36.0', 'v0.35.6'])).toBe('0.36.0');
  });

  test('a value that is not a version throws rather than sorting arbitrarily', () => {
    expect(() => compareVersions('latest', '1.0.0')).toThrow(/not a version/);
  });
});

describe('fan-in gate', () => {
  // A map-driven fake keyed by identifier: absent means "no version could be
  // derived", which the gate must treat as a reason to withhold.
  const versionsFrom = (map) => (node) => map[node.identifier] ?? null;
  const node = (identifier, stateType, labels = ['Bug']) => ({ identifier, stateType, labels });

  const evaluate = (overrides) => {
    const logs = [];
    const result = evaluateFanIn({ log: (m) => logs.push(m), ...overrides });
    return { ...result, logs };
  };

  test('every descendant completed and resolvable notifies with the coverage set', () => {
    const r = evaluate({
      ticket: node('PRD-7394', 'started', ['Bug', 'ok:intake']),
      descendants: [node('PRD-7398', 'completed'), node('PRD-7403', 'completed', [])],
      resolveVersion: versionsFrom({ 'PRD-7398': 'v0.35.2', 'PRD-7403': 'v0.36.0' }),
    });
    expect(r.decision).toBe('notify');
    expect(r.coverage).toEqual(['PRD-7398', 'PRD-7403']);
  });

  test('the selected version is the highest contributor by numeric semver', () => {
    const r = evaluate({
      ticket: node('PRD-7394', 'started'),
      descendants: [node('PRD-7398', 'completed'), node('PRD-7403', 'completed')],
      resolveVersion: versionsFrom({ 'PRD-7398': 'v0.36.0', 'PRD-7403': 'v0.35.2' }),
    });
    expect(r.version).toBe('0.36.0');
  });

  test('an outstanding descendant withholds and is named', () => {
    const r = evaluate({
      ticket: node('PRD-7394', 'started'),
      descendants: [node('PRD-7398', 'completed'), node('PRD-7400', 'unstarted')],
      resolveVersion: versionsFrom({ 'PRD-7398': 'v0.36.0' }),
    });
    expect(r.decision).toBe('withhold');
    expect(r.blocking).toEqual(['PRD-7400']);
    expect(r.logs.some((m) => m.includes('PRD-7400'))).toBe(true);
  });

  test('a ticket with no children is evaluated alone rather than failing', () => {
    const r = evaluate({
      ticket: node('PRD-7539', 'completed', ['Bug', 'ok:platform']),
      descendants: [],
      resolveVersion: versionsFrom({ 'PRD-7539': 'v0.36.0' }),
    });
    expect(r.decision).toBe('notify');
    expect(r.coverage).toEqual(['PRD-7539']);
    expect(r.version).toBe('0.36.0');
  });

  test('a canceled descendant neither blocks nor contributes', () => {
    const r = evaluate({
      ticket: node('PRD-7394', 'started'),
      descendants: [node('PRD-7398', 'completed'), node('PRD-7402', 'canceled')],
      resolveVersion: versionsFrom({ 'PRD-7398': 'v0.36.0' }),
    });
    expect(r.decision).toBe('notify');
    expect(r.coverage).toEqual(['PRD-7398']);
    expect(r.neutral).toEqual(['PRD-7402']);
  });

  test('an open unlabelled descendant withholds, which gating on the Bug label would have missed', () => {
    // The live PRD-7394 tree: six children, two of them carrying no labels at
    // all, and one of those two still open.
    const r = evaluate({
      ticket: node('PRD-7394', 'started', ['Bug', 'ok:intake']),
      descendants: [
        node('PRD-7398', 'completed'),
        node('PRD-7399', 'completed'),
        node('PRD-7400', 'completed'),
        node('PRD-7401', 'unstarted', []),
        node('PRD-7402', 'completed'),
        node('PRD-7403', 'completed', []),
      ],
      resolveVersion: () => 'v0.36.0',
    });
    expect(r.decision).toBe('withhold');
    expect(r.blocking).toEqual(['PRD-7401']);
  });

  test('unlabelled descendants are listed so the triage gap is observable rather than silent', () => {
    const r = evaluate({
      ticket: node('PRD-7394', 'started'),
      descendants: [node('PRD-7401', 'unstarted', []), node('PRD-7403', 'completed', [])],
      resolveVersion: () => 'v0.36.0',
    });
    expect(r.unlabelledDescendants).toEqual(['PRD-7401', 'PRD-7403']);
    expect(r.logs.some((m) => m.startsWith('::notice::') && m.includes('no labels'))).toBe(true);
  });

  test('a completed descendant whose version cannot be derived withholds rather than assuming it shipped', () => {
    const r = evaluate({
      ticket: node('PRD-7394', 'started'),
      descendants: [node('PRD-7398', 'completed'), node('PRD-7403', 'completed')],
      resolveVersion: versionsFrom({ 'PRD-7398': 'v0.36.0' }),
    });
    expect(r.decision).toBe('withhold');
    expect(r.blocking).toEqual(['PRD-7403']);
    // Distinguished from a routine "still open" so the caller can annotate a
    // broken fix-reference chain differently from ordinary in-progress work.
    expect(r.unresolved).toEqual(['PRD-7403']);
  });

  test('an open descendant is blocking but not reported as unresolvable', () => {
    const r = evaluate({
      ticket: node('PRD-7394', 'started'),
      descendants: [node('PRD-7400', 'unstarted')],
      resolveVersion: () => 'v0.36.0',
    });
    expect(r.blocking).toEqual(['PRD-7400']);
    expect(r.unresolved).toEqual([]);
  });

  test('a tree whose only descendants are canceled withholds rather than notifying about nothing', () => {
    const r = evaluate({
      ticket: node('PRD-7394', 'started'),
      descendants: [node('PRD-7402', 'canceled')],
      resolveVersion: () => 'v0.36.0',
    });
    expect(r.decision).toBe('withhold');
    expect(r.coverage).toEqual([]);
  });

  test('a missing ticket or resolver is a wiring error and throws rather than deciding', () => {
    expect(() => evaluateFanIn({ ticket: null, resolveVersion: () => null })).toThrow(/identifier/);
    expect(() => evaluateFanIn({ ticket: { identifier: 'PRD-1' } })).toThrow(/resolveVersion/);
  });
});

describe('reply composition', () => {
  const CHANGESET = {
    title: 'Honor backslash escapes in the markdown promoters',
    body: 'Typing `\\==not a highlight\\==` now stays literal instead of turning into a highlight.',
  };

  const compose = (overrides = {}) =>
    composeReply({ changeset: CHANGESET, version: 'v0.36.0', originChannel: 'github-issue', ...overrides });

  test('the reply names the version', () => {
    expect(compose()).toContain('v0.36.0');
  });

  test('the reply carries the changeset prose', () => {
    expect(compose()).toContain('stays literal instead of turning into a highlight');
  });

  test('the reply lists every contributing ticket in sorted order', () => {
    const text = compose({ coverage: ['PRD-7403', 'PRD-7398', 'PRD-7400'] });
    expect(text).toContain('Covers PRD-7398, PRD-7400, PRD-7403.');
  });

  test('a single-ticket report still gets its coverage line', () => {
    expect(compose({ coverage: ['PRD-7539'] })).toContain('Covers PRD-7539.');
  });

  test('the update instruction is channel-appropriate', () => {
    const gh = compose({ originChannel: 'github-issue' });
    const discord = compose({ originChannel: 'discord-thread' });
    expect(gh).toContain('[the releases page](https://github.com/inkeep/open-knowledge/releases)');
    // Bare on Discord it would expand into an embed card; angle brackets suppress that.
    expect(discord).toContain('<https://github.com/inkeep/open-knowledge/releases>');
    for (const text of [gh, discord]) {
      expect(text).toContain('npm install -g @inkeep/open-knowledge@0.36.0');
    }
  });

  test('an empty changeset body falls back to the changeset title', () => {
    const text = compose({ changeset: { title: 'Fix the thing', body: '   ' } });
    expect(text).toContain('Fix the thing');
  });

  test('an empty body and title refuses to compose rather than emitting a blank reply', () => {
    expect(compose({ changeset: { title: '', body: '' } })).toBeNull();
    expect(compose({ changeset: {} })).toBeNull();
  });

  test('a missing version throws rather than composing a reply that names nothing', () => {
    expect(() => compose({ version: null })).toThrow(/derived version/);
    expect(() => compose({ version: 'latest' })).toThrow(/derived version/);
  });

  test('pathological changeset prose is bounded so the reply fits a Discord message', () => {
    const text = compose({ changeset: { title: 't', body: 'x'.repeat(5000) }, coverage: ['PRD-1'] });
    expect(text.length).toBeLessThan(2000);
    expect(text).toContain('...');
  });

  test('no internal ticket detail reaches the composed reply', () => {
    // An adversarial candidate: every field a reporter must never see is
    // populated with a recognizable value. The composer's parameter list is
    // the mechanism, so the assertion is that none of it can be threaded in.
    const candidate = {
      identifier: 'PRD-7539',
      title: 'INTERNAL escalation for Contoso, blocked on unreleased auth rewrite',
      assigneeName: 'Dana Internal',
      customerName: 'Contoso Corp',
      unreleasedWorkNote: 'depends on the unshipped v0.40 auth rewrite',
      changeset: CHANGESET,
      version: 'v0.36.0',
      coverage: ['PRD-7539'],
      originChannel: 'github-issue',
    };

    const text = composeReply({
      changeset: candidate.changeset,
      version: candidate.version,
      originChannel: candidate.originChannel,
      coverage: candidate.coverage,
    });

    for (const secret of [
      candidate.title,
      candidate.assigneeName,
      candidate.customerName,
      candidate.unreleasedWorkNote,
      'INTERNAL',
      'Contoso',
      'Dana',
      'unreleased',
      'unshipped',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  test('the composer accepts nothing beyond the changeset, the version, the channel, and the coverage', () => {
    // A regression pin on the redaction mechanism itself: if a future change
    // widens the parameter object, this states the intended surface out loud.
    expect(composeReply.length).toBe(1);
    const text = composeReply({
      changeset: CHANGESET,
      version: '0.36.0',
      originChannel: 'github-issue',
      coverage: ['PRD-7539'],
      title: 'INTERNAL leak attempt',
      assigneeName: 'Dana Internal',
    });
    expect(text).not.toContain('INTERNAL');
    expect(text).not.toContain('Dana');
  });
});
