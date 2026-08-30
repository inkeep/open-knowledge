import { describe, expect, test } from 'vitest';
import {
  classifyAttachment,
  compareVersions,
  composeReply,
  evaluateFanIn,
  isOriginRepliableFrom,
  highestVersion,
  markerSuffixFor,
  originAlreadyNotified,
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

  test('a Linear upload is evidence on the ticket, not a place anyone is waiting', () => {
    // Any file dragged onto any ticket lands here: a screenshot, a log, a
    // diagnostic zip. Reading one as an origin kept every such ticket on the
    // expensive path and produced a warning about an "only origin" that could
    // not be replied to, on tickets that never had an origin.
    const c = classifyAttachment(LINEAR_UPLOAD);
    expect(c.kind).toBe('evidence');
    expect(c.channel).toBe('linear-upload');
  });

  test('evidence is neither an origin nor a fix reference when the buckets are split', () => {
    const parts = partitionAttachments([LINEAR_UPLOAD, GH_ISSUE, GH_PULL]);
    expect(parts.evidence.map((e) => e.url)).toEqual([LINEAR_UPLOAD]);
    expect(parts.origins.map((o) => o.url)).toEqual([GH_ISSUE]);
    expect(parts.unrepliable).toEqual([]);
    expect(parts.fixReferences.map((f) => f.url)).toEqual([GH_PULL]);
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

  test('a multi-paragraph changeset that fits the bound is quoted in full', () => {
    // A body that fits the bound is quoted whole, paragraph breaks included: a
    // changeset that leads with a list stem is meaningless without the list in
    // the block below it.
    const text = compose({
      changeset: {
        title: 'Message actions',
        body: 'Messages you send now carry their own actions:\n\n- Resend to a different agent.\n- Copy and edit.',
      },
    });
    expect(text).toContain('Messages you send now carry their own actions:');
    expect(text).toContain('Resend to a different agent.');
  });

  test('quote: false omits the changeset prose but keeps the rest of the reply', () => {
    // The second reply on an origin that already received one has nothing new
    // to quote: the opening line, coverage, and update instruction already
    // say everything it needs to.
    const text = compose({ quote: false });
    expect(text).not.toContain('stays literal instead of turning into a highlight');
    expect(text).toContain('v0.36.0');
    expect(text).toContain('update to the latest desktop app');
  });

  test('quote: false still refuses to compose from an empty changeset', () => {
    // A changeset that does not exist is not a fact this reply can stand on,
    // whether or not the caller intended to quote it.
    expect(compose({ quote: false, changeset: { title: '', body: '' } })).toBeNull();
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
  });

  test('the update instruction names the desktop app and nothing else', () => {
    for (const originChannel of ['github-issue', 'discord-thread']) {
      const text = compose({ originChannel });
      expect(text).toContain('update to the latest desktop app');
      // The desktop app is the promoted install path; naming the CLI here would
      // hand a reporter a second thing to weigh in a reply about one shipped fix.
      expect(text).not.toContain('npm install');
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

  // Mirrors write-back-gate.mjs's MAX_PROSE_CHARS (1200). A single-token body
  // like 'x'.repeat(5000) above can't tell `>` from `>=` at the boundary, and
  // can't tell .trimEnd() from .trimStart() (both are no-ops on all-x input) —
  // these three pin the boundary itself and a realistic multi-word cut.
  test('a body exactly at the bound is quoted whole, not truncated', () => {
    const body = 'x'.repeat(1200);
    const text = compose({ changeset: { title: 't', body }, coverage: ['PRD-1'] });
    expect(text).toContain(body);
    expect(text).not.toContain('...');
  });

  test('one character past the bound is truncated', () => {
    const body = 'x'.repeat(1201);
    const text = compose({ changeset: { title: 't', body }, coverage: ['PRD-1'] });
    expect(text).toContain(`${'x'.repeat(1200)}...`);
    expect(text).not.toContain(body);
  });

  test('a realistic multi-word body is cut mid-word with the trailing space trimmed', () => {
    const body = `${'word '.repeat(240)}tail`; // 240*5 + 4 = 1204 chars, space right at the cut
    const text = compose({ changeset: { title: 't', body }, coverage: ['PRD-1'] });
    expect(text).toContain('word...');
    expect(text).not.toContain('word ...');
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

  test('the composer redacts extraneous fields rather than trusting the caller to omit them', () => {
    // A regression pin on the redaction mechanism itself: `composeReply` reads
    // only the fields it destructures, so passing more can never leak. This
    // does not (and, being a single destructured object, structurally cannot)
    // pin which fields those are — that surface is the explicit parameter
    // list at the function's own definition.
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

describe('origin remit', () => {
  const issue = (owner, repo) => ({ channel: 'github-issue', owner, repo });

  test('an issue in this repo is repliable and one anywhere else is not', () => {
    expect(isOriginRepliableFrom(issue('inkeep', 'open-knowledge'), 'inkeep/open-knowledge')).toBe(
      true,
    );
    expect(isOriginRepliableFrom(issue('inkeep', 'agents'), 'inkeep/open-knowledge')).toBe(false);
    expect(isOriginRepliableFrom(issue('someone', 'fork'), 'inkeep/open-knowledge')).toBe(false);
  });

  test('the comparison ignores case, because GitHub slugs are not case sensitive', () => {
    expect(isOriginRepliableFrom(issue('Inkeep', 'Open-Knowledge'), 'inkeep/open-knowledge')).toBe(
      true,
    );
  });

  test('a Discord thread is repliable regardless of repo, and an unknown repo makes nothing repliable', () => {
    expect(isOriginRepliableFrom({ channel: 'discord-thread', threadId: '1' }, '')).toBe(true);
    expect(isOriginRepliableFrom(issue('inkeep', 'open-knowledge'), '')).toBe(false);
    expect(isOriginRepliableFrom(undefined, 'inkeep/open-knowledge')).toBe(false);
  });
});

describe('repeat-reply detection', () => {
  const ORIGIN = 'https://github.com/inkeep/open-knowledge/issues/1414';
  // Built from the real `markerSuffixFor`, not a hand-rolled restatement of
  // it, so this pins the shared contract rather than a second copy of it.
  const marker = (version, originUrl = ORIGIN) =>
    `https://github.com/inkeep/open-knowledge/releases/tag/v${version}${markerSuffixFor(originUrl)}`;

  test('no marker for this origin at all means no earlier reply', () => {
    expect(originAlreadyNotified([], ORIGIN)).toBe(false);
    expect(originAlreadyNotified([marker('0.59.0')], 'https://github.com/other/repo/issues/1')).toBe(
      false,
    );
  });

  test('a marker for a DIFFERENT version on this origin means an earlier reply already quoted it', () => {
    // The beta leg marks the origin with its own version; the stable run
    // reads that marker for a version that is not the one it is about to post.
    expect(originAlreadyNotified([marker('0.59.0-beta.2')], ORIGIN)).toBe(true);
  });

  test('an origin carrying its own query string still gets an unambiguous suffix', () => {
    // encodeURIComponent escapes both `?` and `&`, so a `?notified=` inside the
    // origin URL itself cannot be confused with the marker's own suffix.
    const trickyOrigin = 'https://github.com/inkeep/open-knowledge/issues/1?notified=x';
    expect(originAlreadyNotified([marker('0.59.0')], trickyOrigin)).toBe(false);
    expect(originAlreadyNotified([marker('0.59.0', trickyOrigin)], trickyOrigin)).toBe(true);
    expect(originAlreadyNotified([marker('0.59.0', trickyOrigin)], ORIGIN)).toBe(false);
  });

  test('the suffix must be at the tail, not merely present', () => {
    // Pins .endsWith over .includes: a plausible-looking simplification to
    // .includes would leave this suite green everywhere else, since every
    // other case here puts the suffix genuinely last or leaves it out
    // entirely.
    expect(originAlreadyNotified([`${marker('0.59.0')}&ref=slack`], ORIGIN)).toBe(false);
  });
});

describe('prerelease ordering', () => {
  test('a beta ranks below the stable that supersedes it', () => {
    expect(compareVersions('0.59.0-beta.9', '0.59.0')).toBeLessThan(0);
    expect(compareVersions('0.59.0', '0.59.0-beta.9')).toBeGreaterThan(0);
  });

  test('betas of one cycle order numerically, not as strings', () => {
    expect(compareVersions('0.59.0-beta.2', '0.59.0-beta.10')).toBeLessThan(0);
  });

  test('the highest across a fan-in spanning both channels is the stable', () => {
    // A three-part compare calls a beta equal to its stable, so whichever
    // arrived first would win and a reporter could be sent to a build that does
    // not carry every part of what they reported.
    expect(highestVersion(['0.59.0-beta.9', '0.59.0', '0.58.1'])).toBe('0.59.0');
  });
});

describe('the two channels say different things', () => {
  const changeset = {
    title: 'Configurable auto-sync cadence',
    body: 'Auto-sync cadence is now configurable.',
  };

  test('a stable reply claims the fix is out and points at the current app', () => {
    const text = composeReply({ changeset, version: '0.59.1', originChannel: 'github-issue' });
    expect(text).toContain('This shipped in Open Knowledge v0.59.1.');
    expect(text).toContain('update to the latest desktop app');
    expect(text).not.toMatch(/beta/i);
  });

  test('a beta reply names the beta, does not claim the default channel, and promises the follow-up', () => {
    const text = composeReply({
      changeset,
      version: '0.59.0-beta.2',
      originChannel: 'github-issue',
      channel: 'beta',
    });
    expect(text).toContain('v0.59.0-beta.2');
    expect(text).toContain('going out now on the Open Knowledge beta channel');
    expect(text).toContain('follow up here');
    // "update to the latest" would send them to a build without the fix: a beta
    // is not on the channel the desktop app follows.
    expect(text).not.toContain('update to the latest');
    expect(text).toContain('download the v0.59.0-beta.2 beta');
    // The release is still a draft when this posts, so nothing may claim the
    // build is already sitting on the releases page.
    expect(text).not.toMatch(/available now|download it now/i);
    expect(text).toContain('installers have finished uploading');
  });

  test('a Discord beta reply wraps the URL so it does not expand into an embed', () => {
    const text = composeReply({
      changeset,
      version: '0.59.0-beta.2',
      originChannel: 'discord-thread',
      channel: 'beta',
    });
    expect(text).toMatch(/<https:\/\/github\.com\/inkeep\/open-knowledge\/releases>/);
  });

  test('a channel that is neither refuses rather than composing a reply in the wrong voice', () => {
    expect(() =>
      composeReply({
        changeset,
        version: '0.59.1',
        originChannel: 'github-issue',
        channel: 'nightly',
      }),
    ).toThrow(/channel/);
  });

  test('a beta version is a version composeReply accepts', () => {
    expect(() =>
      composeReply({ changeset, version: 'nonsense', originChannel: 'github-issue' }),
    ).toThrow(/derived version/);
  });
});
