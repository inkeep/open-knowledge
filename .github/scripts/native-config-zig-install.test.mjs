import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const WORKFLOW = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'workflows',
  'native-config-prebuild.yml',
);
const document = parse(readFileSync(WORKFLOW, 'utf8'));
const job = document.jobs.build;
const step = job.steps.find(({ name }) => name?.startsWith('Install Zig'));

const runnerBashArgs = () => {
  const shell = step.shell ?? job.defaults?.run?.shell ?? document.defaults?.run?.shell;
  if (shell === 'bash') return ['--noprofile', '--norc', '-e', '-o', 'pipefail'];
  throw new Error(`no runner argument format for the Zig step's shell: ${shell}`);
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const onPath = (command) =>
  (process.env.PATH ?? '').split(delimiter).some((dir) => existsSync(join(dir, command)));

const CURL_STUB = [
  '#!/bin/sh',
  'out=',
  'url=',
  'while [ "$#" -gt 0 ]; do',
  '  case "$1" in',
  '    -o) out=$2; shift 2 ;;',
  '    --retry|--max-time|--connect-timeout|--speed-limit|--speed-time) shift 2 ;;',
  '    -*) shift ;;',
  '    *) url=$1; shift ;;',
  '  esac',
  'done',
  'case "$url" in',
  '  */community-mirrors.txt) cat "$STUB_MIRRORS"; exit 0 ;;',
  'esac',
  'while read -r host behavior; do',
  '  case "$url" in',
  '    "https://$host/"*)',
  '      case "$behavior" in',
  '        fail) echo "curl: (28) Operation too slow" >&2; exit 28 ;;',
  '        garbage) printf \'not a zig tarball\' > "$out"; exit 0 ;;',
  '        fixture) cp "$STUB_FIXTURE" "$out"; exit 0 ;;',
  '      esac ;;',
  '  esac',
  'done < "$STUB_SOURCES"',
  'echo "curl stub: no source rule for $url" >&2',
  'exit 7',
  '',
].join('\n');

const fixtureRoot = mkdtempSync(join(tmpdir(), 'ok-zig-fixture-'));
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));
const fixture = (() => {
  const tree = join(fixtureRoot, 'tree', 'zig-fixture');
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, 'zig'), '#!/bin/sh\necho 0.0.0-fixture\n');
  chmodSync(join(tree, 'zig'), 0o755);
  const path = join(fixtureRoot, 'zig-fixture.tar.xz');
  const tar = spawnSync('tar', ['-cJf', path, '-C', join(fixtureRoot, 'tree'), 'zig-fixture'], {
    encoding: 'utf8',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  if (tar.status !== 0) throw new Error(`could not build the Zig fixture: ${tar.stderr}`);
  return { path, tarball: 'zig-fixture.tar.xz', sha256: sha256(readFileSync(path)) };
})();

const runStep = ({ mirrors, sources, env = {} }) => {
  const dir = mkdtempSync(join(tmpdir(), 'ok-zig-install-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const stub = (name, body) => {
      writeFileSync(join(bin, name), body);
      chmodSync(join(bin, name), 0o755);
    };
    stub('curl', CURL_STUB);
    stub('uname', '#!/bin/sh\necho x86_64\n');
    stub('shuf', '#!/bin/sh\ncat\n');
    if (!onPath('sha256sum')) stub('sha256sum', '#!/bin/sh\nexec shasum -a 256 "$@"\n');
    const runnerTemp = join(dir, 'runner-temp');
    mkdirSync(runnerTemp);
    const githubPath = join(dir, 'github-path');
    writeFileSync(githubPath, '');
    writeFileSync(join(dir, 'mirrors.txt'), mirrors.map((mirror) => `${mirror}\n`).join(''));
    writeFileSync(
      join(dir, 'sources.txt'),
      Object.entries(sources)
        .map(([host, behavior]) => `${host} ${behavior}\n`)
        .join(''),
    );
    const script = join(dir, 'install-zig.sh');
    writeFileSync(script, step.run);
    const result = spawnSync('bash', [...runnerBashArgs(), script], {
      encoding: 'utf8',
      timeout: 30_000,
      cwd: dir,
      env: {
        ...process.env,
        ...step.env,
        ...env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        RUNNER_TEMP: runnerTemp,
        GITHUB_PATH: githubPath,
        STUB_MIRRORS: join(dir, 'mirrors.txt'),
        STUB_SOURCES: join(dir, 'sources.txt'),
        STUB_FIXTURE: fixture.path,
      },
    });
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      githubPath: readFileSync(githubPath, 'utf8'),
      runnerTemp,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe.skipIf(process.platform === 'win32')(
  'native-config-prebuild.yml installs Zig only from bytes matching the pinned sha256',
  () => {
    test('the step pins one x86_64 Linux tarball by a full sha256', () => {
      expect(step, 'the Install Zig step is missing').toBeDefined();
      expect(step.env.ZIG_TARBALL).toMatch(/^zig-x86_64-linux-\d+\.\d+\.\d+\.tar\.xz$/);
      expect(step.env.ZIG_SHA256).toMatch(/^[0-9a-f]{64}$/);
    });

    test('a working tarball whose sha256 is not the pin is refused at every source, and each source is named', () => {
      const pin = sha256('a different build');
      const result = runStep({
        mirrors: ['https://slow.example', 'https://tampered.example/zig'],
        sources: {
          'slow.example': 'fail',
          'tampered.example': 'fixture',
          'ziglang.org': 'fixture',
        },
        env: { ZIG_TARBALL: fixture.tarball, ZIG_SHA256: pin },
      });
      expect(result.status, result.output).toBe(1);
      expect(result.githubPath).toBe('');
      for (const source of [
        'https://tampered.example/zig',
        'https://ziglang.org/download/0.14.1',
      ]) {
        expect(result.output).toContain(
          `::warning::${source} served ${fixture.tarball} with sha256 ${fixture.sha256}, not the expected ${pin}`,
        );
      }
      expect(result.output).toContain('https://slow.example did not finish serving');
      expect(result.output).not.toContain('::warning::https://slow.example');
      expect(result.output).toContain(
        `::error::no source served ${fixture.tarball} with sha256 ${pin}, and these served it with a different sha256: https://tampered.example/zig https://ziglang.org/download/0.14.1`,
      );
      expect(result.output).not.toContain('0.0.0-fixture');
    });

    test('the pinned tarball name and sha256 are what the step compares against', () => {
      const result = runStep({
        mirrors: ['https://mirror.example'],
        sources: { 'mirror.example': 'garbage', 'ziglang.org': 'garbage' },
      });
      expect(result.status, result.output).toBe(1);
      expect(result.githubPath).toBe('');
      expect(result.output).toContain(
        `::warning::https://mirror.example served ${step.env.ZIG_TARBALL} with sha256 ${sha256('not a zig tarball')}, not the expected ${step.env.ZIG_SHA256}`,
      );
    });

    test('when every download fails, the error says no digest could be checked', () => {
      const result = runStep({
        mirrors: ['https://slow.example'],
        sources: { 'slow.example': 'fail', 'ziglang.org': 'fail' },
      });
      expect(result.status, result.output).toBe(1);
      expect(result.githubPath).toBe('');
      expect(result.output).not.toContain('::warning::');
      expect(result.output).toContain(
        `::error::no source served ${step.env.ZIG_TARBALL} with sha256 ${step.env.ZIG_SHA256}; every download failed before its sha256 could be checked`,
      );
    });

    test('the first source whose bytes match is installed, after a failed download and a mismatch', () => {
      const result = runStep({
        mirrors: ['https://slow.example', 'https://tampered.example', 'https://good.example/zig'],
        sources: {
          'slow.example': 'fail',
          'tampered.example': 'garbage',
          'good.example': 'fixture',
        },
        env: { ZIG_TARBALL: fixture.tarball, ZIG_SHA256: fixture.sha256 },
      });
      expect(result.status, result.output).toBe(0);
      expect(result.githubPath).toBe(`${join(result.runnerTemp, 'zig-fixture')}\n`);
      expect(result.output).toContain('0.0.0-fixture');
      expect(result.output).toContain(`Installed ${fixture.tarball} from https://good.example/zig`);
      expect(result.output).toContain('::warning::https://tampered.example served');
      expect(result.output).not.toContain('::error::');
    });
  },
);
