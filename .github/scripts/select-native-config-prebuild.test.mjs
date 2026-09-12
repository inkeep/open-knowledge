import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
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
  const start = step.indexOf('          summarize() {');
  const close = '\n          }\n';
  const end = step.indexOf(close, step.indexOf('          degrade_or_fail() {'));
  if (start === -1 || end === -1) throw new Error('no staging function block in the step');
  return step
    .slice(start, end + close.length)
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
};

const runDegradeOrFail = (functions, { isStable, staged }) => {
  const dir = mkdtempSync(join(tmpdir(), 'ok-native-staging-'));
  try {
    mkdirSync(join(dir, 'packages', 'native-config'), { recursive: true });
    for (const target of staged) {
      writeFileSync(join(dir, 'packages', 'native-config', `native-config.${target}.node`), '');
    }
    const script = join(dir, 'staging.sh');
    writeFileSync(
      script,
      `${functions}\ndegrade_or_fail "could not download native-config-bindings-all from run 1" "0/8"\n`,
    );
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      timeout: 10_000,
      cwd: dir,
      env: {
        ...process.env,
        IS_STABLE: String(isStable),
        GITHUB_STEP_SUMMARY: join(dir, 'step-summary.txt'),
      },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const runDownloadBindings = (functions, { failures }) => {
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
    if (!functions.includes('/tmp/nc-bindings')) {
      throw new Error('staging bytes no longer name /tmp/nc-bindings; the rescope would silently no-op');
    }
    const scoped = functions.replaceAll('/tmp/nc-bindings', bindingsDir);
    writeFileSync(script, `${scoped}\ndownload_bindings 1\n`);
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      timeout: 60_000,
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        IS_STABLE: 'false',
        NC_RETRY_BACKOFF_S: '0',
      },
    });
    const calls = readFileSync(attempts, 'utf8').trim().split('\n').filter(Boolean).length;
    return { status: result.status, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const BOTH_WINDOWS_TARGETS = ['win32-x64-msvc', 'win32-arm64-msvc'];

const REFUSAL_RECOVERY_SECTION = {
  'release.yml': 'Native addon staging (Windows is mandatory)',
  'desktop-release.yml': 'Resuming a blocked cut',
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
  test('isAncestor reads a non-zero exit as "not an ancestor"', () => {
    const isAncestor = makeIsAncestor((_cmd, args) => ({
      status: args.includes('good') ? 0 : 1,
      stdout: '',
      stderr: '',
    }));
    expect(isAncestor('good', 'HEAD')).toBe(true);
    expect(isAncestor('missing', 'HEAD')).toBe(false);
  });

  test('treeAt returns null for an unresolvable path', () => {
    const treeAt = makeTreeAt(() => ({ status: 128, stdout: '', stderr: 'bad revision' }));
    expect(treeAt('HEAD')).toBeNull();
  });

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

    test(`${name} still splits beta degradation from stable refusal`, () => {
      const step = stagingStep(workflow(name));
      expect(step).toContain('degrade_or_fail');
      expect(step).toMatch(
        /if \[ "\$IS_STABLE" = "true" \]; then\n\s+echo "::error::[^\n]+\n\s+exit 1/,
      );
      expect(step).toMatch(/echo "::warning::[^\n]+\n\s+exit 0/);
    });

    test(`${name} requires both Windows binaries at every staging outcome`, () => {
      const step = stagingStep(workflow(name));
      for (const target of BOTH_WINDOWS_TARGETS) {
        expect(step).toContain(`native-config.${target}.node`);
      }
      expect(step).toMatch(/summarize "\$2 — \$1"\n\s+require_windows_targets "\$1"/);
      expect(step).toMatch(/-lt 8 \]; then\n(?:.*\n)*?\s+fi\n\s+require_windows_targets /);
    });

    test(`${name} refuses a beta cut whose staged set lacks either Windows binary`, () => {
      const functions = stagingFunctions(workflow(name));
      expect(functions).toContain('require_windows_targets');

      const recovered = runDownloadBindings(functions, { failures: 2 });
      expect(recovered.status).toBe(0);
      expect(recovered.calls).toBe(3);
      const exhausted = runDownloadBindings(functions, { failures: 99 });
      expect(exhausted.status).not.toBe(0);
      expect(exhausted.calls).toBe(3);

      const complete = runDegradeOrFail(functions, {
        isStable: false,
        staged: BOTH_WINDOWS_TARGETS,
      });
      expect(complete.status).toBe(0);
      expect(complete.output).toContain('::warning::');
      expect(complete.output).not.toContain('::error::');

      for (const missing of BOTH_WINDOWS_TARGETS) {
        const staged = BOTH_WINDOWS_TARGETS.filter((target) => target !== missing);
        const refused = runDegradeOrFail(functions, { isStable: false, staged });
        expect(refused.status).toBe(1);
        expect(refused.output).toContain(`native-config.${missing}.node was not staged`);
        expect(refused.output).not.toContain('::warning::');
        expect(refused.output).toContain(
          `resume per RELEASES.md '${REFUSAL_RECOVERY_SECTION[name]}'`,
        );
      }
    });

    test(`${name} still refuses a stable cut with a complete Windows pair`, () => {
      const refused = runDegradeOrFail(stagingFunctions(workflow(name)), {
        isStable: true,
        staged: BOTH_WINDOWS_TARGETS,
      });
      expect(refused.status).toBe(1);
      expect(refused.output).toContain('incomplete native-config binary set');
      expect(refused.output).not.toContain('::warning::');
    });

    test(`${name} names the missing Windows binary on the stable channel too`, () => {
      const functions = stagingFunctions(workflow(name));
      for (const missing of BOTH_WINDOWS_TARGETS) {
        const staged = BOTH_WINDOWS_TARGETS.filter((target) => target !== missing);
        const refused = runDegradeOrFail(functions, { isStable: true, staged });
        expect(refused.status).toBe(1);
        expect(refused.output).toContain(`native-config.${missing}.node was not staged`);
        expect(refused.output).not.toContain('incomplete native-config binary set');
      }
    });

    test(`${name} asserts the selector's output shape, not just non-emptiness`, () => {
      const step = stagingStep(workflow(name));
      expect(step).toContain("selection_shape='^[0-9]+'$'\\t''[0-9a-f]{7,40}$'");
      expect(step).toMatch(
        /if \[\[ ! \$selection =~ \$selection_shape \]\]; then\n\s+flattened=[^\n]*\n\s+degrade_or_fail[^\n]*\n\s+fi/,
      );
    });
  }
});
