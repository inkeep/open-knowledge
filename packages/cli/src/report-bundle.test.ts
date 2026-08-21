/**
 * Tests for the leveled report-bundle entry. Real disk fixtures (no fs
 * mocks) matching the bug-report-bundle conventions: injected userLogsDir
 * keeps tests off the real `~/.ok`, and zip verification shells out to
 * `unzip` rather than adding a parser dep.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SERVER_CRASH_LOG } from '@inkeep/open-knowledge-core';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { collectReportBundle as collectReportBundleFromIndex } from './index.ts';
import { collectReportBundle } from './report-bundle.ts';
import type { LanguageMetadata } from './report-language.ts';

const tmpDirs: string[] = [];

function makeTmpDir(prefix = 'ok-report-test-'): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// Several sources default to a path under the home directory when the caller
// supplies no override — the user-level logs, the ShipIt cache, and the
// bug-report send ledger. Every one of those resolves `homedir()` at call time
// rather than at import, precisely so a test can move it. Point HOME at an
// empty directory for the whole file so a developer's own logs and prior bug
// reports cannot end up staged into a fixture bundle, and so a run here matches
// a run on CI, where that directory does not exist.
const realHome = process.env.HOME;
beforeAll(() => {
  process.env.HOME = mkdtempSync(resolve(tmpdir(), 'ok-report-test-home-'));
});
afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});

afterEach(() => {
  for (const d of tmpDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

function writeAt(baseDir: string, relPath: string, body: string | Buffer): void {
  const full = join(baseDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function listZipEntries(zipPath: string): string[] {
  const out = execSync(`unzip -Z1 ${JSON.stringify(zipPath)}`, { encoding: 'utf-8' });
  return out.split('\n').filter(Boolean);
}

function readZipEntry(zipPath: string, entry: string): string {
  return readZipEntryBuffer(zipPath, entry).toString('utf-8');
}

function readZipEntryBuffer(zipPath: string, entry: string): Buffer {
  const extractDir = makeTmpDir('ok-report-extract-');
  execSync(
    `unzip -q -o ${JSON.stringify(zipPath)} ${JSON.stringify(entry)} -d ${JSON.stringify(extractDir)}`,
  );
  return readFileSync(join(extractDir, entry));
}

const SECRET = `ghp_${'a'.repeat(40)}`;

function makeStandardProjectDir(slug = 'report-proj'): string {
  const projectDir = makeTmpDir();
  writeAt(projectDir, '.ok/config.yml', `name: ${slug}\n`);
  writeAt(projectDir, '.ok/local/server.lock', '{"pid":1234}\n');
  writeAt(projectDir, '.ok/local/last-spawn-error.log', 'spawn failed\n');
  writeAt(projectDir, '.ok/local/logs/server-current.jsonl', '{"level":30}\n');
  return projectDir;
}

/** A project with telemetry + log sinks but no shadow repo and no server lock. */
function makeFullProjectDir(slug = 'full-proj'): string {
  const projectDir = makeTmpDir();
  writeAt(projectDir, '.ok/config.yml', `name: ${slug}\n`);
  const span = JSON.stringify({
    name: 'doc.write',
    attributes: [{ key: 'doc.name', value: { stringValue: 'secret-notes/plan' } }],
  });
  const leak = JSON.stringify({ msg: `token ${SECRET}` });
  writeAt(projectDir, '.ok/local/telemetry/spans-current.jsonl', `${span}\n${leak}\n`);
  writeAt(projectDir, '.ok/local/logs/server-current.jsonl', '{"level":30,"msg":"boot"}\n');
  return projectDir;
}

/**
 * One realistically-shaped credential per input the STANDARD tier harvests,
 * paired with the zip entry it must not survive in. The standard tier is
 * `collectStandardBundle`, a different assembler from the full tier's
 * `collectBundle` — the full-tier canary does not cover any of these sinks.
 */
const STANDARD_PLANTS = {
  'logs/desktop.log': 'AKIAIOSFODNN7EXAMPLE',
  'local-logs/server-current.jsonl': SECRET,
  'lockdir/last-spawn-error.log': 'abcdefghijklmnopqrstuvwxyz0123456789',
  'lockdir/server.lock': 'hunter2',
  [`lockdir/${SERVER_CRASH_LOG}`]: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
  'note.txt': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.s5x8Qk3rTvW2pLmNq7Yz',
} as const satisfies Record<string, string>;

const PLANTED_NOTE = `it died right after I pasted ${STANDARD_PLANTS['note.txt']}`;

/** Every standard-tier source seeded with its planted credential. */
function makePlantedStandardProject(): { projectDir: string; userLogsDir: string } {
  const projectDir = makeTmpDir();
  const userLogsDir = makeTmpDir();
  writeAt(projectDir, '.ok/config.yml', 'name: planted-proj\n');
  // The desktop transport's sink: renderer console output captured into
  // `~/.ok/logs`, which the standard tier harvests wholesale.
  writeAt(
    userLogsDir,
    'desktop.log',
    `{"level":50,"msg":"assume-role ${STANDARD_PLANTS['logs/desktop.log']} denied"}\n`,
  );
  // The web transport's sink: the same renderer console output, ingested
  // through `/api/client-logs` into the project-local server log.
  writeAt(
    projectDir,
    '.ok/local/logs/server-current.jsonl',
    `{"level":50,"source":"renderer-console","msg":"push failed ${STANDARD_PLANTS['local-logs/server-current.jsonl']}"}\n`,
  );
  writeAt(
    projectDir,
    '.ok/local/last-spawn-error.log',
    `spawn failed: Authorization: Bearer ${STANDARD_PLANTS['lockdir/last-spawn-error.log']}\n`,
  );
  writeAt(
    projectDir,
    '.ok/local/server.lock',
    `{"pid":1234,"remote":"https://ci:${STANDARD_PLANTS['lockdir/server.lock']}@github.com/o/r.git"}\n`,
  );
  writeAt(
    projectDir,
    `.ok/local/${SERVER_CRASH_LOG}`,
    `{"reason":"boot failed","env":"ANTHROPIC_API_KEY=${STANDARD_PLANTS[`lockdir/${SERVER_CRASH_LOG}`]}"}\n`,
  );
  return { projectDir, userLogsDir };
}

describe('collectReportBundle — standard level', () => {
  test('packages the bug-report content set with level metadata in the summary', async () => {
    const projectDir = makeStandardProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'standard',
      projectDir,
      redact: true,
      outputPath,
    });

    expect(zipPath).toBe(outputPath);
    expect(existsSync(zipPath)).toBe(true);
    const entries = listZipEntries(zipPath);
    expect(entries).toContain('lockdir/server.lock');
    expect(entries).toContain('lockdir/last-spawn-error.log');
    expect(entries).toContain('local-logs/server-current.jsonl');
    expect(entries).toContain('sysinfo.json');
    expect(entries).toContain('MANIFEST.json');
    expect(summary.level).toBe('standard');
    expect(summary.systemWide).toBe(false);
    expect(summary.projectSlug).toBe('report-proj');
    expect(summary.files).toContain('lockdir/server.lock');
  });

  test('persists the note as note.txt, scrubbed and audited when redact is on', async () => {
    const projectDir = makeStandardProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'standard',
      projectDir,
      note: `crashed right after I pasted ${SECRET}`,
      redact: true,
      outputPath,
    });

    const note = readZipEntry(zipPath, 'note.txt');
    expect(note).not.toContain(SECRET);
    expect(note).toContain('[REDACTED-GH-PAT]');
    const manifest = JSON.parse(readZipEntry(zipPath, 'MANIFEST.json'));
    expect(manifest.files).toContain('note.txt');
    expect(summary.files).toContain('note.txt');
    const audit = summary.redactions.find((r) => r.file === 'note.txt');
    expect(audit?.patterns).toContain('github-pat');
    expect(summary.redactedLineCount).toBeGreaterThanOrEqual(1);
  });

  test('includes extra files byte-for-byte under extra/, never scrubbed', async () => {
    const projectDir = makeStandardProjectDir();
    const sourceDir = makeTmpDir();
    const minidump = Buffer.concat([
      Buffer.from([0x4d, 0x44, 0x4d, 0x50, 0x00, 0xff, 0xfe]),
      Buffer.from(SECRET),
      Buffer.from([0x00, 0x01, 0x02]),
    ]);
    writeAt(sourceDir, 'crash.dmp', minidump);
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'standard',
      projectDir,
      redact: true,
      outputPath,
      extraFiles: [{ sourcePath: join(sourceDir, 'crash.dmp') }],
    });

    const bundled = readZipEntryBuffer(zipPath, 'extra/crash.dmp');
    expect(bundled.equals(minidump)).toBe(true);
    expect(summary.files).toContain('extra/crash.dmp');
  });

  test('canary: no planted credential survives in any standard-tier bundle artifact', async () => {
    const { projectDir, userLogsDir } = makePlantedStandardProject();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'standard',
      projectDir,
      note: PLANTED_NOTE,
      redact: true,
      outputPath,
      userLogsDir,
    });

    // Every seeded source really did reach the bundle — otherwise the sweep
    // below would pass by collecting nothing.
    const entries = listZipEntries(zipPath);
    for (const entry of Object.keys(STANDARD_PLANTS)) expect(entries).toContain(entry);

    // No text artifact anywhere in the assembled bundle carries any of them.
    const textEntries = entries.filter((e) => /\.(jsonl?|txt|log|lock|md)$/.test(e));
    for (const entry of textEntries) {
      const content = readZipEntry(zipPath, entry);
      for (const secret of Object.values(STANDARD_PLANTS)) {
        expect(`${entry}: ${content}`).not.toContain(secret);
      }
    }
    expect(summary.redactedLineCount).toBeGreaterThanOrEqual(Object.keys(STANDARD_PLANTS).length);
  });

  test('canary control: with the scrub off every planted credential lands verbatim', async () => {
    const { projectDir, userLogsDir } = makePlantedStandardProject();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'standard',
      projectDir,
      note: PLANTED_NOTE,
      redact: false,
      outputPath,
      userLogsDir,
    });

    // The scrub is the only thing removing them: unredacted, each planted
    // credential is present in the entry it was planted in.
    for (const [entry, secret] of Object.entries(STANDARD_PLANTS)) {
      expect(readZipEntry(zipPath, entry)).toContain(secret);
    }
  });

  test('produces a system-wide bundle when projectDir is omitted', async () => {
    const userLogsDir = makeTmpDir();
    writeAt(userLogsDir, 'cli.log', 'started\n');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'standard',
      redact: true,
      outputPath,
      userLogsDir,
    });

    const entries = listZipEntries(zipPath);
    expect(entries).toContain('logs/cli.log');
    expect(entries).toContain('sysinfo.json');
    expect(entries.some((e) => e.startsWith('lockdir/'))).toBe(false);
    expect(summary.systemWide).toBe(true);
    expect(summary.projectSlug).toBeNull();
  });

  // The collector is tested directly beside `collectShipItLogFiles`, but this
  // entry is where the caches dir is actually resolved and handed to it — the
  // seam a triager's bundle depends on, and the one a refactor can drop
  // without any collector test noticing.
  test('resolves the ShipIt install log from the caches dir and stages it under logs/', async () => {
    const cachesDir = makeTmpDir();
    writeAt(
      cachesDir,
      'com.inkeep.open-knowledge.ShipIt/ShipIt_stderr.log',
      'ShipIt: Failed to move bundle\n',
    );
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'standard',
      projectDir: makeStandardProjectDir(),
      redact: true,
      outputPath,
      userLogsDir: makeTmpDir(),
      cachesDir,
    });

    expect(listZipEntries(zipPath)).toContain('logs/ShipIt_stderr.log');
    expect(summary.files).toContain('logs/ShipIt_stderr.log');
    expect(readZipEntry(zipPath, 'logs/ShipIt_stderr.log')).toContain('Failed to move bundle');
  });
});

describe('collectReportBundle — full level', () => {
  test('produces the diagnose superset and omits unavailable pieces without error', async () => {
    const projectDir = makeFullProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: true,
      outputPath,
    });

    const entries = listZipEntries(zipPath);
    expect(entries).toContain('manifest.json');
    expect(entries).toContain('telemetry/spans-current.jsonl');
    expect(entries).toContain('logs/server-current.jsonl');
    expect(entries).toContain('state/runtime.json');
    expect(entries).toContain('state/server-status.txt');
    // No shadow repo and no server lock in the fixture: both pieces are
    // omitted, and the bundled manifest inventory reflects the omission.
    expect(entries).not.toContain('state/shadow-head.txt');
    expect(entries).not.toContain('state/server.lock');
    expect(entries).not.toContain('state/agent-presence.json');
    const manifest = JSON.parse(readZipEntry(zipPath, 'manifest.json'));
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.serverStatus).toBe('not-running');
    const paths = manifest.files.map((f: { path: string }) => f.path);
    expect(paths).not.toContain('state/shadow-head.txt');
    expect(summary.level).toBe('full');
    expect(summary.systemWide).toBe(false);
    expect(summary.projectSlug).toBe('full-proj');
    expect(summary.files).toEqual(paths);
  });

  test('carries the user-level logs the standard level collects, scrubbed', async () => {
    // On desktop the Electron main process captures the renderer console into
    // the user-level log, never into the project's server sink — so this is the
    // only path a renderer crash reaches a full bundle by.
    const projectDir = makeFullProjectDir();
    const userLogsDir = makeTmpDir();
    writeAt(
      userLogsDir,
      'desktop.2026-07-28.log',
      `${JSON.stringify({ subsystem: 'renderer', msg: 'app-shell render crash' })}\n${JSON.stringify({ msg: `token ${SECRET}` })}\n`,
    );
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: true,
      outputPath,
      userLogsDir,
    });

    const entries = listZipEntries(zipPath);
    expect(entries).toContain('logs/desktop.2026-07-28.log');
    expect(summary.files).toContain('logs/desktop.2026-07-28.log');
    const body = readZipEntry(zipPath, 'logs/desktop.2026-07-28.log');
    expect(body).toContain('app-shell render crash');
    // Staged before the scrub, unlike extra/ payloads.
    expect(body).not.toContain(SECRET);
  });

  // The full level assembles through `diagnose/bundle.ts` rather than the
  // standard collector, so its ShipIt wiring is a second seam that can break
  // on its own. Directory name spelled out rather than imported from
  // `DESKTOP_BUNDLE_ID`, so this also pins the path macOS actually writes.
  test('carries the ShipIt install log the standard level collects', async () => {
    const cachesDir = makeTmpDir();
    writeAt(
      cachesDir,
      'com.inkeep.open-knowledge.ShipIt/ShipIt_stderr.log',
      `ShipIt: Failed to move bundle\ntoken ${SECRET}\n`,
    );
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'full',
      projectDir: makeFullProjectDir(),
      redact: true,
      outputPath,
      userLogsDir: makeTmpDir(),
      cachesDir,
    });

    expect(listZipEntries(zipPath)).toContain('logs/ShipIt_stderr.log');
    const shipIt = readZipEntry(zipPath, 'logs/ShipIt_stderr.log');
    expect(shipIt).toContain('Failed to move bundle');
    expect(shipIt).not.toContain(SECRET);
  });

  test('scrubs ROTATED user logs too, whose counter suffix defeats an extension test', async () => {
    const projectDir = makeFullProjectDir();
    const userLogsDir = makeTmpDir();
    // `desktop.2026-07-28.log.1` slices to `.1`, not `.log`.
    writeAt(
      userLogsDir,
      'desktop.2026-07-28.log.1',
      `${JSON.stringify({ msg: `token ${SECRET}` })}\n`,
    );
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: true,
      outputPath,
      userLogsDir,
    });

    expect(listZipEntries(zipPath)).toContain('logs/desktop.2026-07-28.log.1');
    expect(readZipEntry(zipPath, 'logs/desktop.2026-07-28.log.1')).not.toContain(SECRET);
  });

  test('scrubs credentials in user logs, which are pino JSONL behind a .log suffix', async () => {
    // User-level logs carry a .log suffix but are line-delimited JSON, so
    // routing them by extension alone would give them the substring-only pass
    // and skip the per-line credential scrub. Doc names stay in cleartext by
    // the ratified consent posture: legible names are what make a bundle
    // diagnosable, and the summary says so before anything is written.
    const projectDir = makeFullProjectDir();
    const userLogsDir = makeTmpDir();
    writeAt(
      userLogsDir,
      'desktop.2026-07-28.log',
      `${JSON.stringify({
        attributes: [{ key: 'doc.name', value: { stringValue: 'secret-notes/plan' } }],
        msg: 'token ghp_0123456789abcdefghijABCDEFGHIJ123456 leaked into a log line',
      })}\n`,
    );
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: true,
      outputPath,
      userLogsDir,
    });

    const entry = readZipEntry(zipPath, 'logs/desktop.2026-07-28.log');
    expect(entry).not.toContain('ghp_0123456789abcdefghijABCDEFGHIJ123456');
    expect(entry).toContain('[REDACTED-');
    expect(entry).toContain('secret-notes/plan');
  });

  test('omits telemetry entirely when the sink has never written', async () => {
    const projectDir = makeTmpDir();
    writeAt(projectDir, '.ok/config.yml', 'name: bare-proj\n');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: true,
      outputPath,
    });

    const entries = listZipEntries(zipPath);
    expect(entries.some((e) => e.startsWith('telemetry/'))).toBe(false);
    expect(entries).toContain('manifest.json');
  });

  test('scrubs seeded credentials while doc names ship raw, with no inverse-map sidecar', async () => {
    const projectDir = makeFullProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: true,
      outputPath,
    });

    const spans = readZipEntry(zipPath, 'telemetry/spans-current.jsonl');
    // Credentials are scrubbed, unconditionally.
    expect(spans).not.toContain(SECRET);
    expect(spans).toContain('[REDACTED-GH-PAT]');
    // Doc names ship raw under Detailed-diagnostics consent — no hashing.
    expect(spans).toContain('secret-notes/plan');
    expect(spans).not.toMatch(/doc:[a-f0-9]{8}/);
    const manifest = JSON.parse(readZipEntry(zipPath, 'manifest.json'));
    expect(manifest.redaction.applied).toBe(true);
    const scrub = manifest.redaction.secretScrub;
    expect(scrub.redactions.map((r: { file: string }) => r.file)).toContain(
      'telemetry/spans-current.jsonl',
    );
    expect(summary.redactions).toEqual(scrub.redactions);
    expect(summary.redactedLineCount).toBe(scrub.redactedLineCount);
    expect(summary.redactedLineCount).toBeGreaterThanOrEqual(1);
    // No inverse-map sidecar is written next to the zip anymore.
    expect(existsSync(join(dirname(outputPath), 'report.docnames.json'))).toBe(false);
    expect(listZipEntries(zipPath)).not.toContain('report.docnames.json');
  });

  test('canary: planted credentials appear in no full-tier bundle artifact', async () => {
    const projectDir = makeFullProjectDir();
    // Plant the same secret across multiple sinks: the server log and a
    // loss-ring event field, on top of the span leak makeFullProjectDir seeds.
    writeAt(
      projectDir,
      '.ok/local/logs/server-current.jsonl',
      `{"level":50,"msg":"auth failed for ${SECRET}"}\n`,
    );
    writeAt(
      projectDir,
      '.ok/local/loss-capture/loss-current.jsonl',
      `${JSON.stringify({
        ts: 1,
        schemaVersion: 1,
        seq: 1,
        event: 'detector-trip',
        docName: 'notes/plan',
        writerId: `agent ${SECRET}`,
        checkpointSha: 'deadbeef',
      })}\n`,
    );
    const outputPath = join(makeTmpDir(), 'report.zip');
    const { zipPath } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: true,
      outputPath,
    });

    // No text artifact anywhere in the assembled bundle carries the secret.
    const textEntries = listZipEntries(zipPath).filter((e) => /\.(jsonl?|txt|log|lock)$/.test(e));
    for (const entry of textEntries) {
      expect(readZipEntry(zipPath, entry)).not.toContain(SECRET);
    }
    // The loss ring rode the full tier; its doc name shipped raw, secret gone.
    const ring = readZipEntry(zipPath, 'state/loss-current.jsonl');
    expect(ring).toContain('notes/plan');
    expect(ring).not.toContain(SECRET);
  });

  test('tier gating: the loss ring rides the full tier only, never the standard tier', async () => {
    const projectDir = makeFullProjectDir();
    writeAt(
      projectDir,
      '.ok/local/loss-capture/loss-current.jsonl',
      `${JSON.stringify({ ts: 1, schemaVersion: 1, seq: 1, event: 'checkpoint-write', docName: 'd' })}\n`,
    );

    const full = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: true,
      outputPath: join(makeTmpDir(), 'full.zip'),
    });
    expect(listZipEntries(full.zipPath)).toContain('state/loss-current.jsonl');

    const standard = await collectReportBundle({
      level: 'standard',
      projectDir,
      redact: true,
      outputPath: join(makeTmpDir(), 'standard.zip'),
    });
    expect(listZipEntries(standard.zipPath)).not.toContain('state/loss-current.jsonl');
  });

  test('redact: false leaves content unmodified with an empty audit', async () => {
    const projectDir = makeFullProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: false,
      outputPath,
    });

    const spans = readZipEntry(zipPath, 'telemetry/spans-current.jsonl');
    expect(spans).toContain(SECRET);
    expect(spans).toContain('secret-notes/plan');
    const manifest = JSON.parse(readZipEntry(zipPath, 'manifest.json'));
    expect(manifest.redaction.applied).toBe(false);
    expect(manifest.redaction.secretScrub).toBeUndefined();
    expect(summary.redactions).toEqual([]);
    expect(summary.redactedLineCount).toBe(0);
  });

  test('persists the note and extra files, creating output parents as needed', async () => {
    const projectDir = makeFullProjectDir();
    const sourceDir = makeTmpDir();
    const minidump = Buffer.concat([
      Buffer.from([0x4d, 0x44, 0x4d, 0x50, 0x00, 0xff]),
      Buffer.from(SECRET),
    ]);
    writeAt(sourceDir, 'crash.dmp', minidump);
    const outputPath = join(makeTmpDir(), 'nested', 'sub', 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'full',
      projectDir,
      note: 'Editor froze after paste',
      redact: true,
      outputPath,
      extraFiles: [{ sourcePath: join(sourceDir, 'crash.dmp') }],
    });

    expect(readZipEntry(zipPath, 'note.txt')).toBe('Editor froze after paste');
    const bundled = readZipEntryBuffer(zipPath, 'extra/crash.dmp');
    expect(bundled.equals(minidump)).toBe(true);
    const manifest = JSON.parse(readZipEntry(zipPath, 'manifest.json'));
    const paths = manifest.files.map((f: { path: string }) => f.path);
    expect(paths).toContain('note.txt');
    expect(paths).toContain('extra/crash.dmp');
    expect(summary.files).toContain('note.txt');
    expect(summary.files).toContain('extra/crash.dmp');
  });

  test('scrubs a secret pasted into the note', async () => {
    const projectDir = makeFullProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'full',
      projectDir,
      note: `it broke after ${SECRET}`,
      redact: true,
      outputPath,
    });

    const note = readZipEntry(zipPath, 'note.txt');
    expect(note).not.toContain(SECRET);
    expect(note).toContain('[REDACTED-GH-PAT]');
    expect(summary.redactions.some((r) => r.file === 'note.txt')).toBe(true);
  });

  test('falls back to the system-wide standard set when no project is in scope', async () => {
    const userLogsDir = makeTmpDir();
    writeAt(userLogsDir, 'cli.log', 'started\n');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'full',
      redact: true,
      outputPath,
      userLogsDir,
    });

    const entries = listZipEntries(zipPath);
    expect(entries).toContain('MANIFEST.json');
    expect(entries).toContain('sysinfo.json');
    expect(entries).toContain('logs/cli.log');
    expect(entries).not.toContain('manifest.json');
    expect(summary.level).toBe('full');
    expect(summary.systemWide).toBe(true);
    expect(summary.projectSlug).toBeNull();
  });

  test('resolves content.dir from the project config for the full capture', async () => {
    const projectDir = makeTmpDir();
    writeAt(projectDir, '.ok/config.yml', 'name: split-proj\ncontent:\n  dir: docs\n');
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: false,
      outputPath,
    });

    const manifest = JSON.parse(readZipEntry(zipPath, 'manifest.json'));
    expect(manifest.contentDir.absolutePath).toBe(resolve(projectDir, 'docs'));
  });
});

describe('collectReportBundle — desktop metadata seam', () => {
  const DESKTOP = { electronVersion: '1.2.3', packaged: true, channel: 'latest' };

  test('injected desktop metadata lands in the standard sysinfo and manifest', async () => {
    const projectDir = makeStandardProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'standard',
      projectDir,
      redact: true,
      outputPath,
      readDesktopEnv: () => DESKTOP,
    });

    expect(JSON.parse(readZipEntry(zipPath, 'sysinfo.json')).desktop).toEqual(DESKTOP);
    expect(JSON.parse(readZipEntry(zipPath, 'MANIFEST.json')).sysinfo.desktop).toEqual(DESKTOP);
  });

  test('injected desktop metadata lands in the full runtime block', async () => {
    const projectDir = makeFullProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: false,
      outputPath,
      readDesktopEnv: () => DESKTOP,
    });

    expect(JSON.parse(readZipEntry(zipPath, 'state/runtime.json')).host.desktop).toEqual(DESKTOP);
  });

  test('a null seam records desktop: null at the standard level (not an Electron host)', async () => {
    const projectDir = makeStandardProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'standard',
      projectDir,
      redact: true,
      outputPath,
      readDesktopEnv: () => null,
    });

    expect(JSON.parse(readZipEntry(zipPath, 'sysinfo.json')).desktop).toBeNull();
  });
});

describe('collectReportBundle — interface-language seam', () => {
  const LANGUAGE = {
    preference: 'system',
    locale: 'es',
    source: 'system',
    systemLanguages: ['es-ES', 'en-US'],
  } as const satisfies LanguageMetadata;

  test('injected language lands in the standard sysinfo and manifest', async () => {
    const projectDir = makeStandardProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'standard',
      projectDir,
      redact: true,
      outputPath,
      readLanguage: () => LANGUAGE,
    });

    expect(JSON.parse(readZipEntry(zipPath, 'sysinfo.json')).language).toEqual(LANGUAGE);
    expect(JSON.parse(readZipEntry(zipPath, 'MANIFEST.json')).sysinfo.language).toEqual(LANGUAGE);
  });

  test('injected language lands in the full runtime block and manifest host', async () => {
    const projectDir = makeFullProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: false,
      outputPath,
      readLanguage: () => LANGUAGE,
    });

    expect(JSON.parse(readZipEntry(zipPath, 'state/runtime.json')).host.language).toEqual(LANGUAGE);
    expect(JSON.parse(readZipEntry(zipPath, 'manifest.json')).host.language).toEqual(LANGUAGE);
  });

  // The preference is the field a triager reads to tell a deliberate choice
  // from an inherited one, so it has to survive the round trip unresolved —
  // a bundle recording `'es'` where the user chose `'system'` reads as a
  // decision they never made.
  test('an explicit choice is recorded unresolved beside what it resolved to', async () => {
    const projectDir = makeStandardProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'standard',
      projectDir,
      redact: true,
      outputPath,
      readLanguage: () => ({
        preference: 'ar',
        locale: 'ar',
        source: 'explicit',
        systemLanguages: ['en-US'],
      }),
    });

    const { language } = JSON.parse(readZipEntry(zipPath, 'sysinfo.json'));
    expect(language.preference).toBe('ar');
    expect(language.source).toBe('explicit');
  });

  // Every bundle carries the key, so an absent language is legible as "this
  // build could not tell" rather than as a bundle predating the field.
  test('the default seam still records a language block at both levels', async () => {
    const standardOut = join(makeTmpDir(), 'standard.zip');
    const fullOut = join(makeTmpDir(), 'full.zip');

    const standard = await collectReportBundle({
      level: 'standard',
      projectDir: makeStandardProjectDir(),
      redact: true,
      outputPath: standardOut,
    });
    const full = await collectReportBundle({
      level: 'full',
      projectDir: makeFullProjectDir(),
      redact: false,
      outputPath: fullOut,
    });

    const standardLanguage = JSON.parse(readZipEntry(standard.zipPath, 'sysinfo.json')).language;
    expect(typeof standardLanguage.locale).toBe('string');
    expect(typeof standardLanguage.preference).toBe('string');
    expect(JSON.parse(readZipEntry(full.zipPath, 'manifest.json')).host).toHaveProperty('language');
  });
});

describe('collectReportBundle — opted-in extras that cannot be staged', () => {
  function makeRecordingLogger() {
    const warnings: Array<{ payload: Record<string, unknown>; message: string }> = [];
    return {
      logger: {
        info: () => {},
        warn: (payload: Record<string, unknown>, message: string) => {
          warnings.push({ payload, message });
        },
      },
      warnings,
    };
  }

  test('standard level warns when an extra is unreadable and still builds the bundle', async () => {
    const projectDir = makeStandardProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');
    const missingDump = join(makeTmpDir(), 'vanished.dmp');
    const { logger, warnings } = makeRecordingLogger();

    const { zipPath, summary } = await collectReportBundle({
      level: 'standard',
      projectDir,
      redact: true,
      outputPath,
      extraFiles: [{ sourcePath: missingDump }],
      logger,
    });

    expect(existsSync(zipPath)).toBe(true);
    expect(summary.files.some((f) => f.startsWith('extra/'))).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.payload.sourcePath).toBe(missingDump);
  });

  test('full level warns when an extra is missing on disk and still builds the bundle', async () => {
    const projectDir = makeFullProjectDir();
    const outputPath = join(makeTmpDir(), 'report.zip');
    const missingDump = join(makeTmpDir(), 'vanished.dmp');
    const { logger, warnings } = makeRecordingLogger();

    const { zipPath, summary } = await collectReportBundle({
      level: 'full',
      projectDir,
      redact: true,
      outputPath,
      extraFiles: [{ sourcePath: missingDump }],
      logger,
    });

    expect(existsSync(zipPath)).toBe(true);
    expect(summary.files.some((f) => f.startsWith('extra/'))).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.payload.sourcePath).toBe(missingDump);
  });
});

describe('collectReportBundle — package surface', () => {
  test('is exported from the package index', () => {
    expect(collectReportBundleFromIndex).toBe(collectReportBundle);
  });
});

/**
 * The per-report send ledger (`~/.ok/bug-reports/*.yaml`) records every send
 * attempt with its outcome, and it is the artifact that made the two observed
 * send failures diagnosable at all — but only because they happened on a
 * machine we could read directly.
 *
 * It is also the copy that outlives the logs: `desktop.*.log` rotates on a
 * seven-day/45 MB budget, while a sidecar persists next to its zip. A reporter
 * filing a bug about a send that failed last week has the ledger and no log.
 */
describe('collectReportBundle — bug-report send ledger', () => {
  const LEDGER_YAML = [
    'version: 1',
    'id: 2026-08-19T16-42-03-547Z-bugreport.zip',
    'createdAt: 2026-08-19T16:42:03.547Z',
    'bundleLevel: full',
    'state: upload-failed',
    'lastError:',
    '  reason: upload-network-error',
    '  at: 2026-08-19T16:42:19.000Z',
    'attempts:',
    '  - at: 2026-08-19T16:42:03.547Z',
    '    transport: upload',
    '    outcome: failed',
    '    error: upload-network-error',
    '',
  ].join('\n');

  /** A reports dir shaped like the real one: sidecars beside their payloads. */
  function makeBugReportsDir(): string {
    const dir = makeTmpDir('ok-bug-reports-');
    writeAt(dir, '2026-08-19T16-42-03-547Z-bugreport.yaml', LEDGER_YAML);
    writeAt(dir, '2026-08-19T16-42-03-547Z-bugreport.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    return dir;
  }

  test('full level stages the ledger so a failed send is answerable from the bundle', async () => {
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath, summary } = await collectReportBundle({
      level: 'full',
      projectDir: makeFullProjectDir(),
      redact: true,
      outputPath,
      userLogsDir: makeTmpDir(),
      bugReportsDir: makeBugReportsDir(),
    });

    const entry = 'state/bug-reports/2026-08-19T16-42-03-547Z-bugreport.yaml';
    expect(listZipEntries(zipPath)).toContain(entry);
    expect(summary.files).toContain(entry);
    // The attempt sequence is the whole point: two failures then a success is
    // what separates a transient fault from a broken intake.
    expect(readZipEntry(zipPath, entry)).toContain('upload-network-error');
  });

  test('standard level stages it too', async () => {
    // A reporter filing at standard level is reporting the same failed send.
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'standard',
      projectDir: makeStandardProjectDir(),
      redact: true,
      outputPath,
      userLogsDir: makeTmpDir(),
      bugReportsDir: makeBugReportsDir(),
    });

    expect(listZipEntries(zipPath)).toContain(
      'state/bug-reports/2026-08-19T16-42-03-547Z-bugreport.yaml',
    );
  });

  test('neither level stages the zip payloads sitting beside the sidecars', async () => {
    // A bundle must not contain other bundles: the reports dir holds every
    // previously-captured zip, and harvesting them would multiply a 6 MB
    // report by every report the machine has ever kept.
    for (const level of ['standard', 'full'] as const) {
      const outputPath = join(makeTmpDir(), `${level}.zip`);
      const { zipPath } = await collectReportBundle({
        level,
        projectDir: level === 'full' ? makeFullProjectDir() : makeStandardProjectDir(),
        redact: true,
        outputPath,
        userLogsDir: makeTmpDir(),
        bugReportsDir: makeBugReportsDir(),
      });

      expect(listZipEntries(zipPath).filter((e) => e.endsWith('-bugreport.zip'))).toEqual([]);
    }
  });

  test('the ledger goes through the secret scrub like every other staged text file', async () => {
    // Sidecars carry a `note` field holding the reporter's own words, so this
    // is user-authored text, not machine output. Staging it without the scrub
    // would ship a credential a reporter pasted into a bug description.
    // `.yaml` is not one of the extensions the full-level scrub recognized, so
    // this is the failure mode a scrub-by-extension design invites.
    const dir = makeTmpDir('ok-bug-reports-');
    writeAt(
      dir,
      '2026-08-19T16-42-03-547Z-bugreport.yaml',
      `${LEDGER_YAML}note: it died right after I pasted ${SECRET}\n`,
    );

    for (const level of ['standard', 'full'] as const) {
      const outputPath = join(makeTmpDir(), `${level}.zip`);
      const { zipPath } = await collectReportBundle({
        level,
        projectDir: level === 'full' ? makeFullProjectDir() : makeStandardProjectDir(),
        redact: true,
        outputPath,
        userLogsDir: makeTmpDir(),
        bugReportsDir: dir,
      });

      const body = readZipEntry(
        zipPath,
        'state/bug-reports/2026-08-19T16-42-03-547Z-bugreport.yaml',
      );
      expect(body).toContain('upload-network-error');
      expect(body).not.toContain(SECRET);
    }
  });

  test('a dir with dozens of reports contributes a bounded, newest-first slice', async () => {
    // Retention keeps reports around, so this directory grows without limit on
    // a machine that files often. Report ids are timestamp-prefixed, so newest
    // sorts last lexicographically and no stat call is needed to rank them.
    const dir = makeTmpDir('ok-bug-reports-');
    for (let i = 0; i < 40; i += 1) {
      const stamp = `2026-08-${String((i % 28) + 1).padStart(2, '0')}T10-00-${String(i).padStart(2, '0')}-000Z`;
      writeAt(dir, `${stamp}-bugreport.yaml`, `id: ${stamp}-bugreport.zip\nstate: sent\n`);
    }
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'full',
      projectDir: makeFullProjectDir(),
      redact: true,
      outputPath,
      userLogsDir: makeTmpDir(),
      bugReportsDir: dir,
    });

    const staged = listZipEntries(zipPath).filter((e) => e.startsWith('state/bug-reports/'));
    // Exact, not a range: 40 readable sidecars go in, so a range assertion
    // holds just as well if the cap regresses to 1, and the ordering
    // assertions below would still pass. The number is the contract.
    expect(staged.length).toBe(25);
    // Newest kept: the last id by sort order must be present, the first absent.
    expect(staged).toContain('state/bug-reports/2026-08-28T10-00-27-000Z-bugreport.yaml');
    expect(staged).not.toContain('state/bug-reports/2026-08-01T10-00-00-000Z-bugreport.yaml');
  });

  test('an absent reports dir is not an error', async () => {
    const outputPath = join(makeTmpDir(), 'report.zip');

    const { zipPath } = await collectReportBundle({
      level: 'full',
      projectDir: makeFullProjectDir(),
      redact: true,
      outputPath,
      userLogsDir: makeTmpDir(),
      bugReportsDir: join(makeTmpDir(), 'does-not-exist'),
    });

    expect(existsSync(zipPath)).toBe(true);
    expect(listZipEntries(zipPath).filter((e) => e.startsWith('state/bug-reports/'))).toEqual([]);
  });
});
