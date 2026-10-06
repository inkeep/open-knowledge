import { type ExecFileOptionsWithStringEncoding, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual, promisify, stripVTControlCharacters } from 'node:util';
import YAML from 'yaml';
import { z } from 'zod';

const execute = promisify(execFile);
const INSTALL_ATTEMPTS = 3;
const INSTALL_TIMEOUT_MS = 180_000;
const TRANSPORT_CAUSE =
  /operation timed out|timed out|connection (?:closed|reset|refused)|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT/i;
const TRANSPORT_WRAPPERS = new Set(['ERR_PNPM_TARBALL_FETCH_TARBALL', 'ERR_PNPM_META_FETCH_FAIL']);
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
const FETCH_TRANSPORT_CODES = new Set([
  ...TRANSPORT_CODES,
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
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
const pnpmErrorSchema = z.object({ level: z.literal('error'), code: z.string() });
const lockedTarball = z.object({
  resolution: z.object({ integrity: z.string(), tarball: z.string().optional() }),
});

type FetchVerdict = { code: string; transport?: boolean; reason: string };

async function refetchLockedTarball(
  packageId: string,
  installPrefix: string,
  registry: string,
  timeoutMs: number,
): Promise<FetchVerdict> {
  const lock = lockSchema.parse(
    YAML.parse(readFileSync(join(installPrefix, 'pnpm-lock.yaml'), 'utf8')),
  );
  const entry = lockedTarball.safeParse(lock.packages[packageId]);
  if (!entry.success)
    return {
      code: `INCOMPLETE_FETCH ${packageId}`,
      transport: false,
      reason: 'it has no locked tarball to check',
    };
  const at = packageId.lastIndexOf('@');
  const name = packageId.slice(0, at);
  const url =
    entry.data.resolution.tarball ??
    `${registry.replace(/\/+$/, '')}/${name}/-/${name.split('/').at(-1)}-${packageId.slice(at + 1)}.tgz`;
  let body: Buffer;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok)
      return {
        code: `ERR_PNPM_FETCH_${response.status}`,
        reason: `the registry answered ${response.status}`,
      };
    body = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
    const code = z.object({ code: z.string() }).safeParse(cause ?? error).data?.code;
    const timedOut =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {
      code: `INCOMPLETE_FETCH ${packageId}`,
      transport: timedOut || (code !== undefined && FETCH_TRANSPORT_CODES.has(code)),
      reason: `the request failed (${[error instanceof Error ? error.message : String(error), cause?.message, code].filter(Boolean).join(': ')})`,
    };
  }
  const [locked] = entry.data.resolution.integrity.split(/\s+/);
  const separator = locked.indexOf('-');
  const actual = createHash(locked.slice(0, separator)).update(body).digest('base64');
  return actual === locked.slice(separator + 1)
    ? {
        code: `INCOMPLETE_FETCH ${packageId}`,
        transport: true,
        reason: 'it downloads and matches the lockfile now, so the failure was transient',
      }
    : {
        code: 'ERR_PNPM_TARBALL_INTEGRITY',
        transport: false,
        reason: 'its integrity does not match the lockfile',
      };
}

function ndjsonEvents(stdout: string) {
  return stdout.split('\n').flatMap((line) => {
    try {
      return [z.record(z.string(), z.unknown()).parse(JSON.parse(line))];
    } catch {
      return [];
    }
  });
}

function pnpmStartedFetches(events: Record<string, unknown>[]) {
  return new Set(
    events
      .filter(
        (event) =>
          event.name === 'pnpm:fetching-progress' &&
          event.status === 'started' &&
          typeof event.packageId === 'string',
      )
      .map((event) => String(event.packageId)),
  );
}

function pnpmRecordedAcquisition(output: string) {
  const events = ndjsonEvents(output);
  const started = pnpmStartedFetches(events);
  return (
    events.some((event) => event.name === 'pnpm:stage' && event.stage === 'importing_done') &&
    events.some(
      (event) =>
        event.name === 'pnpm:progress' &&
        (event.status === 'fetched' || event.status === 'found_in_store'),
    ) &&
    events.every(
      (event) =>
        event.name !== 'pnpm:progress' ||
        event.status !== 'fetched' ||
        started.has(String(event.packageId)),
    )
  );
}

function pnpmIncompleteFetches(output: string) {
  const events = ndjsonEvents(output);
  const started = pnpmStartedFetches(events);
  for (const event of events)
    if (event.name === 'pnpm:progress' && event.status === 'fetched')
      started.delete(String(event.packageId));
  return [...started];
}

function pnpmAcquisition(output: string) {
  const events = ndjsonEvents(output);
  const progress = new Map<string, Set<string>>();
  for (const event of events)
    if (
      event.name === 'pnpm:progress' &&
      typeof event.status === 'string' &&
      typeof event.packageId === 'string'
    )
      progress.set(event.status, (progress.get(event.status) ?? new Set()).add(event.packageId));
  return { fetchStarts: pnpmStartedFetches(events), progress };
}

function pnpmReportedErrors(output: string) {
  return ndjsonEvents(output).flatMap((event) => {
    const parsed = pnpmErrorSchema.safeParse(event);
    return parsed.success ? [{ code: parsed.data.code }] : [];
  });
}

function pnpmPrintedErrors(stderr: string) {
  const text = stripVTControlCharacters(stderr);
  return [
    ...text.matchAll(/^Error: (ERR_PNPM_[A-Z0-9_]+)\n([\s\S]*?)(?=^Error: |(?![\s\S]))/gm),
  ].map(([, code, cause]) => ({
    code,
    transport:
      TRANSPORT_WRAPPERS.has(code) && TRANSPORT_CAUSE.test(cause.replace(/\s*[│├╰─▶]+\s*/g, ' ')),
  }));
}

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

interface NpmContext {
  cacheDir: string;
  logsDir: string;
}

function createNpmContext(packDest: string): NpmContext {
  const root = realpathSync(mkdtempSync(join(packDest, 'npm-')));
  const cacheDir = join(root, 'cache');
  const logsDir = join(root, 'logs');
  mkdirSync(cacheDir);
  mkdirSync(logsDir);
  return {
    cacheDir,
    logsDir,
  };
}

function npmDebugEvidence({ logsDir }: NpmContext): string {
  let files: string[];
  try {
    files = readdirSync(logsDir)
      .filter((name) => /-debug-\d+\.log$/.test(name))
      .sort();
  } catch (error) {
    return `\nNpm debug logs unavailable at ${logsDir}: ${String(error)}\n`;
  }
  if (!files.length) return `\nNo npm debug logs available at ${logsDir}.\n`;
  return files
    .map((name) => {
      const path = join(logsDir, name);
      try {
        return `\nNpm debug log ${path}:\n${readFileSync(path, 'utf8')}`;
      } catch (error) {
        return `\nNpm debug log unreadable at ${path}: ${String(error)}\n`;
      }
    })
    .join('');
}

function attachNpmDebugEvidence(error: unknown, evidence: string): unknown {
  if (error instanceof Error) {
    try {
      error.message += evidence;
    } catch {}
  }
  return error;
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
  const env = { ...(options.env ?? process.env) };
  const mode =
    options.mode ?? z.enum(['locked', 'fresh']).parse(env.OK_CLI_E2E_INSTALL_MODE ?? 'locked');
  const graphDir = join(options.packageDir, 'test-results');
  const graphPath = join(graphDir, 'cli-e2e-fresh-graph.json');
  if (mode === 'fresh') rmSync(graphPath, { force: true });
  const npm = createNpmContext(options.packDest);
  const npmArgs = ['--cache', npm.cacheDir, '--logs-dir', npm.logsDir];
  let packed: { stdout: string; stderr: string };
  try {
    packed = await execute(
      'npm',
      ['pack', '--json', '--pack-destination', options.packDest, ...npmArgs],
      { cwd: options.packageDir, encoding: 'utf8', env },
    );
  } catch (error) {
    throw attachNpmDebugEvidence(error, npmDebugEvidence(npm));
  }
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
          ...npmArgs,
        ];
  const configuredFetchTimeout = z.coerce
    .number()
    .int()
    .positive()
    .parse(env.npm_config_fetch_timeout ?? INSTALL_TIMEOUT_MS);
  const deadline = now() + INSTALL_TIMEOUT_MS;
  let unavailable: CliInstallUnavailableError | undefined;
  let outputBytes = 0;
  let acceptedOutput = '';
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
    let diagnostics = '';
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
      if (mode === 'fresh') diagnostics = npmDebugEvidence(npm);
      const failure = z
        .object({
          stdout: z.string(),
          stderr: z.string(),
          signal: z.string().nullable().optional(),
          killed: z.boolean().optional(),
          code: z.union([z.string(), z.number(), z.null()]).optional(),
        })
        .safeParse(error);
      if (!failure.success) throw attachNpmDebugEvidence(error, diagnostics);
      ({ stdout, stderr } = failure.data);
      const ownDeadline =
        failure.data.killed === true &&
        failure.data.code === null &&
        failure.data.signal === 'SIGTERM' &&
        now() >= deadline;
      if (typeof failure.data.code === 'string' || (failure.data.signal && !ownDeadline)) {
        process.stderr.write(stdout + stderr);
        throw attachNpmDebugEvidence(error, diagnostics);
      }
      if (ownDeadline) deadlineError = error;
      failed = true;
    }
    outputBytes += Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
    const failures: { code: string; transport?: boolean }[] =
      mode === 'locked'
        ? []
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
      const terminalErrors = [
        ...pnpmReportedErrors(`${stdout}\n${stderr}`),
        ...pnpmPrintedErrors(stderr),
      ];
      failures.push(...terminalErrors);
      if (!terminalErrors.length && !deadlineError)
        failures.push({ code: 'UNCLASSIFIED_PNPM_FAILURE' });
    }
    const refetched: { packageId: string; verdict: FetchVerdict }[] = [];
    if (mode === 'locked' && !failed)
      for (const packageId of pnpmIncompleteFetches(`${stdout}\n${stderr}`)) {
        const remaining = deadline - now();
        const verdict =
          remaining > 0
            ? await refetchLockedTarball(
                packageId,
                installPrefix,
                env.pnpm_config_registry ??
                  env.npm_config_registry ??
                  'https://registry.npmjs.org/',
                Math.min(fetchTimeout, remaining),
              )
            : {
                code: `INCOMPLETE_FETCH ${packageId}`,
                transport: false,
                reason: 'the acquisition deadline left no time to check it',
              };
        refetched.push({ packageId, verdict });
        failures.push(verdict);
      }
    const unobserved =
      mode === 'locked' && !failed && !pnpmRecordedAcquisition(`${stdout}\n${stderr}`);
    if (!failed && !failures.length && !unobserved) {
      acceptedOutput = `${stdout}\n${stderr}`;
      break;
    }
    process.stderr.write(stdout + stderr);
    const retryable =
      failures.length > 0 &&
      failures.every(
        (failure) =>
          failure.transport === true ||
          TRANSPORT_CODES.has(failure.code) ||
          /^(?:E|ERR_PNPM_FETCH_)(?:408|429|5\d\d)$/.test(failure.code),
      );
    const message = `Packed CLI ${command} installation failed.\n${refetched.map(({ packageId, verdict }) => `pnpm started fetching ${packageId} but never finished, and pnpm 12 skips a failed optional dependency without reporting why. Fetched again by the harness: ${verdict.code.startsWith('INCOMPLETE_FETCH') ? '' : `${verdict.code}: `}${verdict.reason}.\n`).join('')}${stdout}${stderr}${diagnostics}`;
    if (!retryable) {
      if (deadlineError)
        throw new Error(
          `Packed CLI ${command} acquisition deadline elapsed on attempt ${attempt} of ${INSTALL_ATTEMPTS}.${diagnostics}`,
          { cause: deadlineError },
        );
      throw new Error(unobserved ? `CLI fetch observer did not run.\n${message}` : message);
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
    acquisition: mode === 'locked' ? pnpmAcquisition(acceptedOutput) : null,
  };
}
