import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { gitCleanEnv } from '../../scripts/git-clean-env.mjs';
import { evaluateBugLane, makeIsInStable, readPendingBumps } from './bug-lane.mjs';

const FIX_A = 'a'.repeat(40);
const FIX_B = 'b'.repeat(40);
const FEAT = 'c'.repeat(40);
const SHIPPED = 'd'.repeat(40);

const cs = (id, bump, addingSha, addingSubject = `${id} subject (#100)`) => ({
  id,
  bump,
  addingSha,
  addingSubject,
});

const bugIssues = { issues: [{ identifier: 'PRD-1', labels: ['Bug', 'ok:ui'] }] };
const plainIssues = { issues: [{ identifier: 'PRD-2', labels: ['ok:ui'] }] };

const evaluate = (overrides = {}) =>
  evaluateBugLane({
    pendingChangesets: [cs('one', 'patch', FIX_A)],
    isInStable: () => false,
    resolveChangesetPrUrl: (id) => `https://github.com/inkeep/agents-private/pull/${id.length}`,
    resolveIssuesForUrl: async () => bugIssues,
    ...overrides,
  });

describe('evaluateBugLane', () => {
  test('a patch-only bug-linked commit qualifies', async () => {
    const r = await evaluate();
    expect(r.fixRefs).toEqual([FIX_A]);
    expect(r.reason).toBe('candidates');
    expect(r.perCommit[0]).toMatchObject({ qualifies: true, linkedIssues: ['PRD-1'] });
  });

  test('a commit adding any minor changeset is feature work and stays with its cycle', async () => {
    const r = await evaluate({
      pendingChangesets: [cs('one', 'patch', FEAT), cs('two', 'minor', FEAT)],
    });
    expect(r.fixRefs).toEqual([]);
    expect(r.perCommit[0].reason).toBe('not-patch-only');
  });

  test('a patch commit with no Bug-labeled issue does not qualify', async () => {
    const r = await evaluate({ resolveIssuesForUrl: async () => plainIssues });
    expect(r.fixRefs).toEqual([]);
    expect(r.perCommit[0].reason).toBe('not-bug-linked');
  });

  test('a commit already contained in the stable is excluded before any resolution', async () => {
    const r = await evaluate({
      pendingChangesets: [cs('restored', 'patch', SHIPPED)],
      isInStable: (sha) => sha === SHIPPED,
      resolveChangesetPrUrl: () => {
        throw new Error('must not resolve an already-shipped commit');
      },
    });
    expect(r.fixRefs).toEqual([]);
    expect(r.perCommit[0].reason).toBe('already-in-stable');
  });

  test('several qualifying commits batch in input (merge) order', async () => {
    const r = await evaluate({
      pendingChangesets: [cs('one', 'patch', FIX_A), cs('two', 'patch', FIX_B)],
    });
    expect(r.fixRefs).toEqual([FIX_A, FIX_B]);
  });

  test('resolution failures degrade the commit, never the tick', async () => {
    const r = await evaluate({
      pendingChangesets: [cs('one', 'patch', FIX_A), cs('two', 'patch', FIX_B)],
      resolveIssuesForUrl: async (url) => {
        if (url.endsWith('/3')) throw new Error('linear down');
        return bugIssues;
      },
      resolveChangesetPrUrl: (id) => `https://github.com/inkeep/agents-private/pull/${id.length}`,
    });
    expect(r.reason).toBe('no-qualifying-fixes');
    expect(r.warnings.some((w) => w.startsWith('issues-error'))).toBe(true);
  });

  test('an unresolvable Linear lookup (no key) degrades to not-bug-linked', async () => {
    const r = await evaluate({
      resolveIssuesForUrl: async () => ({ unresolvable: 'no-linear-api-key' }),
    });
    expect(r.fixRefs).toEqual([]);
    expect(r.perCommit[0].reason).toBe('not-bug-linked');
    expect(r.warnings.some((w) => w.includes('no-linear-api-key'))).toBe(true);
  });

  test('a commit qualifies through any one of its changesets', async () => {
    const r = await evaluate({
      pendingChangesets: [cs('one', 'patch', FIX_A), cs('two', 'patch', FIX_A)],
      resolveIssuesForUrl: async (url) => (url.endsWith('/3') ? plainIssues : bugIssues),
      resolveChangesetPrUrl: (id) => `https://github.com/inkeep/agents-private/pull/${id === 'one' ? 3 : 4}`,
    });
    expect(r.fixRefs).toEqual([FIX_A]);
  });

  test('an isInStable failure degrades that commit with a warning and the tick still answers', async () => {
    const r = await evaluate({
      pendingChangesets: [cs('one', 'patch', FIX_A), cs('two', 'patch', FIX_B)],
      isInStable: (sha) => {
        if (sha === FIX_A) throw new Error('git lock');
        return false;
      },
    });
    expect(r.fixRefs).toEqual([FIX_B]);
    expect(r.warnings.some((w) => w.startsWith('containment-error') && w.includes('git lock'))).toBe(true);
    expect(r.perCommit.find((c) => c.sha === FIX_A).reason).toBe('containment-error');
  });

  test('an empty pile is a real answer', async () => {
    const r = await evaluate({ pendingChangesets: [] });
    expect(r).toMatchObject({ fixRefs: [], reason: 'no-pending-changesets' });
  });

  test('the Bug label matches case-insensitively and no other label counts', async () => {
    const r = await evaluate({
      resolveIssuesForUrl: async () => ({ issues: [{ identifier: 'PRD-9', labels: ['bug'] }] }),
    });
    expect(r.fixRefs).toEqual([FIX_A]);
    const r2 = await evaluate({
      resolveIssuesForUrl: async () => ({ issues: [{ identifier: 'PRD-9', labels: ['Bugfix'] }] }),
    });
    expect(r2.fixRefs).toEqual([]);
  });
});

describe('makeIsInStable', () => {
  let dir;
  let fixOnMain;
  let laterOnMain;

  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitCleanEnv() }).trim();
  const inRepo = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: gitCleanEnv() });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-bug-lane-containment-'));
    git('init', '--initial-branch=main', '--quiet');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');

    writeFileSync(join(dir, 'base.txt'), 'base\n');
    git('add', '-A');
    git('commit', '-m', 'base', '--quiet');
    const base = git('rev-parse', 'HEAD');

    writeFileSync(join(dir, 'fix.txt'), 'the fix\n');
    git('add', '-A');
    git('commit', '-m', 'fix: the bug', '--quiet');
    fixOnMain = git('rev-parse', 'HEAD');

    writeFileSync(join(dir, 'later.txt'), 'later feature\n');
    git('add', '-A');
    git('commit', '-m', 'feat: later', '--quiet');
    laterOnMain = git('rev-parse', 'HEAD');

    git('checkout', '--quiet', '-b', 'stable', base);
    writeFileSync(join(dir, 'prior.txt'), 'earlier point release\n');
    git('add', '-A');
    git('commit', '-m', 'fix: an earlier point release', '--quiet');
    git('cherry-pick', fixOnMain);
    git('tag', 'v1.0.0');
    git('checkout', '--quiet', 'main');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('the cherry-picked copy on the stable is NOT an ancestor of it', () => {
    expect(git('rev-parse', 'v1.0.0')).not.toBe(fixOnMain);
    expect(inRepo(['merge-base', '--is-ancestor', fixOnMain, 'v1.0.0']).status).toBe(1);
  });

  test('a fix already released into the stable reads as contained', () => {
    expect(makeIsInStable('v1.0.0', inRepo)(fixOnMain)).toBe(true);
  });

  test('a commit the stable does not carry reads as not contained', () => {
    expect(makeIsInStable('v1.0.0', inRepo)(laterOnMain)).toBe(false);
  });

  test('a genuine ancestor still reads as contained', () => {
    expect(makeIsInStable('v1.0.0', inRepo)(git('rev-parse', 'v1.0.0^'))).toBe(true);
  });

  test('an equivalence probe that fails degrades to not-contained, not an error', () => {
    const flaky = (args) =>
      args[0] === 'cherry' ? { status: 128, stdout: '', stderr: 'boom' } : inRepo(args);
    expect(makeIsInStable('v1.0.0', flaky)(laterOnMain)).toBe(false);
  });

  test('an ancestry probe that fails is still an infrastructure error', () => {
    const broken = () => ({ status: 128, stdout: '', stderr: 'not a git repository' });
    expect(() => makeIsInStable('v1.0.0', broken)(laterOnMain)).toThrow(/merge-base/);
  });
});

describe('readPendingBumps, run by the job that holds no credential', () => {
  test('reads every changeset pending at HEAD, keyed by blob, and reads nothing else', () => {
    const reads = [];
    const git = {
      changesetIds: (sha) => (sha === 'HEAD' ? ['fix-crash', 'new-thing'] : []),
      changesetBlobs: (sha) =>
        new Map(sha === 'HEAD' ? [['fix-crash', 'blob-fix'], ['new-thing', 'blob-feat']] : []),
      bumpTypeOf: (sha, id) => {
        reads.push(`${sha}:${id}`);
        return id === 'new-thing' ? 'minor' : 'patch';
      },
    };
    expect(Object.fromEntries(readPendingBumps(git))).toEqual({ 'blob-fix': 'patch', 'blob-feat': 'minor' });
    expect(reads).toEqual(['HEAD:fix-crash', 'HEAD:new-thing']);
  });

  test('an empty pile reads as no verdicts', () => {
    const git = {
      changesetIds: () => [],
      changesetBlobs: () => new Map(),
      bumpTypeOf: () => {
        throw new Error('nothing to read');
      },
    };
    expect(readPendingBumps(git).size).toBe(0);
  });
});

describe('the bug-lane entry points the two jobs run', () => {
  const SCRIPT = realpathSync(fileURLToPath(new URL('./bug-lane.mjs', import.meta.url)));
  const OK_ROOT = join(dirname(SCRIPT), '..', '..');
  const COPIED = [
    '.github/scripts/bug-lane.mjs',
    '.github/scripts/select-beta-to-promote.mjs',
    'scripts/compute-stable-version.mjs',
    'scripts/compute-next-beta.mjs',
    'scripts/git-clean-env.mjs',
  ];
  const dirs = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  });
  const scratch = (prefix) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };
  const { BUMP_VERDICTS: _verdicts, LINEAR_API_KEY: _key, LINK_REPO: _repo, ...cleanEnv } = gitCleanEnv();
  const git = (cwd, ...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
      env: gitCleanEnv(),
    }).trim();
  const pendingRepo = () => {
    const root = scratch('bug-lane-entry-');
    const commit = (id, type, subject) => {
      mkdirSync(join(root, '.changeset'), { recursive: true });
      writeFileSync(join(root, '.changeset', `${id}.md`), `---\n"@inkeep/open-knowledge": ${type}\n---\n\n${id}\n`);
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', subject);
      return git(root, 'rev-parse', 'HEAD');
    };
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'README.md'), 'stable\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'stable');
    git(root, 'tag', 'v1.0.0');
    const fix = commit('fix-crash', 'patch', 'fix: stop the crash (#101)');
    const feat = commit('new-thing', 'minor', 'feat: a new thing (#102)');
    return {
      root,
      fix,
      feat,
      blobs: {
        fix: git(root, 'rev-parse', 'HEAD:.changeset/fix-crash.md'),
        feat: git(root, 'rev-parse', 'HEAD:.changeset/new-thing.md'),
      },
    };
  };
  const isolatedScript = () => {
    const dir = scratch('bug-lane-no-node-modules-');
    for (const file of COPIED) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      copyFileSync(join(OK_ROOT, file), join(dir, file));
    }
    return join(dir, '.github', 'scripts', 'bug-lane.mjs');
  };
  const linearStub = () => {
    const dir = scratch('bug-lane-linear-');
    const preload = join(dir, 'linear.mjs');
    const calls = join(dir, 'calls');
    writeFileSync(
      preload,
      [
        "import { appendFileSync } from 'node:fs';",
        'globalThis.fetch = async (url, init) => {',
        '  appendFileSync(process.env.LINEAR_CALLS, `${JSON.stringify({ url: String(url), authorization: init.headers.authorization, body: JSON.parse(init.body) })}\\n`);',
        "  return new Response(JSON.stringify({ data: { attachmentsForURL: { nodes: [{ issue: { identifier: 'PRD-1', labels: { nodes: [{ name: 'Bug' }] } } }] } } }), { status: 200 });",
        '};',
        '',
      ].join('\n'),
    );
    writeFileSync(calls, '');
    return { preload, calls, read: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) };
  };
  const run = (script, cwd, { args = [], env = {}, preload } = {}) => {
    const output = join(scratch('bug-lane-output-'), 'github-output');
    writeFileSync(output, '');
    const res = spawnSync(process.execPath, [...(preload ? ['--import', preload] : []), script, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...cleanEnv, GITHUB_OUTPUT: output, ...env },
    });
    return { ...res, output: readFileSync(output, 'utf8') };
  };

  test('--read-bumps writes the bump of every pending changeset, keyed by blob id', () => {
    const { root, blobs } = pendingRepo();
    const res = run(SCRIPT, root, { args: ['--read-bumps'] });
    expect(res.status, res.stderr).toBe(0);
    expect(res.output).toBe(`bump_verdicts={"${blobs.fix}":"patch","${blobs.feat}":"minor"}\n`);
  });

  test('with the reader job verdicts and no node_modules it makes the same Linear queries and writes the same outputs', () => {
    const { root, fix } = pendingRepo();
    const verdicts = run(SCRIPT, root, { args: ['--read-bumps'] }).output.trim().slice('bump_verdicts='.length);

    const withReader = linearStub();
    const reader = run(SCRIPT, root, {
      env: { LINEAR_API_KEY: 'placeholder-linear-key', LINEAR_CALLS: withReader.calls },
      preload: withReader.preload,
    });
    expect(reader.status, reader.stderr).toBe(0);

    const withoutReader = linearStub();
    const verdictMode = run(isolatedScript(), root, {
      env: { LINEAR_API_KEY: 'placeholder-linear-key', LINEAR_CALLS: withoutReader.calls, BUMP_VERDICTS: verdicts },
      preload: withoutReader.preload,
    });
    expect(verdictMode.status, verdictMode.stderr).toBe(0);

    expect(verdictMode.output).toBe(`fix_refs=${fix}\nstable=v1.0.0\nfix_tickets={"${fix}":["PRD-1"]}\n`);
    expect(verdictMode.output).toBe(reader.output);
    expect(withoutReader.read()).toEqual([
      {
        url: 'https://api.linear.app/graphql',
        authorization: 'placeholder-linear-key',
        body: expect.objectContaining({ variables: { url: 'https://github.com/inkeep/agents-private/pull/101' } }),
      },
    ]);
    expect(withoutReader.read()).toEqual(withReader.read());
    expect(verdictMode.stdout).toContain('"feat: a new thing (#102)" -> not-patch-only');
  });

  test('without verdicts the same isolated copy cannot load the reader, so the run above proves it never tried', () => {
    const { root } = pendingRepo();
    const res = run(isolatedScript(), root);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/@changesets\/cli/);
    expect(res.output).toBe('');
  });

  test('a changeset the reader job did not read stops the tick before Linear or any output', () => {
    const { root, blobs } = pendingRepo();
    const linear = linearStub();
    const res = run(isolatedScript(), root, {
      env: {
        LINEAR_API_KEY: 'placeholder-linear-key',
        LINEAR_CALLS: linear.calls,
        BUMP_VERDICTS: JSON.stringify({ [blobs.fix]: 'patch' }),
      },
      preload: linear.preload,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/no bump verdict for \.changeset\/new-thing\.md/);
    expect(res.output).toBe('');
    expect(linear.read()).toEqual([]);
  });

  test('an empty BUMP_VERDICTS stops the tick with an error naming the read-bumps output', () => {
    const { root } = pendingRepo();
    const res = run(isolatedScript(), root, { env: { BUMP_VERDICTS: '' } });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/BUMP_VERDICTS is empty: the read-bumps job wrote no bump_verdicts output/);
    expect(res.output).toBe('');
  });
});
