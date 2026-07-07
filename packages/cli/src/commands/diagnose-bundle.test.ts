/**
 * Tests for `ok diagnose bundle` runner.
 *
 * Verifies the CLI wrapper around collectBundle + writeBundle:
 * pid integration via runDiagnose, summary printing, y/N prompt, --out
 * path validation, --yes skip-prompt path. Runs the real collector + zip
 * writer end-to-end against a tmpdir; only network + process-diagnose
 * deps are injected.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type RunDiagnoseBundleDeps, runDiagnoseBundle } from './diagnose.ts';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function makeTmpDir(prefix = 'ok-bundle-runner-test-'): string {
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

function writeAt(contentDir: string, relPath: string, body: string): void {
  const full = join(contentDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

interface CapturedRun {
  logs: string[];
  prompts: string[];
}

function deterministicCollectDeps(): RunDiagnoseBundleDeps['collectDeps'] {
  return {
    fetchAgentPresence: async () => null,
    readShadowHead: () => null,
    now: () => new Date('2026-05-28T14:22:01.000Z'),
    okVersion: () => '0.7.99',
    readDesktopEnv: () => null,
    readRuntime: () => ({ nodeVersion: 'v22.18.0', platform: 'darwin', arch: 'arm64' }),
    isOtlpPushEnabled: () => false,
  };
}

function makeRunnerDeps(over: Partial<RunDiagnoseBundleDeps> = {}): {
  deps: RunDiagnoseBundleDeps;
  captured: CapturedRun;
} {
  const captured: CapturedRun = { logs: [], prompts: [] };
  const deps: RunDiagnoseBundleDeps = {
    log: (msg) => captured.logs.push(msg),
    prompt: async (q) => {
      captured.prompts.push(q);
      return 'y';
    },
    collectDeps: deterministicCollectDeps(),
    ...over,
  };
  return { captured, deps };
}

function readZipEntries(zipPath: string): string[] {
  const out = execSync(`unzip -Z1 ${JSON.stringify(zipPath)}`, { encoding: 'utf-8' });
  return out
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .sort();
}

// ---------------------------------------------------------------------------
// Tracer bullet — bundle works on a fresh content-dir, --yes
// ---------------------------------------------------------------------------

describe('runDiagnoseBundle — tracer bullet', () => {
  test('writes a zip to the default path with no server running and --yes', async () => {
    const contentDir = makeTmpDir();
    const { deps, captured } = makeRunnerDeps();

    const result = await runDiagnoseBundle({ contentDir, yes: true }, deps);

    expect(result.outputPath).not.toBeNull();
    expect(result.outputPath).toContain(join(contentDir, '.ok', 'local', 'diagnostics'));
    expect(result.outputPath?.endsWith('.zip')).toBe(true);
    expect(existsSync(result.outputPath ?? '')).toBe(true);

    // --yes skips the prompt entirely.
    expect(captured.prompts.length).toBe(0);

    // Zip contains manifest.json + state files at minimum.
    const entries = readZipEntries(result.outputPath ?? '');
    expect(entries).toContain('manifest.json');
    expect(entries).toContain('state/runtime.json');
    expect(entries).toContain('state/server-status.txt');
  });
});

// ---------------------------------------------------------------------------
// works without a running server
// ---------------------------------------------------------------------------

describe('runDiagnoseBundle — no running server', () => {
  test('manifest.serverStatus is not-running; state/server-status.txt confirms', async () => {
    const contentDir = makeTmpDir();
    const { deps, captured } = makeRunnerDeps();

    const result = await runDiagnoseBundle({ contentDir, yes: true }, deps);
    expect(result.outputPath).not.toBeNull();

    // Pull manifest + status out of the zip.
    const extractDir = makeTmpDir('ok-bundle-extract-');
    execSync(
      `unzip -q ${JSON.stringify(result.outputPath ?? '')} -d ${JSON.stringify(extractDir)}`,
    );
    const manifest = JSON.parse(readFileSync(join(extractDir, 'manifest.json'), 'utf-8'));
    expect(manifest.serverStatus).toBe('not-running');
    const statusBody = readFileSync(join(extractDir, 'state', 'server-status.txt'), 'utf-8');
    expect(statusBody).toContain('not-running');

    // CLI should have surfaced the 'server not running' warning to the user.
    const allLogs = captured.logs.join('\n');
    expect(allLogs).toContain('server not running');
  });
});

// ---------------------------------------------------------------------------
// --pid integration
// ---------------------------------------------------------------------------

describe('runDiagnoseBundle — --pid integration', () => {
  test('--pid runs process-diagnose into a tmp dir and includes process/ in the zip', async () => {
    const contentDir = makeTmpDir();
    let pidSeen: number | null = null;
    let processDirHandedOff: string | null = null;
    const { deps } = makeRunnerDeps({
      runProcessDiagnose: async (pid) => {
        pidSeen = pid;
        // Simulate the existing runDiagnose flow by writing a small payload
        // into a tmp dir — the runner copies the contents under `process/`.
        const dir = mkdtempSync(join(tmpdir(), 'ok-bundle-test-proc-'));
        tmpDirs.push(dir);
        writeFileSync(join(dir, 'metadata.json'), '{"pid":42,"command":"node"}');
        writeFileSync(join(dir, 'lsof.txt'), 'COMMAND PID\n');
        processDirHandedOff = dir;
        return dir;
      },
    });

    const result = await runDiagnoseBundle({ contentDir, pid: 42, yes: true }, deps);

    expect(pidSeen).toBe(42);
    expect(processDirHandedOff).not.toBeNull();
    expect(result.outputPath).not.toBeNull();

    const entries = readZipEntries(result.outputPath ?? '');
    expect(entries).toContain('process/metadata.json');
    expect(entries).toContain('process/lsof.txt');
  });
});

// ---------------------------------------------------------------------------
// content summary + y/N prompt
// ---------------------------------------------------------------------------

describe('runDiagnoseBundle — prompt + summary', () => {
  test('prints a content summary before the prompt', async () => {
    const contentDir = makeTmpDir();
    writeAt(
      contentDir,
      '.ok/local/telemetry/spans-current.jsonl',
      '{"resourceSpans":[{"attributes":[{"key":"doc.name","value":"a"}]}]}\n',
    );
    const { deps, captured } = makeRunnerDeps();

    await runDiagnoseBundle({ contentDir, yes: true }, deps);
    const allLogs = captured.logs.join('\n');
    expect(allLogs).toContain('content summary');
    expect(allLogs).toContain('Files:');
    expect(allLogs).toContain('Total size:');
    expect(allLogs).toContain('doc.name attributes:');
    expect(allLogs).toContain('Content-dir path:');
    expect(allLogs).toContain('Server status:');
    // Includes the count from the seeded spans file.
    expect(allLogs).toMatch(/doc\.name attributes:\s+1 occurrence/);
  });

  test('prompt accepted with "y" → zip written', async () => {
    const contentDir = makeTmpDir();
    const { deps, captured } = makeRunnerDeps();
    const result = await runDiagnoseBundle({ contentDir }, deps);
    expect(captured.prompts.length).toBe(1);
    expect(captured.prompts[0]).toMatch(/y\/N/);
    expect(result.outputPath).not.toBeNull();
    expect(existsSync(result.outputPath ?? '')).toBe(true);
    expect(result.declined).toBe(false);
  });

  test('prompt declined with "n" → no zip, declined=true', async () => {
    const contentDir = makeTmpDir();
    const { deps } = makeRunnerDeps({ prompt: async () => 'n' });
    const result = await runDiagnoseBundle({ contentDir }, deps);
    expect(result.declined).toBe(true);
    expect(result.outputPath).toBeNull();
    // No zip should have landed at the default location.
    const defaultDir = join(contentDir, '.ok', 'local', 'diagnostics');
    if (existsSync(defaultDir)) {
      const files = (await import('node:fs')).readdirSync(defaultDir);
      expect(files.filter((f) => f.endsWith('.zip'))).toEqual([]);
    }
  });

  test('empty answer (bare Enter) → declined', async () => {
    const contentDir = makeTmpDir();
    const { deps } = makeRunnerDeps({ prompt: async () => '' });
    const result = await runDiagnoseBundle({ contentDir }, deps);
    expect(result.declined).toBe(true);
    expect(result.outputPath).toBeNull();
  });

  test('"yes" (full word, case-insensitive) → accepted', async () => {
    const contentDir = makeTmpDir();
    const { deps } = makeRunnerDeps({ prompt: async () => 'YES' });
    const result = await runDiagnoseBundle({ contentDir }, deps);
    expect(result.declined).toBe(false);
    expect(result.outputPath).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// --out flag
// ---------------------------------------------------------------------------

describe('runDiagnoseBundle — --out flag', () => {
  test('--out with existing parent directory writes the zip there', async () => {
    const contentDir = makeTmpDir();
    const outDir = makeTmpDir('ok-bundle-out-');
    const targetPath = join(outDir, 'my-bundle.zip');
    const { deps } = makeRunnerDeps();

    const result = await runDiagnoseBundle({ contentDir, out: targetPath, yes: true }, deps);
    expect(result.outputPath).toBe(targetPath);
    expect(existsSync(targetPath)).toBe(true);
  });

  test('--out with missing parent directory throws a clear error', async () => {
    const contentDir = makeTmpDir();
    const targetPath = join(makeTmpDir(), 'does-not-exist', 'b.zip');
    const { deps } = makeRunnerDeps();
    await expect(
      runDiagnoseBundle({ contentDir, out: targetPath, yes: true }, deps),
    ).rejects.toThrow(/parent directory does not exist/);
    expect(existsSync(targetPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// --redact end-to-end
// ---------------------------------------------------------------------------

describe('runDiagnoseBundle — --redact', () => {
  test('hashes doc names and strips contentDir in zipped JSONLs; manifest carries inverse map', async () => {
    const contentDir = makeTmpDir();
    // Seed a fixture with a known doc name + the content-dir path.
    const otlpLine = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  attributes: [
                    { key: 'doc.name', value: { stringValue: 'fixture-doc' } },
                    { key: 'fs.path', value: { stringValue: `${contentDir}/foo.md` } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    writeAt(contentDir, '.ok/local/telemetry/spans-current.jsonl', `${otlpLine}\n`);

    const { deps } = makeRunnerDeps();
    const out = join(makeTmpDir('ok-bundle-out-'), 'redacted.zip');
    const result = await runDiagnoseBundle({ contentDir, out, yes: true, redact: true }, deps);
    expect(result.outputPath).toBe(out);

    // Extract the zip and inspect.
    const extractDir = makeTmpDir('ok-bundle-extract-');
    execSync(`unzip -q ${JSON.stringify(out)} -d ${JSON.stringify(extractDir)}`);
    const zippedSpans = readFileSync(join(extractDir, 'telemetry', 'spans-current.jsonl'), 'utf-8');

    // (a) doc-name-shaped values were replaced with doc:<8hex>.
    expect(zippedSpans).not.toContain('fixture-doc');
    expect(zippedSpans).toMatch(/"doc:[a-f0-9]{8}"/);

    // (b) absolute content-dir prefix was replaced with <CONTENT_DIR>.
    expect(zippedSpans).not.toContain(contentDir);
    expect(zippedSpans).toContain('<CONTENT_DIR>/foo.md');

    // (c) manifest.json.redaction.docNameMapSidecar references an out-of-zip
    // sidecar; the inverse map itself never lives inside the zip.
    const manifest = JSON.parse(readFileSync(join(extractDir, 'manifest.json'), 'utf-8'));
    expect(manifest.redaction.applied).toBe(true);
    expect(manifest.redaction.docNameMapSidecar).toMatch(/\.docnames\.json$/);
    expect(manifest.redaction).not.toHaveProperty('docNameMap');
    // The manifest's absolutePath is masked when redaction is on, so the
    // recipient never sees the raw user-home path either.
    expect(manifest.contentDir.absolutePath).toBe('<CONTENT_DIR>');
    // pathSha256 stays as the SHA-256 of the original path for correlation.
    expect(manifest.contentDir.pathSha256).toMatch(/^[0-9a-f]{64}$/);

    // The sidecar exists next to the zip and contains the inverse map.
    const sidecarPath = join(dirname(out), manifest.redaction.docNameMapSidecar);
    expect(existsSync(sidecarPath)).toBe(true);
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
    expect(Object.values(sidecar.docNameMap)).toContain('fixture-doc');
  });

  test('original on-disk JSONL files under .ok/local/ are NOT modified by --redact', async () => {
    const contentDir = makeTmpDir();
    const originalSpansBody = `${JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  attributes: [{ key: 'doc.name', value: { stringValue: 'original-untouched' } }],
                },
              ],
            },
          ],
        },
      ],
    })}\n`;
    const originalLogsBody = `${JSON.stringify({
      level: 30,
      'doc.name': 'original-log-doc',
    })}\n`;
    writeAt(contentDir, '.ok/local/telemetry/spans-current.jsonl', originalSpansBody);
    writeAt(contentDir, '.ok/local/logs/server-current.jsonl', originalLogsBody);

    const { deps } = makeRunnerDeps();
    await runDiagnoseBundle({ contentDir, yes: true, redact: true }, deps);

    // Originals on disk under contentDir/.ok/local/ must be byte-identical to
    // what we seeded — redaction only touches the staged copies in the bundle.
    const spansOnDisk = readFileSync(
      join(contentDir, '.ok/local/telemetry/spans-current.jsonl'),
      'utf-8',
    );
    const logsOnDisk = readFileSync(
      join(contentDir, '.ok/local/logs/server-current.jsonl'),
      'utf-8',
    );
    expect(spansOnDisk).toBe(originalSpansBody);
    expect(logsOnDisk).toBe(originalLogsBody);
    expect(spansOnDisk).toContain('original-untouched');
    expect(logsOnDisk).toContain('original-log-doc');
  });

  test('--redact off by default leaves manifest.redaction.applied=false', async () => {
    const contentDir = makeTmpDir();
    const otlpLine = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  attributes: [{ key: 'doc.name', value: { stringValue: 'visible' } }],
                },
              ],
            },
          ],
        },
      ],
    });
    writeAt(contentDir, '.ok/local/telemetry/spans-current.jsonl', `${otlpLine}\n`);

    const { deps } = makeRunnerDeps();
    const out = join(makeTmpDir('ok-bundle-out-'), 'plain.zip');
    await runDiagnoseBundle({ contentDir, out, yes: true }, deps);

    const extractDir = makeTmpDir('ok-bundle-extract-');
    execSync(`unzip -q ${JSON.stringify(out)} -d ${JSON.stringify(extractDir)}`);
    const zippedSpans = readFileSync(join(extractDir, 'telemetry', 'spans-current.jsonl'), 'utf-8');
    expect(zippedSpans).toContain('visible');

    const manifest = JSON.parse(readFileSync(join(extractDir, 'manifest.json'), 'utf-8'));
    expect(manifest.redaction.applied).toBe(false);
    expect(manifest.redaction.docNameMapSidecar).toBeNull();
    expect(manifest.redaction).not.toHaveProperty('docNameMap');
    expect(manifest.contentDir.absolutePath).toBe(resolve(contentDir));
  });
});
