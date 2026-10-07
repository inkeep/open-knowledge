import { createHash } from 'node:crypto';
import { globSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

export type InputDigests = Readonly<Record<string, string>>;

export const SERVER_RESTART_INPUTS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.node-version',
  'tsconfig.json',
  'turbo.json',
  'patches/**',
  'packages/core/**',
  'packages/server/**',
  'packages/app/package.json',
  'packages/app/tsconfig.json',
  'packages/app/vite.*.ts',
  'packages/app/postcss.config.ts',
  'packages/app/lingui.config.ts',
  'packages/app/scripts/**',
  'packages/app/src/build/**',
  'packages/app/src/server/**',
] as const;

export const PREBUILT_BUILD_INPUTS = [
  ...SERVER_RESTART_INPUTS,
  'packages/app/*.html',
  'packages/app/public/**',
  'packages/app/src/**',
] as const;

const GENERATED_OUTPUTS = [
  '**/node_modules',
  '**/node_modules/**',
  '**/dist/**',
  '**/.turbo/**',
  'packages/app/public/excalidraw-assets/**',
  'packages/app/.excalidraw-assets-staging-*/**',
];

export type ServerFingerprint = {
  readonly digest: string;
  readonly inputs: InputDigests;
  readonly env: InputDigests;
};

export type ReuseDecision =
  | { readonly reuse: true }
  | {
      readonly reuse: false;
      readonly changedInputs: readonly string[];
      readonly changedEnv: readonly string[];
    };

const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

function sorted(entries: Iterable<readonly [string, string]>): InputDigests {
  return Object.fromEntries([...entries].sort(([left], [right]) => (left < right ? -1 : 1)));
}

export function digestInputs(okRoot: string, patterns: readonly string[]): InputDigests {
  const files = globSync([...patterns], { cwd: okRoot, exclude: GENERATED_OUTPUTS }).filter(
    (path) => statSync(join(okRoot, path)).isFile(),
  );
  return sorted(
    files.map((path) => [path.split(sep).join('/'), sha256(readFileSync(join(okRoot, path)))]),
  );
}

function digestValues(values: Readonly<Record<string, string>>): InputDigests {
  return sorted(Object.entries(values).map(([key, value]) => [key, sha256(value)]));
}

function changedKeys(before: InputDigests, after: InputDigests): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => before[key] !== after[key]).sort();
}

export function serverFingerprint(
  okRoot: string,
  workerEnv: Readonly<Record<string, string>>,
): ServerFingerprint {
  const inputs = digestInputs(okRoot, SERVER_RESTART_INPUTS);
  const env = digestValues(workerEnv);
  return { digest: sha256(JSON.stringify({ inputs, env })), inputs, env };
}

export function reuseDecision(
  admitted: ServerFingerprint,
  current: ServerFingerprint,
): ReuseDecision {
  const changedInputs = changedKeys(admitted.inputs, current.inputs);
  const changedEnv = changedKeys(admitted.env, current.env);
  return changedInputs.length === 0 && changedEnv.length === 0
    ? { reuse: true }
    : { reuse: false, changedInputs, changedEnv };
}

export type BuildOptions = Readonly<Record<string, string | number | boolean>>;

export type PrebuiltManifest = {
  readonly digest: string;
  readonly inputs: InputDigests;
  readonly options: Readonly<Record<string, string>>;
};

export type PrebuiltServingDecision =
  | { readonly serve: true }
  | { readonly serve: false; readonly reason: 'missing' }
  | {
      readonly serve: false;
      readonly reason: 'stale';
      readonly changedInputs: readonly string[];
      readonly changedOptions: readonly string[];
    };

export function prebuiltManifest(okRoot: string, buildOptions: BuildOptions): PrebuiltManifest {
  const inputs = digestInputs(okRoot, PREBUILT_BUILD_INPUTS);
  const options = sorted(
    Object.entries(buildOptions).map(([key, value]) => [key, JSON.stringify(value)]),
  );
  return { digest: sha256(JSON.stringify({ inputs, options })), inputs, options };
}

export function prebuiltServingDecision(
  recorded: PrebuiltManifest | undefined,
  current: PrebuiltManifest,
): PrebuiltServingDecision {
  if (recorded === undefined) return { serve: false, reason: 'missing' };
  const changedInputs = changedKeys(recorded.inputs, current.inputs);
  const changedOptions = changedKeys(recorded.options, current.options);
  return changedInputs.length === 0 && changedOptions.length === 0
    ? { serve: true }
    : { serve: false, reason: 'stale', changedInputs, changedOptions };
}
