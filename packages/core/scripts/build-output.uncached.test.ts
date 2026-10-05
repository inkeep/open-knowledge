import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { isTestOnlySourceFile } from '../../../test-support/test-only-source-file.mjs';
import { withoutTurboAgentDetection } from '../../../test-support/turbo-agent-env.test-helper.mjs';
import { MANIFEST_NAME } from './build-output.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OK_ROOT = join(PACKAGE_ROOT, '..', '..');
const TURBO_BIN = join(OK_ROOT, 'node_modules', 'turbo', 'bin', 'turbo');
const CORE_MANIFEST = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
const OK_MANIFEST = JSON.parse(readFileSync(join(OK_ROOT, 'package.json'), 'utf8'));
const CORE = CORE_MANIFEST.name as string;
const REAL_TURBO = JSON.parse(readFileSync(join(OK_ROOT, 'turbo.json'), 'utf8'));
const PRODUCER_TASK_ID = `${CORE}#build:output`;
const COMPLETION_TASK_ID = `${CORE}#build`;
const RUN_TIMEOUT_MS = 60_000;
const ENV_CACHE_DIR = '.cache-from-env';
const CHUNK_MEMBER = 'packages/core/dist/chunk.mjs';
const MANIFEST_MEMBER = `packages/core/dist/${MANIFEST_NAME}`;
const UNRELATED = 'packages/core/dist-unrelated/keep.txt';

const FIXTURE_COMPILER = `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
appendFileSync('../../compiles.log', 'compile\\n');
if (existsSync('../../compile-fails')) {
  process.stderr.write('fixture compiler: told to fail\\n');
  process.exit(1);
}
const source = readFileSync('src/index.ts', 'utf8');
mkdirSync('dist/types', { recursive: true });
writeFileSync('dist/index.mjs', "import { chunk } from './chunk.mjs';\\nexport const source = " + JSON.stringify(source) + ';\\nexport { chunk };\\n');
writeFileSync('dist/chunk.mjs', 'export const chunk = ' + JSON.stringify('x'.repeat(2048)) + ';\\n');
writeFileSync('dist/index.d.mts', 'export declare const source: string;\\nexport declare const chunk: string;\\n');
writeFileSync('dist/types/index.d.mts', 'export {};\\n');
`;

const FIXTURE_READER = `import { createHash } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
const root = '../core/dist';
const tree = readdirSync(root, { recursive: true, withFileTypes: true })
  .map((entry) => {
    const path = relative(root, join(entry.parentPath, entry.name)).split('\\\\').join('/');
    if (!entry.isFile()) return { path, type: entry.isDirectory() ? 'directory' : 'other' };
    return { path, type: 'file', sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex') };
  })
  .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
appendFileSync('../../reads.jsonl', JSON.stringify(tree) + '\\n');
`;

type TreeEntry = { path: string; type: string; sha256?: string };
type TaskSummary = { taskId: string; hash: string; cache: { status: string; source?: string } };
type Run = {
  status: number | null;
  output: string;
  tasks: Map<string, TaskSummary>;
  reads: TreeEntry[][];
  compiles: number;
};

const workspaces: string[] = [];

afterAll(() => {
  for (const root of workspaces) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'ok-core-build-output-'));
  workspaces.push(root);
  const tasks: Record<string, unknown> = { build: REAL_TURBO.tasks.build };
  for (const [key, definition] of Object.entries(REAL_TURBO.tasks)) {
    if (key.startsWith(`${CORE}#`)) tasks[key] = definition;
  }
  tasks['reader#read'] = { dependsOn: ['^build'], cache: false, command: ['node', 'read.mjs'] };
  const topLevel = Object.fromEntries(
    Object.entries(REAL_TURBO).filter(
      ([key]) => !['$schema', 'globalDependencies', 'tasks'].includes(key),
    ),
  );
  writeJson(join(root, 'turbo.json'), { ...topLevel, tasks });
  writeJson(join(root, 'package.json'), {
    name: 'core-build-output-fixture',
    private: true,
    packageManager: OK_MANIFEST.packageManager,
  });
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  writeFileSync(
    join(root, '.gitignore'),
    ['node_modules', 'dist', 'dist-unrelated', '.turbo', ENV_CACHE_DIR, ''].join('\n'),
  );
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(
    join(OK_ROOT, 'node_modules', 'turbo'),
    join(root, 'node_modules', 'turbo'),
    'junction',
  );

  const core = join(root, 'packages', 'core');
  writeJson(join(core, 'package.json'), {
    name: CORE,
    private: true,
    type: 'module',
    exports: { '.': { types: './dist/index.d.mts', default: './dist/index.mjs' } },
    scripts: { build: CORE_MANIFEST.scripts.build },
  });
  mkdirSync(join(core, 'scripts'), { recursive: true });
  for (const name of readdirSync(join(PACKAGE_ROOT, 'scripts'))) {
    if (name.endsWith('.mjs') && !isTestOnlySourceFile(name)) {
      copyFileSync(join(PACKAGE_ROOT, 'scripts', name), join(core, 'scripts', name));
    }
  }
  mkdirSync(join(core, 'src'), { recursive: true });
  writeFileSync(join(core, 'src', 'index.ts'), 'export const value = 1;\n');
  writeJson(join(core, 'node_modules', 'tsdown', 'package.json'), {
    name: 'tsdown',
    type: 'module',
    exports: { './run': './run.mjs' },
  });
  writeFileSync(join(core, 'node_modules', 'tsdown', 'run.mjs'), FIXTURE_COMPILER);
  mkdirSync(dirname(join(root, UNRELATED)), { recursive: true });
  writeFileSync(join(root, UNRELATED), 'not core output\n');

  writeJson(join(root, 'packages', 'reader', 'package.json'), {
    name: 'reader',
    private: true,
    dependencies: { [CORE]: 'workspace:*' },
  });
  writeFileSync(join(root, 'packages', 'reader', 'read.mjs'), FIXTURE_READER);
  return root;
}

function turboEnv(extra: Record<string, string>) {
  const env = Object.fromEntries(
    Object.entries(withoutTurboAgentDetection(process.env)).filter(
      ([key]) => !key.startsWith('TURBO_') && !key.startsWith('GIT_'),
    ),
  );
  return { ...env, TURBO_TELEMETRY_DISABLED: '1', TURBO_NO_UPDATE_NOTIFIER: '1', ...extra };
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
}

function readerRun(
  root: string,
  env: Record<string, string> = { TURBO_CACHE_DIR: ENV_CACHE_DIR },
): Run {
  rmSync(join(root, '.turbo', 'runs'), { recursive: true, force: true });
  rmSync(join(root, 'reads.jsonl'), { force: true });
  const compilesBefore = lines(join(root, 'compiles.log')).length;
  const result = spawnSync(
    process.execPath,
    [
      TURBO_BIN,
      'run',
      'read',
      '--filter=reader',
      '--summarize',
      '--output-logs=full',
      '--log-prefix=task',
      '--concurrency=1',
    ],
    {
      cwd: root,
      env: turboEnv(env),
      encoding: 'utf8',
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  const output = `${result.stdout}${result.stderr}`;
  const runsDir = join(root, '.turbo', 'runs');
  const summaries = existsSync(runsDir)
    ? readdirSync(runsDir).filter((name) => name.endsWith('.json'))
    : [];
  if (summaries.length !== 1)
    throw new Error(`expected one run summary, found ${summaries.length}: ${output}`);
  const summary = JSON.parse(readFileSync(join(runsDir, summaries[0]), 'utf8'));
  return {
    status: result.status,
    output,
    tasks: new Map((summary.tasks as TaskSummary[]).map((task) => [task.taskId, task])),
    reads: lines(join(root, 'reads.jsonl')).map((line) => JSON.parse(line)),
    compiles: lines(join(root, 'compiles.log')).length - compilesBefore,
  };
}

function completionLines(run: Run): string[] {
  return run.output
    .split('\n')
    .filter((line) => line.startsWith(`${COMPLETION_TASK_ID.replace('#', ':')}: `))
    .filter((line) => !line.includes('cache bypass, force executing'));
}

const completionLine = (message: string) => `${CORE}:build: ${CORE}: ${message}`;

function producerCache(run: Run) {
  const producer = run.tasks.get(PRODUCER_TASK_ID);
  if (!producer) throw new Error(`no ${PRODUCER_TASK_ID} in the run summary: ${run.output}`);
  return { status: producer.cache.status, source: producer.cache.source };
}

function distTree(root: string): TreeEntry[] {
  const dist = join(root, 'packages', 'core', 'dist');
  return readdirSync(dist, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const path = relative(dist, join(entry.parentPath, entry.name)).split('\\').join('/');
      if (!entry.isFile()) return { path, type: entry.isDirectory() ? 'directory' : 'other' };
      return {
        path,
        type: 'file',
        sha256: createHash('sha256')
          .update(readFileSync(join(dist, path)))
          .digest('hex'),
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

type TarEntry = { header: Buffer; data: Buffer };

function archivePath(root: string, cacheDir: string, hash: string) {
  return join(root, cacheDir, `${hash}.tar.zst`);
}

function readArchive(path: string) {
  const tar = zstdDecompressSync(readFileSync(path));
  const entries: { name: string; entry: TarEntry }[] = [];
  let offset = 0;
  while (
    offset + 512 <= tar.length &&
    tar.subarray(offset, offset + 512).some((byte) => byte !== 0)
  ) {
    const header = Buffer.from(tar.subarray(offset, offset + 512));
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const type = field(156, 1);
    if (!['', '0', '2', '5'].includes(type))
      throw new Error(`unsupported tar entry type ${JSON.stringify(type)} in ${path}`);
    const prefix =
      header.subarray(257, 263).toString('latin1') === 'ustar\0' ? field(345, 155) : '';
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    const data = Buffer.from(tar.subarray(offset + 512, offset + 512 + size));
    entries.push({ name: name.replace(/\/$/, ''), entry: { header, data } });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function writeArchive(path: string, entries: { entry: TarEntry }[]) {
  const blocks: Buffer[] = [];
  for (const { entry } of entries) {
    const header = Buffer.from(entry.header);
    header.write(`${entry.data.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    header.fill(0x20, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    blocks.push(header, entry.data, Buffer.alloc((512 - (entry.data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  writeFileSync(path, zstdCompressSync(Buffer.concat(blocks)));
}

type Damage = 'missing' | 'truncated' | 'same-length' | { replace: string };

function damageArchive(path: string, damage: Damage, member = CHUNK_MEMBER) {
  const entries = readArchive(path);
  const index = entries.findIndex(({ name }) => name === member);
  if (index === -1)
    throw new Error(`${member} is not in ${path}: ${entries.map(({ name }) => name).join(', ')}`);
  const { entry } = entries[index];
  if (damage === 'missing') entries.splice(index, 1);
  else if (damage === 'truncated') entry.data = entry.data.subarray(0, 7);
  else if (damage === 'same-length')
    entry.data = Buffer.concat([Buffer.from('/'), entry.data.subarray(1)]);
  else entry.data = Buffer.from(damage.replace);
  writeArchive(path, entries);
}

function removeDist(root: string) {
  rmSync(join(root, 'packages', 'core', 'dist'), { recursive: true, force: true });
}

describe('core build output reaches its readers exactly as the producer made it', () => {
  let root: string;
  let golden: TreeEntry[];
  let producerHash: string;

  const expectUnrelatedFileSurvives = () =>
    expect(readFileSync(join(root, UNRELATED), 'utf8')).toBe('not core output\n');

  const expectQuietHitNext = () => {
    const next = readerRun(root);
    expect(next.status, next.output).toBe(0);
    expect(producerCache(next)).toEqual({ status: 'HIT', source: 'LOCAL' });
    expect(next.compiles).toBe(0);
    expect(next.reads).toEqual([golden]);
  };

  beforeAll(() => {
    root = createWorkspace();
    const cold = readerRun(root);
    expect(cold.status, cold.output).toBe(0);
    expect(producerCache(cold).status).toBe('MISS');
    expect(cold.compiles).toBe(1);
    golden = distTree(root);
    expect(golden.map(({ path }) => path)).toContain(MANIFEST_NAME);
    expect(cold.reads).toEqual([golden]);
    producerHash = cold.tasks.get(PRODUCER_TASK_ID)?.hash ?? '';
    expect(existsSync(archivePath(root, ENV_CACHE_DIR, producerHash))).toBe(true);
  }, RUN_TIMEOUT_MS * 2);

  test(
    'an unchanged valid hit runs no producer and prints nothing',
    () => {
      const run = readerRun(root);
      expect(run.status, run.output).toBe(0);
      expect(producerCache(run)).toEqual({ status: 'HIT', source: 'LOCAL' });
      expect(run.compiles).toBe(0);
      expect(completionLines(run)).toEqual([]);
      expect(run.reads).toEqual([golden]);
      expectUnrelatedFileSurvives();
    },
    RUN_TIMEOUT_MS,
  );

  test(
    'extra files beside a valid hit are removed before the reader runs, without a rebuild',
    () => {
      const dist = join(root, 'packages', 'core', 'dist');
      writeFileSync(join(dist, 'planted.mjs'), 'export const planted = true;\n');
      mkdirSync(join(dist, 'planted-dir'), { recursive: true });
      writeFileSync(join(dist, 'planted-dir', 'inner.mjs'), 'export {};\n');
      const run = readerRun(root);
      expect(run.reads).toEqual([golden]);
      expect(run.status, run.output).toBe(0);
      expect(producerCache(run)).toEqual({ status: 'HIT', source: 'LOCAL' });
      expect(run.compiles).toBe(0);
      expect(completionLines(run)).toEqual([
        completionLine(
          'removed planted-dir, planted.mjs from dist; its manifest does not list them',
        ),
      ]);
      expectUnrelatedFileSurvives();
    },
    RUN_TIMEOUT_MS,
  );

  test.each([
    ['missing member', CHUNK_MEMBER, 'missing', 'missing: chunk.mjs'],
    ['truncated member', CHUNK_MEMBER, 'truncated', 'changed: chunk.mjs'],
    ['same-length member', CHUNK_MEMBER, 'same-length', 'changed: chunk.mjs'],
    ['missing manifest', MANIFEST_MEMBER, 'missing', `dist/${MANIFEST_NAME} is missing`],
    ['truncated manifest', MANIFEST_MEMBER, 'truncated', `dist/${MANIFEST_NAME} is unreadable (`],
    [
      'manifest with a non-object member',
      MANIFEST_MEMBER,
      { replace: '{"version":1,"members":[null]}\n' },
      `dist/${MANIFEST_NAME} is not a version 1 manifest`,
    ],
  ] as const)(
    'a %s restored from the local cache is rebuilt once before the reader runs, and the cache entry is replaced',
    (_label, member, damage, difference) => {
      const archive = archivePath(root, ENV_CACHE_DIR, producerHash);
      const intact = readFileSync(archive);
      damageArchive(archive, damage, member);
      removeDist(root);
      try {
        const run = readerRun(root);
        expect(run.reads).toEqual([golden]);
        expect(run.status, run.output).toBe(0);
        expect(producerCache(run)).toEqual({ status: 'HIT', source: 'LOCAL' });
        expect(run.compiles).toBe(1);
        expect(completionLines(run)).toContainEqual(
          expect.stringContaining(completionLine(`dist differs from its manifest (${difference}`)),
        );
        expect(completionLines(run)).toContain(completionLine('rebuilt dist matches its manifest'));
        expectUnrelatedFileSurvives();
        expectQuietHitNext();
      } finally {
        writeFileSync(archive, intact);
        removeDist(root);
      }
    },
    RUN_TIMEOUT_MS * 2,
  );

  test(
    'a failed rebuild blocks the reader',
    () => {
      const archive = archivePath(root, ENV_CACHE_DIR, producerHash);
      const intact = readFileSync(archive);
      damageArchive(archive, 'same-length');
      removeDist(root);
      writeFileSync(join(root, 'compile-fails'), '');
      try {
        const run = readerRun(root);
        expect(run.reads).toEqual([]);
        expect(run.status, run.output).not.toBe(0);
        expect(producerCache(run)).toEqual({ status: 'HIT', source: 'LOCAL' });
        expect(run.compiles).toBe(1);
        expectUnrelatedFileSurvives();
      } finally {
        rmSync(join(root, 'compile-fails'), { force: true });
        writeFileSync(archive, intact);
        removeDist(root);
      }
      expectQuietHitNext();
    },
    RUN_TIMEOUT_MS * 2,
  );

  test.each([
    ['missing member', (dist: string) => rmSync(join(dist, 'chunk.mjs')), 'missing: chunk.mjs'],
    [
      'same-length change',
      (dist: string) => {
        const bytes = readFileSync(join(dist, 'chunk.mjs'));
        bytes[0] = 0x2f;
        writeFileSync(join(dist, 'chunk.mjs'), bytes);
      },
      'changed: chunk.mjs',
    ],
    [
      'file its manifest does not list',
      (dist: string) => writeFileSync(join(dist, 'planted.mjs'), 'export const planted = true;\n'),
      'not in the manifest: planted.mjs',
    ],
    [
      'missing manifest',
      (dist: string) => rmSync(join(dist, MANIFEST_NAME)),
      `dist/${MANIFEST_NAME} is missing`,
    ],
  ] as const)(
    'verify rejects a dist with a %s, names it, and changes nothing',
    (_label, damage, difference) => {
      expectQuietHitNext();
      const core = join(root, 'packages', 'core');
      damage(join(core, 'dist'));
      try {
        const damaged = distTree(root);
        expect(damaged).not.toEqual(golden);
        const compilesBefore = lines(join(root, 'compiles.log')).length;
        const verify = spawnSync(process.execPath, ['scripts/build-output.mjs', 'verify'], {
          cwd: core,
          env: turboEnv({}),
          encoding: 'utf8',
        });
        expect(verify.status, `${verify.stdout}${verify.stderr}`).toBe(1);
        expect(verify.stderr).toContain(
          `${CORE}: dist differs from the manifest its producer wrote (${difference}). Rebuild it through Turbo`,
        );
        expect(distTree(root)).toEqual(damaged);
        expect(lines(join(root, 'compiles.log')).length).toBe(compilesBefore);
        expectUnrelatedFileSurvives();
      } finally {
        removeDist(root);
      }
    },
    RUN_TIMEOUT_MS,
  );

  test(
    'a repair rewrites the cache entry in the configured cache directory when no TURBO_CACHE_DIR is set',
    () => {
      const configured = REAL_TURBO.cacheDir as string;
      const configRun = () => readerRun(root, {});
      const cold = configRun();
      expect(cold.status, cold.output).toBe(0);
      const archive = archivePath(root, configured, cold.tasks.get(PRODUCER_TASK_ID)?.hash ?? '');
      damageArchive(archive, 'truncated');
      removeDist(root);
      const run = configRun();
      expect(run.reads).toEqual([golden]);
      expect(run.status, run.output).toBe(0);
      expect(producerCache(run)).toEqual({ status: 'HIT', source: 'LOCAL' });
      expect(run.compiles).toBe(1);
      const next = configRun();
      expect(producerCache(next)).toEqual({ status: 'HIT', source: 'LOCAL' });
      expect(next.compiles).toBe(0);
      expect(next.reads).toEqual([golden]);
    },
    RUN_TIMEOUT_MS * 3,
  );

  test(
    "core's own build script rebuilds from source when run directly",
    () => {
      const core = join(root, 'packages', 'core');
      writeFileSync(join(core, 'src', 'index.ts'), 'export const value = 2;\n');
      const env = turboEnv({
        PATH: `${join(core, 'node_modules', '.bin')}${delimiter}${process.env.PATH ?? ''}`,
      });
      const direct = spawnSync(CORE_MANIFEST.scripts.build, {
        cwd: core,
        env,
        shell: true,
        encoding: 'utf8',
        timeout: RUN_TIMEOUT_MS,
      });
      expect(direct.status, `${direct.stdout}${direct.stderr}`).toBe(0);
      expect(readFileSync(join(core, 'dist', 'index.mjs'), 'utf8')).toContain(
        'export const value = 2;',
      );
      const verify = spawnSync(process.execPath, ['scripts/build-output.mjs', 'verify'], {
        cwd: core,
        env,
        encoding: 'utf8',
      });
      expect(verify.status, `${verify.stdout}${verify.stderr}`).toBe(0);
      expectUnrelatedFileSurvives();
    },
    RUN_TIMEOUT_MS,
  );
});
