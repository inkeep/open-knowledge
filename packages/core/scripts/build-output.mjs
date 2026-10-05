import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExportsTargetsError, verifyExportsTargets } from './verify-exports-targets.mjs';

export const MANIFEST_NAME = 'output-manifest.json';
const MANIFEST_VERSION = 1;
const PRODUCER_TASK = 'build:output';
const LISTED_PATHS = 10;

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TURBO_ROOT = resolve(PACKAGE_ROOT, '../..');
const OUTPUT_ROOT = join(PACKAGE_ROOT, 'dist');
const MANIFEST_PATH = join(OUTPUT_ROOT, MANIFEST_NAME);

class BuildOutputError extends Error {}

const packageName = () => JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).name;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const byPath = (left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

function entryType(entry) {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  return 'other';
}

function inventory() {
  if (!lstatSync(OUTPUT_ROOT).isDirectory()) throw new BuildOutputError('dist is not a directory');
  const members = [];
  const visit = (relative) => {
    for (const entry of readdirSync(join(OUTPUT_ROOT, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (path === MANIFEST_NAME) continue;
      const type = entryType(entry);
      if (type === 'directory') {
        members.push({ path, type });
        visit(path);
      } else if (type === 'other') {
        members.push({ path, type });
      } else {
        const absolute = join(OUTPUT_ROOT, path);
        const bytes =
          type === 'file' ? readFileSync(absolute) : Buffer.from(readlinkSync(absolute));
        members.push({ path, type, size: bytes.length, sha256: sha256(bytes) });
      }
    }
  };
  visit('');
  return members.sort(byPath);
}

function readManifest() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (error) {
    return {
      problem:
        error.code === 'ENOENT'
          ? `dist/${MANIFEST_NAME} is missing`
          : `dist/${MANIFEST_NAME} is unreadable (${error.message})`,
    };
  }
  if (
    manifest?.version !== MANIFEST_VERSION ||
    !Array.isArray(manifest.members) ||
    !manifest.members.every((member) => typeof member?.path === 'string')
  ) {
    return { problem: `dist/${MANIFEST_NAME} is not a version ${MANIFEST_VERSION} manifest` };
  }
  return { members: new Map(manifest.members.map((member) => [member.path, member])) };
}

function inspect() {
  const manifest = readManifest();
  if (manifest.problem)
    return { problem: manifest.problem, missing: [], changed: [], unexpected: [] };
  let actual;
  try {
    actual = inventory();
  } catch (error) {
    const where = error.path ? ` at ${error.path}` : '';
    return {
      problem: `dist could not be read (${error.code ?? error.message}${where})`,
      missing: [],
      changed: [],
      unexpected: [],
    };
  }
  const found = new Map(actual.map((member) => [member.path, member]));
  const missing = [];
  const changed = [];
  for (const [path, expected] of manifest.members) {
    const member = found.get(path);
    if (!member) missing.push(path);
    else if (
      member.type !== expected.type ||
      member.size !== expected.size ||
      member.sha256 !== expected.sha256
    )
      changed.push(path);
  }
  const unexpected = actual
    .filter((member) => !manifest.members.has(member.path))
    .map((member) => member.path);
  return { problem: undefined, missing, changed, unexpected };
}

const differs = (state) =>
  state.problem !== undefined ||
  state.missing.length + state.changed.length + state.unexpected.length > 0;

function listed(paths) {
  const shown = paths.slice(0, LISTED_PATHS).join(', ');
  return paths.length > LISTED_PATHS ? `${shown} and ${paths.length - LISTED_PATHS} more` : shown;
}

function describe(state) {
  if (state.problem) return state.problem;
  return [
    ['missing', state.missing],
    ['changed', state.changed],
    ['not in the manifest', state.unexpected],
  ]
    .filter(([, paths]) => paths.length > 0)
    .map(([label, paths]) => `${label}: ${listed(paths)}`)
    .join('; ');
}

function removeUnexpected(paths) {
  const removed = [];
  for (const path of [...paths].sort()) {
    if (removed.some((parent) => path.startsWith(`${parent}/`))) continue;
    rmSync(join(OUTPUT_ROOT, ...path.split('/')), { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}

function run(label, args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new BuildOutputError(`${label} exited ${result.status ?? result.signal}`);
}

function produce() {
  rmSync(OUTPUT_ROOT, { recursive: true, force: true });
  run('tsdown', [fileURLToPath(import.meta.resolve('tsdown/run'))], PACKAGE_ROOT);
  verifyExportsTargets(PACKAGE_ROOT);
  writeFileSync(
    MANIFEST_PATH,
    `${JSON.stringify({ version: MANIFEST_VERSION, members: inventory() })}\n`,
  );
}

function rebuildWithoutCacheReads(name) {
  const turbo = createRequire(import.meta.url).resolve('turbo/bin/turbo');
  const args = [turbo, 'run', PRODUCER_TASK, `--filter=${name}`, '--cache=local:w'];
  if (process.env.TURBO_CACHE_DIR)
    args.push(`--cache-dir=${resolve(TURBO_ROOT, process.env.TURBO_CACHE_DIR)}`);
  run(`turbo run ${PRODUCER_TASK}`, args, TURBO_ROOT);
}

function complete() {
  const name = packageName();
  let state = inspect();
  if (state.problem === undefined && state.unexpected.length > 0) {
    const removed = removeUnexpected(state.unexpected);
    process.stderr.write(
      `${name}: removed ${listed(removed)} from dist; its manifest does not list them\n`,
    );
    state = { ...state, unexpected: [] };
  }
  if (!differs(state)) return;
  process.stderr.write(
    `${name}: dist differs from its manifest (${describe(state)}); rebuilding it once without reading the cache\n`,
  );
  rebuildWithoutCacheReads(name);
  state = inspect();
  if (differs(state))
    throw new BuildOutputError(
      `${name}: dist still differs from its manifest after one rebuild (${describe(state)})`,
    );
  process.stderr.write(`${name}: rebuilt dist matches its manifest\n`);
}

function verify() {
  const state = inspect();
  if (!differs(state)) return;
  const name = packageName();
  throw new BuildOutputError(
    `${name}: dist differs from the manifest its producer wrote (${describe(state)}). Rebuild it through Turbo (\`turbo run build --filter=${name}\` from public/open-knowledge), or re-download it from the job that built it.`,
  );
}

const MODES = { build: produce, produce, complete, verify };

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const mode = process.argv[2];
  if (!Object.hasOwn(MODES, mode)) {
    process.stderr.write(
      `usage: node scripts/build-output.mjs <${Object.keys(MODES).join('|')}>\n`,
    );
    process.exitCode = 2;
  } else {
    try {
      MODES[mode]();
    } catch (error) {
      process.stderr.write(
        error instanceof BuildOutputError || error instanceof ExportsTargetsError
          ? `${error.message}\n`
          : `build-output.mjs ${mode} failed: ${error instanceof Error ? error.stack : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
