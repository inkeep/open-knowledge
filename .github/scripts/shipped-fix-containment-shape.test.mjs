// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell and GitHub expression fixtures must remain literal.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { gitCleanEnv } from '../../scripts/git-clean-env.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const OK_ROOT = join(SCRIPTS, '..', '..');
const GUARD = '.github/scripts/shipped-fix-containment.mjs';
const workflow = (name) => parse(readFileSync(join(OK_ROOT, '.github', 'workflows', name), 'utf8'));
const stepsOf = (file, job) => {
  const steps = workflow(file).jobs?.[job]?.steps;
  if (!Array.isArray(steps) || steps.length < 3) {
    throw new Error(`${file} job ${job} has no step list to inspect`);
  }
  return steps;
};
const guardSteps = (steps) => steps.filter((step) => String(step.run ?? '').includes(GUARD));
const indexWhere = (steps, predicate, what) => {
  const index = steps.findIndex(predicate);
  if (index === -1) throw new Error(`no step ${what}`);
  return index;
};

const scratch = [];
afterAll(() => {
  while (scratch.length > 0) rmSync(scratch.pop(), { recursive: true, force: true });
});

describe('promotion: promote-stable refuses before it tags', () => {
  const steps = stepsOf('promote-stable.yml', 'promote');
  const [guard] = guardSteps(steps);

  test('the promote job runs the guard on the beta it computed the version for', () => {
    expect(guardSteps(steps)).toHaveLength(1);
    expect(guard.run).toContain('--candidate "$BETA_SHA"');
    expect(guard.env).toMatchObject({
      GH_TOKEN: '${{ steps.app-token.outputs.token }}',
      BETA_SHA: '${{ steps.ver.outputs.beta_sha }}',
    });
    expect(guard['continue-on-error']).toBeUndefined();
  });

  test('it runs whenever the promotion would tag, after the version is computed', () => {
    const compute = indexWhere(steps, (step) => step.id === 'ver', 'with id ver');
    const tag = indexWhere(steps, (step) => step.name === 'Tag stable at beta SHA', 'that tags');
    const index = steps.indexOf(guard);
    expect(index).toBeGreaterThan(compute);
    expect(index).toBeLessThan(tag);
    expect(guard.if).toBe(steps[tag].if);
    expect(guard.if).toBe("steps.ver.outputs.skip != 'true'");
    const mutating = steps.filter((step) =>
      /git tag "|push origin|gh release (create|edit) |\/dispatches/.test(String(step.run ?? '')),
    );
    expect(mutating.length).toBeGreaterThanOrEqual(3);
    for (const step of mutating) expect(steps.indexOf(step)).toBeGreaterThan(index);
  });
});

describe('point releases: the planner holds the guards', () => {
  const steps = stepsOf('point-release.yml', 'point-release');

  test('the release job runs the planner with a token that can list Releases', () => {
    const plan = steps.find((step) => step.id === 'plan');
    expect(plan.run).toBe('node .github/scripts/point-release-plan.mjs');
    expect(plan.env.GH_TOKEN).toBe('${{ steps.app-token.outputs.token }}');
    expect(plan['continue-on-error']).toBeUndefined();
  });
});

describe('direct recovery: desktop-release refuses a stable in prepare', () => {
  const release = workflow('desktop-release.yml');
  const steps = stepsOf('desktop-release.yml', 'prepare');
  const [guard] = guardSteps(steps);

  test('prepare runs the guard for the stable channel only, against the release tag', () => {
    expect(guardSteps(steps)).toHaveLength(1);
    expect(guard.if).toBe("steps.channel.outputs.channel == 'latest'");
    expect(guard.run).toContain('--candidate "refs/tags/${RELEASE_TAG}"');
    expect(guard.env.RELEASE_TAG).toBe(
      '${{ github.event.client_payload.release_tag || inputs.release_tag }}',
    );
    expect(guard.env.GH_TOKEN).toContain('github.token');
    expect(guard['continue-on-error']).toBeUndefined();
    const channel = indexWhere(steps, (step) => step.id === 'channel', 'with id channel');
    expect(steps.indexOf(guard)).toBeGreaterThan(channel);
  });

  test('the guard comes from the workflow revision, not from the tag being rebuilt', () => {
    expect(guard.run).toMatch(
      /git archive "\$GITHUB_SHA" [^\n]*\.github\/scripts\/shipped-fix-containment\.mjs/,
    );
    expect(guard.run).toMatch(/node "\$guard\/\.github\/scripts\/shipped-fix-containment\.mjs"/);
  });

  test('the archive carries every module the guard imports', () => {
    const archived = /git archive "\$GITHUB_SHA" ([^|]+)\|/.exec(guard.run)[1].trim().split(/\s+/);
    const pending = [GUARD];
    const needed = new Set();
    while (pending.length > 0) {
      const file = pending.pop();
      if (needed.has(file)) continue;
      needed.add(file);
      const source = readFileSync(join(OK_ROOT, file), 'utf8');
      for (const [, specifier] of source.matchAll(/^import [^;]*? from '(\.{1,2}\/[^']+)';$/gms)) {
        pending.push(posix.normalize(posix.join(posix.dirname(file), specifier)));
      }
    }
    expect([...needed].sort()).toEqual([...archived].sort());
  });

  test('publication needs prepare to have succeeded', () => {
    const publish = release.jobs['publish-assets'];
    const finalize = release.jobs.finalize;
    expect(publish.needs).toContain('prepare');
    expect(publish.if).toContain("needs.prepare.result == 'success'");
    expect(finalize.needs).toEqual(expect.arrayContaining(['prepare', 'publish-assets']));
    expect(finalize.if).toContain("needs.publish-assets.result == 'success'");
    expect(release.jobs['release-consumers'].needs).toBe('finalize');
  });

  test('the archived guard runs on its own against a tag checkout that predates it', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-shipped-fix-archive-')));
    scratch.push(root);
    const git = (...args) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.com',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd: join(root, 'checkout'), env: gitCleanEnv(), encoding: 'utf8' },
      ).trim();
    mkdirSync(join(root, 'checkout'));
    git('init', '-q', '-b', 'main');
    writeFileSync(join(root, 'checkout', 'notes.txt'), 'first\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'Initial (#1)');
    git('tag', 'v1.0.0');
    writeFileSync(join(root, 'checkout', 'notes.txt'), 'second\n');
    git('commit', '-q', '-am', 'Second (#2)');
    git('tag', 'v1.0.1');
    const guardDir = join(root, 'guard');
    for (const file of [GUARD, 'scripts/git-clean-env.mjs']) {
      mkdirSync(dirname(join(guardDir, file)), { recursive: true });
      writeFileSync(join(guardDir, file), readFileSync(join(OK_ROOT, file)));
    }
    const listing = join(root, 'releases.json');
    writeFileSync(
      listing,
      JSON.stringify([
        { tag_name: 'v1.0.0', draft: false, body: '' },
        { tag_name: 'v1.0.1', draft: false, body: '' },
      ]),
    );
    const run = (candidate) =>
      spawnSync(
        process.execPath,
        [join(guardDir, GUARD), '--candidate', candidate, '--releases', listing],
        { cwd: join(root, 'checkout'), encoding: 'utf8', env: gitCleanEnv() },
      );
    const admitted = run('refs/tags/v1.0.1');
    expect(admitted.status, admitted.stderr).toBe(0);
    const refused = run('refs/tags/v1.0.0');
    expect(refused.status).toBe(2);
    expect(refused.stdout).toContain(
      '::error::refs/tags/v1.0.0 lacks 1 fix that a published stable already shipped: #2 (v1.0.1).',
    );
  });
});

describe('direct recovery and re-runs: desktop-release checks again right before it publishes', () => {
  const release = workflow('desktop-release.yml');
  const steps = stepsOf('desktop-release.yml', 'finalize');
  const [guard] = guardSteps(steps);

  test('finalize runs the guard on the stable channel, from a checkout of the workflow revision with every tag', () => {
    expect(guardSteps(steps)).toHaveLength(1);
    expect(guard.if).toBe("success() && needs.prepare.outputs.channel == 'latest'");
    expect(guard.run).toContain('node .github/scripts/shipped-fix-containment.mjs "${args[@]}"');
    expect(guard.run).toContain('--candidate "refs/tags/${RELEASE_TAG}"');
    expect(guard.env.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(guard['continue-on-error']).toBeUndefined();
    expect(release.jobs.finalize.env.RELEASE_TAG).toBe(
      '${{ github.event.client_payload.release_tag || inputs.release_tag }}',
    );
    const checkout = steps.filter((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout).toHaveLength(1);
    expect(checkout[0].with?.['fetch-depth']).toBe(0);
    expect(checkout[0].with?.ref).toBeUndefined();
    expect(steps.indexOf(checkout[0])).toBeLessThan(steps.indexOf(guard));
  });

  test('it is the step right before the draft flip, ahead of every step that publishes, dispatches or announces', () => {
    const publish = indexWhere(steps, (step) => step.id === 'publish', 'that publishes the draft');
    expect(steps[publish].run).toContain('gh release edit "$RELEASE_TAG" --draft=false');
    expect(steps.indexOf(guard)).toBe(publish - 1);
    const shipping = steps.filter((step) =>
      /--draft=false|\/dispatches|curl /.test(String(step.run ?? '')),
    );
    expect(shipping.map((step) => step.name)).toEqual(
      expect.arrayContaining([
        'Promote draft release to published',
        'Trigger release.yml to publish stable to npm',
        'Announce stable release to Slack',
        'Announce stable release to Discord',
      ]),
    );
    for (const step of shipping) expect(steps.indexOf(step)).toBeGreaterThan(steps.indexOf(guard));
  });
});

describe('an asset repair of an already published stable is the one run the guard lets through', () => {
  const prepareGuard = guardSteps(stepsOf('desktop-release.yml', 'prepare'))[0];
  const finalizeGuard = guardSteps(stepsOf('desktop-release.yml', 'finalize'))[0];
  const runStep = (step, event, nodeExit = 0) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-shipped-fix-step-')));
    scratch.push(dir);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const argv = join(dir, 'node-argv');
    writeFileSync(
      join(bin, 'node'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argv}"\nexit ${nodeExit}\n`,
      {
        mode: 0o755,
      },
    );
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(bin, 'tar'), '#!/bin/sh\ncat > /dev/null\nexit 0\n', { mode: 0o755 });
    const script = join(dir, 'step.sh');
    writeFileSync(script, step.run);
    const res = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        GITHUB_EVENT_NAME: event,
        GITHUB_SHA: 'f'.repeat(40),
        RUNNER_TEMP: dir,
        RELEASE_TAG: 'v9.9.9',
      },
    });
    let args = [];
    try {
      args = readFileSync(argv, 'utf8').split('\n').filter(Boolean);
    } catch {
      args = [];
    }
    return { status: res.status, stderr: res.stderr, args: args.slice(1) };
  };

  test.each([
    ['prepare', prepareGuard],
    ['finalize', finalizeGuard],
  ])('%s passes the exemption on workflow_dispatch and on no other event', (_job, step) => {
    const checked = ['--candidate', 'refs/tags/v9.9.9', '--label', 'v9.9.9'];
    const dispatched = runStep(step, 'repository_dispatch');
    expect(dispatched.status, dispatched.stderr).toBe(0);
    expect(dispatched.args).toEqual(checked);
    const manual = runStep(step, 'workflow_dispatch');
    expect(manual.status, manual.stderr).toBe(0);
    expect(manual.args).toEqual([...checked, '--allow-published-repair', 'v9.9.9']);
  });

  test.each([
    ['prepare', prepareGuard],
    ['finalize', finalizeGuard],
  ])('%s fails when the guard refuses or cannot decide', (_job, step) => {
    expect(runStep(step, 'repository_dispatch', 2).status).toBe(2);
    expect(runStep(step, 'workflow_dispatch', 1).status).toBe(1);
  });
});

describe('the selector does not dispatch what promote-stable would refuse', () => {
  const steps = stepsOf('select-beta-to-promote.yml', 'evaluate');

  test('the select step knows whether this tick may dispatch, and can list Releases', () => {
    const hours = indexWhere(steps, (step) => step.id === 'hours', 'with id hours');
    const select = indexWhere(steps, (step) => step.id === 'select', 'with id select');
    expect(select).toBeGreaterThan(hours);
    expect(steps[select].run).toBe('node .github/scripts/select-beta-to-promote.mjs');
    expect(steps[select].env).toMatchObject({
      DISPATCH_WINDOW_OPEN: '${{ steps.hours.outputs.open }}',
      GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
    });
  });

  test('both dispatch paths read only the screened outputs', () => {
    const dispatch = steps.find((step) =>
      String(step.run ?? '').includes('gh workflow run promote-stable.yml'),
    );
    expect(dispatch.if).toContain("steps.select.outputs.target != ''");
    expect(dispatch.env.TARGET).toBe('${{ steps.select.outputs.target }}');
    const nominate = steps.find((step) => step.id === 'nominate');
    expect(nominate.env.CANDIDATE).toBe('${{ steps.select.outputs.fast_tier_candidate }}');
  });
});

describe('the bug lane does not hand over a batch a point release would refuse', () => {
  const steps = stepsOf('bug-lane.yml', 'bug-lane');

  test('the evaluator can list Releases and gates the handoff on its fix_refs output', () => {
    const evaluate = steps.find((step) => step.id === 'evaluate');
    expect(evaluate.run).toBe('node .github/scripts/bug-lane.mjs');
    expect(evaluate.env.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
    const handoff = steps.find((step) =>
      String(step.run ?? '').includes('gh workflow run bug-lane-verify.yml'),
    );
    expect(handoff.if).toContain("steps.evaluate.outputs.fix_refs != ''");
  });
});
