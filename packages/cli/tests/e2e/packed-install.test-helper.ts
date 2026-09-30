import { type ExecFileOptionsWithStringEncoding, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify, stripVTControlCharacters } from 'node:util';
import YAML from 'yaml';
import { z } from 'zod';

const execute = promisify(execFile);
const INSTALL_ATTEMPTS = 3;
const INSTALL_TIMEOUT_MS = 180_000;
const OBSERVER_READY = 'OK_CLI_FETCH_OBSERVER_V1';
const FETCH_FAILURE = 'OK_CLI_FETCH_FAILURE_V1 ';
const TRANSPORT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ERR_SOCKET_TIMEOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);
const declarations = z.record(z.string(), z.string());
const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  dependencies: declarations.optional(),
  optionalDependencies: declarations.optional(),
  engines: declarations.optional(),
  bin: z.union([z.string(), declarations]).optional(),
});
const references = z.record(z.string(), z.object({ specifier: z.string(), version: z.string() }));
const lockSchema = z.looseObject({
  lockfileVersion: z.literal('9.0'),
  importers: z.record(
    z.string(),
    z.object({
      dependencies: references.optional(),
      optionalDependencies: references.optional(),
    }),
  ),
  packages: z.record(z.string(), z.unknown()),
  snapshots: z.record(z.string(), z.unknown()),
});
const fetchFailureSchema = z.object({ code: z.string().optional(), status: z.number().optional() });
const pnpmErrorSchema = z.object({ level: z.literal('error'), code: z.string() });

export class CliInstallUnavailableError extends Error {
  readonly exitCode = 77;
  readonly acquisitionId = randomUUID();
  readonly outputBytes: number;

  constructor(message: string, outputBytes: number) {
    super(message);
    this.name = 'CliInstallUnavailableError';
    this.outputBytes = outputBytes;
  }
}

export interface PackedInstallOptions {
  packageDir: string;
  packDest: string;
  installPrefix: string;
  mode?: 'locked' | 'fresh';
  env?: NodeJS.ProcessEnv;
}

interface InstallRuntime {
  now: () => number;
  executeInstall: (
    command: string,
    args: string[],
    options: ExecFileOptionsWithStringEncoding,
  ) => Promise<{ stdout: string; stderr: string }>;
}

async function prepareLockedConsumer(
  options: PackedInstallOptions,
  tarball: string,
  integrity: string,
  env: NodeJS.ProcessEnv,
) {
  const workspaceDir = resolve(options.packageDir, '../..');
  const lock = lockSchema.parse(
    YAML.parse(readFileSync(join(workspaceDir, 'pnpm-lock.yaml'), 'utf8')),
  );
  const sourceManifest = manifestSchema.parse(
    JSON.parse(readFileSync(join(options.packageDir, 'package.json'), 'utf8')),
  );
  const packed = await execute('tar', ['-xOf', tarball, 'package/package.json'], {
    encoding: 'utf8',
    env,
  });
  const manifest = manifestSchema.parse(JSON.parse(packed.stdout));
  if (!isDeepStrictEqual(manifest, sourceManifest))
    throw new Error('Packed CLI manifest differs from its source manifest');
  const importer = lock.importers[relative(workspaceDir, options.packageDir).split('\\').join('/')];
  if (!importer) throw new Error('Committed lockfile has no CLI importer');
  for (const field of ['dependencies', 'optionalDependencies'] as const) {
    const locked = Object.fromEntries(
      Object.entries(importer[field] ?? {}).map(([name, entry]) => [name, entry.specifier]),
    );
    if (!isDeepStrictEqual(locked, manifest[field] ?? {}))
      throw new Error(`Packed CLI ${field} differ from the committed lockfile`);
  }
  if (lock.pnpmfileChecksum !== undefined)
    throw new Error('CLI replay requires explicit support for the workspace pnpmfile');
  const workspace = z
    .record(z.string(), z.unknown())
    .parse(YAML.parse(readFileSync(join(workspaceDir, 'pnpm-workspace.yaml'), 'utf8')));
  const patches = declarations.parse(workspace.patchedDependencies ?? {});
  for (const path of Object.values(patches)) {
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..'))
      throw new Error('CLI replay requires workspace-relative patch paths');
    cpSync(join(workspaceDir, path), join(options.installPrefix, path), { recursive: true });
  }
  const { packageManager } = z
    .object({ packageManager: z.string().regex(/^pnpm@\d+\.\d+\.\d+(?:\+.+)?$/) })
    .parse(JSON.parse(readFileSync(join(workspaceDir, 'package.json'), 'utf8')));
  const hook = readFileSync(
    fileURLToPath(new URL('./packed-fetch.test-helper.cjs', import.meta.url)),
    'utf8',
  );
  writeFileSync(join(options.installPrefix, '.pnpmfile.cjs'), hook);
  lock.pnpmfileChecksum = `sha256-${createHash('sha256').update(hook.replaceAll('\r\n', '\n')).digest('base64')}`;
  cpSync(tarball, join(options.installPrefix, 'cli.tgz'));
  const reference = 'file:cli.tgz';
  const key = `${manifest.name}@${reference}`;
  lock.importers = {
    '.': { dependencies: { [manifest.name]: { specifier: reference, version: reference } } },
  };
  lock.packages[key] = {
    resolution: { integrity, tarball: reference },
    version: manifest.version,
    engines: manifest.engines,
    hasBin: Boolean(manifest.bin),
  };
  lock.snapshots[key] = Object.fromEntries(
    (['dependencies', 'optionalDependencies'] as const).map((field) => [
      field,
      Object.fromEntries(
        Object.entries(importer[field] ?? {}).map(([name, entry]) => [name, entry.version]),
      ),
    ]),
  );
  writeFileSync(
    join(options.installPrefix, 'package.json'),
    JSON.stringify({ private: true, packageManager, dependencies: { [manifest.name]: reference } }),
  );
  writeFileSync(
    join(options.installPrefix, 'pnpm-workspace.yaml'),
    YAML.stringify({ ...workspace, packages: [], enableGlobalVirtualStore: false }),
  );
  writeFileSync(join(options.installPrefix, 'pnpm-lock.yaml'), YAML.stringify(lock));
  const version = await execute('pnpm', ['--version'], { cwd: options.installPrefix, env });
  if (version.stdout.trim() !== packageManager.slice('pnpm@'.length).split('+')[0])
    throw new Error('CLI replay pnpm version differs from the workspace pin');
}

export async function installPackedCli(
  options: PackedInstallOptions,
  { now, executeInstall }: InstallRuntime = { now: Date.now, executeInstall: execute },
) {
  const installPrefix = realpathSync(options.installPrefix);
  const env = options.env ?? process.env;
  const mode =
    options.mode ?? z.enum(['locked', 'fresh']).parse(env.OK_CLI_E2E_INSTALL_MODE ?? 'locked');
  const graphDir = join(options.packageDir, 'test-results');
  const graphPath = join(graphDir, 'cli-e2e-fresh-graph.json');
  if (mode === 'fresh') rmSync(graphPath, { force: true });
  const packed = await execute('npm', ['pack', '--json', '--pack-destination', options.packDest], {
    cwd: options.packageDir,
    encoding: 'utf8',
    env,
  });
  const [archive] = z
    .array(z.object({ filename: z.string(), integrity: z.string() }))
    .nonempty()
    .parse(JSON.parse(packed.stdout));
  const tarball = realpathSync(join(options.packDest, archive.filename));
  if (mode === 'locked')
    await prepareLockedConsumer({ ...options, installPrefix }, tarball, archive.integrity, env);
  const command = mode === 'locked' ? 'pnpm' : 'npm';
  const args =
    mode === 'locked'
      ? ['install', '--frozen-lockfile', '--prod', '--reporter=ndjson', '--config.fetch-retries=0']
      : [
          'install',
          '--no-audit',
          '--no-fund',
          '--package-lock=true',
          '--fetch-retries=0',
          '--prefix',
          installPrefix,
          tarball,
        ];
  const configuredFetchTimeout = z.coerce
    .number()
    .int()
    .positive()
    .parse(env.npm_config_fetch_timeout ?? INSTALL_TIMEOUT_MS);
  const deadline = now() + INSTALL_TIMEOUT_MS;
  let unavailable: CliInstallUnavailableError | undefined;
  let outputBytes = 0;
  for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt++) {
    const timeout = deadline - now();
    if (timeout <= 0)
      throw unavailable ?? new Error('Packed CLI acquisition deadline elapsed before installation');
    const fetchTimeout = Math.min(
      configuredFetchTimeout,
      Math.max(1, Math.floor(timeout / (INSTALL_ATTEMPTS - attempt + 2))),
    );
    let stdout: string;
    let stderr: string;
    let failed = false;
    let deadlineError: unknown;
    try {
      ({ stdout, stderr } = await executeInstall(
        command,
        [...args, `--fetch-timeout=${fetchTimeout}`],
        {
          cwd: installPrefix,
          encoding: 'utf8',
          timeout,
          env,
        },
      ));
    } catch (error) {
      const failure = z
        .object({
          stdout: z.string(),
          stderr: z.string(),
          signal: z.string().nullable().optional(),
          killed: z.boolean().optional(),
          code: z.union([z.string(), z.number(), z.null()]).optional(),
        })
        .safeParse(error);
      if (!failure.success) throw error;
      ({ stdout, stderr } = failure.data);
      const ownDeadline =
        failure.data.killed === true &&
        failure.data.code === null &&
        failure.data.signal === 'SIGTERM' &&
        now() >= deadline;
      if (typeof failure.data.code === 'string' || (failure.data.signal && !ownDeadline)) {
        process.stderr.write(stdout + stderr);
        throw error;
      }
      if (ownDeadline) deadlineError = error;
      failed = true;
    }
    outputBytes += Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
    const failures =
      mode === 'locked'
        ? stderr
            .split('\n')
            .filter((line) => line.startsWith(FETCH_FAILURE))
            .map((line) => fetchFailureSchema.parse(JSON.parse(line.slice(FETCH_FAILURE.length))))
        : failed
          ? [
              {
                code:
                  [
                    ...stripVTControlCharacters(stderr).matchAll(
                      /^npm (?:error|ERR!) code (\S+)/gm,
                    ),
                  ].at(-1)?.[1] ?? '',
              },
            ]
          : [];
    if (mode === 'locked' && failed) {
      const terminalErrors = stdout.split('\n').flatMap((line) => {
        try {
          const parsed = pnpmErrorSchema.safeParse(JSON.parse(line));
          return parsed.success ? [{ code: parsed.data.code }] : [];
        } catch {
          return [];
        }
      });
      failures.push(...terminalErrors);
      if (!terminalErrors.length && !deadlineError)
        failures.push({ code: 'UNCLASSIFIED_PNPM_FAILURE' });
    }
    const observed = mode !== 'locked' || stderr.split('\n').includes(OBSERVER_READY);
    if (!failed && !failures.length && observed) break;
    process.stderr.write(stdout + stderr);
    const retryable =
      failures.length > 0 &&
      failures.every(
        (failure) =>
          TRANSPORT_CODES.has(failure.code ?? '') ||
          /^(?:E|ERR_PNPM_FETCH_)(?:429|5\d\d)$/.test(failure.code ?? '') ||
          ('status' in failure &&
            (failure.status === 429 ||
              (typeof failure.status === 'number' &&
                failure.status >= 500 &&
                failure.status <= 599))),
      );
    const message = `Packed CLI ${command} installation failed.\n${stdout}${stderr}`;
    if (!retryable) {
      if (deadlineError)
        throw new Error(
          `Packed CLI ${command} acquisition deadline elapsed on attempt ${attempt} of ${INSTALL_ATTEMPTS}.`,
          { cause: deadlineError },
        );
      throw new Error(observed ? message : `CLI fetch observer did not run.\n${message}`);
    }
    unavailable = new CliInstallUnavailableError(
      `Packed CLI acquisition did-not-run after ${attempt} of ${INSTALL_ATTEMPTS} attempts.\n${message}`,
      outputBytes,
    );
    if (attempt === INSTALL_ATTEMPTS || now() >= deadline) throw unavailable;
    rmSync(join(installPrefix, 'node_modules'), { recursive: true, force: true });
  }
  if (mode === 'fresh') {
    mkdirSync(graphDir, { recursive: true });
    cpSync(join(installPrefix, 'package-lock.json'), graphPath);
  }
  const installed = join(installPrefix, 'node_modules', '@inkeep', 'open-knowledge');
  for (const asset of ['dist/cli.mjs', 'dist/public/index.html', 'dist/assets/skills']) {
    if (!existsSync(join(installed, asset))) {
      throw new Error(`Packed CLI is missing required asset: ${asset}`);
    }
  }
  const binShim = join(installPrefix, 'node_modules', '.bin', 'ok');
  if (!existsSync(binShim)) throw new Error('Packed CLI is missing its ok executable');
  return {
    cliPath: join(installed, 'dist', 'cli.mjs'),
    binShim,
  };
}
