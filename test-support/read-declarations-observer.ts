import { Buffer } from 'node:buffer';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { promisify } from 'node:util';

export const READ_LOG_ENV = 'OK_READ_DECLARATION_LOG';
export const READ_ROOT_ENV = 'OK_READ_DECLARATION_ROOT';

const OBSERVER_IMPORT = `--import=${pathToFileURL(fileURLToPath(import.meta.url)).href}`;
const INSTALLED = Symbol.for('ok.test.readDeclarations.observerInstalled');

const openLog = fs.openSync;
const closeLog = fs.closeSync;
const writeLog = fs.writeSync;

type Log = { dir: string; fd: number; seen: Set<string> };
let log: Log | null = null;

function openLogFile(path: string): number {
  try {
    return openLog(path, 'a');
  } catch (cause) {
    throw new Error(
      `The read-declaration observer could not open ${path}, the log ${READ_LOG_ENV} names for this process, so the files this process reads could not be checked against its read declaration.`,
      { cause },
    );
  }
}

function logFor(dir: string): Log {
  if (log?.dir === dir) return log;
  const fd = openLogFile(join(dir, `${process.pid}.log`));
  if (log !== null) closeLog(log.fd);
  log = { dir, fd, seen: new Set() };
  return log;
}

function note(path: string | null): void {
  const dir = process.env[READ_LOG_ENV];
  const root = process.env[READ_ROOT_ENV];
  if (!dir || !root || path === null) return;
  if (!path.startsWith(`${root}${sep}`) || path.includes(`${sep}node_modules${sep}`)) return;
  const current = logFor(dir);
  if (current.seen.has(path)) return;
  current.seen.add(path);
  writeLog(current.fd, `${path}\n`);
}

function fsPath(target: unknown): string | null {
  if (typeof target === 'string') return resolve(target);
  if (target instanceof URL) return target.protocol === 'file:' ? fileURLToPath(target) : null;
  if (Buffer.isBuffer(target)) return resolve(target.toString());
  return null;
}

const { O_CREAT, O_EXCL, O_TRUNC, O_WRONLY } = fs.constants;
const CREATES_EXCLUSIVELY = O_CREAT | O_EXCL;
const READING_FLAG = /[r+]/;
const TRUNCATING_OR_EXCLUSIVE_FLAG = /[wx]/;

function opensForRead(flags: unknown): boolean {
  if (flags === undefined || flags === null || typeof flags === 'function') return true;
  if (typeof flags === 'string') {
    return READING_FLAG.test(flags) && !TRUNCATING_OR_EXCLUSIVE_FLAG.test(flags);
  }
  if (typeof flags === 'number') {
    return (
      (flags & 3) !== O_WRONLY &&
      (flags & O_TRUNC) === 0 &&
      (flags & CREATES_EXCLUSIVELY) !== CREATES_EXCLUSIVELY
    );
  }
  return false;
}

type Callable = (this: unknown, ...args: unknown[]) => unknown;

function replace(target: object, name: string, make: (original: Callable) => Callable): void {
  const host = target as Record<string, unknown>;
  const original = host[name];
  if (typeof original !== 'function') return;
  const wrapped = make(original as Callable);
  for (const key of Reflect.ownKeys(original)) {
    if (key === 'length' || key === 'name' || key === 'prototype') continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(original, key);
    if (descriptor === undefined) continue;
    if (key === promisify.custom) descriptor.value = make(descriptor.value);
    Reflect.defineProperty(wrapped, key, descriptor);
  }
  Reflect.defineProperty(wrapped, 'name', { value: original.name });
  host[name] = wrapped;
}

function observeRead(target: object, name: string, pick: (args: unknown[]) => unknown): void {
  replace(
    target,
    name,
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        note(fsPath(pick(args)));
        return original.apply(this, args);
      },
  );
}

export function observerNodeOptions(current: string | undefined): string {
  const options = current ?? '';
  return options.includes(OBSERVER_IMPORT) ? options : `${options} ${OBSERVER_IMPORT}`.trim();
}

function withObserver(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const dir = process.env[READ_LOG_ENV];
  const root = process.env[READ_ROOT_ENV];
  if (!dir || !root) return env;
  return {
    ...env,
    [READ_LOG_ENV]: dir,
    [READ_ROOT_ENV]: root,
    NODE_OPTIONS: observerNodeOptions(env.NODE_OPTIONS),
  };
}

function observeSpawner(name: string, takesArgs: boolean): void {
  replace(
    childProcess,
    name,
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        const at = takesArgs && Array.isArray(args[1]) ? 2 : 1;
        const options = args[at];
        if (options !== null && typeof options === 'object' && 'env' in options) {
          const env = (options as { env?: NodeJS.ProcessEnv }).env;
          if (env !== undefined && env !== null) args[at] = { ...options, env: withObserver(env) };
        }
        return original.apply(this, args);
      },
  );
}

export function installReadObserver(logDir: string): void {
  logFor(logDir);
  const state = globalThis as typeof globalThis & { [INSTALLED]?: true };
  if (state[INSTALLED] === true) return;
  state[INSTALLED] = true;

  const first = (args: unknown[]) => args[0];
  const readOpen = (args: unknown[]) => (opensForRead(args[1]) ? args[0] : null);
  for (const name of [
    'readFileSync',
    'readFile',
    'createReadStream',
    'copyFileSync',
    'copyFile',
    'cpSync',
    'cp',
  ]) {
    observeRead(fs, name, first);
  }
  for (const name of ['openSync', 'open']) observeRead(fs, name, readOpen);
  for (const name of ['readFile', 'copyFile', 'cp']) observeRead(fs.promises, name, first);
  observeRead(fs.promises, 'open', readOpen);

  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'])
    observeSpawner(name, true);
  for (const name of ['exec', 'execSync']) observeSpawner(name, false);
  syncBuiltinESMExports();

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (resolved.url.startsWith('file:')) note(fileURLToPath(resolved.url));
      return resolved;
    },
  });
}

const inheritedLogDir = process.env[READ_LOG_ENV];
if (inheritedLogDir && process.env[READ_ROOT_ENV]) installReadObserver(inheritedLogDir);
