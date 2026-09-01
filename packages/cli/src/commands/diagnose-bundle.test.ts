import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { type RunDiagnoseBundleDeps, runDiagnoseBundle } from './diagnose.ts';

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
    diagnosticReportsDir: makeTmpDir('ok-bundle-runner-reports-'),
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

describe('runDiagnoseBundle — macOS crash reports', () => {
  function writeReport(dir: string, fileName: string, name: string): void {
    const header = JSON.stringify({
      app_name: name,
      name,
      bug_type: '309',
      timestamp: '2026-05-28 14:00:00.00 +0000',
    });
    const body = JSON.stringify({ procName: name, asi: { [name]: ['abort() called'] } });
    writeAt(dir, fileName, `${header}\n${body}\n`.replaceAll('/', String.raw`\/`));
  }

  test('collects into the zip, and the summary says what it found', async () => {
    const contentDir = makeTmpDir();
    const reportsDir = makeTmpDir('ok-bundle-runner-reports-');
    writeReport(reportsDir, 'OpenKnowledge-2026-05-28-140000.ips', 'OpenKnowledge');
    writeReport(reportsDir, 'Slack-2026-05-28-140000.ips', 'Slack');
    const { deps, captured } = makeRunnerDeps({ diagnosticReportsDir: reportsDir });

    const result = await runDiagnoseBundle({ contentDir, yes: true }, deps);

    const entries = readZipEntries(result.outputPath ?? '');
    expect(entries).toContain('diagnostic-reports/OpenKnowledge-2026-05-28-140000.ips');
    expect(entries).not.toContain('diagnostic-reports/Slack-2026-05-28-140000.ips');
    expect(entries).toContain('state/diagnostic-reports-status.txt');
    const summaryLine = captured.logs.find((l) => l.includes('macOS crash reports:'));
    expect(summaryLine).toContain(
      '1 collected (7d; 1 other-process report(s) ignored; 0 unparseable)',
    );
    expect(summaryLine).not.toContain('not-collected');
  });

  test('reports an empty sweep rather than staying silent', async () => {
    const contentDir = makeTmpDir();
    const { deps, captured } = makeRunnerDeps();

    await runDiagnoseBundle({ contentDir, yes: true }, deps);

    expect(captured.logs.find((l) => l.includes('macOS crash reports:'))).toContain(
      'none found in window',
    );
  });

  test('--no-redact names the crash-report rewrite as the exception', async () => {
    const contentDir = makeTmpDir();
    const reportsDir = makeTmpDir('ok-bundle-runner-reports-');
    writeReport(reportsDir, 'OpenKnowledge-2026-05-28-140000.ips', 'OpenKnowledge');
    const { deps, captured } = makeRunnerDeps({ diagnosticReportsDir: reportsDir });

    await runDiagnoseBundle({ contentDir, yes: true, redact: false }, deps);
    const allLogs = captured.logs.join('\n');

    expect(allLogs).toContain(
      'NOT scrubbed (--no-redact): tokens and keys ship verbatim, crash reports excepted',
    );
    expect(allLogs).toContain('Not byte-identical to the files macOS wrote');
  });

  test('--no-redact promises no exception when no report was staged', async () => {
    const contentDir = makeTmpDir();
    const { deps, captured } = makeRunnerDeps();

    await runDiagnoseBundle({ contentDir, yes: true, redact: false }, deps);
    const allLogs = captured.logs.join('\n');

    expect(allLogs).toContain('NOT scrubbed (--no-redact): tokens and keys ship verbatim');
    expect(allLogs).not.toContain('crash reports excepted');
    expect(allLogs).not.toContain('Not byte-identical to the files macOS wrote');
  });
});

describe('runDiagnoseBundle — tracer bullet', () => {
  test('writes a zip to the default path with no server running and --yes', async () => {
    const contentDir = makeTmpDir();
    const { deps, captured } = makeRunnerDeps();

    const result = await runDiagnoseBundle({ contentDir, yes: true }, deps);

    expect(result.outputPath).not.toBeNull();
    expect(result.outputPath).toContain(join(contentDir, '.ok', 'local', 'diagnostics'));
    expect(result.outputPath?.endsWith('.zip')).toBe(true);
    expect(existsSync(result.outputPath ?? '')).toBe(true);

    expect(captured.prompts.length).toBe(0);

    const entries = readZipEntries(result.outputPath ?? '');
    expect(entries).toContain('manifest.json');
    expect(entries).toContain('state/runtime.json');
    expect(entries).toContain('state/server-status.txt');
  });
});

describe('runDiagnoseBundle — no running server', () => {
  test('manifest.serverStatus is not-running; state/server-status.txt confirms', async () => {
    const contentDir = makeTmpDir();
    const { deps, captured } = makeRunnerDeps();

    const result = await runDiagnoseBundle({ contentDir, yes: true }, deps);
    expect(result.outputPath).not.toBeNull();

    const extractDir = makeTmpDir('ok-bundle-extract-');
    execSync(
      `unzip -q ${JSON.stringify(result.outputPath ?? '')} -d ${JSON.stringify(extractDir)}`,
    );
    const manifest = JSON.parse(readFileSync(join(extractDir, 'manifest.json'), 'utf-8'));
    expect(manifest.serverStatus).toBe('not-running');
    const statusBody = readFileSync(join(extractDir, 'state', 'server-status.txt'), 'utf-8');
    expect(statusBody).toContain('not-running');

    const allLogs = captured.logs.join('\n');
    expect(allLogs).toContain('server not running');
  });
});

describe('runDiagnoseBundle — --pid integration', () => {
  test('--pid runs process-diagnose into a tmp dir and includes process/ in the zip', async () => {
    const contentDir = makeTmpDir();
    let pidSeen: number | null = null;
    let processDirHandedOff: string | null = null;
    const { deps } = makeRunnerDeps({
      runProcessDiagnose: async (pid) => {
        pidSeen = pid;
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
    expect(allLogs).toContain('what leaves this machine');
    expect(allLogs).toContain('Files:');
    expect(allLogs).toContain('Total size:');
    expect(allLogs).toContain('Document names:');
    expect(allLogs).toContain('Content-dir path:');
    expect(allLogs).toContain('Credentials:');
    expect(allLogs).toContain('Server status:');
    expect(allLogs).toMatch(/Document names:\s+included in cleartext \(1 doc\.name occurrence/);
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

describe('runDiagnoseBundle — consent summary', () => {
  const SECRET = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';

  function seedSpans(contentDir: string): void {
    writeAt(
      contentDir,
      '.ok/local/telemetry/spans-current.jsonl',
      `${JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    attributes: [
                      { key: 'doc.name', value: { stringValue: 'q3-layoff-plan' } },
                      { key: 'fs.path', value: { stringValue: `${contentDir}/q3-layoff-plan.md` } },
                      { key: 'ok.note', value: { stringValue: `token ${SECRET}` } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      })}\n`,
    );
  }

  test('default run names doc names as cleartext, the path as masked, and counts the scrub', async () => {
    const contentDir = makeTmpDir();
    seedSpans(contentDir);
    const { deps, captured } = makeRunnerDeps();

    await runDiagnoseBundle({ contentDir, yes: true }, deps);
    const allLogs = captured.logs.join('\n');

    expect(allLogs).toMatch(/Document names:\s+included in cleartext/);
    expect(allLogs).toContain('masked as <CONTENT_DIR>');
    expect(allLogs).not.toContain('but still present in some files');

    const scrubbed = allLogs.match(
      /Credentials:\s+scrubbed known credential formats \((\d+) line\(s\) across (\d+) file\(s\)\)/,
    );
    expect(scrubbed).not.toBeNull();
    expect(Number(scrubbed?.[1])).toBeGreaterThan(0);
    expect(Number(scrubbed?.[2])).toBeGreaterThan(0);

    expect(allLogs).not.toContain('Redacted:');
  });

  test('--no-redact run says the path is visible and credentials are not scrubbed', async () => {
    const contentDir = makeTmpDir();
    seedSpans(contentDir);
    const { deps, captured } = makeRunnerDeps();

    await runDiagnoseBundle({ contentDir, yes: true, redact: false }, deps);
    const allLogs = captured.logs.join('\n');

    expect(allLogs).toMatch(/Document names:\s+included in cleartext/);
    expect(allLogs).toContain(`visible (${resolve(contentDir)})`);
    expect(allLogs).toContain('NOT scrubbed (--no-redact): tokens and keys ship verbatim');
    expect(allLogs).not.toContain('masked as <CONTENT_DIR>');
  });

  test('the summary describes the bundle that was actually written', async () => {
    const contentDir = makeTmpDir();
    seedSpans(contentDir);
    const { deps, captured } = makeRunnerDeps();

    const result = await runDiagnoseBundle({ contentDir, yes: true }, deps);
    const allLogs = captured.logs.join('\n');

    const extractDir = makeTmpDir('ok-bundle-extract-');
    execSync(
      `unzip -q ${JSON.stringify(result.outputPath ?? '')} -d ${JSON.stringify(extractDir)}`,
    );
    const spans = readFileSync(join(extractDir, 'telemetry', 'spans-current.jsonl'), 'utf-8');

    expect(allLogs).toMatch(/Document names:\s+included in cleartext/);
    expect(spans).toContain('q3-layoff-plan');
    expect(allLogs).toContain('masked as <CONTENT_DIR>');
    expect(spans).not.toContain(contentDir);
    expect(allLogs).toMatch(/Credentials:\s+scrubbed/);
    expect(spans).not.toContain(SECRET);
  });
});

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

describe('runDiagnoseBundle — redaction', () => {
  test('redacts by default: masks contentDir and scrubs credentials while doc names ship raw', async () => {
    const contentDir = makeTmpDir();
    const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
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
                    { key: 'ok.note', value: { stringValue: `token ${secret}` } },
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
    const result = await runDiagnoseBundle({ contentDir, out, yes: true }, deps);
    expect(result.outputPath).toBe(out);

    const extractDir = makeTmpDir('ok-bundle-extract-');
    execSync(`unzip -q ${JSON.stringify(out)} -d ${JSON.stringify(extractDir)}`);
    const zippedSpans = readFileSync(join(extractDir, 'telemetry', 'spans-current.jsonl'), 'utf-8');

    expect(zippedSpans).toContain('fixture-doc');
    expect(zippedSpans).not.toMatch(/doc:[a-f0-9]{8}/);
    expect(zippedSpans).not.toContain(contentDir);
    expect(zippedSpans).toContain('<CONTENT_DIR>/foo.md');
    expect(zippedSpans).not.toContain(secret);
    expect(zippedSpans).toContain('[REDACTED-GH-PAT]');

    const manifest = JSON.parse(readFileSync(join(extractDir, 'manifest.json'), 'utf-8'));
    expect(manifest.redaction.applied).toBe(true);
    expect(manifest.redaction).not.toHaveProperty('docNameMapSidecar');
    expect(manifest.redaction).not.toHaveProperty('docNameMap');
    expect(manifest.redaction.secretScrub.redactedLineCount).toBeGreaterThan(0);
    expect(manifest.contentDir.absolutePath).toBe('<CONTENT_DIR>');
    expect(manifest.contentDir.pathSha256).toMatch(/^[0-9a-f]{64}$/);

    expect(existsSync(join(dirname(out), 'redacted.docnames.json'))).toBe(false);
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

  test('--no-redact writes a raw bundle: doc names, content-dir, and credentials all visible', async () => {
    const contentDir = makeTmpDir();
    const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    const otlpLine = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  attributes: [
                    { key: 'doc.name', value: { stringValue: 'visible' } },
                    { key: 'fs.path', value: { stringValue: `${contentDir}/foo.md` } },
                    { key: 'ok.note', value: { stringValue: `token ${secret}` } },
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
    const out = join(makeTmpDir('ok-bundle-out-'), 'plain.zip');
    await runDiagnoseBundle({ contentDir, out, yes: true, redact: false }, deps);

    const extractDir = makeTmpDir('ok-bundle-extract-');
    execSync(`unzip -q ${JSON.stringify(out)} -d ${JSON.stringify(extractDir)}`);
    const zippedSpans = readFileSync(join(extractDir, 'telemetry', 'spans-current.jsonl'), 'utf-8');
    expect(zippedSpans).toContain('visible');
    expect(zippedSpans).toContain(secret);
    expect(zippedSpans).toContain(contentDir);

    const manifest = JSON.parse(readFileSync(join(extractDir, 'manifest.json'), 'utf-8'));
    expect(manifest.redaction.applied).toBe(false);
    expect(manifest.redaction).not.toHaveProperty('docNameMapSidecar');
    expect(manifest.contentDir.absolutePath).toBe(resolve(contentDir));
  });
});
