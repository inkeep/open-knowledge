// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell and GitHub expression fixtures must remain literal.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { gitCleanEnv } from '../../scripts/git-clean-env.mjs';
import { configureTestGitRepository } from '../../test-support/configure-git-fixture.test-helper.ts';
import { expectNoAutomaticGitMaintenance } from './git-fixture-maintenance.test-helper.mjs';
import { RELEASE_HOLD_SENTINEL } from './release-hold.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const OK_ROOT = join(SCRIPTS, '..', '..');
const GUARD = '.github/scripts/release-hold.mjs';
const PUBLISHES = /gh release (create|edit|upload) |--draft=false|\/dispatches|npm publish |git tag "|push origin "/;
const workflow = (name) => parse(readFileSync(join(OK_ROOT, '.github', 'workflows', name), 'utf8'));
const stepsOf = (file, job) => {
  const steps = workflow(file).jobs?.[job]?.steps;
  if (!Array.isArray(steps) || steps.length < 3) throw new Error(`${file} job ${job} has no step list to inspect`);
  return steps;
};
const holdSteps = (steps) => steps.filter((step) => String(step.run ?? '').includes('release-hold.mjs'));
const onlyHoldStep = (steps) => {
  const found = holdSteps(steps);
  expect(found).toHaveLength(1);
  expect(found[0]['continue-on-error']).toBeUndefined();
  return found[0];
};
const indexWhere = (steps, predicate, what) => {
  const index = steps.findIndex(predicate);
  if (index === -1) throw new Error(`no step ${what}`);
  return index;
};
const publishingJobs = (file) =>
  Object.entries(workflow(file).jobs)
    .filter(([, job]) => (job.steps ?? []).some((step) => PUBLISHES.test(String(step.run ?? ''))))
    .map(([name]) => name)
    .sort();
const archivedModules = (run) => /git archive "\$GITHUB_SHA" ([^|]+)\|/.exec(run)[1].trim().split(/\s+/);
const importClosure = (entry) => {
  const pending = [entry];
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
  return [...needed].sort();
};

const scratch = [];
afterAll(() => {
  while (scratch.length > 0) rmSync(scratch.pop(), { recursive: true, force: true });
});

function mirrorFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-release-hold-mirror-')));
  scratch.push(root);
  const env = gitCleanEnv();
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const commit = (message, files) => {
    for (const [path, content] of Object.entries(files)) write(path, content);
    git('add', '-A');
    git('commit', '--quiet', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '--quiet', '--initial-branch=main');
  env.GIT_TRACE2_EVENT = join(root, '.git', 'fixture-maintenance.jsonl');
  configureTestGitRepository(root, (args) => git(...args));
  commit('chore: the shipped change (#100)', { 'README.md': 'stable\n' });
  git('tag', 'v1.0.0');
  commit('ci: add the release hold guard (#150)', Object.fromEntries(importClosure(GUARD).map((file) => [file, readFileSync(join(OK_ROOT, file))])));
  git('tag', 'v1.0.1-beta.0');
  commit('feat: boot only the converged host (#200)', { [RELEASE_HOLD_SENTINEL]: 'held\n' });
  git('tag', 'v1.1.0-beta.0');
  git('tag', 'v1.1.0');
  const postFlipFix = commit('fix: a post-flip fix (#201)', { 'post-flip-fix.txt': 'fixed\n' });
  git('switch', '--quiet', '--detach', 'v1.0.0');
  git('cherry-pick', postFlipFix);
  git('tag', 'v1.0.1');
  git('switch', '--quiet', 'main');
  return { root, git, env, workflowSha: git('rev-parse', 'HEAD') };
}

function runStep(step, { cwd, env }) {
  const runnerTemp = realpathSync(mkdtempSync(join(tmpdir(), 'ok-release-hold-runner-')));
  scratch.push(runnerTemp);
  const script = join(runnerTemp, 'step.sh');
  writeFileSync(script, step.run);
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    cwd,
    encoding: 'utf8',
    env: { ...gitCleanEnv(), RUNNER_TEMP: runnerTemp, ...env },
  });
}

describe('promote-stable refuses a held beta before it tags', () => {
  const steps = stepsOf('promote-stable.yml', 'promote');
  const hold = onlyHoldStep(steps);

  test('it reads the beta commit promote-stable would tag, and reports main', () => {
    expect(hold.run).toBe(
      'node .github/scripts/release-hold.mjs --candidate "$BETA_SHA" --label "${STABLE_TAG} from ${BETA_TAG}" --main HEAD',
    );
    expect(hold.env).toEqual({
      BETA_TAG: '${{ steps.resolve.outputs.beta_tag }}',
      BETA_SHA: '${{ steps.ver.outputs.beta_sha }}',
      STABLE_TAG: '${{ steps.ver.outputs.stable_tag }}',
    });
  });

  test('it runs whenever the promotion would tag, and every tag and publish step comes after it', () => {
    const compute = indexWhere(steps, (step) => step.id === 'ver', 'with id ver');
    const tag = indexWhere(steps, (step) => step.name === 'Tag stable at beta SHA', 'that tags');
    expect(steps.indexOf(hold)).toBeGreaterThan(compute);
    expect(hold.if).toBe(steps[tag].if);
    const publishing = steps.filter((step) => PUBLISHES.test(String(step.run ?? '')));
    expect(publishing.length).toBeGreaterThanOrEqual(3);
    for (const step of publishing) expect(steps.indexOf(step)).toBeGreaterThan(steps.indexOf(hold));
    expect(publishingJobs('promote-stable.yml')).toEqual(['promote']);
  });
});

describe('desktop-release refuses a held stable tag in prepare and again in finalize', () => {
  const release = workflow('desktop-release.yml');
  const prepare = stepsOf('desktop-release.yml', 'prepare');
  const finalize = stepsOf('desktop-release.yml', 'finalize');
  const prepareHold = onlyHoldStep(prepare);
  const finalizeHold = onlyHoldStep(finalize);

  test('prepare checks the stable channel only, against the release tag, after the channel is known', () => {
    expect(prepareHold.if).toBe("steps.channel.outputs.channel == 'latest'");
    expect(prepareHold.env.RELEASE_TAG).toBe('${{ github.event.client_payload.release_tag || inputs.release_tag }}');
    expect(prepareHold.run).toContain('--candidate "refs/tags/${RELEASE_TAG}"');
    expect(prepare.indexOf(prepareHold)).toBeGreaterThan(indexWhere(prepare, (step) => step.id === 'channel', 'with id channel'));
  });

  test('prepare loads the guard from the workflow revision, with every module it imports', () => {
    expect(prepareHold.run).toMatch(/git archive "\$GITHUB_SHA" [^\n]*\.github\/scripts\/release-hold\.mjs/);
    expect(prepareHold.run).toMatch(/node "\$hold\/\.github\/scripts\/release-hold\.mjs"/);
    expect(archivedModules(prepareHold.run).sort()).toEqual(importClosure(GUARD));
  });

  test('finalize checks again, from the workflow revision with every tag, before it publishes anything', () => {
    expect(finalizeHold.if).toBe("success() && needs.prepare.outputs.channel == 'latest'");
    expect(finalizeHold.run).toBe('node .github/scripts/release-hold.mjs --candidate "refs/tags/${RELEASE_TAG}" --label "$RELEASE_TAG"');
    expect(release.jobs.finalize.env.RELEASE_TAG).toBe('${{ github.event.client_payload.release_tag || inputs.release_tag }}');
    const [checkout] = finalize.filter((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout.with?.['fetch-depth']).toBe(0);
    expect(checkout.with?.ref).toBeUndefined();
    expect(finalize.indexOf(checkout)).toBeLessThan(finalize.indexOf(finalizeHold));
    const shipping = finalize.filter((step) => /--draft=false|\/dispatches|curl /.test(String(step.run ?? '')));
    expect(shipping.length).toBeGreaterThanOrEqual(4);
    for (const step of shipping) expect(finalize.indexOf(step)).toBeGreaterThan(finalize.indexOf(finalizeHold));
  });

  test('every job that uploads, publishes or dispatches runs only after prepare succeeded', () => {
    expect(publishingJobs('desktop-release.yml')).toEqual(['finalize', 'publish-assets', 'release-consumers']);
    expect(release.jobs['publish-assets'].needs).toContain('prepare');
    expect(release.jobs['publish-assets'].if).toContain("needs.prepare.result == 'success'");
    expect(release.jobs.finalize.needs).toEqual(expect.arrayContaining(['prepare', 'publish-assets']));
    expect(release.jobs.finalize.if).toContain("needs.publish-assets.result == 'success'");
    expect(release.jobs['release-consumers'].needs).toBe('finalize');
    expect(release.jobs['release-consumers'].if).toContain("needs.finalize.outputs.published == 'true'");
  });
});

describe('release.yml refuses to publish a held stable to npm', () => {
  const release = workflow('release.yml');
  const build = stepsOf('release.yml', 'build');
  const hold = onlyHoldStep(build);

  test('the build job checks the stable tag it checked out, on the publish-stable path only', () => {
    expect(hold.if).toBe("github.event.action == 'publish-stable'");
    expect(hold.run).toContain('--candidate HEAD');
    const [checkout] = build.filter((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout.with.ref).toMatch(/^\$\{\{ github\.event\.client_payload\.ref \|\| /);
    expect(build.indexOf(checkout)).toBeLessThan(build.indexOf(hold));
    expect(archivedModules(hold.run).sort()).toEqual(importClosure(GUARD));
  });

  test('tagging and npm publication need the build job, with no condition that outlives its failure', () => {
    expect(publishingJobs('release.yml')).toEqual(['publish', 'release']);
    for (const name of ['release', 'publish']) {
      expect(release.jobs[name].needs).toContain('build');
      expect(release.jobs[name].if).not.toMatch(/always\(\)|cancelled\(\)|failure\(\)/);
    }
  });
});

describe('the selector, the point release and the bug lane run the guard inside their scripts', () => {
  test('the selector step and the planner step are the scripts that hold the guard', () => {
    const select = stepsOf('select-beta-to-promote.yml', 'evaluate').find((step) => step.id === 'select');
    expect(select.run).toBe('node .github/scripts/select-beta-to-promote.mjs');
    const plan = stepsOf('point-release.yml', 'point-release').find((step) => step.id === 'plan');
    expect(plan.run).toBe('node .github/scripts/point-release-plan.mjs');
    expect(publishingJobs('select-beta-to-promote.yml')).toEqual([]);
    expect(publishingJobs('point-release.yml')).toEqual([]);
  });

  test("the bug lane's evaluator checks out full history, so every pick's first parent is present", () => {
    const steps = stepsOf('bug-lane.yml', 'bug-lane');
    const evaluate = steps.find((step) => step.id === 'evaluate');
    expect(evaluate.run).toBe('node .github/scripts/bug-lane.mjs');
    const checkouts = steps.filter((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0].with?.['fetch-depth']).toBe(0);
    expect(steps.indexOf(checkouts[0])).toBeLessThan(steps.indexOf(evaluate));
    const handoff = steps.find((step) => String(step.run ?? '').includes('gh workflow run bug-lane-verify.yml'));
    expect(handoff.if).toContain("steps.evaluate.outputs.fix_refs != ''");
  });
});

describe('each workflow step runs the guard against a repository laid out like inkeep/open-knowledge', () => {
  const fixture = mirrorFixture();
  const promoteHold = onlyHoldStep(stepsOf('promote-stable.yml', 'promote'));
  const prepareHold = onlyHoldStep(stepsOf('desktop-release.yml', 'prepare'));
  const finalizeHold = onlyHoldStep(stepsOf('desktop-release.yml', 'finalize'));
  const publishHold = onlyHoldStep(stepsOf('release.yml', 'build'));
  const at = (ref) => fixture.git('rev-parse', `${ref}^{commit}`);
  const checkout = (ref) => fixture.git('switch', '--quiet', '--detach', ref);

  test('fixture Git operations do not launch automatic maintenance', () => {
    expect(() => expectNoAutomaticGitMaintenance(fixture.root, fixture.env)).not.toThrow();
  });

  test('promote-stable admits a beta without the sentinel and refuses one that carries it', () => {
    checkout('main');
    const env = { BETA_TAG: 'v1.0.1-beta.0', BETA_SHA: at('v1.0.1-beta.0'), STABLE_TAG: 'v1.0.1' };
    const admitted = runStep(promoteHold, { cwd: fixture.root, env });
    expect(admitted.status, admitted.stdout + admitted.stderr).toBe(0);
    expect(admitted.stdout).toContain(`v1.0.1 from v1.0.1-beta.0 (${env.BETA_SHA.slice(0, 12)}) does not carry ${RELEASE_HOLD_SENTINEL}`);
    expect(admitted.stdout).toContain(`::notice::Release hold in force: HEAD carries ${RELEASE_HOLD_SENTINEL}`);
    const held = runStep(promoteHold, {
      cwd: fixture.root,
      env: { BETA_TAG: 'v1.1.0-beta.0', BETA_SHA: at('v1.1.0-beta.0'), STABLE_TAG: 'v1.1.0' },
    });
    expect(held.status).toBe(2);
    expect(held.stdout).toContain('::error::v1.1.0 from v1.1.0-beta.0');
  });

  test('a sentinel-carrying beta tag is not a stable to desktop-release, so it still builds as a beta', () => {
    const channel = stepsOf('desktop-release.yml', 'prepare').find((step) => step.id === 'channel');
    const output = join(fixture.root, '.git', 'channel-output');
    writeFileSync(output, '');
    const res = runStep(channel, { cwd: fixture.root, env: { RELEASE_TAG: 'v1.1.0-beta.0', GITHUB_OUTPUT: output } });
    expect(res.status, res.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain('channel=beta\n');
    expect(prepareHold.if).toBe("steps.channel.outputs.channel == 'latest'");
  });

  test.each([
    ['the pre-flip stable', 'v1.0.0', 0],
    ['a hotfix stable over it carrying a post-flip fix', 'v1.0.1', 0],
    ['a stable tagged on the flip', 'v1.1.0', 2],
  ])('prepare, from a checkout of the tag, and finalize, from the workflow revision: %s', (_what, tag, status) => {
    checkout(tag);
    const prepared = runStep(prepareHold, { cwd: fixture.root, env: { RELEASE_TAG: tag, GITHUB_SHA: fixture.workflowSha } });
    expect(prepared.status, prepared.stdout + prepared.stderr).toBe(status);
    checkout('main');
    const finalized = runStep(finalizeHold, { cwd: fixture.root, env: { RELEASE_TAG: tag } });
    expect(finalized.status, finalized.stdout + finalized.stderr).toBe(status);
    for (const res of [prepared, finalized]) {
      expect(res.stdout).toContain(status === 0 ? 'so the release hold does not apply.' : `::error::${tag} (`);
    }
  });

  test.each([
    ['v1.0.0', 0],
    ['v1.0.1', 0],
    ['v1.1.0', 2],
  ])('the npm publish-stable build of %s, from a checkout of the tag', (tag, status) => {
    checkout(tag);
    const res = runStep(publishHold, { cwd: fixture.root, env: { STABLE_REF: tag, GITHUB_SHA: fixture.workflowSha } });
    expect(res.status, res.stdout + res.stderr).toBe(status);
    expect(res.stdout).toContain(status === 0 ? `${tag} (${at(tag).slice(0, 12)}) does not carry` : `::error::${tag} (`);
    checkout('main');
  });
});
