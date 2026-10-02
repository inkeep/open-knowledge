import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { gitCleanEnv } from '../../scripts/git-clean-env.mjs';
import {
  DEFAULT_CANDIDATE_LIMIT,
  describeNoSelection,
  describeSelectionFailure,
  listPrebuildRuns,
  main,
  makeIsAncestor,
  makeTreeAt,
  selectPrebuildRun,
} from './select-native-config-prebuild.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = (name) => readFileSync(join(REPO_ROOT, '.github', 'workflows', name), 'utf8');

const stagingStep = (yaml) => {
  const start = yaml.indexOf('- name: Stage native-config prebuilt binaries');
  if (start === -1) throw new Error('no "Stage native-config prebuilt binaries" step');
  const rest = yaml.slice(start);
  const end = rest.indexOf('\n      - name: ');
  return end === -1 ? rest : rest.slice(0, end);
};

const stagingFunctions = (yaml) => {
  const step = stagingStep(yaml);
  const start = step.search(/^ {10}[a-z_]+\(\) \{$/m);
  const close = '\n          }\n';
  const end = step.indexOf(close, step.indexOf('          judge_staging() {'));
  if (start === -1 || end === -1) throw new Error('no staging function block in the step');
  return step
    .slice(start, end + close.length)
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
};

const stagingDeclarations = (yaml) => {
  const document = parse(yaml);
  const job = Object.values(document.jobs).find(({ steps }) =>
    steps?.some((step) => step.name === 'Stage native-config prebuilt binaries'),
  );
  const step = job.steps.find(({ name }) => name === 'Stage native-config prebuilt binaries');
  return { document, job, step };
};

const stagingEnv = (yaml) => stagingDeclarations(yaml).step.env;

const runnerBashArgs = (yaml) => {
  const { document, job, step } = stagingDeclarations(yaml);
  const shell = step.shell ?? job.defaults?.run?.shell ?? document.defaults?.run?.shell;
  if (shell === undefined) return ['-e'];
  if (shell === 'bash') return ['--noprofile', '--norc', '-e', '-o', 'pipefail'];
  throw new Error(`no runner argument format for the staging step's shell: ${shell}`);
};

const NATIVE_CONFIG = join(REPO_ROOT, 'packages', 'native-config');
const JUDGE = join(REPO_ROOT, '.github', 'scripts', 'assert-native-set.mjs');
const { NODE_PATH: _pnpmShimPath, ...judgeEnv } = process.env;

const runJudge = (yaml, { staged, env }) => {
  const dir = mkdtempSync(join(tmpdir(), 'ok-native-staging-'));
  try {
    const nativeConfig = join(dir, 'packages', 'native-config');
    mkdirSync(nativeConfig, { recursive: true });
    writeFileSync(
      join(nativeConfig, 'package.json'),
      readFileSync(join(NATIVE_CONFIG, 'package.json')),
    );
    symlinkSync(join(NATIVE_CONFIG, 'node_modules'), join(nativeConfig, 'node_modules'));
    for (const target of staged) {
      writeFileSync(join(nativeConfig, `native-config.${target}.node`), `bytes of ${target}`);
    }
    const files = { GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary') };
    for (const file of Object.values(files)) writeFileSync(file, '');
    const script = join(dir, 'staging.sh');
    writeFileSync(
      script,
      `${stagingFunctions(yaml)}\njudge="${JUDGE}"\njudge_staging "staged from run 1"\n`,
    );
    const result = spawnSync('bash', [...runnerBashArgs(yaml), script], {
      encoding: 'utf8',
      timeout: 30_000,
      cwd: dir,
      env: { ...judgeEnv, ...env, ...files },
    });
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      outputs: readFileSync(files.GITHUB_OUTPUT, 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const runDownloadBindings = (yaml, { failures }) => {
  const dir = mkdtempSync(join(tmpdir(), 'ok-native-download-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const attempts = join(dir, 'attempts');
    const bindingsDir = join(dir, 'nc-bindings');
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/bash\necho x >> "${attempts}"\nif [ -n "$(ls -A "${bindingsDir}" 2>/dev/null)" ]; then exit 1; fi\nif [ "$(wc -l < "${attempts}" | tr -d ' ')" -le ${failures} ]; then mkdir -p "${bindingsDir}"; touch "${bindingsDir}/partial.node"; exit 1; fi\nexit 0\n`,
    );
    spawnSync('chmod', ['+x', join(bin, 'gh')]);
    const script = join(dir, 'download.sh');
    const functions = stagingFunctions(yaml);
    if (!functions.includes('/tmp/nc-bindings')) {
      throw new Error(
        'staging bytes no longer name /tmp/nc-bindings; the rescope would silently no-op',
      );
    }
    const scoped = functions.replaceAll('/tmp/nc-bindings', bindingsDir);
    writeFileSync(script, `${scoped}\ndownload_bindings 1\n`);
    const result = spawnSync('bash', [...runnerBashArgs(yaml), script], {
      encoding: 'utf8',
      timeout: 60_000,
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        NC_RETRY_BACKOFF_S: '0',
      },
    });
    const calls = readFileSync(attempts, 'utf8').trim().split('\n').filter(Boolean).length;
    return { status: result.status, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const runQaStaging = ({ gh, platforms }) => {
  const dir = mkdtempSync(join(tmpdir(), 'ok-qa-staging-'));
  try {
    const nativeConfig = join(dir, 'packages', 'native-config');
    mkdirSync(nativeConfig, { recursive: true });
    writeFileSync(
      join(nativeConfig, 'package.json'),
      readFileSync(join(NATIVE_CONFIG, 'package.json')),
    );
    symlinkSync(join(NATIVE_CONFIG, 'node_modules'), join(nativeConfig, 'node_modules'));
    mkdirSync(join(dir, '.github', 'scripts'), { recursive: true });
    copyFileSync(JUDGE, join(dir, '.github', 'scripts', 'assert-native-set.mjs'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!/bin/bash\n${gh}\n`, { mode: 0o755 });
    const yaml = workflow('desktop-build-win-linux.yml');
    const script = join(dir, 'staging.sh');
    writeFileSync(script, stagingDeclarations(yaml).step.run);
    const files = { GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary') };
    for (const file of Object.values(files)) writeFileSync(file, '');
    const result = spawnSync('bash', [...runnerBashArgs(yaml), script], {
      encoding: 'utf8',
      timeout: 30_000,
      cwd: dir,
      env: {
        ...gitCleanEnv(judgeEnv),
        ...files,
        GIT_CEILING_DIRECTORIES: dirname(dir),
        GITHUB_SHA: '0000000000000000000000000000000000000000',
        PATH: `${bin}:${process.env.PATH}`,
        PLATFORMS: platforms,
        RUNNER_TEMP: dir,
      },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const EVERY_TARGET = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64-gnu',
  'linux-arm64-musl',
  'linux-x64-gnu',
  'linux-x64-musl',
  'win32-arm64-msvc',
  'win32-x64-msvc',
];
const LINUX_TARGETS = EVERY_TARGET.filter((target) => target.startsWith('linux-'));
const allBut = (targets, missing) => targets.filter((target) => target !== missing);

const REFUSAL_RECOVERY_SECTION = {
  'release.yml': 'Native addon staging',
  'desktop-release.yml': 'Resuming a blocked cut',
  'desktop-build-win-linux.yml': 'Native addon staging',
};

const chainFixture = (chain) => {
  const index = new Map(chain.map((c, i) => [c.sha, { ...c, position: i }]));
  return {
    isAncestor: (sha, ref) => {
      const a = index.get(sha);
      const b = index.get(ref);
      return Boolean(a && b && a.position <= b.position);
    },
    treeAt: (ref) => index.get(ref)?.tree ?? null,
  };
};

const RELEASE_REGRESSION = chainFixture([
  { sha: '98556f27', tree: 'eb09e361' },
  { sha: 'b2b06a46', tree: 'eb09e361' },
  { sha: '7d5af880', tree: 'e1a1c0e4' },
]);

const CANDIDATES_NEWEST_FIRST = [
  { databaseId: 32317026296, headSha: '7d5af880' },
  { databaseId: 30076077253, headSha: '98556f27' },
];

describe('selectPrebuildRun', () => {
  test('takes the newest ANCESTOR run, not the newest run', () => {
    expect(
      selectPrebuildRun({
        candidates: CANDIDATES_NEWEST_FIRST,
        ...RELEASE_REGRESSION,
        releaseRef: 'b2b06a46',
      }),
    ).toEqual({ runId: '30076077253', headSha: '98556f27' });
  });

  test('prefers the newest qualifying run when several are ancestors', () => {
    const graph = chainFixture([
      { sha: 'old', tree: 'T1' },
      { sha: 'newer', tree: 'T1' },
      { sha: 'release', tree: 'T1' },
    ]);
    expect(
      selectPrebuildRun({
        candidates: [
          { databaseId: 2, headSha: 'newer' },
          { databaseId: 1, headSha: 'old' },
        ],
        ...graph,
        releaseRef: 'release',
      }),
    ).toEqual({ runId: '2', headSha: 'newer' });
  });

  test('skips an ancestor whose native-config source differs from the release', () => {
    const graph = chainFixture([
      { sha: 'stale', tree: 'T1' },
      { sha: 'release', tree: 'T2' },
    ]);
    expect(
      selectPrebuildRun({
        candidates: [{ databaseId: 1, headSha: 'stale' }],
        ...graph,
        releaseRef: 'release',
      }),
    ).toBeNull();
  });

  test('returns null when only descendants exist', () => {
    expect(
      selectPrebuildRun({
        candidates: [{ databaseId: 32317026296, headSha: '7d5af880' }],
        ...RELEASE_REGRESSION,
        releaseRef: 'b2b06a46',
      }),
    ).toBeNull();
  });

  test('returns null when the release ref has no native-config tree', () => {
    expect(
      selectPrebuildRun({
        candidates: CANDIDATES_NEWEST_FIRST,
        ...RELEASE_REGRESSION,
        releaseRef: 'unknown-commit',
      }),
    ).toBeNull();
  });

  test('skips candidates missing an id or a head sha', () => {
    expect(
      selectPrebuildRun({
        candidates: [
          { databaseId: '', headSha: '98556f27' },
          { databaseId: 7, headSha: '' },
          { databaseId: 30076077253, headSha: '98556f27' },
        ],
        ...RELEASE_REGRESSION,
        releaseRef: 'b2b06a46',
      }),
    ).toEqual({ runId: '30076077253', headSha: '98556f27' });
  });

  test('tolerates an empty candidate list', () => {
    expect(
      selectPrebuildRun({ candidates: [], ...RELEASE_REGRESSION, releaseRef: 'b2b06a46' }),
    ).toBeNull();
  });
});

describe('describeNoSelection', () => {
  test('names the newest green run so "why not that one" is answered', () => {
    const reason = describeNoSelection(CANDIDATES_NEWEST_FIRST);
    expect(reason).toContain('32317026296');
    expect(reason).toContain('7d5af880');
    expect(reason).toContain('packages/native-config');
  });

  test('says no run exists when there are none', () => {
    expect(describeNoSelection([])).toBe('no successful native-config-prebuild run on main found');
  });
});

describe('describeSelectionFailure', () => {
  test('names the release ref when its native-config tree is unreadable', () => {
    const reason = describeSelectionFailure({
      candidates: CANDIDATES_NEWEST_FIRST,
      treeAt: () => null,
      releaseRef: 'v9.9.9',
    });
    expect(reason).toContain('v9.9.9');
    expect(reason).toContain('release ref');
    expect(reason).not.toContain('32317026296');
  });

  test('falls back to the prebuild account when the release ref reads fine', () => {
    const reason = describeSelectionFailure({
      candidates: CANDIDATES_NEWEST_FIRST,
      treeAt: () => 'eb09e361',
      releaseRef: 'HEAD',
    });
    expect(reason).toContain('32317026296');
  });
});

describe('step extraction', () => {
  test('stagingStep() throws on a document with no staging step', () => {
    expect(() => stagingStep('name: nothing that matches\n')).toThrow(
      /Stage native-config prebuilt binaries/,
    );
  });
});

describe('git boundary', () => {
  const failures = [
    [
      'an exit status git reserves for errors',
      { status: 128, stdout: '', stderr: 'fatal: not a git repository' },
      'fatal: not a git repository',
    ],
    [
      'a git that could not be spawned',
      { status: null, error: new Error('spawn git ENOENT') },
      'spawn git ENOENT',
    ],
    [
      'a git killed by a signal',
      { status: null, signal: 'SIGKILL', stdout: '', stderr: '' },
      'SIGKILL',
    ],
  ];

  test('isAncestor answers only on exit 0 and exit 1', () => {
    const isAncestor = makeIsAncestor((_cmd, args) => ({
      status: args.some((arg) => arg.startsWith('good')) ? 0 : 1,
      stdout: '',
      stderr: '',
    }));
    expect(isAncestor('good', 'HEAD')).toBe(true);
    expect(isAncestor('missing', 'HEAD')).toBe(false);
  });

  test.each(failures)(
    'isAncestor throws when merge-base fails on %s after the candidate is found',
    (_label, result, cause) => {
      const isAncestor = makeIsAncestor((_cmd, args) =>
        args[0] === 'rev-parse' ? { status: 0, stdout: 'aaaaaaa\n', stderr: '' } : result,
      );
      expect(() => isAncestor('good', 'HEAD')).toThrow(cause);
    },
  );

  test('isAncestor reads a candidate commit absent from the clone as not an ancestor', () => {
    const asked = [];
    const isAncestor = makeIsAncestor((_cmd, args) => {
      asked.push(args[0]);
      return args[0] === 'rev-parse'
        ? { status: 1, stdout: '', stderr: '' }
        : { status: 128, stdout: '', stderr: 'fatal: Not a valid commit name' };
    });
    expect(isAncestor('gone', 'HEAD')).toBe(false);
    expect(asked).toEqual(['rev-parse']);
  });

  test('against real git: absent commits and paths are answers, and a missing repository throws', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ok-select-prebuild-git-'));
    const outside = mkdtempSync(join(tmpdir(), 'ok-select-prebuild-nogit-'));
    const env = { ...gitCleanEnv(), GIT_CEILING_DIRECTORIES: dirname(outside) };
    try {
      const git = (...args) =>
        spawnSync(
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
          { cwd: repo, encoding: 'utf8', env },
        ).stdout.trim();
      git('init', '--quiet', '--initial-branch=main');
      git('commit', '--quiet', '--allow-empty', '-m', 'before native-config');
      const first = git('rev-parse', 'HEAD');
      mkdirSync(join(repo, 'packages', 'native-config'), { recursive: true });
      writeFileSync(join(repo, 'packages', 'native-config', 'Cargo.toml'), '[package]\n');
      git('add', '.');
      git('commit', '--quiet', '-m', 'native-config');
      const inRepo = (cmd, args, options) => spawnSync(cmd, args, { ...options, cwd: repo, env });
      const isAncestor = makeIsAncestor(inRepo);
      const treeAt = makeTreeAt(inRepo);
      expect(isAncestor(first, 'HEAD')).toBe(true);
      expect(isAncestor('HEAD', first)).toBe(false);
      expect(isAncestor('0123456789abcdef0123456789abcdef01234567', 'HEAD')).toBe(false);
      expect(() => isAncestor(first, 'no-such-ref')).toThrow(
        /merge-base --is-ancestor .*no-such-ref/,
      );
      expect(treeAt('HEAD')).toMatch(/^[0-9a-f]{40}$/);
      expect(treeAt(first)).toBeNull();
      const inNoRepo = (cmd, args, options) =>
        spawnSync(cmd, args, { ...options, cwd: outside, env });
      expect(() => makeIsAncestor(inNoRepo)(first, 'HEAD')).toThrow('not a git repository');
      expect(() => makeTreeAt(inNoRepo)('HEAD')).toThrow('not a git repository');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test.each(failures)(
    'isAncestor throws on %s instead of answering "not an ancestor"',
    (_label, result, cause) => {
      const isAncestor = makeIsAncestor(() => result);
      expect(() => isAncestor('good', 'HEAD')).toThrow(cause);
    },
  );

  test('treeAt asks git quietly and reads exit 1 as an absent path', () => {
    let seen = [];
    const treeAt = makeTreeAt((_cmd, args) => {
      seen = args;
      return { status: 1, stdout: '', stderr: '' };
    });
    expect(treeAt('HEAD')).toBeNull();
    expect(seen).toContain('--quiet');
  });

  test.each(failures)(
    'treeAt throws on %s instead of answering "absent"',
    (_label, result, cause) => {
      const treeAt = makeTreeAt(() => result);
      expect(() => treeAt('HEAD')).toThrow(cause);
    },
  );

  test('treeAt trims the tree object it reports', () => {
    const treeAt = makeTreeAt(() => ({ status: 0, stdout: 'eb09e361\n', stderr: '' }));
    expect(treeAt('HEAD')).toBe('eb09e361');
  });
});

describe('listPrebuildRuns', () => {
  test('keeps the supply-chain filters that scope candidates to merged main', () => {
    let seen = [];
    listPrebuildRuns({
      run: (_cmd, args) => {
        seen = args;
        return { status: 0, stdout: '[]', stderr: '' };
      },
    });
    expect(seen).toContain('--workflow=native-config-prebuild.yml');
    expect(seen).toContain('main');
    expect(seen).toContain('push');
    expect(seen).toContain('success');
    expect(seen).toContain(String(DEFAULT_CANDIDATE_LIMIT));
    expect(seen).toContain('databaseId,headSha');
  });

  test('walks back far enough to clear a native-config change', () => {
    expect(DEFAULT_CANDIDATE_LIMIT).toBeGreaterThan(1);
  });

  test('the lane whose job restates token scopes keeps the Actions read it stages with', () => {
    const yaml = workflow('desktop-release.yml');
    const jobStart = yaml.indexOf('\n  prepare:');
    expect(jobStart).toBeGreaterThan(-1);
    const block = yaml.slice(jobStart);
    const permissionsStart = block.indexOf('permissions:');
    expect(permissionsStart).toBeGreaterThan(-1);
    const permissions = block.slice(permissionsStart);
    const permissionsEnd = permissions.indexOf('\n    defaults:');
    expect(permissionsEnd).toBeGreaterThan(-1);
    const declared = permissions.slice(0, permissionsEnd);
    expect(declared).toContain('actions: read');
    expect(stagingStep(yaml)).toContain('gh run download');
  });

  test('reports a spawn failure, which leaves stderr empty', () => {
    expect(() =>
      listPrebuildRuns({
        run: () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn gh ENOENT') }),
        sleep: () => {},
      }),
    ).toThrow(/spawn gh ENOENT/);
  });

  test('throws on an unreadable answer rather than reading it as "no runs"', () => {
    expect(() =>
      listPrebuildRuns({
        run: () => ({ status: 1, stdout: '', stderr: 'rate limited' }),
        sleep: () => {},
      }),
    ).toThrow(/rate limited/);
  });

  test('a transient gh failure never reaches the caller as a refusal', () => {
    let calls = 0;
    const slept = [];
    const runs = listPrebuildRuns({
      run: () => {
        calls += 1;
        return calls < 3
          ? { status: 1, stdout: '', stderr: 'API rate limit exceeded' }
          : { status: 0, stdout: '[{"databaseId":7,"headSha":"abc1234"}]', stderr: '' };
      },
      sleep: (ms) => slept.push(ms),
    });
    expect(runs).toEqual([{ databaseId: 7, headSha: 'abc1234' }]);
    expect(calls).toBe(3);
    expect(slept).toEqual([1000, 2000]);
  });

  test('gives up after a bounded number of attempts instead of retrying forever', () => {
    let calls = 0;
    expect(() =>
      listPrebuildRuns({
        run: () => {
          calls += 1;
          return { status: 1, stdout: '', stderr: 'API rate limit exceeded' };
        },
        sleep: () => {},
      }),
    ).toThrow(/failed after 3 attempts: API rate limit exceeded/);
    expect(calls).toBe(3);
  });
});

describe('main', () => {
  test('prints the selected run and commit, tab separated', () => {
    expect(
      main(['--release-ref', 'b2b06a46'], {
        list: () => CANDIDATES_NEWEST_FIRST,
        ...RELEASE_REGRESSION,
      }),
    ).toEqual({ ok: true, line: '30076077253\t98556f27' });
  });

  test('reports a reason instead of a selection when nothing qualifies', () => {
    const result = main(['--release-ref', 'b2b06a46'], {
      list: () => [{ databaseId: 32317026296, headSha: '7d5af880' }],
      ...RELEASE_REGRESSION,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('32317026296');
  });

  test('blames the release ref, not the prebuild runs, when its tree is unreadable', () => {
    const result = main(['--release-ref', 'unknown-commit'], {
      list: () => CANDIDATES_NEWEST_FIRST,
      ...RELEASE_REGRESSION,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unknown-commit');
    expect(result.reason).not.toContain('32317026296');
  });

  test('defaults to HEAD when no ref is given', () => {
    const graph = chainFixture([
      { sha: 'prebuild', tree: 'T1' },
      { sha: 'HEAD', tree: 'T1' },
    ]);
    expect(main([], { list: () => [{ databaseId: 9, headSha: 'prebuild' }], ...graph })).toEqual({
      ok: true,
      line: '9\tprebuild',
    });
  });
});

describe('workflow wiring', () => {
  for (const name of ['desktop-release.yml', 'release.yml']) {
    test(`${name} stages through the shared selector`, () => {
      const step = stagingStep(workflow(name));
      expect(step).toContain('select-native-config-prebuild.mjs');
      expect(step).not.toContain('--limit');
      expect(step).not.toContain('merge-base');
    });

    test(`${name} runs the selector from the workflow's own commit`, () => {
      const step = stagingStep(workflow(name));
      expect(step).toContain('$GITHUB_SHA:.github/scripts/select-native-config-prebuild.mjs');
      expect(step).toContain('cp .github/scripts/select-native-config-prebuild.mjs');
    });

    test(`${name} retries the bindings download a bounded number of times`, () => {
      const yaml = workflow(name);
      const recovered = runDownloadBindings(yaml, { failures: 2 });
      expect(recovered.status).toBe(0);
      expect(recovered.calls).toBe(3);
      const exhausted = runDownloadBindings(yaml, { failures: 99 });
      expect(exhausted.status).not.toBe(0);
      expect(exhausted.calls).toBe(3);
    });

    test(`${name} asserts the selector's output shape, not just non-emptiness`, () => {
      const step = stagingStep(workflow(name));
      expect(step).toContain("selection_shape='^[0-9]+'$'\\t''[0-9a-f]{7,40}$'");
      expect(step).toMatch(
        /if \[\[ ! \$selection =~ \$selection_shape \]\]; then\n\s+flattened=[^\n]*\n\s+judge_staging[^\n]*\n\s+fi/,
      );
    });
  }

  for (const name of ['desktop-release.yml', 'release.yml', 'desktop-build-win-linux.yml']) {
    test(`${name} judges staging with the native-set judge from the workflow's own commit, on every path`, () => {
      const step = stagingStep(workflow(name));
      expect(step).toContain('$GITHUB_SHA:.github/scripts/assert-native-set.mjs');
      expect(step).toContain('cp .github/scripts/assert-native-set.mjs');
      expect(step).toContain('id: stage');
      expect(step).not.toMatch(/\bexit 0\b/);
      expect(step).not.toContain('degrade_or_fail');
      expect(step).toMatch(
        /judge_staging "staged \$count native-config binaries from run \$run_id/,
      );
    });
  }

  test('release.yml requires every platform, because one npm tarball carries them all', () => {
    expect(stagingEnv(workflow('release.yml'))).toMatchObject({
      SERVES: 'mac,windows,linux',
      REQUIRES: 'mac,windows,linux',
    });
    const yaml = workflow('release.yml');
    const env = stagingEnv(yaml);
    const complete = runJudge(yaml, { staged: EVERY_TARGET, env });
    expect(complete.status).toBe(0);
    expect(complete.outputs).toBe('platforms=mac,windows,linux\n');
    const gap = runJudge(yaml, { staged: allBut(EVERY_TARGET, 'linux-arm64-musl'), env });
    expect(gap.status).toBe(1);
    expect(gap.output).toContain(
      '::error::native-set: linux is a required platform, and its staged native-config set is missing native-config.linux-arm64-musl.node',
    );
    expect(gap.output).toContain(
      `resume per RELEASES.md '${REFUSAL_RECOVERY_SECTION['release.yml']}'`,
    );
    expect(gap.output).not.toContain('::warning::');
  });

  test('desktop-release.yml reads the channel and the required platforms into its staging step', () => {
    expect(stagingEnv(workflow('desktop-release.yml'))).toEqual({
      GH_TOKEN: `\${{ github.token }}`,
      CHANNEL: `\${{ steps.channel.outputs.channel }}`,
      REQUIRED: `\${{ steps.required.outputs.required }}`,
    });
  });

  test('desktop-release.yml requires every platform on a stable cut, whatever the required platforms say', () => {
    const yaml = workflow('desktop-release.yml');
    const stable = { CHANNEL: 'latest', REQUIRED: 'mac,linux' };

    const complete = runJudge(yaml, { staged: EVERY_TARGET, env: stable });
    expect(complete.status).toBe(0);
    expect(complete.outputs).toBe('platforms=mac,windows,linux\n');

    const gap = runJudge(yaml, {
      staged: allBut(EVERY_TARGET, 'win32-x64-msvc'),
      env: stable,
    });
    expect(gap.status).toBe(1);
    expect(gap.output).toContain(
      '::error::native-set: windows is a required platform, and its staged native-config set is missing native-config.win32-x64-msvc.node',
    );
    expect(gap.output).not.toContain('::warning::');
    expect(gap.outputs).toBe('');

    const darwinGap = runJudge(yaml, {
      staged: allBut(EVERY_TARGET, 'darwin-arm64'),
      env: stable,
    });
    expect(darwinGap.status).toBe(1);
    expect(darwinGap.output).toContain(
      '::error::native-set: mac is a required platform, and its staged native-config set is missing native-config.darwin-arm64.node',
    );
  });

  test('desktop-release.yml judges a beta cut’s Windows and Linux bundle against the required platforms', () => {
    const yaml = workflow('desktop-release.yml');
    const base = { CHANNEL: 'beta' };

    const requiredGap = runJudge(yaml, {
      staged: allBut(EVERY_TARGET, 'win32-arm64-msvc'),
      env: { ...base, REQUIRED: 'mac,windows,linux' },
    });
    expect(requiredGap.status).toBe(1);
    expect(requiredGap.output).toContain(
      '::error::native-set: windows is a required platform, and its staged native-config set is missing native-config.win32-arm64-msvc.node',
    );
    expect(requiredGap.output).toContain(
      `resume per RELEASES.md '${REFUSAL_RECOVERY_SECTION['desktop-release.yml']}'`,
    );
    expect(requiredGap.outputs).toBe('');

    const droppedGap = runJudge(yaml, {
      staged: allBut(EVERY_TARGET, 'win32-x64-msvc'),
      env: { ...base, REQUIRED: 'mac,linux' },
    });
    expect(droppedGap.status).toBe(0);
    expect(droppedGap.output).toContain(
      '::warning::DEGRADED CUT: windows is not a required platform',
    );
    expect(droppedGap.output).not.toContain('::error::');
    expect(droppedGap.outputs).toBe('platforms=linux\n');

    const complete = runJudge(yaml, {
      staged: EVERY_TARGET,
      env: { ...base, REQUIRED: 'mac,linux' },
    });
    expect(complete.status).toBe(0);
    expect(complete.outputs).toBe('platforms=windows,linux\n');
  });

  test('desktop-release.yml packages only the platforms staging kept, and publishes them from prepare', () => {
    const { jobs } = parse(workflow('desktop-release.yml'));
    expect(jobs.prepare.outputs.platforms).toBe(`\${{ steps.stage.outputs.platforms }}`);
    expect(jobs['build-windows'].if).toBe("contains(needs.prepare.outputs.platforms, 'windows')");
    expect(jobs['build-linux'].if).toBe("contains(needs.prepare.outputs.platforms, 'linux')");
  });

  test('desktop-build-win-linux.yml requires exactly the platforms a QA dispatch builds', () => {
    const yaml = workflow('desktop-build-win-linux.yml');
    expect(stagingEnv(yaml)).toMatchObject({ PLATFORMS: `\${{ inputs.platforms }}` });

    const linuxOnly = runJudge(yaml, { staged: LINUX_TARGETS, env: { PLATFORMS: 'linux' } });
    expect(linuxOnly.status).toBe(0);
    expect(linuxOnly.outputs).toBe('platforms=linux\n');

    const linuxGap = runJudge(yaml, {
      staged: allBut(LINUX_TARGETS, 'linux-x64-gnu'),
      env: { PLATFORMS: 'linux' },
    });
    expect(linuxGap.status).toBe(1);
    expect(linuxGap.output).toContain(
      '::error::native-set: linux is a required platform, and its staged native-config set is missing native-config.linux-x64-gnu.node',
    );
    expect(linuxGap.output).toContain(
      `RELEASES.md '${REFUSAL_RECOVERY_SECTION['desktop-build-win-linux.yml']}'`,
    );

    const both = runJudge(yaml, { staged: EVERY_TARGET, env: { PLATFORMS: 'both' } });
    expect(both.status).toBe(0);
    expect(both.outputs).toBe('platforms=windows,linux\n');
  });

  test('desktop-build-win-linux.yml tells a failed prebuild-run query apart from an empty one', () => {
    const failed = runQaStaging({
      gh: "echo 'HTTP 502: Bad Gateway' >&2\nexit 1",
      platforms: 'linux',
    });
    expect(failed.status).toBe(1);
    expect(failed.output).toContain(
      '(could not list native-config-prebuild runs on main: HTTP 502: Bad Gateway)',
    );
    expect(failed.output).not.toContain('no successful native-config-prebuild run found');

    const empty = runQaStaging({ gh: 'exit 0', platforms: 'linux' });
    expect(empty.status).toBe(1);
    expect(empty.output).toContain('(no successful native-config-prebuild run found on main)');
  });

  test('desktop-build-win-linux.yml names a cause when a failed prebuild-run query prints nothing', () => {
    const silent = runQaStaging({ gh: 'exit 4', platforms: 'linux' });
    expect(silent.status).toBe(1);
    expect(silent.output).toContain(
      '(could not list native-config-prebuild runs on main: gh run list exited 4 with no error output)',
    );
  });
});
