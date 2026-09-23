import { spawn } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { okVitestBase } from '../../../test-support/vitest.base.ts';
import { BUNDLE_IDS, BUNDLE_SKILL_NAME } from '../src/skill-bundles.ts';
import {
  __testing,
  buildAgentPluginArtifact,
  buildPackSkills,
  buildSkillBundles,
  defaultPaths,
  type SkillBundlePaths,
} from './build-skill-bundles.ts';

const { keepDisplacedTree, peerPublished, sweepRuns } = __testing;

const PUBLISH_CYCLES = 6;
const CONCURRENT_WRITERS = 4;
const SUITE_TEST_TIMEOUT_MS = okVitestBase.test.testTimeout;
const HANG_GUARD_MS = SUITE_TEST_TIMEOUT_MS - 5_000;
const WRITER_BARRIER_BOUND_MS = HANG_GUARD_MS;
const WRITER_PUBLISH_ROUNDS = 3;
const COMPOSER_PATH = fileURLToPath(new URL('./build-skill-bundles.ts', import.meta.url));
const STAGING_ROOT_PREFIX = '.ok-skill-publish-';
const STALE_STAGING_MTIME = new Date('2001-01-01T00:00:00Z');
const PERMISSION_BITS_UNENFORCED = process.platform === 'win32' || process.getuid?.() === 0;

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) {
    const path = cleanup.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

const OBSERVER_STATES = ['ROOT_ABSENT', 'STRADDLE', 'WALK_ERROR', 'COMPLETE', 'PARTIAL'] as const;
type ObserverState = (typeof OBSERVER_STATES)[number];

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (prefix: string): void => {
    for (const entry of readdirSync(prefix === '' ? root : join(root, prefix), {
      withFileTypes: true,
    })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk('');
  return out.sort();
}

function listFilesIfPresent(root: string): string[] {
  return existsSync(root) ? listFiles(root) : [];
}

function composedSkillsTreeExpectedFiles(sourceSkills: string): string[] {
  const packsDir = join(sourceSkills, 'packs');
  return [
    ...BUNDLE_IDS.flatMap((bundle) =>
      listFiles(join(sourceSkills, bundle)).map((file) => `${bundle}/${file}`),
    ),
    ...readdirSync(packsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) =>
        listFiles(join(packsDir, entry.name)).map((file) => `packs/${entry.name}/${file}`),
      ),
  ].sort();
}

function agentPluginExpectedFiles(sourceSkills: string): string[] {
  return [
    ...BUNDLE_IDS.flatMap((bundle) =>
      listFiles(join(sourceSkills, bundle)).map(
        (file) => `skills/${BUNDLE_SKILL_NAME[bundle]}/${file}`,
      ),
    ),
    'plugin.json',
  ].sort();
}

interface ObserverWitness {
  readonly state: ObserverState;
  readonly expectedFiles: number;
  readonly observedFiles: number | null;
  readonly missingCount: number | null;
  readonly missingSample: string[];
}

interface ObserverTarget {
  readonly label: string;
  readonly hist: Partial<Record<ObserverState, number>>;
  readonly witness: ObserverWitness | null;
}

interface ObserverResult {
  readonly exitReason: string;
  readonly targets: ObserverTarget[];
}

function parseObserverResult(raw: string): ObserverResult {
  const parsed = JSON.parse(raw) as ObserverResult;
  const known = new Set<string>(OBSERVER_STATES);
  for (const target of parsed.targets) {
    for (const state of Object.keys(target.hist)) {
      if (!known.has(state)) {
        throw new Error(
          `observer reported state '${state}' for ${target.label}, which is not one of ${[...known].join(', ')}`,
        );
      }
    }
  }
  return parsed;
}

const OBSERVER_SOURCE = `
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
const STATE = ${JSON.stringify(Object.fromEntries(OBSERVER_STATES.map((state) => [state, state])))};

function walk(root, prefix, out) {
  const dir = prefix === '' ? root : join(root, prefix);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : prefix + '/' + entry.name;
    if (entry.isDirectory()) walk(root, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
}

const targets = spec.targets.map((t) => ({
  label: t.label,
  path: t.path,
  expect: t.expect,
  hist: {},
  witness: null,
}));

function classify(target) {
  let before;
  try {
    before = statSync(target.path).ino;
  } catch {
    return { state: STATE.ROOT_ABSENT };
  }
  const found = [];
  let torn = false;
  try {
    walk(target.path, '', found);
  } catch {
    torn = true;
  }
  let after = -1;
  try {
    after = statSync(target.path).ino;
  } catch {
    after = -1;
  }
  if (after !== before) return { state: STATE.STRADDLE };
  if (torn) return { state: STATE.WALK_ERROR };
  const seen = new Set(found);
  const missing = target.expect.filter((f) => !seen.has(f));
  if (missing.length === 0) return { state: STATE.COMPLETE };
  return { state: STATE.PARTIAL, missing, observedFiles: found.length };
}

function sweep() {
  for (const target of targets) {
    const result = classify(target);
    target.hist[result.state] = (target.hist[result.state] || 0) + 1;
    if (
      target.witness === null &&
      (result.state === STATE.PARTIAL || result.state === STATE.WALK_ERROR)
    ) {
      target.witness = {
        state: result.state,
        expectedFiles: target.expect.length,
        observedFiles: result.observedFiles ?? null,
        missingCount: result.missing ? result.missing.length : null,
        missingSample: result.missing ? result.missing.slice(0, 8) : [],
      };
    }
  }
}

sweep();
for (const target of targets) {
  target.hist = {};
  target.witness = null;
}
process.stdout.write('ready\\n');

let exitReason = 'liveness-bound';
const bound = Date.now() + spec.livenessBoundMs;
while (Date.now() < bound) {
  sweep();
  if (existsSync(spec.sentinelPath)) {
    exitReason = 'sentinel';
    break;
  }
}

writeFileSync(
  spec.resultPath,
  JSON.stringify({
    exitReason,
    targets: targets.map((t) => ({ label: t.label, hist: t.hist, witness: t.witness })),
  }),
  'utf-8',
);
`;

const WRITER_SOURCE = `
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
const composer = await import(pathToFileURL(spec.composerPath).href);
const paths = { skillsDir: spec.skillsDir, distDir: spec.distDir };

process.stdout.write('armed\\n');
const barrierBound = Date.now() + spec.barrierBoundMs;
while (!existsSync(spec.startPath) && Date.now() < barrierBound) {
  await new Promise((resolve) => setTimeout(resolve, 1));
}

for (let round = 0; round < spec.rounds; round += 1) {
  composer.buildSkillBundles(paths);
  composer.buildPackSkills(paths);
  composer.buildAgentPluginArtifact(paths);
}
process.stdout.write('composed\\n');
`;

type WriterOutcome =
  | { readonly writer: number; readonly outcome: 'composed' }
  | { readonly writer: number; readonly outcome: 'hang-guard' }
  | {
      readonly writer: number;
      readonly outcome: 'failed';
      readonly exitCode: number | null;
      readonly stderr: string;
    };

type DestinationState = 'absent' | 'empty' | 'occupied';

function plantStagingTree(root: string): string {
  mkdirSync(join(root, 'project'), { recursive: true });
  writeFileSync(join(root, 'project', 'SKILL.md'), 'scratch from an earlier run', 'utf-8');
  return root;
}

function backdate(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) backdate(child);
    else utimesSync(child, STALE_STAGING_MTIME, STALE_STAGING_MTIME);
  }
  utimesSync(path, STALE_STAGING_MTIME, STALE_STAGING_MTIME);
}

function captureConsole(channel: 'warn' | 'error', run: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(console, channel).mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

function errnoFailure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`rename failed with ${code}`), { code });
}

function makeDestination(root: string, state: DestinationState): string {
  const dest = join(root, `destination-${state}`);
  if (state === 'absent') return dest;
  mkdirSync(dest, { recursive: true });
  if (state === 'occupied') writeFileSync(join(dest, 'SKILL.md'), 'a peer published me', 'utf-8');
  return dest;
}

describe('the lost-publish-race arbiter', () => {
  test.each([
    {
      arm: 'a destination-occupied errno is a peer publish even once the destination is gone again',
      state: 'absent',
      failure: errnoFailure('ENOTEMPTY'),
      expected: true,
    },
    {
      arm: 'an occupied destination is a peer publish when the errno does not say so, the only arm Windows rename leaves',
      state: 'occupied',
      failure: errnoFailure('EPERM'),
      expected: true,
    },
    {
      arm: 'an absent destination under a non-occupancy errno is this run failing, not a peer publishing',
      state: 'absent',
      failure: errnoFailure('EPERM'),
      expected: false,
    },
    {
      arm: 'an empty destination under a non-occupancy errno is not a peer publish, since rename would have taken it',
      state: 'empty',
      failure: errnoFailure('EPERM'),
      expected: false,
    },
    {
      arm: 'a thrown value carrying no code still answers from the destination it can observe',
      state: 'occupied',
      failure: null,
      expected: true,
    },
    {
      arm: 'a thrown value carrying no code answers false when nothing occupies the destination',
      state: 'absent',
      failure: undefined,
      expected: false,
    },
  ] as ReadonlyArray<{
    arm: string;
    state: DestinationState;
    failure: unknown;
    expected: boolean;
  }>)('$arm', ({ state, failure, expected }) => {
    const root = mkdtempSync(join(tmpdir(), 'ok-skill-peer-arbiter-'));
    cleanup.push(root);

    expect(peerPublished(makeDestination(root, state), failure)).toBe(expected);
  });

  test('the error this platform really raises for an occupied destination is read as a peer publish', () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-skill-peer-arbiter-real-'));
    cleanup.push(root);
    const staged = join(root, 'staged');
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, 'SKILL.md'), 'this run', 'utf-8');
    const dest = makeDestination(root, 'occupied');

    let failure: unknown;
    try {
      renameSync(staged, dest);
    } catch (err) {
      failure = err;
    }

    expect(
      failure,
      'renaming onto an occupied destination has to fail, or the lost race this arbiter decides never arises',
    ).toBeDefined();
    expect(peerPublished(dest, failure)).toBe(true);
  });
});

describe('skill-bundle publish atomicity', () => {
  test(
    'no concurrent reader observes a published bundle directory incomplete',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'ok-skill-atomic-publish-'));
      cleanup.push(root);
      const sourceSkills = defaultPaths().skillsDir;
      const paths: SkillBundlePaths = {
        skillsDir: sourceSkills,
        distDir: join(root, 'dist', 'assets', 'skills'),
      };

      const packTargets = readdirSync(join(sourceSkills, 'packs'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          files: listFiles(join(sourceSkills, 'packs', entry.name)),
        }))
        .sort((a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name))
        .slice(0, 1)
        .map((pack) => ({
          label: `dist/assets/skills/packs/${pack.name}`,
          path: join(paths.distDir, 'packs', pack.name),
          expect: pack.files,
        }));

      const targets = [
        {
          label: 'dist/assets/skills/project',
          path: join(paths.distDir, 'project'),
          expect: listFiles(join(sourceSkills, 'project')),
        },
        ...packTargets,
        {
          label: 'dist/assets/agent-plugin',
          path: join(paths.distDir, '..', 'agent-plugin'),
          expect: agentPluginExpectedFiles(sourceSkills),
        },
      ];

      buildSkillBundles(paths);
      buildPackSkills(paths);
      buildAgentPluginArtifact(paths);

      const observerPath = join(root, 'observer.mjs');
      const specPath = join(root, 'observer-spec.json');
      const sentinelPath = join(root, 'writer-finished');
      const resultPath = join(root, 'observer-result.json');
      writeFileSync(observerPath, OBSERVER_SOURCE, 'utf-8');
      writeFileSync(
        specPath,
        JSON.stringify({
          targets,
          sentinelPath,
          resultPath,
          livenessBoundMs: HANG_GUARD_MS,
        }),
        'utf-8',
      );

      const observer = spawn(process.execPath, [observerPath, specPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let observerStderr = '';
      observer.stderr.setEncoding('utf-8');
      observer.stderr.on('data', (chunk: string) => {
        observerStderr += chunk;
      });
      const exited = new Promise<void>((resolve) => {
        observer.on('exit', () => resolve());
      });

      try {
        await new Promise<void>((resolve, reject) => {
          let stdout = '';
          observer.stdout.setEncoding('utf-8');
          observer.stdout.on('data', (chunk: string) => {
            stdout += chunk;
            if (stdout.includes('ready')) resolve();
          });
          observer.on('error', reject);
          observer.on('exit', () => {
            reject(new Error(`observer exited before signalling ready: ${observerStderr}`));
          });
        });

        for (let cycle = 0; cycle < PUBLISH_CYCLES; cycle += 1) {
          buildSkillBundles(paths);
          buildPackSkills(paths);
          buildAgentPluginArtifact(paths);
        }
        writeFileSync(sentinelPath, '', 'utf-8');
        await exited;
      } finally {
        if (observer.exitCode === null && observer.signalCode === null) observer.kill();
      }

      expect(existsSync(resultPath), `observer wrote no result. stderr: ${observerStderr}`).toBe(
        true,
      );
      const result = parseObserverResult(readFileSync(resultPath, 'utf-8'));

      expect(
        result.exitReason,
        'the observer must still be sampling when the publisher finishes, or it proves nothing',
      ).toBe('sentinel');

      expect(
        result.targets
          .filter((target) => (target.hist.COMPLETE ?? 0) > 0)
          .map((target) => target.label),
      ).toEqual(targets.map((target) => target.label));

      const violations = result.targets
        .filter((target) => (target.hist.PARTIAL ?? 0) > 0 || (target.hist.WALK_ERROR ?? 0) > 0)
        .map((target) => ({
          label: target.label,
          partialSamples: target.hist.PARTIAL ?? 0,
          walkErrorSamples: target.hist.WALK_ERROR ?? 0,
          firstWitness: target.witness,
        }));
      expect(
        violations,
        'PARTIAL and WALK_ERROR are the violations. ROOT_ABSENT (the rename window, in which the destination does not exist at all) and STRADDLE (a publish landed mid-walk) are measured and deliberately tolerated: a reader in either window sees no tree rather than a half-populated one.',
      ).toEqual([]);

      for (const target of targets) {
        expect(
          listFilesIfPresent(target.path),
          `${target.label} must hold a complete tree once publishing has finished`,
        ).toEqual(target.expect);
      }
    },
    SUITE_TEST_TIMEOUT_MS,
  );

  test(
    'concurrent composer processes all succeed and leave one complete published tree',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'ok-skill-writer-race-'));
      cleanup.push(root);
      const sourceSkills = defaultPaths().skillsDir;
      const distDir = join(root, 'dist', 'assets', 'skills');
      const writerPath = join(root, 'writer.mjs');
      const specPath = join(root, 'writer-spec.json');
      writeFileSync(writerPath, WRITER_SOURCE, 'utf-8');
      const startPath = join(root, 'writers-start');
      writeFileSync(
        specPath,
        JSON.stringify({
          composerPath: COMPOSER_PATH,
          skillsDir: sourceSkills,
          distDir,
          startPath,
          barrierBoundMs: WRITER_BARRIER_BOUND_MS,
          rounds: WRITER_PUBLISH_ROUNDS,
        }),
        'utf-8',
      );

      const writers = Array.from({ length: CONCURRENT_WRITERS }, () =>
        spawn(process.execPath, ['--conditions=development', writerPath, specPath], {
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
      let hangGuardFired = false;
      const deadline = setTimeout(() => {
        hangGuardFired = true;
        for (const writer of writers) {
          if (writer.exitCode === null && writer.signalCode === null) writer.kill();
        }
      }, HANG_GUARD_MS);

      let outcomes: WriterOutcome[];
      try {
        const armed: Array<Promise<void>> = [];
        const settled = writers.map((writer, index) => {
          let stdout = '';
          let stderr = '';
          writer.stdout.setEncoding('utf-8');
          writer.stderr.setEncoding('utf-8');
          armed.push(
            new Promise<void>((resolve) => {
              writer.stdout.on('data', (chunk: string) => {
                stdout += chunk;
                if (stdout.includes('armed')) resolve();
              });
              writer.on('exit', () => resolve());
            }),
          );
          writer.stderr.on('data', (chunk: string) => {
            stderr += chunk;
          });
          return new Promise<WriterOutcome>((resolve) => {
            writer.on('exit', (exitCode) => {
              if (exitCode === 0 && stdout.includes('composed')) {
                resolve({ writer: index, outcome: 'composed' });
                return;
              }
              resolve(
                hangGuardFired
                  ? { writer: index, outcome: 'hang-guard' }
                  : { writer: index, outcome: 'failed', exitCode, stderr: stderr.slice(-1200) },
              );
            });
          });
        });
        await Promise.all(armed);
        writeFileSync(startPath, '', 'utf-8');
        outcomes = await Promise.all(settled);
      } finally {
        clearTimeout(deadline);
        for (const writer of writers) {
          if (writer.exitCode === null && writer.signalCode === null) writer.kill();
        }
      }

      expect
        .soft(
          hangGuardFired,
          'the hang guard preempted the writers, so this run measured machine speed rather than the publish race',
        )
        .toBe(false);
      expect(outcomes).toEqual(
        Array.from({ length: CONCURRENT_WRITERS }, (_unused, writer) => ({
          writer,
          outcome: 'composed',
        })),
      );

      expect(listFiles(distDir)).toEqual(composedSkillsTreeExpectedFiles(sourceSkills));
      expect(listFiles(join(distDir, '..', 'agent-plugin'))).toEqual(
        agentPluginExpectedFiles(sourceSkills),
      );
    },
    SUITE_TEST_TIMEOUT_MS,
  );

  test.each([
    {
      window: 'a peer has unlinked the composed bundle directory',
      perturb: (distDir: string): void =>
        rmSync(join(distDir, 'discovery'), { recursive: true, force: true }),
    },
    {
      window: 'a peer has left the composed bundle directory half-populated',
      perturb: (distDir: string): void =>
        rmSync(join(distDir, 'project', 'references'), { recursive: true, force: true }),
    },
  ])('the agent-plugin artifact is complete when $window', ({ perturb }) => {
    const root = mkdtempSync(join(tmpdir(), 'ok-skill-peer-window-'));
    cleanup.push(root);
    const sourceSkills = defaultPaths().skillsDir;
    const paths: SkillBundlePaths = {
      skillsDir: sourceSkills,
      distDir: join(root, 'dist', 'assets', 'skills'),
    };
    const outRoot = join(paths.distDir, '..', 'agent-plugin');

    buildSkillBundles(paths);
    perturb(paths.distDir);

    expect(() => buildAgentPluginArtifact(paths)).not.toThrow();
    expect(listFiles(outRoot)).toEqual(agentPluginExpectedFiles(sourceSkills));
  });

  test('the next build reclaims scratch an interrupted run abandoned and spares scratch still in use', () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-skill-stale-staging-'));
    cleanup.push(root);
    const paths: SkillBundlePaths = {
      skillsDir: defaultPaths().skillsDir,
      distDir: join(root, 'dist', 'assets', 'skills'),
    };

    const abandonedRoot = plantStagingTree(mkdtempSync(join(root, STAGING_ROOT_PREFIX)));
    const abandonedHolder = plantStagingTree(mkdtempSync(`${abandonedRoot}-superseded-`));
    backdate(abandonedRoot);
    backdate(abandonedHolder);

    const workingRoot = plantStagingTree(mkdtempSync(join(root, STAGING_ROOT_PREFIX)));
    backdate(workingRoot);
    writeFileSync(join(workingRoot, 'project', 'SKILL.md'), 'a peer is still composing', 'utf-8');

    const liveRoot = mkdtempSync(join(root, STAGING_ROOT_PREFIX));

    buildSkillBundles(paths);

    expect(
      readdirSync(root)
        .filter((name) => name.startsWith(STAGING_ROOT_PREFIX))
        .sort(),
      "an interrupted run runs no finally, so its staging root and displaced-tree holder outlive it and the next build has to reclaim both; a peer whose only recent write is deep inside its root is still working, so its root is not the next build's to take",
    ).toEqual([basename(liveRoot), basename(workingRoot)].sort());
  });

  test('the displaced tree a stranded publish keeps survives the next build that sweeps beside it', () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-skill-kept-tree-'));
    cleanup.push(root);
    const paths: SkillBundlePaths = {
      skillsDir: defaultPaths().skillsDir,
      distDir: join(root, 'dist', 'assets', 'skills'),
    };

    const stagingRoot = plantStagingTree(mkdtempSync(join(root, STAGING_ROOT_PREFIX)));
    const holder = plantStagingTree(mkdtempSync(`${stagingRoot}-superseded-`));

    const outcome = keepDisplacedTree(holder);
    expect(outcome.kept, 'the tree was moved into the class the sweep spares').toBe(true);
    const kept = outcome.root;
    expect(existsSync(holder), 'the holder is moved, not copied').toBe(false);
    expect(listFiles(kept), 'the displaced tree moves with it').toEqual(['project/SKILL.md']);

    backdate(kept);
    backdate(stagingRoot);

    const sweepsBefore = sweepRuns();
    const warnings = captureConsole('warn', () => {
      buildSkillBundles(paths);
      buildPackSkills(paths);
      buildAgentPluginArtifact(paths);
    });

    expect(
      sweepRuns() - sweepsBefore,
      'all three composer functions open a staging root beside this dist, and the sweep is the expensive part, so it runs once for the build rather than once per function',
    ).toBe(1);
    expect(
      warnings.filter((line) => line.includes(kept)),
      'the sweep enumerates this directory on every run, so it is where a kept tree can still be found by an operator who did not see the build that made it — once for the build, not once per composer function that sweeps',
    ).toHaveLength(1);
    expect(
      listFilesIfPresent(kept),
      "the stranded publish's error names a path inside this tree as the only copy of what it displaced, so no later build may reclaim it however old it looks",
    ).toEqual(['project/SKILL.md']);
    expect(
      existsSync(stagingRoot),
      'the staging root beside it carries no such promise and is still reclaimed',
    ).toBe(false);
  });

  test.skipIf(PERMISSION_BITS_UNENFORCED)(
    'a candidate the sweep cannot finish walking is left alone rather than removed',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'ok-skill-sealed-staging-'));
      cleanup.push(root);
      const paths: SkillBundlePaths = {
        skillsDir: defaultPaths().skillsDir,
        distDir: join(root, 'dist', 'assets', 'skills'),
      };

      const unreadable = plantStagingTree(mkdtempSync(join(root, STAGING_ROOT_PREFIX)));
      const abandoned = plantStagingTree(mkdtempSync(join(root, STAGING_ROOT_PREFIX)));
      backdate(unreadable);
      backdate(abandoned);
      const sealed = join(unreadable, 'project');
      chmodSync(sealed, 0o000);

      try {
        expect(
          () => readdirSync(sealed),
          'the walk has to really fail for this to be the case under test, which it will not when the suite runs as root',
        ).toThrow();

        const warnings = captureConsole('warn', () => buildSkillBundles(paths));

        expect(existsSync(abandoned), 'the sweep ran').toBe(false);
        expect(
          existsSync(unreadable),
          "a candidate whose age the sweep could not establish is not the sweep's to take",
        ).toBe(true);
        const named = warnings.filter((line) => line.includes(unreadable));
        expect(
          named,
          "and the candidate it declined is nameable from this build's own output",
        ).toHaveLength(1);
        expect(
          named[0],
          'as a decline, not as a removal that was attempted and failed, which is what reading an inspection failure as an age produces',
        ).not.toContain('could not remove');
      } finally {
        chmodSync(sealed, 0o755);
      }
    },
  );

  test.skipIf(PERMISSION_BITS_UNENFORCED)(
    'a staging parent the sweep cannot list at all is reported rather than passed over in silence',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'ok-skill-unlistable-parent-'));
      cleanup.push(root);
      const paths: SkillBundlePaths = {
        skillsDir: defaultPaths().skillsDir,
        distDir: join(root, 'dist', 'assets', 'skills'),
      };

      chmodSync(root, 0o300);
      let warnings: string[] = [];
      let sweepsDuringBuild = 0;
      try {
        expect(
          () => readdirSync(root),
          'the listing has to really fail for this to be the case under test, which it will not when the suite runs as root',
        ).toThrow();

        const sweepsBefore = sweepRuns();
        warnings = captureConsole('warn', () => {
          buildSkillBundles(paths);
          buildPackSkills(paths);
          buildAgentPluginArtifact(paths);
        });
        sweepsDuringBuild = sweepRuns() - sweepsBefore;
      } finally {
        chmodSync(root, 0o700);
      }

      expect(
        sweepsDuringBuild,
        "a sweep that could not list the parent has reclaimed nothing, so it does not spend the build's one attempt: each composer function tries again",
      ).toBe(3);
      expect(
        warnings.filter((line) => line.includes(root)),
        'a sweep that cannot run at all leaves nothing on the filesystem for an operator to find later, so the build output is the only place it can surface — once, not once per composer function',
      ).toHaveLength(1);
    },
  );

  test('a keep that cannot move the tree reports it and does not claim the tree was kept', () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-skill-keep-failure-'));
    cleanup.push(root);
    const absent = join(root, `${STAGING_ROOT_PREFIX}gone-superseded-gone`);

    let outcome: { kept: boolean; root: string } | undefined;
    const errors = captureConsole('error', () => {
      outcome = keepDisplacedTree(absent);
    });

    expect(
      outcome,
      'the caller has to be able to tell a kept tree from one the keep could not move, because its message claims one of the two',
    ).toEqual({ kept: false, root: absent });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('[build-skill-bundles]');
    expect(errors[0]).toContain(absent);
    expect(
      errors[0],
      "reported in the same reason form this file's other recovery steps use",
    ).toContain('ENOENT');
  });

  test('a bundle whose source SKILL.md is absent still fails the build loudly', () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-skill-absent-source-'));
    cleanup.push(root);
    const skillsDir = join(root, 'skills');
    const distDir = join(root, 'dist', 'assets', 'skills');
    cpSync(defaultPaths().skillsDir, skillsDir, { recursive: true });
    rmSync(join(skillsDir, 'project', 'SKILL.md'));

    expect(() => buildSkillBundles({ skillsDir, distDir })).toThrow(/SKILL\.md/);
    expect(existsSync(join(distDir, 'project'))).toBe(false);
  });
});
