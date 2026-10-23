import childProcess from 'node:child_process';
import {
  type Dirent,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { aroundAll, expect } from 'vitest';
import { derivedReads } from './read-declarations-closure';
import { declares, type ReadDeclaration, withDerivedReads } from './read-declarations-match';
import {
  installReadObserver,
  observerNodeOptions,
  READ_LOG_ENV,
  READ_ROOT_ENV,
} from './read-declarations-observer';

const runGit = childProcess.spawnSync;
const OK_ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const DECLARATION_MODULE = /\.reads\.(?:ts|mjs)$/;
const LISTING_BUFFER_BYTES = 256 * 1024 * 1024;
const PUBLIC_TREE_OMITS = '*.private.*';
const UNWALKED_DIRECTORIES = new Set(['.git', 'node_modules']);

type Declared = { module: string; declaration: ReadDeclaration; roots: string[] };

function isGlobList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((glob) => typeof glob === 'string');
}

function display(path: string): string {
  const within = relative(OK_ROOT, path);
  return within.startsWith('..') || isAbsolute(within) ? path : within.split(sep).join('/');
}

function entriesOf(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function holdsOnDiskAFileThePublicTreeOmits(): boolean {
  const pending = [OK_ROOT];
  for (const dir of pending) {
    for (const entry of entriesOf(dir)) {
      if (entry.isFile() && matchesGlob(entry.name, PUBLIC_TREE_OMITS)) return true;
      if (entry.isDirectory() && !UNWALKED_DIRECTORIES.has(entry.name)) {
        pending.push(join(dir, entry.name));
      }
    }
  }
  return false;
}

function holdsAPathThePublicTreeOmits(): boolean {
  const listed = runGit('git', ['ls-files', '-z', '--', PUBLIC_TREE_OMITS], {
    cwd: OK_ROOT,
    encoding: 'utf8',
    maxBuffer: LISTING_BUFFER_BYTES,
  });
  if (listed.error === undefined && listed.status === 0) return listed.stdout !== '';
  return holdsOnDiskAFileThePublicTreeOmits();
}

async function declarationFor(testPath: string): Promise<Declared | null> {
  const dir = dirname(testPath);
  const testName = basename(testPath);
  const candidates = readdirSync(dir)
    .filter(
      (entry) =>
        DECLARATION_MODULE.test(entry) &&
        testName.startsWith(`${entry.replace(DECLARATION_MODULE, '')}.`),
    )
    .sort();
  if (candidates.length === 0 || !holdsAPathThePublicTreeOmits()) return null;
  for (const name of candidates) {
    const module = join(dir, name);
    const loaded = (await import(module)) as {
      ROUND_READS?: { test?: unknown; include?: unknown; exclude?: unknown; roots?: unknown };
    };
    const declared = loaded.ROUND_READS;
    if (typeof declared?.test !== 'string' || resolve(dir, declared.test) !== testPath) continue;
    const { include = [], exclude = [], roots = [] } = declared;
    if (!isGlobList(include) || !isGlobList(exclude) || !isGlobList(roots)) {
      throw new Error(
        `The read declaration ${display(module)} names ${display(testPath)} but its include, exclude or roots is not a list of globs.`,
      );
    }
    return { module, declaration: { include, exclude }, roots };
  }
  return null;
}

function listedPaths(): Set<string> {
  const listed = runGit('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: OK_ROOT,
    encoding: 'utf8',
    maxBuffer: LISTING_BUFFER_BYTES,
  });
  if (listed.error !== undefined || listed.status !== 0) {
    throw new Error(
      `git ls-files could not list the files under ${OK_ROOT} (${listed.error?.message ?? listed.stderr.trim()}), so no read declaration can be checked.`,
    );
  }
  return new Set(listed.stdout.split('\0').filter((path) => path !== ''));
}

function undeclaredReads(declared: Declared, logDir: string, testPath: string): string[] {
  const read = new Set<string>();
  for (const name of readdirSync(logDir)) {
    for (const line of readFileSync(join(logDir, name), 'utf8').split('\n')) {
      if (line !== '') read.add(line);
    }
  }
  const listed = listedPaths();
  const coverage = withDerivedReads(
    declared.declaration,
    derivedReads(OK_ROOT, declared.roots, listed, (glob, path) =>
      declares({ include: [glob] }, path),
    ),
  );
  const exempt = new Set([display(testPath), display(declared.module)]);
  const undeclared = new Set<string>();
  const judge = (path: string): void => {
    if (listed.has(path) && !exempt.has(path) && !declares(coverage, path)) undeclared.add(path);
  };
  for (const path of read) {
    const real = existsSync(path) ? realpathSync(path) : path;
    const within = relative(OK_ROOT, real);
    if (within === '' || within.startsWith('..') || isAbsolute(within)) continue;
    const okPath = within.split(sep).join('/');
    if (existsSync(real) && statSync(real).isDirectory()) {
      for (const entry of listed) if (entry.startsWith(`${okPath}/`)) judge(entry);
    } else {
      judge(okPath);
    }
  }
  return [...undeclared].sort();
}

function undeclaredFailure(declared: Declared, testPath: string, undeclared: string[]): Error {
  const declaration = display(declared.module);
  return new Error(
    [
      `${display(testPath)} read ${undeclared.length} tracked file(s) at run time that its read declaration ${declaration} does not list, so a change to one of them would not select it:`,
      ...undeclared.map((path) => `  ${path}`),
      `List each path, or a glob covering it, in ROUND_READS.include of ${declaration}; a module the run loads by path goes in ROUND_READS.roots instead, which also covers what it imports.`,
    ].join('\n'),
  );
}

const testPath = expect.getState().testPath;
const declared = testPath === undefined ? null : await declarationFor(testPath);

if (testPath !== undefined && declared !== null) {
  const logDir = mkdtempSync(join(tmpdir(), 'ok-read-declaration-'));
  const saved = [READ_LOG_ENV, READ_ROOT_ENV, 'NODE_OPTIONS'].map(
    (name) => [name, process.env[name]] as const,
  );
  process.env[READ_ROOT_ENV] = OK_ROOT;
  process.env[READ_LOG_ENV] = logDir;
  process.env.NODE_OPTIONS = observerNodeOptions(process.env.NODE_OPTIONS);
  installReadObserver(logDir);
  process.once('exit', () => rmSync(logDir, { recursive: true, force: true }));

  aroundAll(async (runSuite) => {
    try {
      await runSuite();
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    try {
      const undeclared = undeclaredReads(declared, logDir, testPath);
      if (undeclared.length > 0) throw undeclaredFailure(declared, testPath, undeclared);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
}
