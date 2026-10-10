import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const JOB = 'bug-lane-verify';
const CONCLUSION = 'Fail the run on a refusing verdict';
const REFUSAL_PAGE = 'Page on a refusal (armed only)';
const VERDICT_EXPRESSION = /^\$\{\{\s*steps\.verify\.outputs\.verdict\s*\}\}$/;
const INPUT_EXPRESSION = /^\$\{\{\s*inputs\.([a-z_]+)\s*\}\}$/;
const CASE_ARM = /^(\s*)([a-z|-]+)\)\s*$/;

const REQUIRED_EXITS = new Map([
  ['conflict', 1],
  ['fail', 1],
  ['could-not-verify', 1],
  ['pass', 0],
  ['already-in-stable', 0],
  ['', 0],
]);
const REFUSING = [...REQUIRED_EXITS].filter(([, status]) => status === 1).map(([v]) => v);

const workflowSource = readFileSync(
  new URL('../workflows/bug-lane-verify.yml', import.meta.url),
  'utf8',
);

function exitFor(step, variable, verdict, extraEnv = {}) {
  const result = spawnSync('bash', ['-e', '-c', step.run], {
    env: { PATH: process.env.PATH, ...extraEnv, [variable]: verdict },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status;
}

function checkConclusion(workflow) {
  const steps = workflow.jobs?.[JOB]?.steps ?? [];
  const at = steps.findIndex((step) => step.name === CONCLUSION);
  if (at === -1) {
    return { violations: [`${JOB} has no step named "${CONCLUSION}"`], exits: new Map() };
  }
  const step = steps[at];
  const violations = [];
  if (at !== steps.length - 1) {
    violations.push(`"${CONCLUSION}" is step ${at + 1} of ${steps.length}, not the last`);
  }
  if (step.if !== 'always()') {
    violations.push(`"${CONCLUSION}" runs under if: ${JSON.stringify(step.if)}, not always()`);
  }
  const variables = Object.entries(step.env ?? {})
    .filter(([, value]) => VERDICT_EXPRESSION.test(String(value)))
    .map(([name]) => name);
  if (variables.length !== 1) {
    violations.push(
      `"${CONCLUSION}" reads the verdict through ${variables.length} env variables, not exactly one`,
    );
    return { violations, exits: new Map() };
  }
  const exits = new Map();
  for (const [verdict, required] of REQUIRED_EXITS) {
    const status = exitFor(step, variables[0], verdict);
    exits.set(verdict, status);
    if (status !== required) {
      violations.push(`verdict "${verdict}" exits ${status}, not ${required}`);
    }
  }
  return { violations, exits };
}

function rewriteRefusingArm(run, rewrite) {
  const lines = run.split('\n');
  const arm = lines.findIndex((line) => CASE_ARM.test(line));
  if (arm === -1) throw new Error(`"${CONCLUSION}" has no case arm listing verdicts`);
  const [, indent, pattern] = CASE_ARM.exec(lines[arm]);
  lines[arm] = `${indent}${rewrite(pattern.split('|')).join('|')})`;
  return lines.join('\n');
}

function moveAboveRefusalPage(steps, at) {
  const [step] = steps.splice(at, 1);
  const page = steps.findIndex((candidate) => candidate.name === REFUSAL_PAGE);
  if (page === -1) throw new Error(`${JOB} has no step named "${REFUSAL_PAGE}"`);
  steps.splice(page, 0, step);
}

const MUTATIONS = [
  ['the step is deleted', (steps, at) => steps.splice(at, 1), 'has no step named'],
  ['the step runs above the refusal page', moveAboveRefusalPage, 'not the last'],
  [
    'the step loses its always() condition',
    (steps, at) => {
      delete steps[at].if;
    },
    'not always()',
  ],
  [
    'the step stops reading the verdict through env',
    (steps, at) => {
      delete steps[at].env;
    },
    'through 0 env variables',
  ],
  ...REFUSING.map((verdict) => [
    `"${verdict}" is dropped from the refusing case`,
    (steps, at) => {
      steps[at].run = rewriteRefusingArm(steps[at].run, (arm) => arm.filter((v) => v !== verdict));
    },
    `verdict "${verdict}" exits 0, not 1`,
  ]),
  [
    '"pass" joins the refusing case',
    (steps, at) => {
      steps[at].run = rewriteRefusingArm(steps[at].run, (arm) => [...arm, 'pass']);
    },
    'verdict "pass" exits 1, not 0',
  ],
];

describe('bug-lane-verify concludes from the verdict its verify step mints', () => {
  test('a refusing verdict fails the run from its last step, and every other verdict leaves it green', () => {
    const { violations, exits } = checkConclusion(parse(workflowSource));
    expect(violations).toEqual([]);
    expect(exits.size).toBe(6);
    expect(exits).toEqual(REQUIRED_EXITS);
  });

  test('the conclusion checks read no shell startup file of the developer running them', () => {
    const home = mkdtempSync(join(scratch, 'home-'));
    writeFileSync(join(home, '.bashrc'), ': > "$HOME/startup-read"\n');
    const step = parse(workflowSource).jobs[JOB].steps.find(
      (candidate) => candidate.name === CONCLUSION,
    );
    const [variable] = Object.entries(step.env).find(([, value]) =>
      VERDICT_EXPRESSION.test(String(value)),
    );
    const exits = new Map(
      [...REQUIRED_EXITS.keys()].map((verdict) => [
        verdict,
        exitFor(step, variable, verdict, { HOME: home }),
      ]),
    );
    expect(exits).toEqual(REQUIRED_EXITS);
    expect(readdirSync(home)).toEqual(['.bashrc']);
  });

  test('the planted mutations cover every rule and each of the three refusing verdicts', () => {
    expect(REFUSING).toEqual(['conflict', 'fail', 'could-not-verify']);
    expect(MUTATIONS).toHaveLength(8);
  });

  test.each(MUTATIONS)(
    'the check reports exactly one violation when %s',
    (_label, mutate, expected) => {
      const workflow = parse(workflowSource);
      const steps = workflow.jobs[JOB].steps;
      const at = steps.findIndex((step) => step.name === CONCLUSION);
      expect(at).toBeGreaterThan(-1);
      const before = JSON.stringify(workflow);
      mutate(steps, at);
      expect(JSON.stringify(workflow)).not.toBe(before);
      const { violations } = checkConclusion(workflow);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(expected);
    },
  );
});

const scratch = mkdtempSync(join(tmpdir(), 'bug-lane-verify-step-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const GIT_ENV = {
  HOME: scratch,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'maintenance.auto',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'user.name',
  GIT_CONFIG_VALUE_1: 'fixture',
  GIT_CONFIG_KEY_2: 'user.email',
  GIT_CONFIG_VALUE_2: 'fixture@example.invalid',
};

const STUBS = {
  timeout: [
    '#!/bin/sh',
    'while case "$1" in -*) true ;; *) false ;; esac; do shift; done',
    'shift',
    'exec "$@"',
  ],
  pnpm: [
    '#!/bin/sh',
    '[ "$1" = install ] && exit "$PNPM_INSTALL_STATUS"',
    'echo "$*" >> "$PNPM_TIER_CALLS"',
    'set -- $PNPM_TIER_STATUSES',
    'shift "$(($(wc -l < "$PNPM_TIER_CALLS") - 1))"',
    'exit "$1"',
  ],
  rustup: ['#!/bin/sh', 'exit "$RUSTUP_INSTALL_STATUS"'],
  rustc: ['#!/bin/sh', 'exit 0'],
};

function git(cwd, ...args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...GIT_ENV },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function commit(repo, path, text) {
  writeFileSync(join(repo, path), text);
  git(repo, 'add', path);
  git(repo, 'commit', '-q', '-m', path);
  return git(repo, 'rev-parse', 'HEAD');
}

function stableWithCandidates(repo) {
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const base = commit(repo, 'shared.txt', 'base\n');
  const candidates = {
    conflict: commit(repo, 'shared.txt', 'main\n'),
    clean: commit(repo, 'clean.txt', 'clean\n'),
    contained: commit(repo, 'contained.txt', 'contained\n'),
  };
  git(repo, 'checkout', '-q', '--detach', base);
  commit(repo, 'shared.txt', 'stable\n');
  commit(repo, 'contained.txt', 'contained\n');
  git(repo, 'tag', 'stable');
  return candidates;
}

function runVerify({ refs, install = 0, toolchain = 0, tiers = [] }) {
  const steps = parse(workflowSource).jobs?.[JOB]?.steps ?? [];
  const step = steps.find((candidate) => candidate.id === 'verify');
  if (!step) throw new Error(`${JOB} has no step with id verify`);
  const dir = mkdtempSync(join(scratch, 'scenario-'));
  const repo = join(dir, 'repo');
  const candidates = stableWithCandidates(repo);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const [name, lines] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `${lines.join('\n')}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const output = join(dir, 'github-output');
  writeFileSync(output, '');
  const inputs = { fix_refs: refs.map((ref) => candidates[ref]).join(','), stable: 'stable' };
  const stepEnv = Object.entries(step.env ?? {}).flatMap(([name, value]) => {
    const input = INPUT_EXPRESSION.exec(String(value))?.[1];
    return input !== undefined && Object.hasOwn(inputs, input) ? [[name, inputs[input]]] : [];
  });
  const result = spawnSync('bash', ['-e', '-c', step.run], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...GIT_ENV,
      ...Object.fromEntries(stepEnv),
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: join(dir, 'step-summary'),
      PNPM_INSTALL_STATUS: String(install),
      RUSTUP_INSTALL_STATUS: String(toolchain),
      PNPM_TIER_STATUSES: tiers.join(' '),
      PNPM_TIER_CALLS: join(dir, 'tier-calls'),
    },
  });
  const verdicts = readFileSync(output, 'utf8')
    .split('\n')
    .flatMap((line) => /^verdict=(.*)$/.exec(line)?.slice(1) ?? []);
  return { status: result.status, verdicts, log: `${result.stdout}${result.stderr}` };
}

const VERIFY_SCENARIOS = [
  ['conflict', 'a batch whose only fix conflicts with the stable', { refs: ['conflict'] }],
  ['already-in-stable', 'a batch the stable already contains', { refs: ['contained'] }],
  ['fail', 'a clean batch whose install fails', { refs: ['clean'], install: 1 }],
  [
    'could-not-verify',
    'a clean batch whose declared Rust toolchain cannot be installed',
    { refs: ['clean'], toolchain: 1 },
  ],
  ['fail', 'a clean batch whose tiers fail twice', { refs: ['clean'], tiers: [1, 1] }],
  [
    'could-not-verify',
    'a clean batch whose tiers run out of budget',
    { refs: ['clean'], tiers: [124] },
  ],
  ['pass', 'a clean batch whose tiers pass', { refs: ['clean'], tiers: [0] }],
  ['pass', 'a clean batch whose tiers pass on the retry', { refs: ['clean'], tiers: [1, 0] }],
];

describe('the verify step succeeds on every verdict it mints, so the steps gated on that verdict can run', () => {
  test.each(VERIFY_SCENARIOS)('mints %s and exits 0 for %s', (verdict, _label, scenario) => {
    const { status, verdicts, log } = runVerify(scenario);
    expect({ status, verdicts }, log).toEqual({ status: 0, verdicts: [verdict] });
  });
});
