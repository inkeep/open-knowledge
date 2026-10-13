import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { WORKER_SERVER_BUDGET_TOTAL_MS } from '../../stress/_helpers/fixtures.ts';
import { BUILD_STEP_SILENCE_MS } from '../../stress/_helpers/prebuilt/prebuilt-dev-build.ts';
import {
  APP_DIR,
  type CleanupReceipt,
  identities,
  identitySchema,
  isSameLiveIdentity,
  makeRunDir,
  type ProcessIdentity,
  startResourceOwner,
} from './owner-launch.test-helper.ts';

const INNER_RUN_LIMIT_MS = 2 * BUILD_STEP_SILENCE_MS + 2 * WORKER_SERVER_BUDGET_TOTAL_MS + 120_000;
export const OBSERVATION_LIMIT_MS = INNER_RUN_LIMIT_MS + 60_000 + 20_000;
export const INNER_EXPECTED = [
  {
    file: 'peer.e2e.ts',
    name: 'lifetime subject: peer uses its separate real server',
    outcome: 'passed',
  },
  {
    file: 'exit.e2e.ts',
    name: 'lifetime subject: worker exits after both real servers are ready',
    outcome: 'failed',
  },
] as const;

const readySchema = z.object({
  pid: z.number().int().positive(),
  at: z.number(),
  apiStatus: z.literal(200),
  identity: z.record(z.string(), z.unknown()),
  server: z.object({
    baseURL: z.url(),
    port: z.number().int().positive(),
    contentDir: z.string(),
  }),
});
type ReadyServer = z.infer<typeof readySchema>;

const eventSchema = z.object({
  event: z.string(),
  runId: z.string(),
  identity: identitySchema.optional(),
  environment: z.record(z.string(), z.string()).optional(),
});

type NativeRow = {
  file: string;
  name: string;
  project: string;
  status: string;
  workerIndex: number;
  errors: string[];
};
const nativeSpecSchema = z.object({
  file: z.string(),
  title: z.string(),
  tests: z.array(
    z.object({
      projectName: z.string(),
      results: z.array(
        z.object({
          status: z.string(),
          workerIndex: z.number(),
          errors: z.array(z.object({ message: z.string().optional() })).default([]),
        }),
      ),
    }),
  ),
});

function nativeRows(report: unknown): NativeRow[] {
  const root = z
    .object({ suites: z.array(z.unknown()), errors: z.array(z.unknown()) })
    .parse(report);
  if (root.errors.length !== 0) throw new Error('inner runner has setup or collection errors');
  const rows: NativeRow[] = [];
  function walk(raw: unknown): void {
    const suite = z
      .object({
        specs: z.array(nativeSpecSchema).default([]),
        suites: z.array(z.unknown()).default([]),
      })
      .parse(raw);
    for (const spec of suite.specs) {
      for (const test of spec.tests) {
        for (const result of test.results) {
          rows.push({
            file: spec.file,
            name: spec.title,
            project: test.projectName,
            status: result.status,
            workerIndex: result.workerIndex,
            errors: result.errors.map((error) => error.message ?? ''),
          });
        }
      }
    }
    for (const child of suite.suites) walk(child);
  }
  for (const suite of root.suites) walk(suite);
  return rows;
}

type ServerSample = {
  kind: 'exit' | 'peer';
  livePids: number[];
  processes: { birth: ProcessIdentity; current: ProcessIdentity }[];
  apiStatus: number | null;
  identityStatus: number | null;
  identityBody: unknown;
  ownedListener: boolean;
};
export type LifetimeObservation = {
  dir: string;
  runId: string;
  exit: { code: number | null; signal: string | null; at: number };
  native: NativeRow[];
  ready: { exit: ReadyServer; peer: ReadyServer };
  serverBirths: { exit: ProcessIdentity[]; peer: ProcessIdentity[] };
  samples: { at: number; observedAt: number; elapsedMs: number; servers: ServerSample[] }[];
  cleanup: CleanupReceipt;
};

export async function observeStandalonePrebuiltWorkerLifetime(): Promise<LifetimeObservation> {
  const mode = 'prebuilt';
  if (process.version !== 'v24.21.0')
    throw new Error(`worker lifetime substrate requires Node24.21.0, got ${process.version}`);
  const require = createRequire(import.meta.url);
  const browser: { chromium: { executablePath(): string } } = require('@playwright/test');
  if (!existsSync(browser.chromium.executablePath()))
    throw new Error('worker lifetime substrate has no pinned Chromium executable');
  const run = makeRunDir('standalone-prebuilt');
  const casesDir = join(run.dir, 'cases');
  mkdirSync(casesDir);
  writeFileSync(join(casesDir, 'package.json'), `${JSON.stringify({ type: 'module' })}\n`);
  symlinkSync(join(APP_DIR, 'node_modules'), join(casesDir, 'node_modules'), 'dir');
  const fixturePath = join(APP_DIR, 'tests', 'stress', 'prebuilt-dev-serving.e2e.ts');
  const fixtureSource = readFileSync(fixturePath, 'utf8');
  const resolvedFixture = fixtureSource.replace(
    /\bfrom\s+(['"])(\.[^'"]+)\1/g,
    (_match, _quote, path: string) => `from ${JSON.stringify(resolve(dirname(fixturePath), path))}`,
  );
  const casePath = join(
    APP_DIR,
    'tests',
    'meta',
    '_helpers',
    'worker-lifetime',
    'standalone-case.test-helper.ts',
  );
  const caseSource = readFileSync(casePath);
  const caseInputs = INNER_EXPECTED.map((required) => {
    const kind = required.file === 'exit.e2e.ts' ? 'exit' : 'peer';
    const appended = `
import { runStandaloneLifetimeCase } from ${JSON.stringify(casePath)};
test(${JSON.stringify(required.name)}, async ({ prebuilt }) => {
  await runStandaloneLifetimeCase(prebuilt.server, ${JSON.stringify(kind)});
});
`;
    const executableSource = resolvedFixture + appended;
    const executablePath = join(casesDir, required.file);
    writeFileSync(executablePath, executableSource);
    return {
      sourcePath: fixturePath,
      sourceSha256: createHash('sha256').update(fixtureSource).digest('hex'),
      casePath,
      caseSha256: createHash('sha256').update(caseSource).digest('hex'),
      executablePath,
      executableSha256: createHash('sha256').update(executableSource).digest('hex'),
      retainedFixtureSource: fixtureSource,
      originalAssertionsRetained: true,
      alterations:
        'Only static relative imports resolve to current source, and the standalone lifetime case is appended.',
    };
  });
  writeFileSync(join(run.dir, 'case-inputs.json'), `${JSON.stringify(caseInputs, null, 2)}\n`);
  const args = [
    require.resolve('@playwright/test/cli'),
    'test',
    '--config',
    join(APP_DIR, 'playwright.worker-lifetime.config.ts'),
    'peer.e2e.ts',
    'exit.e2e.ts',
    '--grep',
    'lifetime subject:',
    '--workers=2',
    '--retries=0',
    '--reporter=list,json',
    `--global-timeout=${INNER_RUN_LIMIT_MS}`,
    `--output=${join(run.dir, 'test-results')}`,
  ];
  writeFileSync(
    join(run.dir, 'inner-intent.json'),
    `${JSON.stringify({ at: Date.now(), cwd: APP_DIR, args, expected: INNER_EXPECTED, mode, outerLifetimeMs: OBSERVATION_LIMIT_MS, deadlines: [0, 10, 60] }, null, 2)}\n`,
  );
  const owner = startResourceOwner({
    ...run,
    cwd: APP_DIR,
    args,
    environment: {
      OK_TEST_LIFETIME_DIR: run.dir,
      OK_TEST_E2E_SERVING: mode,
      OK_TEST_E2E_REUSE_SOCKET: '',
      OK_TEST_E2E_REUSE_RUN: '',
      OK_TEST_PREBUILT_APP: '',
      PLAYWRIGHT_JSON_OUTPUT_FILE: join(run.dir, 'native.json'),
      PLAYWRIGHT_JSON_OUTPUT_NAME: '',
      PLAYWRIGHT_JSON_OUTPUT_DIR: '',
    },
    deadlineMs: OBSERVATION_LIMIT_MS,
  });
  let observation: Omit<LifetimeObservation, 'cleanup'> | undefined;
  let observationError: unknown;
  try {
    const exit = await owner.subjectExit;
    const native = nativeRows(JSON.parse(readFileSync(join(run.dir, 'native.json'), 'utf8')));
    for (const required of INNER_EXPECTED) {
      const matches = native.filter(
        (row) => row.file.endsWith(required.file) && row.name === required.name,
      );
      if (matches.length !== 1 || matches[0]?.status !== required.outcome)
        throw new Error(
          `inner membership or execution mismatch: ${JSON.stringify({ required, matches })}`,
        );
      if (
        required.outcome === 'failed' &&
        !matches[0].errors.some((error) => error.includes('code=83, signal=null'))
      )
        throw new Error(
          `inner exit is not the intended code83 trigger: ${JSON.stringify(matches)}`,
        );
    }
    const ready = {
      exit: readySchema.parse(JSON.parse(readFileSync(join(run.dir, 'exit-ready.json'), 'utf8'))),
      peer: readySchema.parse(JSON.parse(readFileSync(join(run.dir, 'peer-ready.json'), 'utf8'))),
    };
    if (
      ready.exit.server.contentDir === ready.peer.server.contentDir ||
      ready.exit.server.port === ready.peer.server.port
    )
      throw new Error('inner ready servers are not isolated');
    const events = readFileSync(join(run.dir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => eventSchema.parse(JSON.parse(line)));
    if (events.some((event) => event.runId !== run.runId))
      throw new Error('foreign native startup record');
    const serverBirths = { exit: [] as ProcessIdentity[], peer: [] as ProcessIdentity[] };
    for (const kind of ['exit', 'peer'] as const) {
      const byIdentity = new Map<string, ProcessIdentity>();
      for (const event of events) {
        if (event.event !== 'spawn' && event.event !== 'runtime') continue;
        if (
          event.environment?.OK_TEST_CONTENT_DIR !== ready[kind].server.contentDir ||
          !event.identity?.found
        )
          continue;
        byIdentity.set(`${event.identity.pid}:${event.identity.stamp}`, event.identity);
      }
      serverBirths[kind] = [...byIdentity.values()];
      if (serverBirths[kind].length < 2)
        throw new Error(`no real leader/server startup identities for ${kind}`);
    }
    const prebuiltDirectories = [
      ...new Set(
        events
          .map((event) => event.environment?.OK_TEST_PREBUILT_APP)
          .filter((path): path is string => path !== undefined && path !== ''),
      ),
    ];
    writeFileSync(
      join(run.dir, 'served-manifests.json'),
      `${JSON.stringify(
        prebuiltDirectories.map((path) => {
          const manifest = join(path, 'prebuilt-manifest.json');
          const bytes = readFileSync(manifest);
          return {
            path: manifest,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            value: JSON.parse(bytes.toString('utf8')),
          };
        }),
        null,
        2,
      )}\n`,
    );
    const samples: LifetimeObservation['samples'] = [];
    for (const at of [0, 10, 60]) {
      const remaining = exit.at + at * 1_000 - Date.now();
      if (remaining > 0) await pause(remaining);
      const observedAt = Date.now();
      const servers: ServerSample[] = [];
      for (const kind of ['exit', 'peer'] as const) {
        const births = serverBirths[kind];
        const current = identities(
          births.map((birth) => birth.pid),
          run.dir,
          run.runId,
        );
        const processes = births.map((birth, index) => ({
          birth,
          current: identitySchema.parse(current[index]),
        }));
        const response = await fetch(`${ready[kind].server.baseURL}/api/config`, {
          signal: AbortSignal.timeout(1_000),
        }).catch(() => null);
        const identity = await fetch(`${ready[kind].server.baseURL}/__ok-test-server-identity`, {
          signal: AbortSignal.timeout(1_000),
        }).catch(() => null);
        const identityBody: unknown = identity === null ? null : await identity.json();
        servers.push({
          kind,
          processes,
          livePids: processes
            .filter((row) => isSameLiveIdentity(row.birth, row.current))
            .map((row) => row.birth.pid),
          apiStatus: response?.status ?? null,
          identityStatus: identity?.status ?? null,
          identityBody,
          ownedListener:
            identity?.status === 200 && isDeepStrictEqual(identityBody, ready[kind].identity),
        });
      }
      samples.push({ at, observedAt, elapsedMs: observedAt - exit.at, servers });
      writeFileSync(
        join(run.dir, 'samples.json'),
        `${JSON.stringify({ runId: run.runId, exit, ready, serverBirths, samples }, null, 2)}\n`,
      );
    }
    observation = { dir: run.dir, runId: run.runId, exit, native, ready, serverBirths, samples };
  } catch (error) {
    observationError = error;
    writeFileSync(
      join(run.dir, 'observation-error.json'),
      `${JSON.stringify({ message: String(error), stack: error instanceof Error ? error.stack : undefined }, null, 2)}\n`,
    );
  }
  let cleanup: CleanupReceipt;
  try {
    cleanup = await owner.release();
  } catch (error) {
    if (observationError !== undefined)
      throw new AggregateError(
        [observationError, error],
        `observation and cleanup failed; see ${run.dir}`,
      );
    throw error;
  }
  if (cleanup.liveSurvivors.length !== 0 || !cleanup.workDirAbsent) {
    throw new AggregateError(
      [
        ...(observationError === undefined ? [] : [observationError]),
        new Error('worker lifetime observer cleanup incomplete'),
      ],
      `see ${run.dir}`,
    );
  }
  if (observationError !== undefined) throw observationError;
  if (observation === undefined)
    throw new Error(`worker lifetime observation not established; see ${run.dir}`);
  return { ...observation, cleanup };
}
