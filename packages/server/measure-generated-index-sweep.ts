import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { stringify as stringifyYaml } from 'yaml';
import { type BootedServer, bootServer } from './src/boot.ts';
import { getBootTimings } from './src/boot-timings.ts';
import { ConfigSchema } from './src/config/schema.ts';
import { loggerFactory } from './src/logger.ts';
import { ensureProjectGit } from './src/project-git.ts';

const execFileAsync = promisify(execFile);
const RESULT_PREFIX = 'GENERATED_INDEX_SWEEP_RESULT ';

export interface MeasurementArgs {
  directoryCounts: number[];
  documentCount: number;
  repetitions: number;
  warmupRuns: number;
}

interface MeasurementSample {
  durationMs: number;
  indexCount: number;
}

interface RuntimeIdentity {
  nodeVersion: string;
  platform: string;
  arch: string;
  cpuModel: string;
}

interface BuildMeasurementResultOptions {
  args: MeasurementArgs;
  capturedAt: string;
  commit: string;
  runtime: RuntimeIdentity;
  samples: Map<number, MeasurementSample[]>;
}

class CampaignInterruptedError extends Error {}

const DEFAULT_ARGS: MeasurementArgs = {
  directoryCounts: [1, 10, 100, 500],
  documentCount: 1000,
  repetitions: 5,
  warmupRuns: 1,
};

function parseInteger(value: string, name: string, allowZero: boolean): number {
  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && (allowZero ? parsed >= 0 : parsed > 0);
  if (!valid) {
    throw new Error(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer`);
  }
  return parsed;
}

function takeValue(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${argv[index]} requires a value`);
  }
  return value;
}

export function parseMeasurementArgs(argv: string[]): MeasurementArgs {
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv;
  const args: MeasurementArgs = {
    ...DEFAULT_ARGS,
    directoryCounts: [...DEFAULT_ARGS.directoryCounts],
  };

  for (let index = 0; index < normalizedArgv.length; index += 2) {
    const flag = normalizedArgv[index];
    const value = takeValue(normalizedArgv, index);
    switch (flag) {
      case '--directories': {
        if (value.length === 0) {
          throw new Error('--directories requires a non-empty comma-separated list');
        }
        const directoryCounts = value.split(',').map((part) => Number(part));
        if (!directoryCounts.every((count) => Number.isInteger(count) && count > 0)) {
          throw new Error('--directories values must be positive integers');
        }
        if (new Set(directoryCounts).size !== directoryCounts.length) {
          throw new Error('--directories values must be unique');
        }
        args.directoryCounts = directoryCounts;
        break;
      }
      case '--documents':
        args.documentCount = parseInteger(value, '--documents', false);
        break;
      case '--repetitions':
        args.repetitions = parseInteger(value, '--repetitions', false);
        break;
      case '--warmups':
        args.warmupRuns = parseInteger(value, '--warmups', true);
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }

  if (args.documentCount < Math.max(...args.directoryCounts)) {
    throw new Error('--documents must be at least the largest directory count');
  }
  return args;
}

export function distributeDocuments(documentCount: number, directoryCount: number): number[] {
  const quotient = Math.floor(documentCount / directoryCount);
  const remainder = documentCount % directoryCount;
  return Array.from(
    { length: directoryCount },
    (_, index) => quotient + (index < remainder ? 1 : 0),
  );
}

function roundHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

export function summarizeDurations(samples: number[]): {
  samples: number[];
  median: number;
  min: number;
  max: number;
} {
  if (samples.length === 0) throw new Error('duration samples must not be empty');
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return {
    samples: [...samples],
    median: roundHundredths(median),
    min: sorted[0],
    max: sorted.at(-1) as number,
  };
}

export function buildMeasurementResult(options: BuildMeasurementResultOptions) {
  return {
    schemaVersion: 1,
    benchmark: 'generated-index-full-sweep',
    capturedAt: options.capturedAt,
    commit: options.commit,
    runtime: options.runtime,
    fixture: {
      topology: 'flat',
      documentCount: options.args.documentCount,
      directoryCounts: options.args.directoryCounts,
      warmupRuns: options.args.warmupRuns,
      repetitions: options.args.repetitions,
    },
    cells: options.args.directoryCounts.map((directoryCount) => {
      const expectedIndexCount = directoryCount + 1;
      const samples = options.samples.get(directoryCount);
      if (!samples || samples.length === 0) {
        throw new Error(`missing measurement samples for ${directoryCount} directories`);
      }
      const indexCounts = new Set(samples.map((sample) => sample.indexCount));
      if (indexCounts.size !== 1 || !indexCounts.has(expectedIndexCount)) {
        throw new Error(
          `expected ${expectedIndexCount} generated indexes for ${directoryCount} directories, got ${[
            ...indexCounts,
          ].join(',')}`,
        );
      }
      return {
        directoryCount,
        expectedIndexCount,
        indexCount: expectedIndexCount,
        sweepDurationMs: summarizeDurations(samples.map((sample) => sample.durationMs)),
      };
    }),
  };
}

function writeFixture(projectDir: string, documentCount: number, directoryCount: number): void {
  const okDir = join(projectDir, '.ok');
  mkdirSync(okDir, { recursive: true });
  writeFileSync(
    join(okDir, 'config.yml'),
    stringifyYaml({
      contentRules: { okf: { enabled: true, generate: { index: true } } },
      telemetry: { localSink: { enabled: false } },
    }),
    'utf8',
  );
  writeFileSync(join(okDir, '.gitignore'), 'local/\n', 'utf8');

  const distribution = distributeDocuments(documentCount, directoryCount);
  const documentWidth = String(documentCount).length;
  const directoryWidth = String(directoryCount).length;
  let documentNumber = 0;
  for (const [directoryIndex, count] of distribution.entries()) {
    const directoryName = `directory-${String(directoryIndex + 1).padStart(directoryWidth, '0')}`;
    const directoryPath = join(projectDir, directoryName);
    mkdirSync(directoryPath, { recursive: true });
    for (let index = 0; index < count; index += 1) {
      documentNumber += 1;
      const label = String(documentNumber).padStart(documentWidth, '0');
      writeFileSync(
        join(directoryPath, `document-${label}.md`),
        `---\ntitle: Document ${label}\ntype: note\n---\n\n# Document ${label}\n`,
        'utf8',
      );
    }
  }
}

let activeServer: BootedServer | undefined;
let activeProjectDir: string | undefined;

async function cleanupActiveSample(): Promise<void> {
  const server = activeServer;
  activeServer = undefined;
  if (server) await server.destroy().catch(() => undefined);
  const projectDir = activeProjectDir;
  activeProjectDir = undefined;
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
}

async function measureCell(
  documentCount: number,
  directoryCount: number,
): Promise<MeasurementSample> {
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-generated-index-sweep-')));
  activeProjectDir = projectDir;
  try {
    writeFixture(projectDir, documentCount, directoryCount);
    await ensureProjectGit(projectDir);
    const config = ConfigSchema.parse({
      contentRules: { okf: { enabled: true, generate: { index: true } } },
      telemetry: { localSink: { enabled: false } },
    });
    activeServer = await bootServer({
      config,
      contentDir: projectDir,
      projectDir,
      host: '127.0.0.1',
      port: 0,
      quiet: true,
      gitEnabled: true,
      skipAutoInit: true,
      idleShutdownMs: null,
      skipStateManifestCheck: true,
    });
    await activeServer.ready;
    await activeServer.generatedIndexSweepReady;

    const timings = getBootTimings();
    const durationMs = timings?.generatedIndexSweepMs;
    const indexCount = timings?.generatedIndexCount;
    if (
      typeof durationMs !== 'number' ||
      !Number.isFinite(durationMs) ||
      indexCount === undefined
    ) {
      throw new Error('boot did not report generated-index sweep timings');
    }
    const expectedIndexCount = directoryCount + 1;
    if (indexCount !== expectedIndexCount) {
      throw new Error(`expected ${expectedIndexCount} generated indexes, got ${indexCount}`);
    }
    if (!existsSync(join(projectDir, 'index.md'))) {
      throw new Error('root generated index was not written');
    }
    for (let directoryIndex = 1; directoryIndex <= directoryCount; directoryIndex += 1) {
      const directoryWidth = String(directoryCount).length;
      const directoryName = `directory-${String(directoryIndex).padStart(directoryWidth, '0')}`;
      if (!existsSync(join(projectDir, directoryName, 'index.md'))) {
        throw new Error(`generated index was not written for ${directoryName}`);
      }
    }
    return {
      durationMs,
      indexCount,
    };
  } finally {
    await cleanupActiveSample();
  }
}

async function resolveCommit(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: resolve(import.meta.dirname, '../..'),
    });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

function assertCampaignActive(signal: AbortSignal): void {
  if (signal.aborted) throw new CampaignInterruptedError('measurement interrupted');
}

async function runCampaign(args: MeasurementArgs, signal: AbortSignal): Promise<void> {
  for (let warmup = 0; warmup < args.warmupRuns; warmup += 1) {
    for (const directoryCount of args.directoryCounts) {
      assertCampaignActive(signal);
      process.stderr.write(
        `warmup ${warmup + 1}/${args.warmupRuns}: ${directoryCount} directories\n`,
      );
      await measureCell(args.documentCount, directoryCount);
      assertCampaignActive(signal);
    }
  }

  const samples = new Map<number, MeasurementSample[]>(
    args.directoryCounts.map((directoryCount) => [directoryCount, []]),
  );
  for (let repetition = 0; repetition < args.repetitions; repetition += 1) {
    const order = repetition % 2 === 0 ? args.directoryCounts : [...args.directoryCounts].reverse();
    for (const directoryCount of order) {
      assertCampaignActive(signal);
      process.stderr.write(
        `measurement ${repetition + 1}/${args.repetitions}: ${directoryCount} directories\n`,
      );
      samples.get(directoryCount)?.push(await measureCell(args.documentCount, directoryCount));
      assertCampaignActive(signal);
    }
  }

  assertCampaignActive(signal);
  const result = buildMeasurementResult({
    args,
    capturedAt: new Date().toISOString(),
    commit: await resolveCommit(),
    runtime: {
      nodeVersion: process.version,
      platform: platform(),
      arch: arch(),
      cpuModel: cpus()[0]?.model ?? 'unknown',
    },
    samples,
  });
  assertCampaignActive(signal);
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
}

async function main(): Promise<void> {
  loggerFactory.configure({ pinoConfig: { options: { level: 'silent' } } });
  const abortController = new AbortController();
  const shutdown = (exitCode: number) => {
    process.exitCode = exitCode;
    abortController.abort();
    void cleanupActiveSample().catch(() => undefined);
  };
  const handleSigint = () => shutdown(130);
  const handleSigterm = () => shutdown(143);
  process.once('SIGINT', handleSigint);
  process.once('SIGTERM', handleSigterm);
  try {
    await runCampaign(parseMeasurementArgs(process.argv.slice(2)), abortController.signal);
  } finally {
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
    await cleanupActiveSample();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    const interrupted = process.exitCode === 130 || process.exitCode === 143;
    if (!interrupted) {
      process.exitCode = 1;
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  });
}
