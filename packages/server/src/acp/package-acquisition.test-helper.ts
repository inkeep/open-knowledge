import { type ChildProcess, execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempDisposableSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { findNodeAtLocation, type ParseError, parseTree } from 'jsonc-parser';
import { z } from 'zod';
import {
  npmPackResult,
  type ResolvedLaunch,
  resetAcquisitionCache,
  resolveWindowsCommand,
  spawnAcpAgent,
  terminateAgentTree,
  windowsCmdWrap,
} from './launch.ts';
import type { RegistryAgent } from './registry.ts';

function executable(name: string): string {
  if (process.platform === 'win32') {
    const path = resolveWindowsCommand(name, process.env.PATH);
    if (!existsSync(path)) throw new Error(`Missing test prerequisite: ${name}`);
    return realpathSync(path);
  }
  const path = (process.env.PATH ?? '')
    .split(delimiter)
    .map((dir) => join(dir, name))
    .find(existsSync);
  if (!path) throw new Error(`Missing test prerequisite: ${name}`);
  return realpathSync(path);
}

export function npmCli(name: 'npm' | 'npx'): string {
  const command = executable('npx');
  const path =
    process.platform === 'win32'
      ? join(dirname(command), 'node_modules', 'npm', 'bin', `${name}-cli.js`)
      : join(dirname(command), `${name}-cli.js`);
  if (!existsSync(path)) throw new Error(`Missing test prerequisite: ${path}`);
  return path;
}

export function installNodeFixture(bin: string): void {
  if (process.platform === 'win32') copyFileSync(process.execPath, join(bin, 'node.exe'));
  else symlinkSync(process.execPath, join(bin, 'node'));
}

export function writeRecordingNpm(bin: string, probeLog: string): void {
  writeExecutable(
    join(bin, 'npm'),
    `require('node:fs').appendFileSync(${JSON.stringify(probeLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
     const spec = process.argv[3];
     const at = spec.lastIndexOf('@');
     const range = spec.slice(at + 1);
     const version = range.includes(' - ') ? range.split(' - ')[1] : range;
     process.stdout.write(JSON.stringify([{ name: spec.slice(0, at), version }]));`,
  );
}

export function probedDescriptors(probeLog: string): string[] {
  if (!existsSync(probeLog)) return [];
  return readFileSync(probeLog, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (JSON.parse(line) as string[])[1] ?? '');
}

export function withAcquisitionHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  return acquisitionHome(run, false);
}

export function withLiveAcquisitionHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  return acquisitionHome(run, true);
}

async function acquisitionHome<T>(run: (home: string) => Promise<T>, network: boolean): Promise<T> {
  const prior = { ...process.env };
  const inherited = (key: string) =>
    Object.entries(prior).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
  using home = mkdtempDisposableSync(join(realpathSync(tmpdir()), 'ok-acquisition-'));
  const env = {
    PATH: inherited('PATH'),
    PATHEXT: inherited('PATHEXT'),
    SystemRoot: inherited('SystemRoot'),
    ComSpec: inherited('ComSpec'),
    HOME: home.path,
    USERPROFILE: home.path,
    TMPDIR: home.path,
    TMP: home.path,
    TEMP: home.path,
    XDG_CONFIG_HOME: join(home.path, 'config'),
    XDG_CACHE_HOME: join(home.path, 'cache'),
    npm_config_cache: join(home.path, 'npm-cache'),
    npm_config_userconfig: join(home.path, '.npmrc'),
    npm_config_globalconfig: join(home.path, 'global.npmrc'),
    npm_config_registry: network ? 'https://registry.npmjs.org/' : 'http://127.0.0.1:1/',
    UV_OFFLINE: network ? '0' : '1',
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_fetch_timeout: '3000',
    npm_config_fetch_retries: '0',
    DO_NOT_TRACK: '1',
    UV_CACHE_DIR: join(home.path, 'uv-cache'),
    UV_TOOL_DIR: join(home.path, 'uv-tools'),
    UV_TOOL_BIN_DIR: join(home.path, 'uv-bin'),
    UV_PYTHON_INSTALL_DIR: join(home.path, 'python'),
    UV_HTTP_TIMEOUT: '20',
    UV_HTTP_RETRIES: '0',
    UV_PYTHON_DOWNLOADS: 'never',
  };
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
  writeFileSync(join(home.path, '.npmrc'), '');
  writeFileSync(join(home.path, 'global.npmrc'), '');
  resetAcquisitionCache();
  try {
    return await run(home.path);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, prior);
  }
}

export function registryPackage(
  packageSpec: string,
  runtime: 'npx' | 'uvx' = 'npx',
  env?: Record<string, string>,
): RegistryAgent {
  return {
    id: 'acquisition-fixture',
    name: 'Acquisition fixture',
    version: '99.99.99',
    distribution: { [runtime]: { package: packageSpec, args: ['--version'], env } },
  };
}

export function native(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const path = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1];
  const resolved = process.platform === 'win32' ? resolveWindowsCommand(cmd, path) : cmd;
  const wrap = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
  const command = wrap ? windowsCmdWrap(resolved, args) : { cmd: resolved, args };
  return new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve) => {
    execFile(
      command.cmd,
      command.args,
      {
        cwd: process.env.HOME,
        env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: wrap,
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        resolve({
          code: error === null ? 0 : (error.code ?? error.signal ?? error.message),
          stdout,
          stderr: error?.code === 'ENOENT' ? `Missing test prerequisite: ${cmd}` : stderr,
        }),
    );
  });
}

export async function npmNative(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return native('npm', args, env);
}

export function freezeNpmClock(home: string, now: number): void {
  const path = join(home, 'clock.cjs');
  writeFileSync(path, `Date.now = () => ${now};\n`);
  process.env.NODE_OPTIONS = `--require=${JSON.stringify(path)}`;
}

export async function captureChild(
  child: ChildProcess,
  { timeoutMs = 60_000, graceMs = 100 }: { timeoutMs?: number; graceMs?: number } = {},
) {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => void terminateAgentTree(child, { graceMs }), timeoutMs);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('close', resolve);
      child.once('error', reject);
    });
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    await terminateAgentTree(child, { graceMs });
  }
}

export function writeExecutable(path: string, body: string): string {
  if (process.platform === 'win32') {
    const script = `${path}.cjs`;
    writeFileSync(script, `${body}\n`);
    writeFileSync(
      `${path}.cmd`,
      `@echo off\r\n"${process.execPath}" "%~dp0${basename(script)}" %*\r\n`,
    );
    return script;
  }
  writeFileSync(path, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return path;
}

export function npmPackedVersion(stdout: string): string {
  const [selected] = parseNpmOutput(npmPackResult, stdout);
  return selected.version;
}

export function npmPublicationTimes(stdout: string): Record<string, string> {
  const times = z.record(z.string(), z.string());
  return parseNpmOutput(z.union([times, z.tuple([times]).transform(([entry]) => entry)]), stdout);
}

const MAX_NPM_PARSE_OUTPUT_CHARS = 2_048;

function npmIssuePaths(issues: z.core.$ZodIssue[]): Array<Array<string | number>> {
  return issues.flatMap((issue) =>
    issue.code === 'invalid_union'
      ? issue.errors.flatMap(npmIssuePaths)
      : [issue.path.filter((part): part is string | number => typeof part !== 'symbol')],
  );
}

function npmFailureExcerpt(stdout: string, cause: unknown): string {
  const errors: ParseError[] = [];
  const root = parseTree(stdout, errors, { disallowComments: true, allowTrailingComma: false });
  let offset = errors[0]?.offset ?? 0;
  if (cause instanceof z.ZodError && root !== undefined) {
    const paths = npmIssuePaths(cause.issues).sort((a, b) => b.length - a.length);
    for (const path of paths) {
      const node = findNodeAtLocation(root, path);
      if (node === undefined) continue;
      offset = node.offset;
      break;
    }
  }
  const start = Math.max(0, offset - MAX_NPM_PARSE_OUTPUT_CHARS / 2);
  const end = Math.min(stdout.length, start + MAX_NPM_PARSE_OUTPUT_CHARS);
  return `[characters ${start}-${end} of ${stdout.length}] ${stdout.slice(start, end)}`;
}

function parseNpmOutput<T>(schema: z.ZodType<T>, stdout: string): T {
  try {
    return schema.parse(JSON.parse(stdout));
  } catch (cause) {
    throw new Error(`Could not parse npm JSON output: ${npmFailureExcerpt(stdout, cause)}`, {
      cause,
    });
  }
}

export const npmOutputs = z
  .array(
    z.object({
      npmVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
      pack: z.unknown(),
      publicationTimes: z.unknown(),
    }),
  )
  .parse(
    JSON.parse(readFileSync(new URL('./npm-json.test-fixture.json', import.meta.url), 'utf8')),
  );

export function compareVersions(left: string, right: string): number {
  return left.localeCompare(right, 'en', { numeric: true });
}

export function newestAdmissible(times: Record<string, string>, ceiling: string, cutoff: number) {
  const versions = Object.keys(times)
    .filter(
      (version) =>
        /^\d+\.\d+\.\d+$/.test(version) &&
        compareVersions(version, ceiling) <= 0 &&
        Date.parse(times[version]) < cutoff,
    )
    .sort(compareVersions);
  return versions.at(-1);
}

export function acquisitionDescriptors(agents: RegistryAgent[]): {
  id: string;
  npx: RegistryAgent['distribution']['npx'];
  uvx: RegistryAgent['distribution']['uvx'];
}[] {
  return agents
    .filter((agent) => agent.distribution.npx || agent.distribution.uvx)
    .map((agent) => ({ id: agent.id, npx: agent.distribution.npx, uvx: agent.distribution.uvx }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function spawnNpxWithProjectCwd(
  launch: ResolvedLaunch & { kind: 'npx' },
  projectCwd: string,
): ChildProcess {
  // @ts-expect-error npx launches own their cwd and cannot accept a project cwd
  return spawnAcpAgent(launch, projectCwd);
}
