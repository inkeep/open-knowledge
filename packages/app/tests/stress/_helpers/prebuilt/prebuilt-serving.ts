import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PREBUILT_OUT_DIR_ENV } from '../../../../src/build/prebuilt-dev-contract.ts';
import {
  type BuildOptions,
  type PrebuiltManifest,
  type PrebuiltServingDecision,
  prebuiltManifest,
  prebuiltServingDecision,
} from '../../../foundation/test-server-inputs.ts';
import {
  PRODUCTION_SHELL_ENV,
  type ProductionShellLaunch,
  productionShellLaunch,
} from '../production-shell-server.ts';

export const E2E_SERVING_ENV = 'OK_TEST_E2E_SERVING';
export const PREBUILT_APP_ENV = 'OK_TEST_PREBUILT_APP';
export const PREBUILT_MANIFEST_FILE = 'prebuilt-manifest.json';

export const E2E_SERVING_MODES = ['dev-server', 'prebuilt'] as const;
export type E2eServingMode = (typeof E2E_SERVING_MODES)[number];

export const PREBUILT_BUILD_OPTIONS = {
  config: 'vite.prebuilt-dev.ts',
  mode: 'development',
  nodeEnv: 'development',
} as const satisfies BuildOptions;

export type WorkerServing =
  | { readonly kind: 'dev-server' }
  | { readonly kind: 'prebuilt'; readonly outputDir: string }
  | { readonly kind: 'production-shell'; readonly launch: ProductionShellLaunch };

export type ModuleServing = Exclude<WorkerServing, { readonly kind: 'production-shell' }>;

export type PrebuiltServing = Extract<WorkerServing, { readonly kind: 'prebuilt' }>;

export type PrebuiltServerCommand = {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

type Env = Readonly<Record<string, string | undefined>>;

const LISTED_CHANGES = 5;

export function e2eServingMode(env: Env): E2eServingMode {
  const raw = env[E2E_SERVING_ENV];
  if (raw === undefined || raw === '') return 'dev-server';
  const mode = E2E_SERVING_MODES.find((candidate) => candidate === raw);
  if (mode === undefined) {
    throw new Error(
      `${E2E_SERVING_ENV}=${raw} names no serving mode; use ${E2E_SERVING_MODES.join(' or ')}`,
    );
  }
  return mode;
}

export function workerServingFromEnv(env: Env): ModuleServing {
  if (e2eServingMode(env) === 'dev-server') return { kind: 'dev-server' };
  const outputDir = env[PREBUILT_APP_ENV];
  if (outputDir === undefined || outputDir === '') {
    throw new Error(
      `${E2E_SERVING_ENV}=prebuilt serves the prebuilt DEV app its globalSetup records in ${PREBUILT_APP_ENV}, and this invocation has none; run it through a Playwright config that lists the prebuilt setup`,
    );
  }
  return { kind: 'prebuilt', outputDir };
}

export function workerServingKind(
  workerServerEnv: Readonly<Record<string, string>>,
  env: Env,
): WorkerServing['kind'] {
  if ((workerServerEnv[PRODUCTION_SHELL_ENV] ?? env[PRODUCTION_SHELL_ENV]) === '1') {
    return 'production-shell';
  }
  return e2eServingMode(env);
}

export function workerServingFor(
  workerServerEnv: Readonly<Record<string, string>>,
  env: Env,
  endpoint: { readonly host: string; readonly candidatePort: number },
): WorkerServing {
  const kind = workerServingKind(workerServerEnv, env);
  switch (kind) {
    case 'production-shell':
      return { kind, launch: productionShellLaunch(endpoint.host, endpoint.candidatePort) };
    case 'dev-server':
    case 'prebuilt':
      return workerServingFromEnv(env);
    default:
      return kind satisfies never;
  }
}

function stringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  const strings = entries.filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return strings.length === entries.length ? Object.fromEntries(strings) : undefined;
}

export function parsePrebuiltManifest(value: unknown): PrebuiltManifest | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { digest, inputs, options } = value as Record<string, unknown>;
  const inputDigests = stringRecord(inputs);
  const optionValues = stringRecord(options);
  if (typeof digest !== 'string' || inputDigests === undefined || optionValues === undefined) {
    return undefined;
  }
  return { digest, inputs: inputDigests, options: optionValues };
}

export function readPrebuiltManifest(path: string): PrebuiltManifest | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return parsePrebuiltManifest(value);
}

type UnservedDecision = Exclude<PrebuiltServingDecision, { serve: true }>;

export function describeChanges(decision: Extract<UnservedDecision, { reason: 'stale' }>): string {
  const changed = [
    ...decision.changedInputs,
    ...decision.changedOptions.map((option) => `build option ${option}`),
  ];
  const listed = changed.slice(0, LISTED_CHANGES).join(', ');
  return changed.length > LISTED_CHANGES
    ? `${listed} and ${changed.length - LISTED_CHANGES} more`
    : listed;
}

export function describePrebuiltRefusal(outputDir: string, decision: UnservedDecision): string {
  return decision.reason === 'missing'
    ? `the prebuilt DEV app at ${outputDir} has no build manifest, so it is not served`
    : `the prebuilt DEV app at ${outputDir} is stale, because ${describeChanges(decision)} changed since it was built, so it is not served; run again to rebuild it`;
}

export function prebuiltServerCommand(
  host: string,
  serving: PrebuiltServing,
  okRoot: string,
): PrebuiltServerCommand {
  const decision = prebuiltServingDecision(
    readPrebuiltManifest(join(serving.outputDir, PREBUILT_MANIFEST_FILE)),
    prebuiltManifest(okRoot, PREBUILT_BUILD_OPTIONS),
  );
  if (!decision.serve) throw new Error(describePrebuiltRefusal(serving.outputDir, decision));
  return {
    args: ['exec', 'vite', 'preview', '--config', PREBUILT_BUILD_OPTIONS.config, '--host', host],
    env: { [PREBUILT_OUT_DIR_ENV]: join(serving.outputDir, 'dist') },
  };
}
