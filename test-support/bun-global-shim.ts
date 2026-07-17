/**
 * `Bun` global facade for running bun-flavored tests under stock Node.
 *
 * Importing this module (it is the shared vitest base config's setup file)
 * installs a `globalThis.Bun` covering the Bun runtime APIs the suites touch:
 * `file`, `write`, `sleep`, `which`, `spawnSync`, `Glob`, `TOML`, `gc`, plus
 * `resolveSync`, `CryptoHasher`, and `Transpiler`. Each maps to a Node
 * equivalent.
 *
 * `Bun.serve` and async `Bun.spawn` have NO facade here: their call sites are
 * rewritten to `node:http` / `node:child_process` per file during the owning
 * package's flip, because a faithful streaming facade would hide semantic
 * differences the rewrites need to make explicit.
 */
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { expect } from 'vitest';

// ---- Bun.Glob (hand-rolled: no glob dependency) ----

/** Escape a literal character for embedding in a RegExp source. */
function escapeRegexChar(c: string): string {
  return /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

/**
 * Translate a glob body to a RegExp source fragment. `*` stays within a path
 * segment, `**` crosses segments, `?` is one non-separator char, `{a,b}` is
 * alternation (its branches may themselves contain globs), `[...]` is a char
 * class. Kept dependency-free so the shim adds no runtime beyond Node + Vitest.
 */
function translateGlob(glob: string): string {
  const chars = [...glob];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '*') {
      if (chars[i + 1] === '*') {
        i++;
        if (chars[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      let depth = 1;
      let j = i + 1;
      let group = '';
      while (j < chars.length && depth > 0) {
        if (chars[j] === '{') depth++;
        else if (chars[j] === '}') {
          depth--;
          if (depth === 0) break;
        }
        group += chars[j];
        j++;
      }
      const branches = group.split(',').map((alt) => translateGlob(alt));
      out += `(?:${branches.join('|')})`;
      i = j;
    } else if (c === '[') {
      let j = i + 1;
      let cls = '[';
      if (chars[j] === '!') {
        cls += '^';
        j++;
      }
      while (j < chars.length && chars[j] !== ']') {
        cls += chars[j];
        j++;
      }
      cls += ']';
      out += cls;
      i = j;
    } else {
      out += escapeRegexChar(c);
    }
  }
  return out;
}

interface GlobScanOptions {
  cwd?: string;
  absolute?: boolean;
  onlyFiles?: boolean;
}

class BunGlobFacade {
  readonly #regex: RegExp;
  constructor(pattern: string) {
    this.#regex = new RegExp(`^${translateGlob(pattern)}$`);
  }

  match(candidate: string): boolean {
    return this.#regex.test(candidate);
  }

  *scanSync(options: GlobScanOptions | string = {}): Generator<string> {
    const opts = typeof options === 'string' ? { cwd: options } : options;
    const cwd = opts.cwd ?? process.cwd();
    const absolute = opts.absolute ?? false;
    const onlyFiles = opts.onlyFiles ?? true;
    const walk = (dir: string, prefix: string): string[] => {
      const results: string[] = [];
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return results;
      }
      for (const entry of entries) {
        // Bun.Glob defaults to `dot: false`: a segment starting with `.`
        // (dot-dirs like `.git`/`.ok`, dotfiles) is never matched or descended.
        if (entry.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!onlyFiles && this.#regex.test(rel)) results.push(rel);
          results.push(...walk(path.join(dir, entry.name), rel));
        } else if (this.#regex.test(rel)) {
          results.push(rel);
        }
      }
      return results;
    };
    for (const rel of walk(cwd, '')) {
      yield absolute ? path.join(cwd, rel) : rel;
    }
  }

  async *scan(options: GlobScanOptions | string = {}): AsyncGenerator<string> {
    for (const entry of this.scanSync(options)) yield entry;
  }
}

// ---- Bun.file ----

function bunFile(target: string | URL) {
  const filePath = target instanceof URL ? target.pathname : target;
  return {
    get name() {
      return filePath;
    },
    get size() {
      try {
        return fs.statSync(filePath).size;
      } catch {
        return 0;
      }
    },
    async text(): Promise<string> {
      return fs.promises.readFile(filePath, 'utf8');
    },
    async json(): Promise<unknown> {
      return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    },
    async bytes(): Promise<Uint8Array> {
      return new Uint8Array(await fs.promises.readFile(filePath));
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      const buf = await fs.promises.readFile(filePath);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    },
    async exists(): Promise<boolean> {
      try {
        await fs.promises.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
    async stat(): Promise<fs.Stats> {
      return fs.promises.stat(filePath);
    },
  };
}

// ---- Bun.write ----

function destinationPath(destination: string | URL | { name: string }): string {
  if (typeof destination === 'string') return destination;
  if (destination instanceof URL) return fileURLToPath(destination);
  return destination.name;
}

/**
 * Minimal `Bun.write`: writes `input` to `destination`, creating parent
 * directories (Bun does this implicitly), and resolves to the byte count.
 * Covers the string / typed-array / ArrayBuffer inputs the suites pass.
 */
async function bunWrite(
  destination: string | URL | { name: string },
  input: string | ArrayBufferView | ArrayBuffer,
): Promise<number> {
  const filePath = destinationPath(destination);
  let bytes: Buffer;
  if (typeof input === 'string') {
    bytes = Buffer.from(input, 'utf8');
  } else if (input instanceof ArrayBuffer) {
    bytes = Buffer.from(input);
  } else {
    bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, bytes);
  return bytes.byteLength;
}

// ---- Bun.sleep ----

function bunSleep(ms: number | Date): Promise<void> {
  const delay = ms instanceof Date ? ms.getTime() - Date.now() : ms;
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, delay));
  });
}

// ---- Bun.which ----

function bunWhich(command: string, options?: { PATH?: string; cwd?: string }): string | null {
  const searchPath = options?.PATH ?? process.env.PATH ?? '';
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* not executable here — keep searching PATH */
    }
  }
  return null;
}

// ---- Bun.spawnSync (via node:child_process) ----

interface SpawnSyncOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string | Uint8Array;
}

function bunSpawnSync(
  cmd: string[] | ({ cmd: string[] } & SpawnSyncOptions),
  options?: SpawnSyncOptions,
) {
  const argv = Array.isArray(cmd) ? cmd : cmd.cmd;
  const opts = Array.isArray(cmd) ? (options ?? {}) : cmd;
  const [file, ...args] = argv;
  const result = nodeSpawnSync(file, args, {
    cwd: opts.cwd,
    env: opts.env as NodeJS.ProcessEnv | undefined,
    input: opts.stdin,
  });
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ?? Buffer.alloc(0);
  return {
    stdout,
    stderr,
    exitCode: result.status ?? 0,
    signalCode: result.signal,
    success: result.status === 0,
    pid: result.pid,
  };
}

// ---- Bun.resolveSync ----

/**
 * bun's `Bun.resolveSync` does not apply the `development` export condition,
 * but the Vitest worker runs with `--conditions development` in its execArgv,
 * so Node's `require.resolve` / `import.meta.resolve` would pick a package's
 * `development` target (e.g. micromark and mdast-util-from-markdown ship a
 * `./dev/` build under that condition). Production conditions match what bun
 * resolves to.
 */
const PRODUCTION_CONDITIONS = ['node', 'import', 'require', 'default'];

/**
 * Walk an `exports` value (string, array, or conditions object) picking the
 * first branch that matches a production condition, in the object's own key
 * order — the same first-match semantics Node uses. Returns null when nothing
 * matches (e.g. a purely `development`-gated target under production).
 */
function selectExportsTarget(node: unknown, conditions: string[]): string | null {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    for (const entry of node) {
      const hit = selectExportsTarget(entry, conditions);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'default' || conditions.includes(key)) {
        const hit = selectExportsTarget(value, conditions);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/**
 * Codes where the CJS `require.resolve` legitimately fails but the module still
 * resolves via the ESM resolver — a package with an `import`-only exports map,
 * a directory import, an ESM target. Bun.resolveSync resolves these, so fall
 * back to `import.meta.resolve`. Any OTHER failure (a malformed package.json or
 * exports target) is a real error and surfaces rather than being papered over
 * by a fallback that could return a different resolution.
 */
const ESM_RESOLVER_FALLBACK_CODES = new Set([
  'MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_REQUIRE_ESM',
  'ERR_UNSUPPORTED_DIR_IMPORT',
  'ERR_PACKAGE_IMPORT_NOT_DEFINED',
]);

function bunResolveSync(specifier: string, from: string): string {
  const fromFile = from.endsWith('/') ? `${from}noop.js` : `${from}/noop.js`;
  const require = createRequire(fromFile);
  const resolveAny = (): string => {
    try {
      return require.resolve(specifier);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (!code || !ESM_RESOLVER_FALLBACK_CODES.has(code)) throw err;
      return fileURLToPath(import.meta.resolve(specifier, pathToFileURL(fromFile).href));
    }
  };
  // Relative/absolute specifiers never touch an exports map.
  if (specifier.startsWith('.') || specifier.startsWith('/')) return resolveAny();

  const resolved = resolveAny().replaceAll('\\', '/');
  const segments = specifier.split('/');
  const pkgName = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
  const marker = `/node_modules/${pkgName}/`;
  const at = resolved.lastIndexOf(marker);
  if (at === -1) return resolved;
  const pkgRoot = resolved.slice(0, at + marker.length - 1);

  let pkg: { exports?: unknown; main?: string };
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
  } catch {
    return resolved;
  }

  const subKey = `.${specifier.slice(pkgName.length)}`;
  let target: string | null = null;
  const exportsField = pkg.exports;
  if (typeof exportsField === 'string') {
    if (subKey === '.') target = exportsField;
  } else if (exportsField && typeof exportsField === 'object') {
    const record = exportsField as Record<string, unknown>;
    const isSubpathMap = Object.keys(record).some((key) => key === '.' || key.startsWith('./'));
    if (isSubpathMap) {
      if (record[subKey] !== undefined)
        target = selectExportsTarget(record[subKey], PRODUCTION_CONDITIONS);
    } else if (subKey === '.') {
      target = selectExportsTarget(record, PRODUCTION_CONDITIONS);
    }
  }
  target ??= subKey === '.' ? (pkg.main ?? 'index.js') : specifier.slice(pkgName.length + 1);
  return path.join(pkgRoot, target);
}

// ---- Bun.CryptoHasher ----

class BunCryptoHasherFacade {
  #hash: ReturnType<typeof createHash>;
  constructor(algorithm: string) {
    this.#hash = createHash(algorithm);
  }
  update(data: string | ArrayBufferView): this {
    this.#hash.update(data as Buffer);
    return this;
  }
  digest(encoding: 'hex' | 'base64'): string {
    return this.#hash.digest(encoding);
  }
}

// ---- Bun.Transpiler ----

/**
 * bun's `Transpiler` strips/compiles TypeScript to JavaScript and throws on a
 * syntax error. Node's `stripTypeScriptTypes` in `transform` mode is the
 * dependency-free equivalent: it compiles TS-only constructs (enums, parameter
 * properties) rather than only erasing annotations, and throws on invalid
 * syntax — the property the callers assert. Only the sync path the suites use
 * is provided.
 */
class BunTranspilerFacade {
  constructor(_options?: { loader?: string }) {}
  transformSync(code: string): string {
    return stripTypeScriptTypes(code, { mode: 'transform' });
  }
  async transform(code: string): Promise<string> {
    return stripTypeScriptTypes(code, { mode: 'transform' });
  }
}

// ---- assembled facade ----

export const bunFacade = {
  file: bunFile,
  write: bunWrite,
  sleep: bunSleep,
  which: bunWhich,
  spawnSync: bunSpawnSync,
  Glob: BunGlobFacade,
  TOML: { parse: parseToml, stringify: stringifyToml },
  gc: (_force?: boolean) => {
    (globalThis as { gc?: () => void }).gc?.();
  },
  resolveSync: bunResolveSync,
  CryptoHasher: BunCryptoHasherFacade,
  Transpiler: BunTranspilerFacade,
};

/**
 * Install the facade as `globalThis.Bun`, idempotently. A real `Bun` global
 * (should these ever run under bun again) wins; the `??=` never clobbers it.
 */
export function installBunGlobal(): void {
  const g = globalThis as Record<string, unknown> & typeof globalThis;
  g.Bun ??= bunFacade as unknown as typeof globalThis.Bun;
  // bun exposes the web `self` alias (=== globalThis) even in its non-DOM test
  // runtime; browser-targeting app modules read it at import time. Node's
  // node-env has no `self`, so provide the same alias. jsdom-env tiers already
  // define `self` (their window), which the `??=` preserves.
  g.self ??= globalThis;
}

installBunGlobal();

// ---- bun `expect` matcher surface ----

/**
 * bun's `expect` ships a jest-extended-flavored matcher set on top of the Jest
 * core matchers. Vitest's `expect` provides the core matchers only, so the suite
 * matchers below (the ones OK's tests actually use) are registered here. Only
 * these are added; the rest of the surface stays Vitest's.
 */
interface BunMatchers<R = unknown> {
  toStartWith(prefix: string): R;
  toEndWith(suffix: string): R;
  toBeString(): R;
  toBeFunction(): R;
  toBeArray(): R;
  toBeTrue(): R;
  toBeFalse(): R;
}

declare module 'vitest' {
  interface Assertion<T = unknown> extends BunMatchers<T> {}
  interface AsymmetricMatchersContaining extends BunMatchers {}
}

interface MatcherContext {
  isNot: boolean;
  utils: { printReceived(v: unknown): string; printExpected(v: unknown): string };
}

function typeMatcher(name: string, predicate: (received: unknown) => boolean) {
  return function (this: MatcherContext, received: unknown) {
    return {
      pass: predicate(received),
      message: () =>
        `expected ${this.utils.printReceived(received)} to ${this.isNot ? 'not ' : ''}be ${name}`,
    };
  };
}

expect.extend({
  toStartWith(this: MatcherContext, received: unknown, prefix: string) {
    return {
      pass: typeof received === 'string' && received.startsWith(prefix),
      message: () =>
        `expected ${this.utils.printReceived(received)} to ${this.isNot ? 'not ' : ''}start with ${this.utils.printExpected(prefix)}`,
    };
  },
  toEndWith(this: MatcherContext, received: unknown, suffix: string) {
    return {
      pass: typeof received === 'string' && received.endsWith(suffix),
      message: () =>
        `expected ${this.utils.printReceived(received)} to ${this.isNot ? 'not ' : ''}end with ${this.utils.printExpected(suffix)}`,
    };
  },
  toBeString: typeMatcher('a string', (v) => typeof v === 'string'),
  toBeFunction: typeMatcher('a function', (v) => typeof v === 'function'),
  toBeArray: typeMatcher('an array', (v) => Array.isArray(v)),
  toBeTrue: typeMatcher('true', (v) => v === true),
  toBeFalse: typeMatcher('false', (v) => v === false),
});
