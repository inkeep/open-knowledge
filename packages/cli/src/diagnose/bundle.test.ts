
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ZipFile } from 'yazl';
import { type CollectBundleDeps, collectBundle, writeBundle } from './bundle.ts';


const tmpDirs: string[] = [];

function makeTmpDir(prefix = 'ok-bundle-test-'): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

function makeDeterministicDeps(over: Partial<CollectBundleDeps> = {}): CollectBundleDeps {
  return {
    fetchAgentPresence: async () => null,
    readShadowHead: () => null,
    now: () => new Date('2026-05-28T14:22:01.000Z'),
    okVersion: () => '0.7.99',
    readDesktopEnv: () => null,
    readRuntime: () => ({
      nodeVersion: 'v22.18.0',
      platform: 'darwin',
      arch: 'arm64',
    }),
    isOtlpPushEnabled: () => false,
    ...over,
  };
}

function writeAt(contentDir: string, relPath: string, body: string): void {
  const full = join(contentDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}


describe('collectBundle — smoke', () => {
  test('produces a v1 manifest on a fresh content-dir with no server', async () => {
    const contentDir = makeTmpDir();
    const collected = await collectBundle({ contentDir, deps: makeDeterministicDeps() });

    expect(collected.manifest.schemaVersion).toBe(1);
    expect(collected.manifest.createdAt).toBe('2026-05-28T14:22:01.000Z');
    expect(collected.manifest.ok).toEqual({
      version: '0.7.99',
      nodeVersion: 'v22.18.0',
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(collected.manifest.host).toEqual({ desktop: null });
    expect(collected.manifest.serverStatus).toBe('not-running');
    expect(collected.manifest.redaction).toEqual({ applied: false, docNameMapSidecar: null });

    const paths = collected.manifest.files.map((f) => f.path);
    expect(paths).toContain('state/runtime.json');
    expect(paths).toContain('state/server-status.txt');

    collected.cleanup();
    expect(existsSync(collected.stagingDir)).toBe(false);
  });
});


describe('collectBundle — file inventory', () => {
  test('lists staged spans-current.jsonl with correct bytes + lines', async () => {
    const contentDir = makeTmpDir();
    const spansBody = `{"resourceSpans":[]}\n{"resourceSpans":[{"x":1}]}\n`;
    writeAt(contentDir, '.ok/local/telemetry/spans-current.jsonl', spansBody);

    const collected = await collectBundle({ contentDir, deps: makeDeterministicDeps() });

    const entry = collected.manifest.files.find((f) => f.path === 'telemetry/spans-current.jsonl');
    expect(entry).toBeDefined();
    expect(entry?.bytes).toBe(Buffer.byteLength(spansBody, 'utf-8'));
    expect(entry?.lines).toBe(2);
    collected.cleanup();
  });

  test('harvests sink + lock from projectDir, not the content sub-folder', async () => {
    const projectDir = makeTmpDir();
    const contentDir = join(projectDir, 'docs');
    mkdirSync(contentDir, { recursive: true });

    const realSpans = '{"resourceSpans":[]}\n';
    writeAt(projectDir, '.ok/local/telemetry/spans-current.jsonl', realSpans);
    writeAt(projectDir, '.ok/local/logs/server-current.jsonl', '{"level":30,"msg":"x"}\n');
    writeAt(projectDir, '.ok/local/server.lock', JSON.stringify({ port: 6111 }));
    writeAt(contentDir, '.ok/local/telemetry/spans-current.jsonl', '{"resourceSpans":["DECOY"]}\n');

    const collected = await collectBundle({
      contentDir,
      projectDir,
      deps: makeDeterministicDeps(),
    });

    const paths = collected.manifest.files.map((f) => f.path);
    expect(paths).toContain('telemetry/spans-current.jsonl');
    expect(paths).toContain('logs/server-current.jsonl');
    expect(paths).toContain('state/server.lock');
    const staged = readFileSync(
      join(collected.stagingDir, 'telemetry', 'spans-current.jsonl'),
      'utf-8',
    );
    expect(staged).toBe(realSpans);
    expect(staged).not.toContain('DECOY');
    collected.cleanup();
  });

  test('defaults to contentDir as the project root when projectDir is omitted', async () => {
    const contentDir = makeTmpDir();
    writeAt(contentDir, '.ok/local/telemetry/spans-current.jsonl', '{"resourceSpans":[]}\n');
    writeAt(contentDir, '.ok/local/server.lock', JSON.stringify({ port: 6222 }));

    const collected = await collectBundle({ contentDir, deps: makeDeterministicDeps() });

    const paths = collected.manifest.files.map((f) => f.path);
    expect(paths).toContain('telemetry/spans-current.jsonl');
    expect(paths).toContain('state/server.lock');
    collected.cleanup();
  });

  test('lists both spans-current.jsonl and spans-prev.jsonl when both exist', async () => {
    const contentDir = makeTmpDir();
    writeAt(contentDir, '.ok/local/telemetry/spans-current.jsonl', '{"resourceSpans":[]}\n');
    writeAt(contentDir, '.ok/local/telemetry/spans-prev.jsonl', '{"resourceSpans":[1]}\n');

    const collected = await collectBundle({ contentDir, deps: makeDeterministicDeps() });

    const paths = collected.manifest.files.map((f) => f.path);
    expect(paths).toContain('telemetry/spans-current.jsonl');
    expect(paths).toContain('telemetry/spans-prev.jsonl');
    collected.cleanup();
  });

  test('omits missing telemetry/log files silently', async () => {
    const contentDir = makeTmpDir();

    const collected = await collectBundle({ contentDir, deps: makeDeterministicDeps() });
    const paths = collected.manifest.files.map((f) => f.path);
    expect(paths).not.toContain('telemetry/spans-current.jsonl');
    expect(paths).not.toContain('telemetry/spans-prev.jsonl');
    expect(paths).not.toContain('logs/server-current.jsonl');
    expect(paths).not.toContain('logs/server-prev.jsonl');
    collected.cleanup();
  });

  test('records server-current.jsonl in logs/ when present', async () => {
    const contentDir = makeTmpDir();
    writeAt(
      contentDir,
      '.ok/local/logs/server-current.jsonl',
      '{"level":30,"msg":"hi"}\n{"level":30,"msg":"there"}\n',
    );

    const collected = await collectBundle({ contentDir, deps: makeDeterministicDeps() });
    const entry = collected.manifest.files.find((f) => f.path === 'logs/server-current.jsonl');
    expect(entry).toBeDefined();
    expect(entry?.lines).toBe(2);
    collected.cleanup();
  });

  test('partial trailing line is not counted (mid-write resilience)', async () => {
    const contentDir = makeTmpDir();
    writeAt(
      contentDir,
      '.ok/local/telemetry/spans-current.jsonl',
      `{"resourceSpans":[]}\n{"resourceSpans":[1]}\n{"resourceSpans"`,
    );
    const collected = await collectBundle({ contentDir, deps: makeDeterministicDeps() });
    const entry = collected.manifest.files.find((f) => f.path === 'telemetry/spans-current.jsonl');
    expect(entry?.lines).toBe(2);
    collected.cleanup();
  });
});


describe('collectBundle — contentDir.pathSha256', () => {
  test('is 64-hex SHA-256 of the absolute path', async () => {
    const contentDir = makeTmpDir();
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update(resolve(contentDir)).digest('hex');

    const collected = await collectBundle({ contentDir, deps: makeDeterministicDeps() });
    expect(collected.manifest.contentDir.pathSha256).toBe(expected);
    expect(collected.manifest.contentDir.pathSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(collected.manifest.contentDir.absolutePath).toBe(resolve(contentDir));
    collected.cleanup();
  });
});


describe('collectBundle — server status', () => {
  test('lock present + agent-presence 2xx → running, agent-presence.json staged', async () => {
    const contentDir = makeTmpDir();
    writeAt(
      contentDir,
      '.ok/local/server.lock',
      JSON.stringify({ pid: 1, port: 4711, hostname: 'h', startedAt: 't', worktreeRoot: '/' }),
    );
    let queriedPort = -1;
    const deps = makeDeterministicDeps({
      fetchAgentPresence: async (port) => {
        queriedPort = port;
        return JSON.stringify({ agents: [] });
      },
    });
    const collected = await collectBundle({ contentDir, deps });

    expect(queriedPort).toBe(4711);
    expect(collected.manifest.serverStatus).toBe('running');
    const presencePath = join(collected.stagingDir, 'state', 'agent-presence.json');
    expect(existsSync(presencePath)).toBe(true);
    expect(JSON.parse(readFileSync(presencePath, 'utf-8'))).toEqual({ agents: [] });
    collected.cleanup();
  });

  test('lock present but endpoint unreachable → not-running, lock staged', async () => {
    const contentDir = makeTmpDir();
    writeAt(
      contentDir,
      '.ok/local/server.lock',
      JSON.stringify({ pid: 1, port: 4711, hostname: 'h', startedAt: 't', worktreeRoot: '/' }),
    );
    const collected = await collectBundle({
      contentDir,
      deps: makeDeterministicDeps({ fetchAgentPresence: async () => null }),
    });

    expect(collected.manifest.serverStatus).toBe('not-running');
    expect(existsSync(join(collected.stagingDir, 'state', 'server.lock'))).toBe(true);
    expect(existsSync(join(collected.stagingDir, 'state', 'agent-presence.json'))).toBe(false);
    const status = readFileSync(join(collected.stagingDir, 'state', 'server-status.txt'), 'utf-8');
    expect(status).toContain('not-running');
    expect(status).toContain('4711');
    collected.cleanup();
  });

  test('no lock file → not-running, no server.lock in bundle, no presence fetch', async () => {
    const contentDir = makeTmpDir();
    let fetched = false;
    const deps = makeDeterministicDeps({
      fetchAgentPresence: async () => {
        fetched = true;
        return null;
      },
    });
    const collected = await collectBundle({ contentDir, deps });

    expect(collected.manifest.serverStatus).toBe('not-running');
    expect(fetched).toBe(false);
    expect(existsSync(join(collected.stagingDir, 'state', 'server.lock'))).toBe(false);
    collected.cleanup();
  });

  test('corrupt lock → not-running, lock still staged for forensics', async () => {
    const contentDir = makeTmpDir();
    writeAt(contentDir, '.ok/local/server.lock', 'not json {');
    const collected = await collectBundle({ contentDir, deps: makeDeterministicDeps() });

    expect(collected.manifest.serverStatus).toBe('not-running');
    expect(existsSync(join(collected.stagingDir, 'state', 'server.lock'))).toBe(true);
    collected.cleanup();
  });
});


describe('collectBundle — state files', () => {
  test('shadow-head.txt is written when readShadowHead returns content', async () => {
    const contentDir = makeTmpDir();
    const deps = makeDeterministicDeps({
      readShadowHead: () => 'deadbee initial\ncafe sync\n',
    });
    const collected = await collectBundle({ contentDir, deps });
    expect(readFileSync(join(collected.stagingDir, 'state', 'shadow-head.txt'), 'utf-8')).toBe(
      'deadbee initial\ncafe sync\n',
    );
    collected.cleanup();
  });

  test('shadow-head.txt is omitted when readShadowHead returns null', async () => {
    const contentDir = makeTmpDir();
    const collected = await collectBundle({ contentDir, deps: makeDeterministicDeps() });
    expect(existsSync(join(collected.stagingDir, 'state', 'shadow-head.txt'))).toBe(false);
    collected.cleanup();
  });

  test('runtime.json carries ok, host blocks; desktop is null by default', async () => {
    const contentDir = makeTmpDir();
    const collected = await collectBundle({ contentDir, deps: makeDeterministicDeps() });
    const runtime = JSON.parse(
      readFileSync(join(collected.stagingDir, 'state', 'runtime.json'), 'utf-8'),
    );
    expect(runtime.ok).toEqual({
      version: '0.7.99',
      nodeVersion: 'v22.18.0',
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(runtime.host).toEqual({ desktop: null });
    collected.cleanup();
  });

  test('runtime.json + manifest.host.desktop reflect OK_DESKTOP_* env block', async () => {
    const contentDir = makeTmpDir();
    const deps = makeDeterministicDeps({
      readDesktopEnv: () => ({ electronVersion: '38.0.0', packaged: true, channel: 'beta' }),
    });
    const collected = await collectBundle({ contentDir, deps });
    expect(collected.manifest.host.desktop).toEqual({
      electronVersion: '38.0.0',
      packaged: true,
      channel: 'beta',
    });
    const runtime = JSON.parse(
      readFileSync(join(collected.stagingDir, 'state', 'runtime.json'), 'utf-8'),
    );
    expect(runtime.host.desktop).toEqual({
      electronVersion: '38.0.0',
      packaged: true,
      channel: 'beta',
    });
    collected.cleanup();
  });
});


describe('collectBundle — process/ subdir', () => {
  test('copies processDir contents under process/ when supplied', async () => {
    const contentDir = makeTmpDir();
    const processSource = makeTmpDir('ok-bundle-procsrc-');
    writeFileSync(join(processSource, 'metadata.json'), '{"pid":42}');
    writeFileSync(join(processSource, 'lsof.txt'), 'COMMAND PID ...\n');

    const collected = await collectBundle({
      contentDir,
      processDir: processSource,
      deps: makeDeterministicDeps(),
    });

    const paths = collected.manifest.files.map((f) => f.path);
    expect(paths).toContain('process/metadata.json');
    expect(paths).toContain('process/lsof.txt');
    expect(readFileSync(join(collected.stagingDir, 'process', 'metadata.json'), 'utf-8')).toBe(
      '{"pid":42}',
    );
    collected.cleanup();
  });

  test('no process/ directory when processDir is omitted', async () => {
    const contentDir = makeTmpDir();
    const collected = await collectBundle({ contentDir, deps: makeDeterministicDeps() });
    expect(existsSync(join(collected.stagingDir, 'process'))).toBe(false);
    collected.cleanup();
  });
});


describe('collectBundle — summary', () => {
  test('docNameCount counts "doc.name" occurrences across telemetry JSONLs', async () => {
    const contentDir = makeTmpDir();
    writeAt(
      contentDir,
      '.ok/local/telemetry/spans-current.jsonl',
      '{"resourceSpans":[{"attributes":[{"key":"doc.name","value":"a"}]}]}\n' +
        '{"resourceSpans":[{"attributes":[{"key":"doc.name","value":"b"}]}]}\n',
    );
    writeAt(
      contentDir,
      '.ok/local/telemetry/spans-prev.jsonl',
      '{"resourceSpans":[{"attributes":[{"key":"doc.name","value":"c"}]}]}\n',
    );
    const collected = await collectBundle({ contentDir, deps: makeDeterministicDeps() });
    expect(collected.summary.docNameCount).toBe(3);
    collected.cleanup();
  });

  test('contentDirVisible flips true when path appears in any staged file', async () => {
    const contentDir = makeTmpDir();
    writeAt(
      contentDir,
      '.ok/local/logs/server-current.jsonl',
      `{"level":30,"msg":"opened ${contentDir}/notes.md"}\n`,
    );
    const collected = await collectBundle({ contentDir, deps: makeDeterministicDeps() });
    expect(collected.summary.contentDirVisible).toBe(true);
    collected.cleanup();
  });

  test('totalBytes is the sum of bytes across files[]', async () => {
    const contentDir = makeTmpDir();
    const collected = await collectBundle({ contentDir, deps: makeDeterministicDeps() });
    const expected = collected.manifest.files.reduce((s, f) => s + f.bytes, 0);
    expect(collected.summary.totalBytes).toBe(expected);
    expect(collected.summary.fileCount).toBe(collected.manifest.files.length);
    collected.cleanup();
  });
});


async function readZipEntries(zipPath: string): Promise<string[]> {
  const { execSync } = await import('node:child_process');
  const out = execSync(`unzip -Z1 ${JSON.stringify(zipPath)}`, { encoding: 'utf-8' });
  return out
    .trim()
    .split('\n')
    .filter((l) => l.length > 0);
}

describe('writeBundle', () => {
  test('produces a zip whose entries match collected.manifest.files[] + manifest.json', async () => {
    const contentDir = makeTmpDir();
    writeAt(contentDir, '.ok/local/telemetry/spans-current.jsonl', '{"resourceSpans":[]}\n');
    const collected = await collectBundle({ contentDir, deps: makeDeterministicDeps() });

    const outDir = makeTmpDir('ok-bundle-out-');
    const outputPath = join(outDir, 'bundle.zip');
    const written = await writeBundle({ collected, outputPath });
    expect(written).toBe(outputPath);
    expect(existsSync(outputPath)).toBe(true);

    const entries = (await readZipEntries(outputPath)).sort();
    const expected = ['manifest.json', ...collected.manifest.files.map((f) => f.path)].sort();
    expect(entries).toEqual(expected);
    collected.cleanup();
  });

  test('rejects when parent directory does not exist', async () => {
    const contentDir = makeTmpDir();
    const collected = await collectBundle({ contentDir, deps: makeDeterministicDeps() });
    const missing = '/tmp/ok-bundle-nope-XXXXX/bundle.zip';
    await expect(writeBundle({ collected, outputPath: missing })).rejects.toThrow(
      /parent directory does not exist/,
    );
    collected.cleanup();
  });

  test('zip contents survive a round-trip — manifest.json parses to the same data', async () => {
    const contentDir = makeTmpDir();
    const collected = await collectBundle({ contentDir, deps: makeDeterministicDeps() });
    const outDir = makeTmpDir('ok-bundle-out-');
    const outputPath = join(outDir, 'bundle.zip');
    await writeBundle({ collected, outputPath });

    const { execSync } = await import('node:child_process');
    const extractDir = makeTmpDir('ok-bundle-extract-');
    execSync(
      `unzip -q ${JSON.stringify(outputPath)} manifest.json -d ${JSON.stringify(extractDir)}`,
    );
    const parsed = JSON.parse(readFileSync(join(extractDir, 'manifest.json'), 'utf-8'));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.contentDir.pathSha256).toBe(collected.manifest.contentDir.pathSha256);
    expect(parsed.files).toEqual(collected.manifest.files);
    collected.cleanup();
  });

  test('yazl ZipFile end-state — explicit smoke that the underlying lib is wired', async () => {
    const outDir = makeTmpDir('ok-bundle-yazl-');
    const outputPath = join(outDir, 'tiny.zip');
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from('hello', 'utf-8'), 'a.txt');
    zip.end();
    const writer = (await import('node:fs')).createWriteStream(outputPath);
    zip.outputStream.pipe(writer);
    await new Promise<void>((r, j) => {
      writer.on('close', r);
      writer.on('error', j);
    });
    expect(existsSync(outputPath)).toBe(true);
  });
});

describe('collectBundle — manifest.telemetry.localSink cascade', () => {
  test("project's explicit `enabled: false` survives schema defaults in an empty project-local config", async () => {
    const contentDir = makeTmpDir();
    writeAt(contentDir, '.ok/config.yml', 'telemetry:\n  localSink:\n    enabled: false\n');
    writeAt(contentDir, '.ok/local/config.yml', '');

    const collected = await collectBundle({
      contentDir,
      deps: makeDeterministicDeps(),
    });
    expect(collected.manifest.telemetry.localSink.enabled).toBe(false);
    collected.cleanup();
  });

  test('project-local explicit `enabled: false` wins over project `true`', async () => {
    const contentDir = makeTmpDir();
    writeAt(contentDir, '.ok/config.yml', 'telemetry:\n  localSink:\n    enabled: true\n');
    writeAt(contentDir, '.ok/local/config.yml', 'telemetry:\n  localSink:\n    enabled: false\n');
    const collected = await collectBundle({
      contentDir,
      deps: makeDeterministicDeps(),
    });
    expect(collected.manifest.telemetry.localSink.enabled).toBe(false);
    collected.cleanup();
  });

  test('per-leaf cascade: project-local spans.maxBytes wins over project', async () => {
    const contentDir = makeTmpDir();
    writeAt(
      contentDir,
      '.ok/config.yml',
      'telemetry:\n  localSink:\n    spans:\n      maxBytes: 999\n',
    );
    writeAt(
      contentDir,
      '.ok/local/config.yml',
      'telemetry:\n  localSink:\n    spans:\n      maxBytes: 7\n',
    );
    const collected = await collectBundle({
      contentDir,
      deps: makeDeterministicDeps(),
    });
    expect(collected.manifest.telemetry.localSink.spansMaxBytes).toBe(7);
    collected.cleanup();
  });

  test('absent both files → manifest reports schema defaults', async () => {
    const contentDir = makeTmpDir();
    const collected = await collectBundle({
      contentDir,
      deps: makeDeterministicDeps(),
    });
    expect(collected.manifest.telemetry.localSink.enabled).toBe(true);
    expect(collected.manifest.telemetry.localSink.spansMaxBytes).toBe(52_428_800);
    expect(collected.manifest.telemetry.localSink.logsMaxBytes).toBe(26_214_400);
    collected.cleanup();
  });
});
