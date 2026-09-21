import { execFile, spawn } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const execFileAsync = promisify(execFile);

const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT_NAME = 'copy-excalidraw-assets.mjs';
const PACKAGE_DIR = realpathSync(join(APP_ROOT, 'node_modules', '@excalidraw', 'excalidraw'));
const SOURCE_FONTS = join(PACKAGE_DIR, 'dist', 'prod', 'fonts');
const VENDORED_VERSION: string = JSON.parse(
  readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf-8'),
).version;

const PREDEV_WORKERS = 4;
const COLD_ROUNDS = 3;
const STALE_ROUNDS = 3;
const INTERRUPT_ROUNDS = 3;
const STALE_VERSION = '0.0.0-stale';
const STALE_FONT_COUNT = 8;
const PUBLISHED_DIR_MODE = 0o755;
const PUBLISHED_FILE_MODE = 0o644;
const STRICT_UMASK = '077';
const POLL_MS = 1;
const RENAME_FAULT_HOOKS = 'rename-fault-hooks.mjs';
const EVICT_RENAME_CALL = 1;
const PUBLISH_RENAME_CALL = 2;
const REINSTATE_RENAME_CALL = 3;
const SUPERSEDED_SUFFIX = '-superseded';
const FAULT_MISTARGET = 'rename-fault mistargeted';

type RenameSite = 'dst' | 'staged' | 'superseded';
interface RenameTarget {
  from: RenameSite;
  to: RenameSite;
}
const PUBLISHES: RenameTarget = { from: 'staged', to: 'dst' };

interface Run {
  code: number | string | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

let fixtureEntries: string[] = [];

function stageAppRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-excalidraw-assets-')));
  mkdirSync(join(root, 'scripts'));
  cpSync(join(APP_ROOT, 'scripts', SCRIPT_NAME), join(root, 'scripts', SCRIPT_NAME));
  symlinkSync(join(APP_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  return root;
}

async function captureRun(command: string, args: string[]): Promise<Run> {
  try {
    const { stderr } = await execFileAsync(command, args, { encoding: 'utf-8' });
    return { code: 0, signal: null, stderr };
  } catch (err) {
    const failure = err as { code?: unknown; signal?: unknown; stderr?: unknown };
    return {
      code:
        typeof failure.code === 'number' || typeof failure.code === 'string' ? failure.code : null,
      signal: typeof failure.signal === 'string' ? (failure.signal as NodeJS.Signals) : null,
      stderr: typeof failure.stderr === 'string' ? failure.stderr : String(err),
    };
  }
}

async function runPredevStep(root: string, umask?: string): Promise<Run> {
  const script = join(root, 'scripts', SCRIPT_NAME);
  const [command, args] =
    umask === undefined
      ? [process.execPath, [script]]
      : ['/bin/sh', ['-c', `umask ${umask} && exec "$0" "$1"`, process.execPath, script]];
  return captureRun(command, args);
}

function writeRenameFaultHooks(
  root: string,
  failingCall: number,
  target: RenameTarget,
  peerPublishesBefore: number[] = [],
): string {
  const file = join(root, RENAME_FAULT_HOOKS);
  writeFileSync(
    file,
    `import { registerHooks } from 'node:module';

const SYNTHETIC_URL = 'ok-test:fs-rename-fault';
const SYNTHETIC_SOURCE = \`export * from 'node:fs';
const fs = process.getBuiltinModule('fs');
const FAILING_CALL = ${failingCall};
const EXPECT_FROM = ${JSON.stringify(target.from)};
const EXPECT_TO = ${JSON.stringify(target.to)};
const describe = (p) => (p.includes('${SUPERSEDED_SUFFIX}') ? 'superseded' : p.endsWith('excalidraw-assets') ? 'dst' : 'staged');
const PEER_PUBLISHES_BEFORE = ${JSON.stringify(peerPublishesBefore)};
let calls = 0;
export function renameSync(from, to) {
  calls += 1;
  if (PEER_PUBLISHES_BEFORE.includes(calls)) {
    process.getBuiltinModule('child_process').execFileSync(process.execPath, [process.argv[1]]);
  }
  if (calls !== FAILING_CALL) return fs.renameSync(from, to);
  const actual = describe(String(from)) + '->' + describe(String(to));
  const wanted = EXPECT_FROM + '->' + EXPECT_TO;
  if (actual !== wanted) {
    throw new Error('${FAULT_MISTARGET}: call ' + FAILING_CALL + ' renames ' + actual + ', not ' + wanted);
  }
  const failure = new Error('EACCES: permission denied, rename');
  failure.code = 'EACCES';
  throw failure;
}
\`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:fs' && context.parentURL?.endsWith('${SCRIPT_NAME}')) {
      return { url: SYNTHETIC_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === SYNTHETIC_URL) {
      return { format: 'module', shortCircuit: true, source: SYNTHETIC_SOURCE };
    }
    return nextLoad(url, context);
  },
});
`,
    'utf-8',
  );
  return file;
}

async function runPredevStepWithRenameFaults(
  root: string,
  failingCall: number,
  target: RenameTarget,
  peerPublishesBefore: number[] = [],
): Promise<Run> {
  const hooks = writeRenameFaultHooks(root, failingCall, target, peerPublishesBefore);
  return captureRun(process.execPath, [
    '--import',
    pathToFileURL(hooks).href,
    join(root, 'scripts', SCRIPT_NAME),
  ]);
}

async function runPredevStepInterrupted(root: string, inFlight: () => boolean): Promise<boolean> {
  const proc = spawn(process.execPath, [join(root, 'scripts', SCRIPT_NAME)], { stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  let interrupted = false;
  while (proc.exitCode === null && proc.signalCode === null) {
    if (inFlight()) {
      proc.kill('SIGKILL');
      interrupted = true;
      break;
    }
    await wait(POLL_MS);
  }
  await exited;
  return interrupted;
}

function describeFailure(run: Run): string {
  const named = run.stderr.split('\n').find((line) => line.startsWith('Error:'));
  if (named !== undefined) return named;
  if (run.stderr !== '') return run.stderr;
  return run.signal !== null ? `killed by ${run.signal}` : `exited with code ${String(run.code)}`;
}

function failureLines(runs: Run[]): string[] {
  return runs.filter((run) => run.code !== 0).map(describeFailure);
}

function vendoredDir(root: string): string {
  return join(root, 'public', 'excalidraw-assets');
}

function markerName(version: string): string {
  return `.copied-from-${version}`;
}

function markerPath(root: string, version = VENDORED_VERSION): string {
  return join(vendoredDir(root), markerName(version));
}

function displacedTrees(root: string): string[] {
  return readdirSync(root)
    .filter((name) => name.endsWith(SUPERSEDED_SUFFIX))
    .map((name) => join(root, name));
}

function publicEntries(root: string): string[] {
  const publicDir = join(root, 'public');
  return existsSync(publicDir) ? readdirSync(publicDir).sort() : [];
}

function strayPublicEntries(root: string): string[] {
  return publicEntries(root).filter((name) => name !== 'excalidraw-assets');
}

function strayRootEntries(root: string): string[] {
  return readdirSync(root).filter((name) => name !== 'public' && !fixtureEntries.includes(name));
}

function publishInFlight(root: string): boolean {
  return strayRootEntries(root).length > 0 || strayPublicEntries(root).length > 0;
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

interface TreeEntries {
  directories: string[];
  files: string[];
}

function entriesUnder(dir: string, collected: TreeEntries = { directories: [], files: [] }) {
  collected.directories.push(dir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) entriesUnder(full, collected);
    else collected.files.push(full);
  }
  return collected;
}

function unlockTree(dir: string): void {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) unlockTree(join(dir, entry.name));
  }
}

function staleFontNames(): string[] {
  return Array.from({ length: STALE_FONT_COUNT }, (_, index) => `Stale${index}.woff2`).sort();
}

function seedStaleVendoredDir(root: string): void {
  const fonts = join(vendoredDir(root), 'fonts');
  mkdirSync(fonts, { recursive: true });
  for (const name of staleFontNames()) {
    writeFileSync(join(fonts, name), 'stale', 'utf-8');
  }
  writeFileSync(markerPath(root, STALE_VERSION), `${STALE_VERSION}\n`, 'utf-8');
}

describe('copy-excalidraw-assets predev step', () => {
  let root: string;

  beforeEach(() => {
    root = stageAppRoot();
    fixtureEntries = readdirSync(root);
  });

  afterEach(() => {
    unlockTree(root);
    rmSync(root, { recursive: true, force: true });
  });

  test('concurrent invocations against a cold destination all succeed', async () => {
    const failures: string[] = [];
    for (let round = 0; round < COLD_ROUNDS; round += 1) {
      rmSync(vendoredDir(root), { recursive: true, force: true });
      const runs = await Promise.all(
        Array.from({ length: PREDEV_WORKERS }, () => runPredevStep(root)),
      );
      failures.push(...failureLines(runs));
    }

    expect(failures).toEqual([]);
    expect(existsSync(markerPath(root))).toBe(true);
    expect(readdirSync(join(vendoredDir(root), 'fonts')).sort()).toEqual(
      readdirSync(SOURCE_FONTS).sort(),
    );
    expect(publicEntries(root)).toEqual(['excalidraw-assets']);
    expect(strayRootEntries(root)).toEqual([]);
  });

  test('every entry of the published tree carries a chosen mode under a strict umask', async () => {
    const run = await runPredevStep(root, STRICT_UMASK);

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const { directories, files } = entriesUnder(vendoredDir(root));
    expect(directories.length).toBeGreaterThan(2);
    expect(files.length).toBeGreaterThan(1);
    expect(directories.filter((path) => modeOf(path) !== PUBLISHED_DIR_MODE)).toEqual([]);
    expect(files.filter((path) => modeOf(path) !== PUBLISHED_FILE_MODE)).toEqual([]);
  });

  test('a destination vendored from another version is republished', async () => {
    seedStaleVendoredDir(root);

    const run = await runPredevStep(root);

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(existsSync(markerPath(root))).toBe(true);
    expect(existsSync(markerPath(root, STALE_VERSION))).toBe(false);
    expect(readdirSync(join(vendoredDir(root), 'fonts')).sort()).toEqual(
      readdirSync(SOURCE_FONTS).sort(),
    );
  });

  test('concurrent invocations against a stale destination all republish', async () => {
    const failures: string[] = [];
    for (let round = 0; round < STALE_ROUNDS; round += 1) {
      rmSync(vendoredDir(root), { recursive: true, force: true });
      seedStaleVendoredDir(root);
      const runs = await Promise.all(
        Array.from({ length: PREDEV_WORKERS }, () => runPredevStep(root)),
      );
      failures.push(...failureLines(runs));
    }

    expect(failures).toEqual([]);
    expect(existsSync(markerPath(root))).toBe(true);
    expect(existsSync(markerPath(root, STALE_VERSION))).toBe(false);
    expect(readdirSync(join(vendoredDir(root), 'fonts')).sort()).toEqual(
      readdirSync(SOURCE_FONTS).sort(),
    );
    expect(publicEntries(root)).toEqual(['excalidraw-assets']);
    expect(strayRootEntries(root)).toEqual([]);
  });

  test('a displaced tree that cannot be removed still publishes, and says so', async () => {
    seedStaleVendoredDir(root);
    chmodSync(join(vendoredDir(root), 'fonts'), 0o500);

    const run = await runPredevStep(root);

    expect(run.code).toBe(0);
    expect(run.stderr).toMatch(
      /\[copy-excalidraw-assets\] could not remove \S+: E[A-Z]+; leaving it behind/,
    );
    expect(existsSync(markerPath(root))).toBe(true);
    expect(existsSync(markerPath(root, STALE_VERSION))).toBe(false);
    expect(readdirSync(join(vendoredDir(root), 'fonts')).sort()).toEqual(
      readdirSync(SOURCE_FONTS).sort(),
    );
    expect(strayRootEntries(root)).not.toEqual([]);
  });

  test('staging happens outside public/, so a run killed mid-staging leaves nothing there', async () => {
    for (let round = 0; round < INTERRUPT_ROUNDS; round += 1) {
      rmSync(vendoredDir(root), { recursive: true, force: true });
      for (const name of strayRootEntries(root)) {
        rmSync(join(root, name), { recursive: true, force: true });
      }
      expect(publishInFlight(root)).toBe(false);

      const interrupted = await runPredevStepInterrupted(root, () => publishInFlight(root));

      expect(interrupted).toBe(true);
      expect(strayPublicEntries(root)).toEqual([]);
    }
  });

  test('a publish that cannot land preserves the displaced tree beside public/, and says where', async () => {
    seedStaleVendoredDir(root);

    const run = await runPredevStepWithRenameFaults(root, PUBLISH_RENAME_CALL, PUBLISHES);

    expect(run.stderr).not.toMatch(FAULT_MISTARGET);
    expect(run.code).not.toBe(0);
    const [preserved, ...extra] = displacedTrees(root);
    expect(extra).toEqual([]);
    expect(preserved).toBeDefined();
    expect(run.stderr).toContain(
      `[copy-excalidraw-assets] could not publish: ${vendoredDir(root)} is absent; the tree this run displaced is the only copy, at ${preserved}`,
    );
    expect(readdirSync(join(preserved, 'fonts')).sort()).toEqual(staleFontNames());
    expect(existsSync(join(preserved, markerName(STALE_VERSION)))).toBe(true);
    expect(existsSync(vendoredDir(root))).toBe(false);
  });

  test('a failed publish still leaves the next invocation able to publish', async () => {
    seedStaleVendoredDir(root);

    const failed = await runPredevStepWithRenameFaults(root, PUBLISH_RENAME_CALL, PUBLISHES);
    expect(failed.stderr).not.toMatch(FAULT_MISTARGET);
    expect(failed.code).not.toBe(0);

    const next = await runPredevStep(root);

    expect(next.stderr).toBe('');
    expect(next.code).toBe(0);
    expect(existsSync(markerPath(root))).toBe(true);
    expect(existsSync(markerPath(root, STALE_VERSION))).toBe(false);
    expect(readdirSync(join(vendoredDir(root), 'fonts')).sort()).toEqual(
      readdirSync(SOURCE_FONTS).sort(),
    );
  });

  test('a publish that cannot land reinstates a peer publication it evicted', async () => {
    seedStaleVendoredDir(root);

    const run = await runPredevStepWithRenameFaults(root, PUBLISH_RENAME_CALL, PUBLISHES, [
      EVICT_RENAME_CALL,
    ]);

    expect(run.stderr).not.toMatch(FAULT_MISTARGET);
    expect(run.code).not.toBe(0);
    expect(existsSync(markerPath(root))).toBe(true);
    expect(readdirSync(join(vendoredDir(root), 'fonts')).sort()).toEqual(
      readdirSync(SOURCE_FONTS).sort(),
    );
    expect(displacedTrees(root)).toEqual([]);
  });

  test('a reinstate that cannot land keeps the publish errno and still says where the tree is', async () => {
    seedStaleVendoredDir(root);

    const run = await runPredevStepWithRenameFaults(root, PUBLISH_RENAME_CALL, PUBLISHES, [
      EVICT_RENAME_CALL,
      REINSTATE_RENAME_CALL,
    ]);

    expect(run.stderr).not.toMatch(FAULT_MISTARGET);
    expect(run.code).not.toBe(0);
    expect(existsSync(markerPath(root))).toBe(true);
    const [preserved, ...extra] = displacedTrees(root);
    expect(extra).toEqual([]);
    expect(preserved).toBeDefined();
    expect(run.stderr).toContain(
      `[copy-excalidraw-assets] could not reinstate ${vendoredDir(root)} from ${preserved}: `,
    );
    expect(run.stderr).toContain(
      `[copy-excalidraw-assets] could not publish: ${vendoredDir(root)} is published; the tree this run displaced is a duplicate, at ${preserved}`,
    );
    expect(run.stderr).toMatch(
      /\[copy-excalidraw-assets\] publishing the staged tree failed: EACCES/,
    );
  });

  test('a destination already vendored from this version is left untouched', async () => {
    expect((await runPredevStep(root)).code).toBe(0);
    const sentinel = join(vendoredDir(root), 'sentinel.txt');
    writeFileSync(sentinel, 'written between invocations', 'utf-8');

    const runs = await Promise.all(
      Array.from({ length: PREDEV_WORKERS }, () => runPredevStep(root)),
    );

    expect(failureLines(runs)).toEqual([]);
    expect(existsSync(sentinel)).toBe(true);
  });
});
