/* biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Turbo passes GITHUB_* and TURBO_HASH to a task without hashing them, and npm_lifecycle_event is the task's own script, so none of them belongs in a task key. */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { Plugin } from 'vitest/config';
import type { Reporter, TestCase, VitestPluginContext } from 'vitest/node';
import { executed, sumAcrossFiles, tallyVitestRun, type VitestFileTally } from './vitest-run-tally';

export const VITEST_RUN_EVIDENCE_OWNER_ENV = 'OK_VITEST_RUN_EVIDENCE_OWNER';

type Vitest = VitestPluginContext['vitest'];

type RunIdentity = { package: string | null; script: string | null; config: string | null };

function nearestPackageName(start: string): string | null {
  for (let dir = start; ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown };
      return typeof name === 'string' ? name : null;
    }
    if (dirname(dir) === dir) return null;
  }
}

function runIdentity(vitest: Vitest, script: string | null): RunIdentity {
  const { root } = vitest.config;
  const configFile = vitest.vite.config.configFile;
  return {
    package: nearestPackageName(root),
    script,
    config: configFile === undefined ? null : relative(root, configFile).split(sep).join('/'),
  };
}

function escapeData(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function emptyRunAnnotation(
  identity: RunIdentity,
  files: ReadonlyArray<VitestFileTally>,
  root: string,
  testNamePattern: RegExp | undefined,
): string {
  const skipped = sumAcrossFiles(files, (file) => file.skipped);
  const todo = sumAcrossFiles(files, (file) => file.todo);
  const unfinished = sumAcrossFiles(files, (file) => file.unfinished);
  const stopped = sumAcrossFiles(files, (file) => file.stopped);
  const collected = skipped + todo + unfinished + stopped;
  const subject = [
    identity.package ?? `the package at ${root}`,
    identity.script === null ? 'no package script' : `script ${identity.script}`,
    identity.config === null ? 'no config file' : `config ${identity.config}`,
  ].join(', ');
  const counts = [
    `${skipped} skipped, ${todo} todo, ${unfinished} unfinished`,
    ...(stopped > 0 ? [`${stopped} stopped by a failure`] : []),
  ].join(', ');
  const scope = [
    plural(files.length, 'file'),
    ...(testNamePattern === undefined ? [] : [`name filter ${String(testNamePattern)}`]),
  ].join('; ');
  const message = `${subject}: the run executed no test (collected ${collected}: ${counts}; ${scope}). On GitHub Actions a Vitest run must execute a test; make it execute one, or correct the filter or skip that emptied it.`;
  return `::error title=Vitest executed no test::${escapeData(message)}`;
}

type RunEvidenceFiles = { directory: string; report: string; provenance: string };

function runEvidenceFiles(root: string, script: string | null): RunEvidenceFiles {
  const name =
    script === null ? `vitest-direct-${randomUUID()}` : `vitest-${script.replaceAll(':', '-')}`;
  return {
    directory: join(root, 'test-results'),
    report: `${name}.json`,
    provenance: `${name}.provenance.json`,
  };
}

function writeProvenance(files: RunEvidenceFiles, identity: RunIdentity): void {
  const provenance = {
    report: files.report,
    ...identity,
    turboHash: process.env.TURBO_HASH ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    job: process.env.GITHUB_JOB ?? null,
  };
  mkdirSync(files.directory, { recursive: true });
  writeFileSync(
    join(files.directory, files.provenance),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
}

function evidenceReporter(
  vitest: Vitest,
  script: string | null,
  evidence: RunEvidenceFiles,
): Reporter {
  const started = new WeakSet<TestCase>();
  return {
    onTestCaseReady(testCase) {
      started.add(testCase);
    },
    onTestRunEnd(testModules) {
      const identity = runIdentity(vitest, script);
      writeProvenance(evidence, identity);
      if (process.env.GITHUB_ACTIONS !== 'true') return;
      const { root, testNamePattern } = vitest.config;
      const files = tallyVitestRun(testModules, root, started);
      if (sumAcrossFiles(files, executed) > 0) return;
      process.exitCode = 1;
      if (files.length > 0 && files.every((file) => file.failedDuringCollection)) return;
      vitest.logger.log(`\n${emptyRunAnnotation(identity, files, root, testNamePattern)}`);
    },
  };
}

export function vitestRunEvidence(): Plugin {
  return {
    name: 'ok:vitest-run-evidence',
    configureVitest({ vitest }) {
      if (process.env[VITEST_RUN_EVIDENCE_OWNER_ENV] !== undefined) return;
      process.env[VITEST_RUN_EVIDENCE_OWNER_ENV] = String(process.pid);
      const script = process.env.npm_lifecycle_event || null;
      if (script === null && process.env.GITHUB_ACTIONS !== 'true') return;
      const evidence = runEvidenceFiles(vitest.config.root, script);
      vitest.config.reporters.push(
        ['json', { outputFile: join(evidence.directory, evidence.report) }],
        evidenceReporter(vitest, script, evidence),
      );
    },
  };
}
