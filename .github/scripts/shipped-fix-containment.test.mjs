import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { gitCleanEnv } from '../../scripts/git-clean-env.mjs';
import {
  appliedOrigins,
  COVERAGE,
  createShippedFixCheck,
  describeVerdict,
  evaluateShippedFixContainment,
  gitRepo,
  parseArgs,
  parseReleaseListing,
  publishedRepairExemption,
  publishedStableReleases,
  REFUSED_EXIT,
  refusalHeadline,
  runMatrix,
  summaryMarkdown,
  terminalPrNumber,
} from './shipped-fix-containment.mjs';

const SCRIPT = fileURLToPath(new URL('./shipped-fix-containment.mjs', import.meta.url));
const scratch = [];

afterAll(() => {
  while (scratch.length > 0) rmSync(scratch.pop(), { recursive: true, force: true });
});

function makeRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-shipped-fix-')));
  scratch.push(dir);
  const git = (args, { env = {}, input } = {}) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Release Bot',
        '-c',
        'user.email=bot@example.com',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'tag.gpgsign=false',
        ...args,
      ],
      { cwd: dir, env: { ...gitCleanEnv(), ...env }, encoding: 'utf8', input, stdio: 'pipe' },
    ).trim();
  git(['init', '--quiet', '--initial-branch=main']);
  const commit = ({
    files = {},
    message,
    author = 'Dev <dev@example.com>',
    date = '1700000000 +0000',
  }) => {
    for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
    git(['add', '-A']);
    const [, name, email] = /^(.*) <(.*)>$/.exec(author);
    git(['commit', '--quiet', '--allow-empty', '-F', '-'], {
      input: message,
      env: {
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    });
    return git(['rev-parse', 'HEAD']);
  };
  return { dir, git, commit };
}

const AUTOSAVE = {
  message: 'fix: keep autosave working (#11)\n\nBody one.',
  author: 'Alice <alice@example.com>',
  date: '1700000100 +0000',
};
const NOTICE = {
  author: 'Bob <bob@example.com>',
  date: '1700000200 +0000',
};
const IDENTICAL = {
  message: 'fix: pick that applies byte for byte (#33)',
  author: 'Carol <carol@example.com>',
  date: '1700000300 +0000',
};

let fixture;

beforeAll(() => {
  const repo = makeRepo();
  const { commit, git } = repo;
  commit({
    files: { 'a.txt': 'a0\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n', 'd.txt': 'd0\n', 'e.txt': 'e0\n' },
    message: 'Initial import',
  });
  git(['tag', 'v1.0.0']);
  const m1 = commit({ files: { 'e.txt': 'e1\n' }, message: 'Unrelated work (#10)' });
  git(['tag', 'v1.1.0-beta.0']);
  const o1 = commit({ files: { 'a.txt': 'a1\n', 'b.txt': 'b1\n' }, ...AUTOSAVE });
  const m2 = commit({ files: { 'e.txt': 'e2\n' }, message: 'More unrelated work (#12)' });
  git(['tag', 'v1.1.0']);
  const o2 = commit({
    files: { 'c.txt': 'c1\n' },
    message: 'fix: keep the notice reachable (#22)\n\nOriginal body.',
    ...NOTICE,
  });
  const o3 = commit({ files: { 'd.txt': 'd1\n' }, ...IDENTICAL });
  const head = commit({ files: { 'e.txt': 'e3\n' }, message: 'Later work (#40)' });

  git(['checkout', '--quiet', '--detach', 'v1.0.0']);
  const x1 = commit({ files: { 'a.txt': 'a1\n' }, ...AUTOSAVE });
  const x2 = commit({
    files: { 'c.txt': 'c1-picked\n' },
    message: 'fix: keep the notice reachable (#22)\n\nReworded while picking.',
    ...NOTICE,
  });
  const x3 = commit({ files: { 'd.txt': 'd1\n' }, ...IDENTICAL });
  git(['tag', 'v1.0.1']);
  const x4 = commit({
    files: { 'f.txt': 'f\n' },
    message: `Revert "fix: something old (#5)"\n\nThis reverts commit ${'1'.repeat(40)}.`,
  });
  git(['tag', 'v1.0.2']);

  git(['checkout', '--quiet', '--detach', 'v1.0.0']);
  const sideAutosave = commit({
    files: { 'a.txt': 'a1-relanded\n' },
    message: 'fix: keep autosave working, landed again (#11)',
    author: 'Dana <dana@example.com>',
  });
  git(['checkout', '--quiet', 'main']);

  fixture = {
    ...repo,
    shas: { m1, o1, m2, o2, o3, head, x1, x2, x3, x4, sideAutosave },
  };
});

function releases({ publishRevert = false, extra = [] } = {}) {
  const { o1, o2, o3 } = fixture.shas;
  return [
    { tag_name: 'v1.0.0', draft: false, prerelease: false, body: 'First stable.' },
    { tag_name: 'v1.1.0-beta.0', draft: false, prerelease: true, body: 'A beta.' },
    {
      tag_name: 'v1.0.1',
      draft: false,
      prerelease: false,
      body: `Point release over v1.0.0: the current stable plus 3 applied commit(s).\n\nApplied: ${o1}, ${o2.slice(0, 9)} (${o2}), ${o3}\n`,
    },
    { tag_name: 'v1.1.0', draft: false, prerelease: false, body: 'Promoted from a beta.' },
    {
      tag_name: 'v1.0.2',
      draft: !publishRevert,
      prerelease: false,
      body: `Applied: ${'1'.repeat(40)}`,
    },
    ...extra,
  ];
}

const evaluate = (candidate, listing = releases()) =>
  evaluateShippedFixContainment({
    candidate,
    published: publishedStableReleases(listing),
    git: gitRepo(fixture.dir),
  });

describe('the published-stable set', () => {
  test('keeps non-draft vX.Y.Z Releases, sorted numerically, and drops betas and drafts', () => {
    const published = publishedStableReleases([
      { tag_name: 'v0.10.0', draft: false, body: 'ten' },
      { tag_name: 'v0.9.1', draft: false, body: null },
      { tag_name: 'v0.10.0-beta.3', draft: false, body: 'beta' },
      { tag_name: 'v0.11.0', draft: true, body: 'draft' },
      { tag_name: 'v0.2.0', draft: false, prerelease: true, body: 'demoted' },
    ]);
    expect(published.map((r) => r.tag)).toEqual(['v0.2.0', 'v0.9.1', 'v0.10.0']);
    expect(published[1].body).toBe('');
  });

  test('refuses a listing entry it cannot read rather than guessing that it is unpublished', () => {
    expect(() => publishedStableReleases([{ tag_name: 'v1.0.0' }])).toThrow(/draft flag/);
    expect(() => publishedStableReleases({ tag_name: 'v1.0.0' })).toThrow(/not an array/);
  });

  test('reads a JSON array, a slurped page list, and the JSON lines gh --jq prints', () => {
    const one = { tag_name: 'v1.0.0', draft: false };
    const two = { tag_name: 'v1.0.1', draft: true };
    expect(parseReleaseListing(JSON.stringify([one, two]))).toEqual([one, two]);
    expect(parseReleaseListing(JSON.stringify([[one], [two]]))).toEqual([one, two]);
    expect(parseReleaseListing(`${JSON.stringify(one)}\n${JSON.stringify(two)}\n`)).toEqual([
      one,
      two,
    ]);
    expect(parseReleaseListing('  ')).toEqual([]);
  });
});

describe('recorded provenance and PR numbers', () => {
  test('reads every full origin SHA from the Applied lines a point release writes', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    expect(
      appliedOrigins(`Point release over v1.0.0.\n\nApplied: ${a}, ${b}\n\n### Patch Changes`),
    ).toEqual([a, b]);
    expect(appliedOrigins(`Applied: 496a4be01 (${a})`)).toEqual([a]);
    expect(appliedOrigins(`Applied: ${a}\r\nlater\nApplied: ${b}, ${a}`)).toEqual([a, b]);
    expect(appliedOrigins(`Notes mention ${a} but record nothing as applied.`)).toEqual([]);
    expect(appliedOrigins(null)).toEqual([]);
  });

  test('takes only the PR number that ends the subject', () => {
    expect(
      terminalPrNumber('fix(ok): keep the update-ready notice reachable (PRD-9007) (#5610)'),
    ).toBe('5610');
    expect(terminalPrNumber('Follow up on (#12) and land it (#13)  ')).toBe('13');
    expect(terminalPrNumber('Revert "fix: tidy (#5)"')).toBeNull();
    expect(terminalPrNumber('main reset: post-stable v0.82.2')).toBeNull();
  });
});

describe('evaluating a candidate against the published stables', () => {
  test('refuses a candidate older than a published stable, naming every commit it lacks', () => {
    const { m1, x1, x2, x3, o1, m2 } = fixture.shas;
    const verdict = evaluate(m1);
    expect(verdict.ok).toBe(false);
    expect(verdict.checked).toEqual(['v1.0.1', 'v1.1.0']);
    expect(verdict.uncovered.map((c) => c.sha)).toEqual([
      ...[x1, x2, x3].sort(),
      ...[o1, m2].sort(),
    ]);
    const byPr = Object.fromEntries(verdict.uncovered.map((c) => [c.sha, [c.pr, c.stables]]));
    expect(byPr[x1]).toEqual(['11', ['v1.0.1']]);
    expect(byPr[m2]).toEqual(['12', ['v1.1.0']]);
  });

  test('refuses a beta that lacks two of a point release three fixes, naming each with its PR and stable', () => {
    const { m2, x1, x2, x3, o1 } = fixture.shas;
    const verdict = evaluate(m2);
    expect(verdict.ok).toBe(false);
    expect(verdict.checked).toEqual(['v1.0.1']);
    expect(verdict.records).toBe(3);
    expect(verdict.plusRecords).toBe(3);
    expect(verdict.uncovered.map((c) => [c.sha, c.pr])).toEqual(
      [
        [x2, '22'],
        [x3, '33'],
      ].sort(([a], [b]) => a.localeCompare(b)),
    );
    expect(verdict.commits.find((c) => c.sha === x1)).toMatchObject({
      coverage: COVERAGE.PROVENANCE,
      origin: o1,
    });
    const listed = verdict.uncovered.map((c) => `#${c.pr} (v1.0.1)`).join(', ');
    expect(refusalHeadline(verdict, 'v1.1.0')).toBe(
      `v1.1.0 lacks 2 fixes that a published stable already shipped: ${listed}.`,
    );
  });

  test('admits a candidate holding every fix by patch, by recorded origin, or by PR number', () => {
    const { head, x1, x2, o1 } = fixture.shas;
    const verdict = evaluate(head);
    expect(verdict).toMatchObject({
      ok: true,
      checked: ['v1.0.1'],
      records: 3,
      plusRecords: 2,
      plusCommits: 2,
      coveredByProvenance: 1,
      coveredByPrNumber: 1,
      uncovered: [],
    });
    expect(verdict.commits).toEqual([
      expect.objectContaining({ sha: x1, coverage: COVERAGE.PROVENANCE, origin: o1, pr: '11' }),
      expect.objectContaining({ sha: x2, coverage: COVERAGE.PR_NUMBER, origin: null, pr: '22' }),
    ]);
    expect(describeVerdict(verdict, 'v1.2.0')).toEqual([
      expect.stringContaining('contains every fix the published stables shipped'),
    ]);
    expect(summaryMarkdown(verdict, 'v1.2.0')).toContain('contains every published fix');
  });

  test('ignores a draft stable, and refuses once the same Release is published', () => {
    const { head, x4 } = fixture.shas;
    expect(evaluate(head).ok).toBe(true);
    const verdict = evaluate(head, releases({ publishRevert: true }));
    expect(verdict.ok).toBe(false);
    expect(verdict.checked).toEqual(['v1.0.1', 'v1.0.2']);
    expect(verdict.uncovered).toEqual([
      expect.objectContaining({ sha: x4, pr: null, coverage: null, stables: ['v1.0.2'] }),
    ]);
    expect(refusalHeadline(verdict, 'v1.2.0')).toBe(
      `v1.2.0 lacks 1 fix that a published stable already shipped: ${x4.slice(0, 12)} (v1.0.2).`,
    );
    expect(describeVerdict(verdict, 'v1.2.0').join('\n')).toContain(
      'no PR number; shipped in v1.0.2',
    );
    expect(summaryMarkdown(verdict, 'v1.2.0')).toContain(`| \`${x4.slice(0, 12)}\` |`);
  });

  test('credits a recorded origin only when that origin is in the candidate history', () => {
    const { sideAutosave, x1, x2, x3 } = fixture.shas;
    const verdict = evaluate(sideAutosave);
    expect(verdict.ok).toBe(false);
    expect(verdict.commits.find((c) => c.sha === x1)).toMatchObject({
      coverage: COVERAGE.PR_NUMBER,
      origin: null,
    });
    expect(verdict.uncovered.map((c) => c.sha)).toEqual(expect.arrayContaining([x2, x3]));
    expect(verdict.uncovered.map((c) => c.sha)).not.toContain(x1);
  });

  test('credits a recorded origin only when the pick carries its author, date and message', () => {
    const { head, x2, o2 } = fixture.shas;
    const real = gitRepo(fixture.dir);
    const withoutPrNumbers = {
      ...real,
      history: (sha) => ({ shas: real.history(sha).shas, prNumbers: new Set() }),
    };
    const verdict = evaluateShippedFixContainment({
      candidate: head,
      published: publishedStableReleases(releases()),
      git: withoutPrNumbers,
    });
    expect(appliedOrigins(releases()[2].body)).toContain(o2);
    expect(verdict.ok).toBe(false);
    expect(verdict.uncovered).toEqual([expect.objectContaining({ sha: x2, coverage: null })]);
    expect(verdict.coveredByProvenance).toBe(1);
  });

  test('fails closed when a published Release has no tag in the checkout', () => {
    expect(() =>
      evaluate(
        fixture.shas.head,
        releases({ extra: [{ tag_name: 'v9.9.9', draft: false, body: '' }] }),
      ),
    ).toThrow(/no tag in this checkout: v9\.9\.9/);
  });

  test('fails closed on a candidate that does not resolve to a commit', () => {
    expect(() => evaluate('v7.7.7')).toThrow(/does not resolve to a commit/);
  });

  test('tells a ref the checkout lacks apart from a git that cannot read the checkout', () => {
    expect(() => gitRepo(fixture.dir).resolveCommit('refs/tags/v7.7.7')).toThrow(
      'refs/tags/v7.7.7 does not resolve to a commit in this checkout',
    );
    expect(() => gitRepo(fixture.dir).resolveCommit(`${fixture.shas.head}^{tree}`)).toThrow(
      /^\S+ does not resolve to a commit in this checkout: \S/,
    );
    const broken = realpathSync(mkdtempSync(join(tmpdir(), 'ok-shipped-fix-broken-')));
    scratch.push(broken);
    writeFileSync(join(broken, '.git'), `gitdir: ${join(broken, 'missing')}\n`);
    let failure;
    try {
      gitRepo(broken).resolveCommit('HEAD');
    } catch (err) {
      failure = err;
    }
    expect(failure?.message).toMatch(
      /^git rev-parse --verify --quiet HEAD\^\{commit\} failed \(exit 128\): \S/,
    );
    expect(failure.message).not.toContain('does not resolve');
  });
});

describe('the reusable check', () => {
  test('lists the Releases once however many questions it answers', () => {
    let listings = 0;
    const check = createShippedFixCheck({
      cwd: fixture.dir,
      listReleases: () => {
        listings += 1;
        return releases();
      },
    });
    expect(check.publishedStableTags()).toEqual(['v1.0.0', 'v1.0.1', 'v1.1.0']);
    expect(check.evaluate(fixture.shas.head).ok).toBe(true);
    expect(check.evaluate(fixture.shas.m2).ok).toBe(false);
    expect(listings).toBe(1);
  });

  test('refuses a listing with no stable Release while the checkout has stable tags', () => {
    const check = createShippedFixCheck({ cwd: fixture.dir, listReleases: () => [] });
    expect(() => check.publishedStableTags()).toThrow(/holds no stable Release/);
  });

  test('a listing with only draft stables is a real answer, not a broken listing', () => {
    const check = createShippedFixCheck({
      cwd: fixture.dir,
      listReleases: () => [{ tag_name: 'v1.0.1', draft: true, body: '' }],
    });
    expect(check.publishedStableTags()).toEqual([]);
    expect(check.evaluate(fixture.shas.m1).ok).toBe(true);
  });
});

describe('the Release listing', () => {
  test('reads every page, so a stable listed past the first still refuses a candidate that lacks its fixes', () => {
    const bin = realpathSync(mkdtempSync(join(tmpdir(), 'ok-shipped-fix-gh-')));
    scratch.push(bin);
    const byTag = new Map(releases().map((release) => [release.tag_name, release]));
    const page = (name, tags) => {
      const lines = tags.map((tag) => {
        const { tag_name, draft, body } = byTag.get(tag);
        return JSON.stringify({ tag_name, draft, body });
      });
      writeFileSync(join(bin, name), `${lines.join('\n')}\n`);
      return join(bin, name);
    };
    const first = page('page-1.jsonl', ['v1.0.2', 'v1.1.0']);
    const second = page('page-2.jsonl', ['v1.0.1', 'v1.0.0']);
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/bin/sh',
        'listing=no',
        'for arg in "$@"; do',
        '  case "$arg" in repos/inkeep/fixture/releases|repos/inkeep/fixture/releases\\?*) listing=yes ;; esac',
        'done',
        'if [ "$1" != api ] || [ "$listing" != yes ]; then echo "unexpected gh call: $*" >&2; exit 97; fi',
        `cat '${first}'`,
        'for arg in "$@"; do',
        `  if [ "$arg" = --paginate ]; then cat '${second}'; fi`,
        'done',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const summary = join(bin, 'summary');
    writeFileSync(summary, '');
    const run = spawnSync(
      process.execPath,
      [SCRIPT, '-C', fixture.dir, '--repo', 'inkeep/fixture', '--candidate', fixture.shas.m2],
      {
        encoding: 'utf8',
        env: {
          ...gitCleanEnv(),
          GITHUB_STEP_SUMMARY: summary,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
        },
      },
    );
    expect(run.stderr).not.toContain('unexpected gh call');
    expect(run.status, run.stderr).toBe(REFUSED_EXIT);
    expect(run.stdout).toContain('#22 (v1.0.1)');
    expect(run.stdout).toContain('#33 (v1.0.1)');
    expect(readFileSync(summary, 'utf8')).toContain('fix: keep the notice reachable (#22)');
  });
});

describe('the command line', () => {
  const listingFile = (listing) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-shipped-fix-cli-')));
    scratch.push(dir);
    const path = join(dir, 'releases.json');
    writeFileSync(path, JSON.stringify(listing));
    return { dir, path };
  };
  const cli = (args, listing = releases()) => {
    const { dir, path } = listingFile(listing);
    const summary = join(dir, 'summary');
    writeFileSync(summary, '');
    const res = spawnSync(
      process.execPath,
      [SCRIPT, '-C', fixture.dir, '--releases', path, ...args],
      {
        encoding: 'utf8',
        env: {
          ...gitCleanEnv(),
          GIT_DIR: join(dir, 'leaked-git-dir'),
          GITHUB_STEP_SUMMARY: summary,
        },
      },
    );
    return {
      status: res.status,
      stdout: res.stdout,
      stderr: res.stderr,
      summary: readFileSync(summary, 'utf8'),
    };
  };

  test('exits 2 with an error annotation and a summary table when the candidate lacks a shipped fix', () => {
    const run = cli(['--candidate', fixture.shas.m2, '--label', 'v1.1.0']);
    expect(run.status).toBe(REFUSED_EXIT);
    expect(run.stdout).toMatch(
      /^::error::v1\.1\.0 lacks 2 fixes that a published stable already shipped: /m,
    );
    expect(run.summary).toContain('| Commit | Subject | PR | Shipped in |');
    expect(run.summary).toContain('fix: keep the notice reachable (#22)');
  });

  test('exits 0 and records the verdict when the candidate contains every shipped fix', () => {
    const run = cli(['--candidate', fixture.shas.head]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('contains every fix the published stables shipped');
    expect(run.summary).toContain('contains every published fix');
    expect(run.stdout).not.toContain('::error::');
  });

  test('exits 1, never 0, when it cannot decide', () => {
    const missing = cli(['--candidate', 'v7.7.7']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(
      'could not decide: v7.7.7 does not resolve to a commit in this checkout',
    );
    const untagged = cli(
      ['--candidate', fixture.shas.head],
      releases({ extra: [{ tag_name: 'v9.9.9', draft: false }] }),
    );
    expect(untagged.status).toBe(1);
  });

  test('refuses arguments it does not understand', () => {
    expect(() => parseArgs(['--candidate', 'v1', '--frobnicate', 'x'])).toThrow(/unrecognized/);
    expect(() => parseArgs(['--candidate'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--candidate', 'a', '--candidate', 'b'])).toThrow(/twice/);
    expect(() => parseArgs(['--releases', 'f'])).toThrow(/exactly one/);
    expect(cli(['--frobnicate', 'x']).status).toBe(1);
  });

  test('the matrix mode reports every pair and fails on a verdict it did not expect', () => {
    const { m1, m2, head } = fixture.shas;
    const good = cli([
      '--matrix',
      `${m1},${m2},${head}`,
      '--expect-refuse',
      `${m1} ${m2}`,
      '--expect-admit',
      head,
    ]);
    expect(good.status).toBe(0);
    expect(good.stdout).toContain(
      'Published stable Releases: 3. Candidates: 3. git cherry pairs: 4.',
    );
    expect(good.stdout).toContain('Expected verdicts: all matched.');
    const bad = cli(['--matrix', `${m2},${head}`, '--expect-admit', m2]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain(`${m2}: refused, expected admission`);
  });
});

describe('an asset repair of a stable that is already published', () => {
  const listingFile = (listing) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-shipped-fix-repair-')));
    scratch.push(dir);
    const path = join(dir, 'releases.json');
    writeFileSync(path, JSON.stringify(listing));
    return { dir, path };
  };
  const cli = (args, listing = releases()) => {
    const { dir, path } = listingFile(listing);
    const summary = join(dir, 'summary');
    writeFileSync(summary, '');
    const res = spawnSync(
      process.execPath,
      [SCRIPT, '-C', fixture.dir, '--releases', path, ...args],
      {
        encoding: 'utf8',
        env: { ...gitCleanEnv(), GITHUB_STEP_SUMMARY: summary },
      },
    );
    return {
      status: res.status,
      stdout: res.stdout,
      stderr: res.stderr,
      summary: readFileSync(summary, 'utf8'),
    };
  };
  const repairOf = (tag) => [
    '--candidate',
    `refs/tags/${tag}`,
    '--label',
    tag,
    '--allow-published-repair',
    tag,
  ];

  test('skips the check for a tag whose Release is published, which the same check otherwise refuses', () => {
    const checked = cli(['--candidate', 'refs/tags/v1.1.0', '--label', 'v1.1.0']);
    expect(checked.status).toBe(REFUSED_EXIT);
    const repair = cli(repairOf('v1.1.0'));
    expect(repair.status, repair.stderr).toBe(0);
    expect(repair.stdout).toContain(
      '::notice::v1.1.0 already has a published Release; this repair may update assets and release metadata',
    );
    expect(repair.stdout).toContain('dispatch desktop-release-published to release consumers for reconciliation');
    expect(repair.stdout).toContain('without explicitly requesting Latest or dispatching npm publication');
    expect(repair.stdout).not.toContain('::error::');
    expect(repair.summary).toContain('### Shipped-fix containment: v1.1.0 not checked');
  });

  test('still checks a tag whose Release is a draft, because finishing it publishes', () => {
    const run = cli(repairOf('v1.0.2'));
    expect(run.status).toBe(REFUSED_EXIT);
    const refusal = run.stdout.split('\n').filter((line) => line.startsWith('::error::'));
    expect(refusal).toEqual([
      expect.stringMatching(
        /^::error::v1\.0\.2 lacks 2 fixes that a published stable already shipped: /,
      ),
    ]);
    expect(refusal[0]).toContain('#10 (v1.1.0)');
    expect(refusal[0]).toContain('#12 (v1.1.0)');
  });

  test('covers only the tag being checked, and only a stable tag', () => {
    const other = cli(['--candidate', fixture.shas.head, '--allow-published-repair', 'v1.1.0']);
    expect(other.status).toBe(1);
    expect(other.stderr).toContain('the exemption covers only the tag being checked');
    const notStable = cli([
      '--candidate',
      'refs/tags/v1.1.0-beta.0',
      '--allow-published-repair',
      'v1.1.0-beta.0',
    ]);
    expect(notStable.status).toBe(1);
    expect(notStable.stderr).toContain('takes a vX.Y.Z stable tag');
    expect(() => parseArgs(['--matrix', 'v1.1.0', '--allow-published-repair', 'v1.1.0'])).toThrow(
      /goes with --candidate/,
    );
  });

  test('asks the listing and git, and never evaluates the candidate', () => {
    let evaluated = 0;
    const check = {
      publishedStableTags: () => ['v1.0.0', 'v1.1.0'],
      resolveCommit: (ref) =>
        ref === 'refs/tags/v1.1.0' || ref === 'cand' ? 'a'.repeat(40) : 'b'.repeat(40),
      evaluate: () => {
        evaluated += 1;
      },
    };
    expect(publishedRepairExemption({ candidate: 'cand', tag: 'v1.1.0', check })).toBe(true);
    expect(
      publishedRepairExemption({
        candidate: 'cand',
        tag: 'v1.1.0',
        check: { ...check, publishedStableTags: () => ['v1.0.0'] },
      }),
    ).toBe(false);
    expect(evaluated).toBe(0);
  });
});

describe('the matrix runner', () => {
  test('names a candidate it expected a verdict for but never evaluated', () => {
    const check = { evaluate: () => ({ ok: true, checked: [], records: 0, plusRecords: 0 }) };
    const result = runMatrix({ candidates: ['a'], expectAdmit: ['a', 'b'], check });
    expect(result.mismatches).toEqual(['b: expected a verdict but it is not in --matrix']);
  });
});
