/**
 * IPC handler tests for the `ok:bug-report:dispatch` create operation.
 *
 * Exercise the pure handler directly against tmpdir-backed fixtures with the
 * real `collectReportBundle` (no capture mocks) — zip contents are the
 * observable contract. The IPC wrapping in main/index.ts is one createHandler
 * call whose ctx-resolution behavior is shared with every project-scoped IPC
 * and covered by the existing main-side siblings.
 *
 * HOME and the `OK_DESKTOP_*` block are snapshot/restored around every test.
 * Vitest forks a worker per test file, so the blast radius stops at this file
 * — but every test inside it shares that one process, and these are exactly
 * the variables the bundle collector reads, so an unrestored mutation makes a
 * later test here depend on which test ran before it.
 */

import { execFileSync, execSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Span names started during a send, for the phase-parity assertions below.
 * The real tracer is a no-op unless OTEL_SDK_DISABLED is 'false', so this
 * records at the `@inkeep/open-knowledge-server` boundary instead — the same
 * seam `bug-report-trace.test.ts` uses.
 */
const startedSpanNames: string[] = [];
vi.mock('@inkeep/open-knowledge-server', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getTracer: () => ({
      startSpan(name: string) {
        startedSpanNames.push(name);
        return {
          isRecording: () => true,
          setAttribute: () => {},
          setAttributes: () => {},
          setStatus: () => {},
          end: () => {},
        };
      },
    }),
  };
});

import {
  createBugReportSidecarStore,
  readReportSidecar,
  sidecarPathForId,
} from '../bug-report-sidecar.ts';
import { createCrashDetection } from '../crash-detection.ts';
import { handleShellOpenExternal } from '../shell-allowlist.ts';
import {
  type BugReportCreateDeps,
  type BugReportScreenshotEntry,
  type BugReportSendDeps,
  type CapturableImage,
  type CaptureScreenshotDeps,
  createBugReportScreenshotHold,
  DEFAULT_BUG_REPORT_INTAKE_URL,
  handleBugReportCaptureScreenshot,
  handleBugReportCrashAck,
  handleBugReportCrashDumpAvailability,
  handleBugReportCreate,
  handleBugReportSend,
  MAX_UPLOAD_ZIP_BYTES,
  type MinidumpIntent,
  type OkBugReportCreateRequest,
  parseTransportSafeUrl,
  resolveBugReportIntakeUrl,
  resolveMinidumpAttachment,
  resolveMinidumpIntent,
} from './bug-report.ts';

const tmpDirs: string[] = [];

function makeTmpDir(prefix = 'ok-bugreport-ipc-'): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const ENV_KEYS = [
  'HOME',
  'OK_DESKTOP_VERSION',
  'OK_DESKTOP_PACKAGED',
  'OK_DESKTOP_CHANNEL',
] as const;
let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  envSnapshot = {};
  for (const key of ENV_KEYS) envSnapshot[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = envSnapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const d of tmpDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

function writeAt(baseDir: string, relPath: string, body: string): void {
  const full = join(baseDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function listZipEntries(zipPath: string): string[] {
  const out = execSync(`unzip -Z1 ${JSON.stringify(zipPath)}`, { encoding: 'utf-8' });
  return out.split('\n').filter(Boolean);
}

function readZipEntry(zipPath: string, entry: string): string {
  const extractDir = makeTmpDir('ok-bugreport-ipc-extract-');
  execSync(
    `unzip -q -o ${JSON.stringify(zipPath)} ${JSON.stringify(entry)} -d ${JSON.stringify(extractDir)}`,
  );
  return readFileSync(join(extractDir, entry), 'utf8');
}

/** Raw-bytes sibling of `readZipEntry` for entries that must not be decoded (minidumps). */
function readZipEntryBytes(zipPath: string, entry: string): Buffer {
  const extractDir = makeTmpDir('ok-bugreport-ipc-extract-');
  execSync(
    `unzip -q -o ${JSON.stringify(zipPath)} ${JSON.stringify(entry)} -d ${JSON.stringify(extractDir)}`,
  );
  return readFileSync(join(extractDir, entry));
}

function makeProjectDir(slug = 'ipc-proj'): string {
  const projectDir = makeTmpDir();
  writeAt(projectDir, '.ok/config.yml', `name: ${slug}\n`);
  return projectDir;
}

const DESKTOP_META = { version: '0.9.9-test.1', packaged: false, channel: 'beta' };

function makeDeps(overrides: Partial<BugReportCreateDeps> = {}): BugReportCreateDeps {
  return {
    projectDir: null,
    desktopMeta: DESKTOP_META,
    outputPath: join(makeTmpDir(), 'report.zip'),
    userLogsDir: makeTmpDir(),
    ...overrides,
  };
}

/** One report-time minidump lookup result, defaulting to "nothing was skipped". */
function dumpLookup(path: string | null, foreignSkipped = 0, unknownSkipped = 0) {
  return { path, foreignSkipped, unknownSkipped };
}

/**
 * Records what the handler logged, so the crash-dump decision lines can be
 * asserted on. The real desktop logger is level-silent under NODE_ENV=test and
 * writes async, so the injected sink is the only observable.
 */
function makeLogRecorder() {
  const lines: Array<{
    level: 'info' | 'warn';
    payload: Record<string, unknown>;
    message: string;
  }> = [];
  const ofPhase = (phase: 'intent' | 'outcome') => {
    const found = lines.filter(
      (l) => l.payload.event === 'bug-report.minidump-decision' && l.payload.phase === phase,
    );
    if (found.length > 1) throw new Error(`expected at most one ${phase}, got ${found.length}`);
    return found[0];
  };
  return {
    lines,
    logger: {
      info: (payload: Record<string, unknown>, message: string) => {
        lines.push({ level: 'info', payload, message });
      },
      warn: (payload: Record<string, unknown>, message: string) => {
        lines.push({ level: 'warn', payload, message });
      },
    },
    /** The pre-collection record — the one that can reach the bundle it describes. */
    intent: () => ofPhase('intent'),
    /** The post-collection confirmation, emitted only for a dump that was on hand. */
    outcome: () => ofPhase('outcome'),
    /** Every decision line, whichever phase, for exhaustive payload sweeps. */
    decisions: () => lines.filter((l) => l.payload.event === 'bug-report.minidump-decision'),
  };
}

describe('handleBugReportCreate — project bundle', () => {
  test('builds the zip at the returned path with the project content set and the note', async () => {
    const projectDir = makeProjectDir();
    writeAt(projectDir, '.ok/local/server.lock', '{"pid":1234}\n');
    writeAt(projectDir, '.ok/local/logs/server-current.jsonl', '{"level":30}\n');
    const deps = makeDeps({ projectDir });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      note: 'it crashed while saving',
    });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(result.zipPath).toBe(deps.outputPath as string);
    expect(existsSync(result.zipPath)).toBe(true);
    expect(result.zipSizeBytes).toBe(statSync(result.zipPath).size);
    expect(result.zipSizeBytes).toBeGreaterThan(0);
    expect(result.summary.level).toBe('standard');
    expect(result.summary.systemWide).toBe(false);
    expect(result.summary.projectSlug).toBe('ipc-proj');

    const entries = listZipEntries(result.zipPath);
    expect(entries).toContain('lockdir/server.lock');
    expect(entries).toContain('local-logs/server-current.jsonl');
    expect(entries).toContain('sysinfo.json');
    expect(entries).toContain('note.txt');
    expect(readZipEntry(result.zipPath, 'note.txt')).toContain('it crashed while saving');
  });

  test('carries the send ledger from the directory the report is written into', async () => {
    // A sidecar lives beside its zip, so the ledger that belongs with a report
    // is the one in the report's own directory — the real reports dir in
    // production, a fixture dir here. Without that the collector would fall
    // back to the home directory and a test would bundle the developer's own
    // prior reports while proving nothing about the wiring.
    //
    // This is the evidence a send failure leaves behind. Its absence is why the
    // two observed failures were only diagnosable on a machine we could read.
    const reportsDir = makeTmpDir('ok-bugreport-reports-');
    writeFileSync(
      join(reportsDir, '2026-08-19T16-42-03-547Z-bugreport.yaml'),
      ['id: 2026-08-19T16-42-03-547Z-bugreport.zip', 'state: upload-failed'].join('\n'),
    );
    const deps = makeDeps({
      projectDir: makeProjectDir(),
      outputPath: join(reportsDir, 'report.zip'),
    });

    const result = await handleBugReportCreate(deps, { kind: 'create', level: 'standard' });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    const entries = listZipEntries(result.zipPath);
    expect(entries).toContain('state/bug-reports/2026-08-19T16-42-03-547Z-bugreport.yaml');
    // The zip being written is in that same directory; a bundle must not
    // contain itself or any other bundle.
    expect(entries.filter((e) => e.endsWith('.zip'))).toEqual([]);
  });

  test('rejects a create request whose note exceeds the length ceiling', async () => {
    const deps = makeDeps({ projectDir: makeProjectDir() });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      note: 'x'.repeat(32_769),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid-request');
  });

  test('redacts a seeded secret in the bundled copy and audits it in the summary', async () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwx';
    const projectDir = makeProjectDir();
    writeAt(projectDir, '.ok/local/logs/server-current.jsonl', `{"msg":"key ${secret}"}\n`);
    const deps = makeDeps({ projectDir });

    const result = await handleBugReportCreate(deps, { kind: 'create', level: 'standard' });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    const bundled = readZipEntry(result.zipPath, 'local-logs/server-current.jsonl');
    expect(bundled).not.toContain(secret);
    expect(bundled).toContain('[REDACTED-ANTHROPIC]');
    expect(result.summary.redactions.length).toBeGreaterThan(0);
    expect(result.summary.redactedLineCount).toBeGreaterThan(0);
  });

  test('full level stamps the desktop host metadata into the bundle runtime block', async () => {
    const projectDir = makeProjectDir();
    const deps = makeDeps({ projectDir });
    // A canary in the env proves the metadata travels the typed collector
    // seam — the collector must never fall back to `OK_DESKTOP_*`.
    process.env.OK_DESKTOP_VERSION = 'env-canary-must-not-be-read';
    process.env.OK_DESKTOP_PACKAGED = '1';
    process.env.OK_DESKTOP_CHANNEL = 'env-canary';

    const result = await handleBugReportCreate(deps, { kind: 'create', level: 'full' });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(result.summary.level).toBe('full');
    const runtime = JSON.parse(readZipEntry(result.zipPath, 'state/runtime.json'));
    expect(runtime.host.desktop).toEqual({
      electronVersion: DESKTOP_META.version,
      packaged: false,
      channel: 'beta',
    });
  });

  /**
   * The seam this feature exists for. A macOS app launched from Finder has no
   * `LANG`, so if the collector ever fell through to its POSIX default the
   * bundle would report the fallback locale for every in-app report no matter
   * what the user was reading. The env below is set to a DIFFERENT language
   * than the injected reader returns, so a fall-through cannot pass this.
   */
  test('the injected desktop language reaches the bundle, not the POSIX default', async () => {
    const projectDir = makeProjectDir();
    const desktopLanguage = {
      preference: 'zh-Hant',
      locale: 'zh-Hant',
      source: 'explicit',
      systemLanguages: ['zh-TW', 'en-US'],
    } as const;
    const deps = makeDeps({ projectDir, readLanguage: () => desktopLanguage });
    const priorLang = process.env.LANG;
    process.env.LANG = 'fr_FR.UTF-8';

    try {
      const full = await handleBugReportCreate(deps, { kind: 'create', level: 'full' });
      if (!full.ok) throw new Error(`expected ok, got: ${full.error}`);
      const runtime = JSON.parse(readZipEntry(full.zipPath, 'state/runtime.json'));
      expect(runtime.host.language).toEqual(desktopLanguage);

      const standard = await handleBugReportCreate(
        makeDeps({ projectDir, readLanguage: () => desktopLanguage }),
        { kind: 'create', level: 'standard' },
      );
      if (!standard.ok) throw new Error(`expected ok, got: ${standard.error}`);
      expect(JSON.parse(readZipEntry(standard.zipPath, 'sysinfo.json')).language).toEqual(
        desktopLanguage,
      );
    } finally {
      if (priorLang === undefined) delete process.env.LANG;
      else process.env.LANG = priorLang;
    }
  });

  test('standard level records the desktop host metadata in sysinfo and the manifest', async () => {
    const projectDir = makeProjectDir();
    const deps = makeDeps({ projectDir });

    const result = await handleBugReportCreate(deps, { kind: 'create', level: 'standard' });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    const expected = {
      electronVersion: DESKTOP_META.version,
      packaged: false,
      channel: 'beta',
    };
    expect(JSON.parse(readZipEntry(result.zipPath, 'sysinfo.json')).desktop).toEqual(expected);
    expect(JSON.parse(readZipEntry(result.zipPath, 'MANIFEST.json')).sysinfo.desktop).toEqual(
      expected,
    );
  });

  test('create leaves process.env free of OK_DESKTOP_* — metadata is injected, never stamped', async () => {
    delete process.env.OK_DESKTOP_VERSION;
    delete process.env.OK_DESKTOP_PACKAGED;
    delete process.env.OK_DESKTOP_CHANNEL;
    const deps = makeDeps({ projectDir: makeProjectDir() });

    const result = await handleBugReportCreate(deps, { kind: 'create', level: 'full' });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(process.env.OK_DESKTOP_VERSION).toBeUndefined();
    expect(process.env.OK_DESKTOP_PACKAGED).toBeUndefined();
    expect(process.env.OK_DESKTOP_CHANNEL).toBeUndefined();
  });
});

describe('handleBugReportCreate — no project (system-wide)', () => {
  test('null projectDir degrades to a labeled system-wide bundle of user logs + sysinfo', async () => {
    const userLogsDir = makeTmpDir();
    writeFileSync(join(userLogsDir, 'desktop.log'), 'renderer line\n');
    const deps = makeDeps({ projectDir: null, userLogsDir });

    const result = await handleBugReportCreate(deps, { kind: 'create', level: 'standard' });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(result.summary.systemWide).toBe(true);
    expect(result.summary.projectSlug).toBeNull();

    const entries = listZipEntries(result.zipPath);
    expect(entries).toContain('logs/desktop.log');
    expect(entries).toContain('sysinfo.json');
    expect(entries.some((e) => e.startsWith('lockdir/'))).toBe(false);
    expect(entries.some((e) => e.startsWith('local-logs/'))).toBe(false);
  });

  test('defaults the destination to ~/.ok/bug-reports/<timestamp>-bugreport.zip', () => {
    // The default path resolves through `homedir()`, so steering it means
    // steering HOME. A subprocess with a fake HOME keeps that mutation out of
    // this process entirely — every other test in this file shares it — while
    // still proving the real `~/.ok` is never where a test writes.
    const fakeHome = makeTmpDir('ok-bugreport-home-');
    const userLogsDir = makeTmpDir();
    const driverDir = makeTmpDir('ok-bugreport-driver-');
    const handlerPath = resolve(import.meta.dirname, 'bug-report.ts');
    writeFileSync(
      join(driverDir, 'driver.ts'),
      [
        `import { handleBugReportCreate } from ${JSON.stringify(handlerPath)};`,
        'const result = await handleBugReportCreate(',
        `  { projectDir: null, desktopMeta: ${JSON.stringify(DESKTOP_META)}, userLogsDir: ${JSON.stringify(userLogsDir)} },`,
        "  { kind: 'create', level: 'standard' },",
        ');',
        'console.log(JSON.stringify(result));',
      ].join('\n'),
    );

    const stdout = execFileSync(process.execPath, [join(driverDir, 'driver.ts')], {
      env: { ...process.env, HOME: fakeHome },
      encoding: 'utf-8',
    });
    const lines = stdout.trim().split('\n');
    const result = JSON.parse(lines[lines.length - 1] ?? '') as Awaited<
      ReturnType<typeof handleBugReportCreate>
    >;

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(dirname(result.zipPath)).toBe(join(fakeHome, '.ok', 'bug-reports'));
    expect(result.zipPath.endsWith('-bugreport.zip')).toBe(true);
    expect(existsSync(result.zipPath)).toBe(true);
  });
});

interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

interface IntakeStub {
  url: string;
  requests: RecordedRequest[];
  stop(): Promise<void>;
}

const SIGNED_HEADERS = {
  'x-signed-token': 'sig-verbatim-123',
  'cache-control': 'private, immutable',
};

const stubServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    stubServers.map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
  stubServers.length = 0;
});

/**
 * Local HTTP stub implementing the intake + signed-upload contract: mint at
 * POST /api/bug-report (upload URL points back at the stub), direct PUT at
 * /upload/dest, completion at POST /api/bug-report/complete. Override
 * per-step status/body to force each failure mode.
 */
function startIntakeStub(
  overrides: {
    mintStatus?: number;
    mintBody?: unknown;
    /** Record the mint request but never respond — for the timeout path. */
    stallMint?: boolean;
    putStatus?: number;
    /** Record the PUT (body fully received) but never respond. */
    stallPut?: boolean;
    completeStatus?: number;
    completeBody?: unknown;
    /** Record the completion request but never respond. */
    stallComplete?: boolean;
    /** Status for the SECOND mint (the image/png screenshot mint) only. */
    screenshotMintStatus?: number;
    /** Status for the screenshot PUT only (the second PUT to /upload/dest). */
    screenshotPutStatus?: number;
    /** Body for the screenshot mint only, for the malformed / non-https guards. */
    screenshotMintBody?: unknown;
  } = {},
): Promise<IntakeStub> {
  const requests: RecordedRequest[] = [];
  let putCount = 0;
  let url = '';
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const method = req.method ?? '';
      const path = req.url ?? '';
      requests.push({ method, path, headers: { ...req.headers }, body: Buffer.concat(chunks) });
      const respond = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (method === 'POST' && path === '/api/bug-report') {
        if (overrides.stallMint === true) return;
        // The screenshot mint is distinguishable by its content type, which lets a
        // test fail only that one and prove the report still files.
        let mintedContentType: unknown;
        try {
          mintedContentType = (
            JSON.parse(Buffer.concat(chunks).toString('utf8')) as { contentType?: unknown }
          ).contentType;
        } catch {
          mintedContentType = undefined;
        }
        if (mintedContentType === 'image/png' && overrides.screenshotMintStatus !== undefined) {
          return respond(overrides.screenshotMintStatus, { error: 'screenshot mint refused' });
        }
        if (mintedContentType === 'image/png' && overrides.screenshotMintBody !== undefined) {
          return respond(200, overrides.screenshotMintBody);
        }
        respond(
          overrides.mintStatus ?? 200,
          overrides.mintBody ?? {
            uploadUrl: `${url}/upload/dest`,
            assetUrl: 'https://uploads.example.invalid/asset/dest',
            headers: SIGNED_HEADERS,
          },
        );
      } else if (method === 'PUT' && path === '/upload/dest') {
        if (overrides.stallPut === true) return;
        // The screenshot PUT is the second one; failing only it proves the report
        // survives a screenshot upload that is refused after a successful mint.
        putCount += 1;
        if (putCount === 2 && overrides.screenshotPutStatus !== undefined) {
          return respond(overrides.screenshotPutStatus, { error: 'screenshot put refused' });
        }
        const putStatus = overrides.putStatus ?? 200;
        if (putStatus >= 300 && putStatus < 400) {
          // A redirecting storage endpoint — the client must refuse to chase it.
          res.writeHead(putStatus, { location: `${url}/redirected` });
          res.end();
        } else {
          respond(putStatus, {});
        }
      } else if (method === 'POST' && path === '/api/bug-report/complete') {
        if (overrides.stallComplete === true) return;
        respond(
          overrides.completeStatus ?? 200,
          overrides.completeBody ?? { reference: 'OK-1042' },
        );
      } else {
        respond(404, { error: 'unexpected request' });
      }
    });
  });
  stubServers.push(server);
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        fail(new Error('stub bound without a port'));
        return;
      }
      url = `http://127.0.0.1:${address.port}`;
      done({ url, requests, stop: () => new Promise((d) => server.close(() => d())) });
    });
  });
}

const SEND_HOST = { appVersion: '0.9.9-test.1', platform: 'darwin 25.4.0' };

/** Fake `~/.ok/bug-reports/` — the containment root send validates against. */
function makeBugReportsRoot(): string {
  return makeTmpDir('ok-bugreport-root-');
}

function makeSendDeps(
  intakeBaseUrl: string | undefined,
  bugReportsRoot: string,
): BugReportSendDeps {
  return { intakeBaseUrl, bugReportsRoot, ...SEND_HOST };
}

const SEND_METADATA = {
  level: 'standard' as const,
  systemWide: false,
  projectSlug: 'ipc-proj',
  note: 'the editor froze',
};

/**
 * Non-UTF-8 byte pattern so the PUT byte-identity assertion is meaningful. The
 * basename carries the report-id shape `defaultBugReportZipPath` produces,
 * since `send` gates on it the same way `delete` does.
 */
function makeZipFixture(bugReportsRoot: string): string {
  const bytes = Buffer.alloc(2048);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) % 256;
  const zipPath = join(bugReportsRoot, '2026-07-15T18-30-00-000Z-bugreport.zip');
  writeFileSync(zipPath, bytes);
  return zipPath;
}

/** Deps plus a zip fixture placed inside the deps' containment root. */
function makeSendRig(
  intakeBaseUrl: string | undefined,
  screenshotPng?: Buffer,
): {
  deps: BugReportSendDeps;
  zipPath: string;
} {
  const bugReportsRoot = makeBugReportsRoot();
  const deps = makeSendDeps(intakeBaseUrl, bugReportsRoot);
  return {
    deps: screenshotPng === undefined ? deps : { ...deps, screenshotPngBytes: () => screenshotPng },
    zipPath: makeZipFixture(bugReportsRoot),
  };
}

// Minimal PNG signature — enough to assert the exact bytes reach the PUT.
const SCREENSHOT_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x07, 0x09]);

describe('resolveBugReportIntakeUrl', () => {
  test('an explicit env URL always wins', () => {
    const envUrl = 'https://intake.example.test';
    expect(resolveBugReportIntakeUrl({ envUrl })).toBe(envUrl);
  });

  test('no env falls back to the production intake (dev included — PRD-7611)', () => {
    expect(resolveBugReportIntakeUrl({ envUrl: undefined })).toBe(DEFAULT_BUG_REPORT_INTAKE_URL);
  });

  test('an empty or whitespace env value is treated as unset', () => {
    expect(resolveBugReportIntakeUrl({ envUrl: '' })).toBe(DEFAULT_BUG_REPORT_INTAKE_URL);
    expect(resolveBugReportIntakeUrl({ envUrl: '   ' })).toBe(DEFAULT_BUG_REPORT_INTAKE_URL);
  });

  test('a surrounding-whitespace env value is trimmed', () => {
    expect(resolveBugReportIntakeUrl({ envUrl: '  https://x.test  ' })).toBe('https://x.test');
  });
});

describe('handleBugReportSend — inline screenshot upload', () => {
  test('uploads the screenshot as its own asset and passes its URL to completion', async () => {
    // Client-side by necessity: the intake cannot read the screenshot back out of
    // the bundle it just received, because Linear serves uploaded assets behind
    // authentication and the workspace API key does not authorize the raw asset
    // URL. Only this process holds the PNG before it is zipped.
    const stub = await startIntakeStub();
    const { deps, zipPath } = makeSendRig(stub.url, SCREENSHOT_PNG);

    const result = await handleBugReportSend(deps, {
      kind: 'send',
      zipPath,
      metadata: SEND_METADATA,
      includeScreenshot: true,
    });

    expect(result).toEqual({ ok: true, reference: 'OK-1042' });

    // The screenshot rides AFTER the bundle PUT and BEFORE completion, so a
    // screenshot failure can never strand a bundle that already landed.
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/bug-report',
      'PUT /upload/dest',
      'POST /api/bug-report',
      'PUT /upload/dest',
      'POST /api/bug-report/complete',
    ]);

    const [, , imageMint, imagePut, complete] = stub.requests;
    expect(JSON.parse(imageMint?.body.toString('utf8') ?? '')).toEqual({
      filename: 'screenshot.png',
      sizeBytes: SCREENSHOT_PNG.byteLength,
      contentType: 'image/png',
      metadata: { ...SEND_METADATA, ...SEND_HOST },
    });
    expect(imagePut?.headers['content-type']).toBe('image/png');
    expect(imagePut?.body.equals(SCREENSHOT_PNG)).toBe(true);

    expect(JSON.parse(complete?.body.toString('utf8') ?? '')).toMatchObject({
      screenshotAssetUrl: 'https://uploads.example.invalid/asset/dest',
    });
  });

  test('omits the screenshot key entirely when no capture is available', async () => {
    // A list retry in a later session, a reporter who unchecked the box, or a
    // failed capture. The key is omitted rather than sent as null so an intake
    // that predates the field is unaffected.
    const stub = await startIntakeStub();
    const { deps, zipPath } = makeSendRig(stub.url);

    const result = await handleBugReportSend(deps, {
      kind: 'send',
      zipPath,
      metadata: SEND_METADATA,
    });

    expect(result).toEqual({ ok: true, reference: 'OK-1042' });
    expect(stub.requests).toHaveLength(3);
    const body = JSON.parse(stub.requests[2]?.body.toString('utf8') ?? '') as Record<
      string,
      unknown
    >;
    expect('screenshotAssetUrl' in body).toBe(false);
  });

  test('still files the report when the screenshot PUT is refused', async () => {
    // The mint succeeds and the upload itself fails, which is a different branch
    // from a refused mint and the one an intake-side storage hiccup takes.
    const stub = await startIntakeStub({ screenshotPutStatus: 500 });
    const { deps, zipPath } = makeSendRig(stub.url, SCREENSHOT_PNG);

    const result = await handleBugReportSend(deps, {
      kind: 'send',
      zipPath,
      metadata: SEND_METADATA,
      includeScreenshot: true,
    });

    expect(result).toEqual({ ok: true, reference: 'OK-1042' });
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/bug-report',
      'PUT /upload/dest',
      'POST /api/bug-report',
      'PUT /upload/dest',
      'POST /api/bug-report/complete',
    ]);
    const body = JSON.parse(stub.requests[4]?.body.toString('utf8') ?? '') as Record<
      string,
      unknown
    >;
    expect('screenshotAssetUrl' in body).toBe(false);
  });

  test('files the report when the screenshot mint body is malformed', async () => {
    // Guard: a 200 whose body does not parse into a mint must not proceed with
    // undefined fields. Without the guard the throw is swallowed by the catch-all
    // and the regression looks identical to a refused mint.
    const stub = await startIntakeStub({ screenshotMintBody: { nope: true } });
    const { deps, zipPath } = makeSendRig(stub.url, SCREENSHOT_PNG);

    const result = await handleBugReportSend(deps, {
      kind: 'send',
      zipPath,
      metadata: SEND_METADATA,
      includeScreenshot: true,
    });

    expect(result).toEqual({ ok: true, reference: 'OK-1042' });
    // Mint attempted, no PUT followed it.
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/bug-report',
      'PUT /upload/dest',
      'POST /api/bug-report',
      'POST /api/bug-report/complete',
    ]);
  });

  test('refuses a screenshot upload URL that is not https', async () => {
    // The same transport gate the bundle's minted URL gets: a compromised or
    // misconfigured intake must not be able to downgrade this PUT to cleartext.
    const stub = await startIntakeStub({
      screenshotMintBody: {
        uploadUrl: 'http://insecure.example.invalid/upload',
        assetUrl: 'https://uploads.example.invalid/asset/dest',
        headers: {},
      },
    });
    const { deps, zipPath } = makeSendRig(stub.url, SCREENSHOT_PNG);

    const result = await handleBugReportSend(deps, {
      kind: 'send',
      zipPath,
      metadata: SEND_METADATA,
      includeScreenshot: true,
    });

    expect(result).toEqual({ ok: true, reference: 'OK-1042' });
    // No cleartext PUT was issued anywhere in the sequence.
    expect(stub.requests.some((r) => r.path.includes('insecure'))).toBe(false);
    const body = JSON.parse(stub.requests[3]?.body.toString('utf8') ?? '') as Record<
      string,
      unknown
    >;
    expect('screenshotAssetUrl' in body).toBe(false);
  });

  test('does not upload the screenshot when the reporter did not include it', async () => {
    // The consent gate. main still holds the capture for this window, so without
    // the gate an unchecked screenshot would be uploaded and embedded anyway.
    const stub = await startIntakeStub();
    const { deps, zipPath } = makeSendRig(stub.url, SCREENSHOT_PNG);

    const result = await handleBugReportSend(deps, {
      kind: 'send',
      zipPath,
      metadata: SEND_METADATA,
      includeScreenshot: false,
    });

    expect(result).toEqual({ ok: true, reference: 'OK-1042' });
    // Bundle mint + bundle PUT + completion. No screenshot mint, no screenshot PUT.
    expect(stub.requests).toHaveLength(3);
    const body = JSON.parse(stub.requests[2]?.body.toString('utf8') ?? '') as Record<
      string,
      unknown
    >;
    expect('screenshotAssetUrl' in body).toBe(false);
  });

  test('does not upload the screenshot when consent is absent (list retry)', async () => {
    // Fail-closed: an omitted flag must behave like an explicit false.
    const stub = await startIntakeStub();
    const { deps, zipPath } = makeSendRig(stub.url, SCREENSHOT_PNG);

    const result = await handleBugReportSend(deps, {
      kind: 'send',
      zipPath,
      metadata: SEND_METADATA,
    });

    expect(result).toEqual({ ok: true, reference: 'OK-1042' });
    expect(stub.requests).toHaveLength(3);
  });

  test('still files the report when the screenshot mint is refused', async () => {
    // The expected answer from an intake deployed before it learned the image
    // content type, and the load-bearing best-effort contract: a screenshot is
    // never worth losing a report over, and the bundle has already landed.
    const stub = await startIntakeStub({ screenshotMintStatus: 400 });
    const { deps, zipPath } = makeSendRig(stub.url, SCREENSHOT_PNG);

    const result = await handleBugReportSend(deps, {
      kind: 'send',
      zipPath,
      metadata: SEND_METADATA,
      includeScreenshot: true,
    });

    expect(result).toEqual({ ok: true, reference: 'OK-1042' });
    // No screenshot PUT was attempted, and completion still ran.
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/bug-report',
      'PUT /upload/dest',
      'POST /api/bug-report',
      'POST /api/bug-report/complete',
    ]);
    const body = JSON.parse(stub.requests[3]?.body.toString('utf8') ?? '') as Record<
      string,
      unknown
    >;
    expect('screenshotAssetUrl' in body).toBe(false);
  });
});

describe('bug-report screenshot hold — two reports composed from one window', () => {
  // Distinguishable PNG signatures: WHICH report's capture reached the ticket is
  // the entire assertion, so the two must never compare equal.
  const SCREENSHOT_A = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x0a, 0x0a]);
  const SCREENSHOT_B = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x0b, 0x0b]);

  test('a retried send uploads its own capture, not that of a report composed after it', async () => {
    const stub = await startIntakeStub();
    const bugReportsRoot = makeBugReportsRoot();
    // main keeps ONE open-time capture per window, and both dialogs open on the
    // same window — the shape that makes the second report overwrite the first.
    const SENDER_ID = 7;
    const windowStore = new Map<number, BugReportScreenshotEntry>();
    const capture = (png: Buffer) =>
      windowStore.set(SENDER_ID, { png, cleanup: () => windowStore.delete(SENDER_ID) });
    const hold = createBugReportScreenshotHold();
    const createDeps = (zipName: string): BugReportCreateDeps => ({
      projectDir: null,
      desktopMeta: DESKTOP_META,
      outputPath: join(bugReportsRoot, zipName),
      userLogsDir: makeTmpDir(),
      screenshotPngBytes: () => windowStore.get(SENDER_ID)?.png ?? null,
      onScreenshotStaged: (reportId, png) => hold.remember(reportId, png, SENDER_ID),
    });

    capture(SCREENSHOT_A);
    const reportA = await handleBugReportCreate(
      createDeps('2026-07-15T18-30-00-000Z-bugreport.zip'),
      { kind: 'create', level: 'standard', includeScreenshot: true },
    );
    if (!reportA.ok) throw new Error(`expected report A to build, got: ${reportA.error}`);

    // The reporter opens the dialog again while A's send is still retryable.
    capture(SCREENSHOT_B);
    const reportB = await handleBugReportCreate(
      createDeps('2026-07-15T18-31-00-000Z-bugreport.zip'),
      { kind: 'create', level: 'standard', includeScreenshot: true },
    );
    if (!reportB.ok) throw new Error(`expected report B to build, got: ${reportB.error}`);

    // Each bundle stages its own capture at collect time, so the zips are right
    // even when the standalone asset is not — that asymmetry is the bug.
    expect(readZipEntryBytes(reportA.zipPath, 'extra/screenshot.png').equals(SCREENSHOT_A)).toBe(
      true,
    );
    expect(readZipEntryBytes(reportB.zipPath, 'extra/screenshot.png').equals(SCREENSHOT_B)).toBe(
      true,
    );

    const result = await handleBugReportSend(
      {
        ...makeSendDeps(stub.url, bugReportsRoot),
        screenshotPngBytes: (reportId) => hold.read(reportId),
      },
      {
        kind: 'send',
        zipPath: reportA.zipPath,
        metadata: SEND_METADATA,
        includeScreenshot: true,
      },
    );

    expect(result).toEqual({ ok: true, reference: 'OK-1042' });
    const imagePut = stub.requests[3];
    expect(imagePut?.headers['content-type']).toBe('image/png');
    expect(imagePut?.body.equals(SCREENSHOT_A)).toBe(true);
  });

  test('create files the capture under the report id, and files nothing without one', async () => {
    const hold = createBugReportScreenshotHold();
    const reportsDir = makeTmpDir();
    // Distinct basenames because the basename IS the report id.
    const holdDeps = (zipName: string) =>
      makeDeps({
        outputPath: join(reportsDir, zipName),
        screenshotPngBytes: () => SCREENSHOT_A,
        onScreenshotStaged: (reportId, png) => hold.remember(reportId, png, 7),
      });

    const withCapture = await handleBugReportCreate(holdDeps('opted-in-bugreport.zip'), {
      kind: 'create',
      level: 'standard',
      includeScreenshot: true,
    });
    if (!withCapture.ok) throw new Error(`expected ok, got: ${withCapture.error}`);
    expect(hold.read(basename(withCapture.zipPath))?.equals(SCREENSHOT_A)).toBe(true);

    // Opting out is indistinguishable at send time from never having captured:
    // both leave the hold empty, and the ticket files without the inline image.
    const optedOut = await handleBugReportCreate(holdDeps('opted-out-bugreport.zip'), {
      kind: 'create',
      level: 'standard',
    });
    if (!optedOut.ok) throw new Error(`expected ok, got: ${optedOut.error}`);
    expect(hold.read(basename(optedOut.zipPath))).toBeNull();
  });

  test('a create whose screenshot bookkeeping throws still succeeds, logger included', async () => {
    // The zip is on disk by this point, so neither a hand-off that throws nor a
    // logger that throws while reporting it may turn a written report into a
    // create failure. Same fail-soft posture `recordMinidumpDecision` takes.
    const result = await handleBugReportCreate(
      makeDeps({
        screenshotPngBytes: () => SCREENSHOT_A,
        onScreenshotStaged: () => {
          throw new Error('hold refused the capture');
        },
        logger: {
          info: () => {},
          warn: () => {
            throw new Error('logger is down');
          },
        },
      }),
      { kind: 'create', level: 'standard', includeScreenshot: true },
    );

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(existsSync(result.zipPath)).toBe(true);
    // The bundle still carries its own capture; only the send-time hold was lost.
    expect(readZipEntryBytes(result.zipPath, 'extra/screenshot.png').equals(SCREENSHOT_A)).toBe(
      true,
    );
  });

  test('an unknown report reads as null rather than as some other report', () => {
    const hold = createBugReportScreenshotHold();
    hold.remember('report-a', SCREENSHOT_A, 7);

    expect(hold.read('report-never-created')).toBeNull();
    hold.forget('report-a');
    expect(hold.read('report-a')).toBeNull();
  });

  test('reading is non-destructive, so a failed send leaves the bytes for the retry', () => {
    // The retry reading its own bytes is the whole point of this change, and a
    // send reads before it can know it failed. A consume-on-read would leave
    // every retry imageless while every other test here still passed.
    const hold = createBugReportScreenshotHold();
    hold.remember('report-a', SCREENSHOT_A, 7);

    expect(hold.read('report-a')?.equals(SCREENSHOT_A)).toBe(true);
    expect(hold.read('report-a')?.equals(SCREENSHOT_A)).toBe(true);
    expect(hold.read('report-a')?.equals(SCREENSHOT_A)).toBe(true);
  });

  test('the hold evicts oldest-first at the cap, and re-filing refreshes recency', () => {
    const hold = createBugReportScreenshotHold({ maxReports: 2 });
    hold.remember('one', Buffer.from([1]), 7);
    hold.remember('two', Buffer.from([2]), 7);
    // Re-filing `one` must move it behind `two`, or the freshest report is the
    // next evicted.
    hold.remember('one', Buffer.from([1]), 7);
    hold.remember('three', Buffer.from([3]), 7);

    expect(hold.read('two')).toBeNull();
    expect(hold.read('one')?.equals(Buffer.from([1]))).toBe(true);
    expect(hold.read('three')?.equals(Buffer.from([3]))).toBe(true);
  });

  test('an eviction names the report it dropped, so triage can tell it from a stale retry', () => {
    // Send logs an unavailable capture identically whether it was evicted here or
    // never existed, so the eviction is the only place the difference is knowable.
    const evicted: string[] = [];
    const hold = createBugReportScreenshotHold({
      maxReports: 1,
      onEvict: (reportId) => evicted.push(reportId),
    });

    hold.remember('first', Buffer.from([1]), 7);
    hold.remember('second', Buffer.from([2]), 7);

    expect(evicted).toEqual(['first']);
    // A report dropped explicitly is not an eviction — nothing was over cap.
    hold.forget('second');
    expect(evicted).toEqual(['first']);
  });

  test('losing a window drops every report it composed and nothing another window did', () => {
    // The send toast that can retry a report lives in the composing window's
    // renderer, so once that window's contents are gone its captures are
    // unreachable and must not wait for the cap to evict them.
    const hold = createBugReportScreenshotHold();
    hold.remember('from-window-7-a', Buffer.from([1]), 7);
    hold.remember('from-window-7-b', Buffer.from([2]), 7);
    hold.remember('from-window-9', Buffer.from([3]), 9);

    hold.forgetOwner(7);

    expect(hold.read('from-window-7-a')).toBeNull();
    expect(hold.read('from-window-7-b')).toBeNull();
    expect(hold.read('from-window-9')?.equals(Buffer.from([3]))).toBe(true);
  });
});

describe('handleBugReportSend — upload happy path', () => {
  test('runs mint, direct PUT with verbatim signed headers, and completion, returning the reference', async () => {
    const stub = await startIntakeStub();
    const { deps, zipPath } = makeSendRig(stub.url);

    const result = await handleBugReportSend(deps, {
      kind: 'send',
      zipPath,
      metadata: SEND_METADATA,
    });

    expect(result).toEqual({ ok: true, reference: 'OK-1042' });

    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/bug-report',
      'PUT /upload/dest',
      'POST /api/bug-report/complete',
    ]);

    const [mint, put, complete] = stub.requests;
    expect(mint?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(mint?.body.toString('utf8') ?? '')).toEqual({
      filename: '2026-07-15T18-30-00-000Z-bugreport.zip',
      sizeBytes: 2048,
      contentType: 'application/zip',
      metadata: { ...SEND_METADATA, ...SEND_HOST },
    });

    expect(put?.headers['x-signed-token']).toBe('sig-verbatim-123');
    expect(put?.headers['cache-control']).toBe('private, immutable');
    expect(put?.headers['content-type']).toBe('application/zip');
    expect(put?.body.equals(readFileSync(zipPath))).toBe(true);

    expect(JSON.parse(complete?.body.toString('utf8') ?? '')).toEqual({
      assetUrl: 'https://uploads.example.invalid/asset/dest',
      metadata: { ...SEND_METADATA, ...SEND_HOST },
    });
  });
});

describe('handleBugReportSend — zip path containment', () => {
  test('a zipPath outside the bug-reports root is refused before any read or network attempt', async () => {
    const stub = await startIntakeStub();
    const bugReportsRoot = makeBugReportsRoot();
    const outsideZip = makeZipFixture(makeTmpDir('ok-bugreport-outside-'));

    const result = await handleBugReportSend(makeSendDeps(stub.url, bugReportsRoot), {
      kind: 'send',
      zipPath: outsideZip,
      metadata: SEND_METADATA,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    // A refusal is a failure, never the designed email-draft path.
    expect(result.reason).toBe('send-failed');
    // Generic fallback only — the refused path must not be echoed into the draft.
    expect(result.fallback.mailtoUrl).not.toContain(encodeURIComponent(outsideZip));
    expect(result.fallback.mailtoUrl.startsWith('mailto:support@inkeep.com?')).toBe(true);
    expect(stub.requests).toHaveLength(0);
  });

  test('a traversal escape through the root is refused', async () => {
    const stub = await startIntakeStub();
    const bugReportsRoot = makeBugReportsRoot();

    const result = await handleBugReportSend(makeSendDeps(stub.url, bugReportsRoot), {
      kind: 'send',
      zipPath: `${bugReportsRoot}/../escape.zip`,
      metadata: SEND_METADATA,
    });

    expect(result.ok).toBe(false);
    expect(stub.requests).toHaveLength(0);
  });

  test('a relative zipPath is refused', async () => {
    const stub = await startIntakeStub();
    const bugReportsRoot = makeBugReportsRoot();

    const result = await handleBugReportSend(makeSendDeps(stub.url, bugReportsRoot), {
      kind: 'send',
      zipPath: 'report.zip',
      metadata: SEND_METADATA,
    });

    expect(result.ok).toBe(false);
    expect(stub.requests).toHaveLength(0);
  });

  test('a symlink inside the bug-reports root that targets a file outside is refused', async () => {
    const stub = await startIntakeStub();
    const bugReportsRoot = makeBugReportsRoot();
    // Lexically contained, canonically escaping — only the realpath check
    // stands between this link and reading (then uploading) the target.
    const outsideZip = makeZipFixture(makeTmpDir('ok-bugreport-outside-'));
    const linkPath = join(bugReportsRoot, 'escape-link.zip');
    symlinkSync(outsideZip, linkPath);

    const result = await handleBugReportSend(makeSendDeps(stub.url, bugReportsRoot), {
      kind: 'send',
      zipPath: linkPath,
      metadata: SEND_METADATA,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.fallback.mailtoUrl).not.toContain(encodeURIComponent(linkPath));
    expect(stub.requests).toHaveLength(0);
  });
});

describe('handleBugReportSend — transport hardening', () => {
  test('a stalled mint request hits the timeout ceiling and falls back', async () => {
    const stub = await startIntakeStub({ stallMint: true });
    const rig = makeSendRig(stub.url);

    const result = await handleBugReportSend(
      { ...rig.deps, timeouts: { mintMs: 50 } },
      { kind: 'send', zipPath: rig.zipPath, metadata: SEND_METADATA },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fallback');
    expect(result.fallback.mailtoUrl.startsWith('mailto:support@inkeep.com?')).toBe(true);
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/bug-report']);
  });

  test('a stalled PUT hits the upload timeout ceiling and falls back before completion', async () => {
    const stub = await startIntakeStub({ stallPut: true });
    const rig = makeSendRig(stub.url);

    const result = await handleBugReportSend(
      { ...rig.deps, timeouts: { putMs: 50 } },
      { kind: 'send', zipPath: rig.zipPath, metadata: SEND_METADATA },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fallback');
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/bug-report',
      'PUT /upload/dest',
    ]);
  });

  test('a stalled completion request hits the timeout ceiling and falls back', async () => {
    const stub = await startIntakeStub({ stallComplete: true });
    const rig = makeSendRig(stub.url);

    const result = await handleBugReportSend(
      { ...rig.deps, timeouts: { completeMs: 50 } },
      { kind: 'send', zipPath: rig.zipPath, metadata: SEND_METADATA },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fallback');
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/bug-report',
      'PUT /upload/dest',
      'POST /api/bug-report/complete',
    ]);
  });

  test('a completion 503 falls back after all three requests fired', async () => {
    const stub = await startIntakeStub({ completeStatus: 503 });
    const rig = makeSendRig(stub.url);

    const result = await handleBugReportSend(rig.deps, {
      kind: 'send',
      zipPath: rig.zipPath,
      metadata: SEND_METADATA,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fallback');
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/bug-report',
      'PUT /upload/dest',
      'POST /api/bug-report/complete',
    ]);
  });

  test('a PUT redirect is treated as failure and never followed', async () => {
    const stub = await startIntakeStub({ putStatus: 302 });
    const rig = makeSendRig(stub.url);

    const result = await handleBugReportSend(rig.deps, {
      kind: 'send',
      zipPath: rig.zipPath,
      metadata: SEND_METADATA,
    });

    expect(result.ok).toBe(false);
    // Neither the redirect target nor the completion endpoint is touched.
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/bug-report',
      'PUT /upload/dest',
    ]);
  });

  test('a non-loopback http intake URL is refused and falls back', async () => {
    const rig = makeSendRig('http://intake.example.invalid');

    const result = await handleBugReportSend(rig.deps, {
      kind: 'send',
      zipPath: rig.zipPath,
      metadata: SEND_METADATA,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fallback');
    expect(result.fallback.mailtoUrl).toContain(encodeURIComponent(rig.zipPath));
  });

  test('a mint response naming a non-loopback http upload URL is refused before any bytes are PUT', async () => {
    const stub = await startIntakeStub({
      mintBody: {
        uploadUrl: 'http://uploads.example.invalid/dest',
        assetUrl: 'https://uploads.example.invalid/asset/dest',
        headers: SIGNED_HEADERS,
      },
    });
    const rig = makeSendRig(stub.url);

    const result = await handleBugReportSend(rig.deps, {
      kind: 'send',
      zipPath: rig.zipPath,
      metadata: SEND_METADATA,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fallback');
    // The bundle bytes get the same transport gate as the intake base: the
    // minted cleartext destination is refused with no PUT ever attempted.
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/bug-report']);
  });

  test('a zip over the upload size ceiling is refused before any read or network attempt', async () => {
    const stub = await startIntakeStub();
    const bugReportsRoot = makeBugReportsRoot();
    const zipPath = join(bugReportsRoot, 'huge.zip');
    // Sparse file: stat reports a logical size over the ceiling without the
    // test actually writing 256 MiB.
    writeFileSync(zipPath, 'zip');
    truncateSync(zipPath, MAX_UPLOAD_ZIP_BYTES + 1);

    const result = await handleBugReportSend(makeSendDeps(stub.url, bugReportsRoot), {
      kind: 'send',
      zipPath,
      metadata: SEND_METADATA,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    // The renderer sees the ordinary failure screen with the email fallback.
    expect(result.reason).toBe('send-failed');
    expect(result.fallback.mailtoUrl.startsWith('mailto:support@inkeep.com?')).toBe(true);
    expect(stub.requests).toHaveLength(0);
  });

  test('parseTransportSafeUrl admits https anywhere and http only on loopback', () => {
    expect(parseTransportSafeUrl('https://openknowledge.ai')).not.toBeNull();
    expect(parseTransportSafeUrl('http://127.0.0.1:8080')).not.toBeNull();
    expect(parseTransportSafeUrl('http://localhost:8080')).not.toBeNull();
    expect(parseTransportSafeUrl('http://[::1]:8080')).not.toBeNull();
    expect(parseTransportSafeUrl('http://intake.example.com')).toBeNull();
    expect(parseTransportSafeUrl('ftp://openknowledge.ai')).toBeNull();
    expect(parseTransportSafeUrl('not a url')).toBeNull();
  });
});

describe('handleBugReportSend — note redaction off the bundle path', () => {
  const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwx';

  test('a secret in the note is scrubbed from the mint and completion metadata', async () => {
    const stub = await startIntakeStub();
    const rig = makeSendRig(stub.url);

    const result = await handleBugReportSend(rig.deps, {
      kind: 'send',
      zipPath: rig.zipPath,
      metadata: { ...SEND_METADATA, note: `it broke right after I pasted ${SECRET}` },
    });

    expect(result).toEqual({ ok: true, reference: 'OK-1042' });
    const [mint, , complete] = stub.requests;
    for (const body of [mint?.body, complete?.body]) {
      const wire = JSON.parse(body?.toString('utf8') ?? '') as {
        metadata: { note?: string };
      };
      expect(wire.metadata.note).toContain('[REDACTED-ANTHROPIC]');
      expect(wire.metadata.note).not.toContain(SECRET);
    }
  });

  test('a secret in the note is scrubbed from the mailto fallback body', async () => {
    const rig = makeSendRig(undefined);

    const result = await handleBugReportSend(rig.deps, {
      kind: 'send',
      zipPath: rig.zipPath,
      metadata: { ...SEND_METADATA, note: `my key is ${SECRET}` },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fallback');
    expect(result.fallback.mailtoUrl).toContain(encodeURIComponent('[REDACTED-ANTHROPIC]'));
    expect(result.fallback.mailtoUrl).not.toContain(encodeURIComponent(SECRET));
    // The zip path itself stays verbatim — the user needs it to attach the file.
    expect(result.fallback.mailtoUrl).toContain(encodeURIComponent(rig.zipPath));
  });
});

describe('handleBugReportSend — email fallback', () => {
  test('unconfigured endpoint resolves to the email-draft path with the exact prefilled mailto, which clears the openExternal gate', async () => {
    const { deps, zipPath } = makeSendRig(undefined);

    const result = await handleBugReportSend(deps, {
      kind: 'send',
      zipPath,
      metadata: SEND_METADATA,
    });

    const expectedBody = [
      'the editor froze',
      '',
      'Please attach the report file saved at:',
      zipPath,
      '',
      'App version: 0.9.9-test.1',
      'Platform: darwin 25.4.0',
      'Project: ipc-proj',
      'Detail level: standard',
    ].join('\n');
    const expectedMailto = `mailto:support@inkeep.com?subject=${encodeURIComponent(
      'OpenKnowledge bug report (v0.9.9-test.1)',
    )}&body=${encodeURIComponent(expectedBody)}`;
    // `email-draft`, not `send-failed`: no intake is configured, so this is
    // the designed transport, and the dialog must not render a failure.
    expect(result).toEqual({
      ok: false,
      reason: 'email-draft',
      fallback: { mailtoUrl: expectedMailto },
    });
    if (result.ok) throw new Error('expected fallback');

    const opened: string[] = [];
    const openExternal = handleShellOpenExternal({
      openExternal: async (url) => {
        opened.push(url);
      },
    });
    await openExternal(result.fallback.mailtoUrl);
    expect(opened).toEqual([expectedMailto]);
  });

  test('a mint rejection (oversize 413) falls back with the note preserved, after only the mint request', async () => {
    const stub = await startIntakeStub({ mintStatus: 413 });

    const rig = makeSendRig(stub.url);
    const result = await handleBugReportSend(rig.deps, {
      kind: 'send',
      zipPath: rig.zipPath,
      metadata: SEND_METADATA,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fallback');
    // A real attempted-and-refused upload — distinct from the email-draft path.
    expect(result.reason).toBe('send-failed');
    expect(result.fallback.mailtoUrl).toContain(encodeURIComponent('the editor froze'));
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/bug-report']);
  });

  test('a network error (endpoint unreachable) falls back instead of throwing', async () => {
    const stub = await startIntakeStub();
    await stub.stop();

    const rig = makeSendRig(stub.url);
    const result = await handleBugReportSend(rig.deps, {
      kind: 'send',
      zipPath: rig.zipPath,
      metadata: SEND_METADATA,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fallback');
    expect(result.fallback.mailtoUrl.startsWith('mailto:support@inkeep.com?')).toBe(true);
  });

  test('a failed PUT falls back and never fires the completion call', async () => {
    const stub = await startIntakeStub({ putStatus: 500 });

    const rig = makeSendRig(stub.url);
    const result = await handleBugReportSend(rig.deps, {
      kind: 'send',
      zipPath: rig.zipPath,
      metadata: SEND_METADATA,
    });

    expect(result.ok).toBe(false);
    // No accepted-but-lost state: a report is only filed with its bundle
    // attached, so a failed upload must leave the completion endpoint untouched.
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/bug-report',
      'PUT /upload/dest',
    ]);
  });

  test('a malformed mint response (missing uploadUrl) falls back', async () => {
    const stub = await startIntakeStub({ mintBody: { assetUrl: 'x', headers: {} } });

    const rig = makeSendRig(stub.url);
    const result = await handleBugReportSend(rig.deps, {
      kind: 'send',
      zipPath: rig.zipPath,
      metadata: SEND_METADATA,
    });

    expect(result.ok).toBe(false);
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/bug-report']);
  });

  test('a completion response without a reference falls back', async () => {
    const stub = await startIntakeStub({ completeBody: { filed: true } });

    const rig = makeSendRig(stub.url);
    const result = await handleBugReportSend(rig.deps, {
      kind: 'send',
      zipPath: rig.zipPath,
      metadata: SEND_METADATA,
    });

    expect(result.ok).toBe(false);
    expect(stub.requests).toHaveLength(3);
  });

  test('a malformed renderer payload falls back to a generic mailto without touching the network', async () => {
    const stub = await startIntakeStub();

    const rig = makeSendRig(stub.url);
    const result = await handleBugReportSend(rig.deps, {
      kind: 'send',
      zipPath: rig.zipPath,
      metadata: { ...SEND_METADATA, level: 'verbose' },
    } as unknown as Parameters<typeof handleBugReportSend>[1]);

    const degenerateBody = ['App version: 0.9.9-test.1', 'Platform: darwin 25.4.0'].join('\n');
    expect(result).toEqual({
      ok: false,
      reason: 'send-failed',
      fallback: {
        mailtoUrl: `mailto:support@inkeep.com?subject=${encodeURIComponent(
          'OpenKnowledge bug report (v0.9.9-test.1)',
        )}&body=${encodeURIComponent(degenerateBody)}`,
      },
    });
    expect(stub.requests).toHaveLength(0);
  });
});

describe('handleBugReportCreate — crash-dump opt-in', () => {
  test('includeCrashDump bundles the newest minidump byte-for-byte under extra/', async () => {
    const dumpPath = join(makeTmpDir(), 'renderer-crash.dmp');
    // Non-UTF-8 payload wrapping a would-be-redacted token: the dump must
    // arrive byte-identical — minidumps are copied raw, never text-scrubbed.
    const dumpBytes = Buffer.concat([
      Buffer.from([0x4d, 0x44, 0x4d, 0x50, 0x00, 0xff, 0xfe, 0x01]),
      Buffer.from('sk-ant-api03-abcdefghijklmnopqrstuvwx'),
      Buffer.from([0x00, 0x9c]),
    ]);
    writeFileSync(dumpPath, dumpBytes);
    const deps = makeDeps({ newestMinidumpForReport: () => dumpLookup(dumpPath) });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeCrashDump: true,
    });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(listZipEntries(result.zipPath)).toContain('extra/renderer-crash.dmp');
    expect(readZipEntryBytes(result.zipPath, 'extra/renderer-crash.dmp').equals(dumpBytes)).toBe(
      true,
    );
  });

  test('without the opt-in no minidump is included even when one exists', async () => {
    const dumpPath = join(makeTmpDir(), 'renderer-crash.dmp');
    writeFileSync(dumpPath, 'dump-bytes');
    const deps = makeDeps({ newestMinidumpForReport: () => dumpLookup(dumpPath) });

    const result = await handleBugReportCreate(deps, { kind: 'create', level: 'standard' });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(listZipEntries(result.zipPath).some((e) => e.startsWith('extra/'))).toBe(false);
  });

  test('opting in with no relevant dump on disk still builds the bundle', async () => {
    const deps = makeDeps({ newestMinidumpForReport: () => dumpLookup(null) });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeCrashDump: true,
    });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(listZipEntries(result.zipPath).some((e) => e.startsWith('extra/'))).toBe(false);
  });

  test('an opted-in dump that vanished before staging is warned about, never dropped silently', async () => {
    const vanishedDump = join(makeTmpDir(), 'already-cleaned.dmp');
    const recorder = makeLogRecorder();
    const deps = makeDeps({
      newestMinidumpForReport: () => dumpLookup(vanishedDump),
      logger: recorder.logger,
    });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeCrashDump: true,
    });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(listZipEntries(result.zipPath).some((e) => e.startsWith('extra/'))).toBe(false);
    // Two independent lines, and both must survive: the collector reports the
    // unreadable source, the handler reports that the decision came out as a
    // failure. Collapsing them would put the record back at the mercy of the
    // collector happening to log.
    const collectorWarn = recorder.lines.find((l) => l.payload.sourcePath !== undefined);
    expect(collectorWarn?.payload.sourcePath).toBe(vanishedDump);
    expect(recorder.outcome()?.payload.reason).toBe('stage-failed');
  });

  test('a non-boolean includeCrashDump is refused as invalid-request', async () => {
    const deps = makeDeps({ newestMinidumpForReport: () => dumpLookup('/never-read.dmp') });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeCrashDump: 'yes',
    } as unknown as Parameters<typeof handleBugReportCreate>[1]);

    expect(result).toEqual({ ok: false, error: 'invalid-request' });
  });
});

/**
 * A bundle that arrives with no crash dump has several very different causes,
 * and before this record they were indistinguishable in triage. Each test here
 * pins one cause to one enum value.
 */
describe('handleBugReportCreate — crash-dump decision record', () => {
  function seedDump(name = 'renderer-crash.dmp', bytes = Buffer.from([0x4d, 0x44, 0x4d, 0x50])) {
    const dumpPath = join(makeTmpDir(), name);
    writeFileSync(dumpPath, bytes);
    return dumpPath;
  }

  /**
   * Writes where the real desktop logger writes — into the user-logs dir the
   * collector snapshots — and does it synchronously, standing in for the
   * production destination plus its flush. The only way to prove the record
   * reaches the bundle rather than merely getting emitted.
   */
  function makeFileLogger(userLogsDir: string) {
    const logPath = join(userLogsDir, 'desktop.2026-01-01.log');
    const write = (level: 'info' | 'warn') => (payload: object, message: string) => {
      appendFileSync(logPath, `${JSON.stringify({ level, ...payload, msg: message })}\n`);
    };
    return { info: write('info'), warn: write('warn') };
  }

  /**
   * The file-logger's asynchronous sibling: lines sit in memory until
   * `flushLogger` drains them, which is how the production destination
   * (`pino.destination({ sync: false })`) behaves. Writing the record before
   * collection is necessary but not sufficient against that destination — only
   * the drain makes the bytes visible to the collector's read.
   *
   * The log file is seeded the way a running app's already is, so a record that
   * never got drained fails as a missing LINE rather than a missing file.
   */
  function makeDeferredFileLogger(userLogsDir: string) {
    const logPath = join(userLogsDir, 'desktop.2026-01-01.log');
    writeFileSync(logPath, `${JSON.stringify({ level: 'info', msg: 'app ready' })}\n`);
    const buffered: string[] = [];
    const write = (level: 'info' | 'warn') => (payload: object, message: string) => {
      buffered.push(`${JSON.stringify({ level, ...payload, msg: message })}\n`);
    };
    return {
      logger: { info: write('info'), warn: write('warn') },
      flush: () => {
        appendFileSync(logPath, buffered.join(''));
        buffered.length = 0;
      },
    };
  }

  /** The decision records the bundle itself carries, parsed out of its log entry. */
  function decisionsInBundle(zipPath: string): Record<string, unknown>[] {
    return readZipEntry(zipPath, 'logs/desktop.2026-01-01.log')
      .split('\n')
      .filter((l) => l.includes('bug-report.minidump-decision'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  test('the intent record is inside the bundle it explains, not some later one', async () => {
    const userLogsDir = makeTmpDir();
    const deps = makeDeps({
      userLogsDir,
      logger: makeFileLogger(userLogsDir),
      newestMinidumpForReport: () => dumpLookup(null, 1, 0),
    });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeCrashDump: true,
    });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    // The collector reads the log file's bytes as it runs, so a record written
    // after it returns can only ever reach triage in the NEXT report. This is
    // the whole point of the split: the terminal reasons land in the bundle.
    expect(decisionsInBundle(result.zipPath)).toEqual([
      expect.objectContaining({ phase: 'intent', reason: 'none-available', requested: true }),
    ]);
  });

  test('against a buffering destination only the drain gets the intent into the bundle', async () => {
    const userLogsDir = makeTmpDir();
    const deferred = makeDeferredFileLogger(userLogsDir);
    const deps = makeDeps({
      userLogsDir,
      logger: deferred.logger,
      flushLogger: deferred.flush,
      newestMinidumpForReport: () => dumpLookup(null, 1, 0),
    });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeCrashDump: true,
    });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    // The sibling test above proves the record is written before collection; a
    // synchronous writer would land it there whether or not anything drained.
    // Here ordering alone buys nothing: drop the `flushLogger` call, or move it
    // after `collectReportBundle`, and the line is still in memory when the
    // collector snapshots the file — the bundle comes back with the seed line
    // and no decision record.
    expect(decisionsInBundle(result.zipPath)).toEqual([
      expect.objectContaining({ phase: 'intent', reason: 'none-available', requested: true }),
    ]);
  });

  test('an on-hand dump leaves an intent record the bundle can be read against', async () => {
    const userLogsDir = makeTmpDir();
    const deps = makeDeps({
      userLogsDir,
      logger: makeFileLogger(userLogsDir),
      newestMinidumpForReport: () => dumpLookup(seedDump()),
    });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeCrashDump: true,
    });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    // `staging` plus the bundle's own `extra/` is the pairing: the outcome
    // record cannot be in here, so the entry has to be readable as the answer.
    expect(decisionsInBundle(result.zipPath)).toEqual([
      expect.objectContaining({ phase: 'intent', reason: 'staging' }),
    ]);
    expect(listZipEntries(result.zipPath)).toContain('extra/renderer-crash.dmp');
  });

  test('the full level puts the intent in the bundle and leaves the outcome out', async () => {
    const userLogsDir = makeTmpDir();
    const deps = makeDeps({
      projectDir: makeProjectDir(),
      userLogsDir,
      logger: makeFileLogger(userLogsDir),
      newestMinidumpForReport: () => dumpLookup(seedDump()),
    });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'full',
      includeCrashDump: true,
    });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    // The in-memory recorder cannot tell "written before collection" from
    // "written after and recorded anyway", and the full level is the one a
    // crash invite actually sends. Read against the finished zip instead: the
    // intent is in it, and the outcome — which lands after the bytes are
    // snapshotted — provably is not.
    expect(decisionsInBundle(result.zipPath)).toEqual([
      expect.objectContaining({ phase: 'intent', reason: 'staging' }),
    ]);
    // The full level names its entries by walking the staging dir rather than
    // by the standard level's literal push. The `attached` inference is only
    // sound while both spell the entry the same way, so pin the name in the
    // inventory the inference reads AND in the zip a triager opens.
    expect(result.summary.files).toContain('extra/renderer-crash.dmp');
    expect(listZipEntries(result.zipPath)).toContain('extra/renderer-crash.dmp');
  });

  test('a staged dump records attached at outcome, with the size read up front', async () => {
    const dumpPath = seedDump();
    const recorder = makeLogRecorder();
    const deps = makeDeps({
      newestMinidumpForReport: () => dumpLookup(dumpPath),
      logger: recorder.logger,
    });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeCrashDump: true,
    });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(recorder.intent()?.payload).toMatchObject({
      event: 'bug-report.minidump-decision',
      phase: 'intent',
      requested: true,
      reason: 'staging',
      minidumpAvailable: true,
      sizeBytes: 4,
    });
    // Nothing is settled yet, so the intent record must not claim it is.
    expect(recorder.intent()?.payload).not.toHaveProperty('attached');
    expect(recorder.outcome()?.level).toBe('info');
    expect(recorder.outcome()?.payload).toMatchObject({
      phase: 'outcome',
      attached: true,
      reason: 'attached',
      sizeBytes: 4,
    });
  });

  test('the production level — a crash invite sends full — still infers attached', async () => {
    // The full level builds its inventory through a completely separate
    // implementation (a staging-dir walk) from the standard level's literal
    // push, and a crash invite always sends `full`. The inference depends on
    // the two agreeing on the entry name.
    const dumpPath = seedDump();
    const recorder = makeLogRecorder();
    const deps = makeDeps({
      projectDir: makeProjectDir(),
      newestMinidumpForReport: () => dumpLookup(dumpPath),
      logger: recorder.logger,
    });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'full',
      includeCrashDump: true,
    });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(listZipEntries(result.zipPath)).toContain('extra/renderer-crash.dmp');
    expect(recorder.outcome()?.payload).toMatchObject({ attached: true, reason: 'attached' });
  });

  test('the full level records stage-failed rather than failing the whole report', async () => {
    // The full-level collector tests for existence and then copies, so a dump
    // cleaned up in between used to throw out of collection and lose the report
    // along with any account of why.
    const recorder = makeLogRecorder();
    const deps = makeDeps({
      projectDir: makeProjectDir(),
      newestMinidumpForReport: () => dumpLookup(join(makeTmpDir(), 'already-cleaned.dmp')),
      logger: recorder.logger,
    });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'full',
      includeCrashDump: true,
    });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(recorder.outcome()?.level).toBe('warn');
    expect(recorder.outcome()?.payload).toMatchObject({ reason: 'stage-failed' });
  });

  test('unchecking the offered box records declined without consulting the lookup', async () => {
    const recorder = makeLogRecorder();
    let lookupCalls = 0;
    const deps = makeDeps({
      newestMinidumpForReport: () => {
        lookupCalls += 1;
        return dumpLookup(seedDump());
      },
      logger: recorder.logger,
    });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeCrashDump: false,
    });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(recorder.intent()?.payload).toMatchObject({
      requested: false,
      reason: 'declined',
    });
    // Settled before collection, so there is nothing left for an outcome to say.
    expect(recorder.outcome()).toBeUndefined();
    // The lookup walks the crash-dumps dir and parses dump headers. Hoisting it
    // out of the opt-in guard would charge every ordinary bug report for that.
    expect(lookupCalls).toBe(0);
    expect(recorder.intent()?.payload).not.toHaveProperty('minidumpAvailable');
  });

  test('a report with no crash checkbox in play records not-offered', async () => {
    const recorder = makeLogRecorder();
    let lookupCalls = 0;
    const deps = makeDeps({
      newestMinidumpForReport: () => {
        lookupCalls += 1;
        return dumpLookup(null);
      },
      logger: recorder.logger,
    });

    const result = await handleBugReportCreate(deps, { kind: 'create', level: 'standard' });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(recorder.intent()?.payload).toMatchObject({
      requested: false,
      reason: 'not-offered',
    });
    expect(recorder.outcome()).toBeUndefined();
    expect(lookupCalls).toBe(0);
  });

  test('opting in with nothing attachable records none-available plus what was skipped', async () => {
    const recorder = makeLogRecorder();
    const deps = makeDeps({
      newestMinidumpForReport: () => dumpLookup(null, 2, 1),
      logger: recorder.logger,
    });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeCrashDump: true,
    });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    // Without the counts this case reads the same as a crash that genuinely
    // wrote no dump, which is the shape that made a real report undiagnosable.
    expect(recorder.intent()?.payload).toMatchObject({
      requested: true,
      reason: 'none-available',
      minidumpAvailable: false,
      foreignDumpsIgnored: 2,
      unreadableDumpsSkipped: 1,
    });
    expect(recorder.intent()?.payload).not.toHaveProperty('sizeBytes');
    expect(recorder.outcome()).toBeUndefined();
  });

  test('a dump that never reached the bundle records stage-failed at warn level', async () => {
    const recorder = makeLogRecorder();
    const deps = makeDeps({
      newestMinidumpForReport: () => dumpLookup(join(makeTmpDir(), 'already-cleaned.dmp')),
      logger: recorder.logger,
    });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeCrashDump: true,
    });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(recorder.intent()?.payload).toMatchObject({ reason: 'staging' });
    expect(recorder.outcome()?.level).toBe('warn');
    expect(recorder.outcome()?.payload).toMatchObject({
      requested: true,
      attached: false,
      reason: 'stage-failed',
      minidumpAvailable: true,
    });
  });

  test('a screenshot riding along in extra/ does not make an absent dump read as attached', async () => {
    const recorder = makeLogRecorder();
    const deps = makeDeps({
      newestMinidumpForReport: () => dumpLookup(join(makeTmpDir(), 'already-cleaned.dmp')),
      screenshotPngBytes: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      logger: recorder.logger,
    });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeCrashDump: true,
      includeScreenshot: true,
    });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    // `extra/` is shared, so a prefix test would call this attached.
    expect(listZipEntries(result.zipPath)).toContain('extra/screenshot.png');
    expect(recorder.outcome()?.payload.reason).toBe('stage-failed');
  });

  test('a dump and a screenshot both staged still records attached', async () => {
    const dumpPath = seedDump();
    const recorder = makeLogRecorder();
    const deps = makeDeps({
      newestMinidumpForReport: () => dumpLookup(dumpPath),
      screenshotPngBytes: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      logger: recorder.logger,
    });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeCrashDump: true,
      includeScreenshot: true,
    });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(listZipEntries(result.zipPath)).toContain('extra/screenshot.png');
    expect(recorder.outcome()?.payload.reason).toBe('attached');
  });

  test('a rejected request records nothing — no decision was ever made', async () => {
    const recorder = makeLogRecorder();
    const deps = makeDeps({
      newestMinidumpForReport: () => dumpLookup('/never-read.dmp'),
      logger: recorder.logger,
    });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeCrashDump: 'yes',
    } as unknown as Parameters<typeof handleBugReportCreate>[1]);

    expect(result.ok).toBe(false);
    expect(recorder.decisions()).toEqual([]);
  });

  test('a bundle that failed to build still records the intent, but no outcome', async () => {
    const recorder = makeLogRecorder();
    // The collector creates its destination directory, so block it with a
    // regular file where that directory would go.
    const blockedRoot = makeTmpDir();
    writeFileSync(join(blockedRoot, 'blocker'), 'not-a-directory');
    const deps = makeDeps({
      outputPath: join(blockedRoot, 'blocker', 'report.zip'),
      newestMinidumpForReport: () => dumpLookup(seedDump()),
      logger: recorder.logger,
    });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeCrashDump: true,
    });

    expect(result.ok).toBe(false);
    // The intent was real even though the bundle was not; the outcome has no
    // inventory to read, so it stays silent rather than guessing.
    expect(recorder.intent()?.payload).toMatchObject({ reason: 'staging' });
    expect(recorder.outcome()).toBeUndefined();
  });

  test('a sink that throws on the decision records never fails the report', async () => {
    // Scoped to the decision records on purpose. The collector's own logging
    // is not fail-soft against a throwing sink and is governed separately; a
    // logger that threw on everything would abort inside collection and prove
    // nothing about these two calls.
    let thrown = 0;
    const throwOnDecision = (payload: Record<string, unknown>) => {
      if (payload.event !== 'bug-report.minidump-decision') return;
      thrown += 1;
      throw new Error('log sink is down');
    };
    const deps = makeDeps({
      newestMinidumpForReport: () => dumpLookup(seedDump()),
      logger: { info: throwOnDecision, warn: throwOnDecision },
      flushLogger: () => {
        throw new Error('drain failed');
      },
    });

    // Observation is not the product: a broken sink loses the record, not the
    // bundle the user is trying to send.
    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeCrashDump: true,
    });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(listZipEntries(result.zipPath)).toContain('extra/renderer-crash.dmp');
    // Both records, and the drain between them, were attempted and swallowed.
    expect(thrown).toBe(2);
  });

  test('no decision record on any branch names the dump', async () => {
    const dumpName = 'renderer-crash-0BADF00D.dmp';
    // Every branch that emits: each terminal intent, and both outcomes. A path
    // added to any one of them has to fail here — the bytes are unredactable
    // process memory and Crashpad names each dump per crash.
    const branches: Array<{
      lookupPath: string | null;
      request: Partial<OkBugReportCreateRequest>;
    }> = [
      { lookupPath: null, request: {} },
      { lookupPath: seedDump(dumpName), request: { includeCrashDump: false } },
      { lookupPath: null, request: { includeCrashDump: true } },
      { lookupPath: seedDump(dumpName), request: { includeCrashDump: true } },
      { lookupPath: join(makeTmpDir(), dumpName), request: { includeCrashDump: true } },
    ];

    const seen = new Set<string>();
    for (const branch of branches) {
      const recorder = makeLogRecorder();
      const deps = makeDeps({
        newestMinidumpForReport: () => dumpLookup(branch.lookupPath),
        logger: recorder.logger,
      });

      const result = await handleBugReportCreate(deps, {
        kind: 'create',
        level: 'standard',
        ...branch.request,
      });

      if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
      const records = recorder.decisions();
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        seen.add(String(record.payload.reason));
        // The message is a fixed string today, but it rides the same sink,
        // so sweep both halves of the record together.
        const serialized = `${JSON.stringify(record.payload)} ${record.message}`;
        if (branch.lookupPath !== null) {
          expect(serialized).not.toContain(branch.lookupPath);
          expect(serialized).not.toContain(dirname(branch.lookupPath));
        }
        expect(serialized).not.toContain(dumpName);
        expect(serialized).not.toContain('renderer-crash');
        expect(serialized).not.toContain('.dmp');
        expect(serialized).not.toContain('extra/');
      }
    }
    // Pins the sweep to the full vocabulary: a sixth reason with a fresh
    // payload shape has to be added above rather than silently skipped.
    expect([...seen].sort()).toEqual(
      ['attached', 'declined', 'none-available', 'not-offered', 'staging', 'stage-failed'].sort(),
    );
  });
});

describe('resolveMinidumpIntent', () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof resolveMinidumpIntent>[0];
    expected: MinidumpIntent;
  }> = [
    {
      name: 'never offered',
      input: { requested: undefined, minidumpPath: '/dumps/a.dmp' },
      expected: { reason: 'not-offered' },
    },
    {
      name: 'offered and unchecked',
      input: { requested: false, minidumpPath: '/dumps/a.dmp' },
      expected: { reason: 'declined' },
    },
    {
      name: 'opted in, nothing the app can prove it owns',
      input: { requested: true, minidumpPath: null },
      expected: { reason: 'none-available' },
    },
    {
      name: 'opted in with a dump on hand',
      input: { requested: true, minidumpPath: '/dumps/a.dmp' },
      expected: { reason: 'staging', zipEntry: 'extra/a.dmp' },
    },
  ];

  for (const { name, input, expected } of cases) {
    test(name, () => {
      expect(resolveMinidumpIntent(input)).toEqual(expected);
    });
  }
});

describe('resolveMinidumpAttachment', () => {
  const staging = { reason: 'staging', zipEntry: 'extra/a.dmp' } as const;

  test('the entry the dump was staged under is in the inventory', () => {
    expect(resolveMinidumpAttachment(staging, ['sysinfo.json', 'extra/a.dmp'])).toEqual({
      attached: true,
      reason: 'attached',
    });
  });

  test('another extra/ entry is not the dump', () => {
    expect(resolveMinidumpAttachment(staging, ['sysinfo.json', 'extra/screenshot.png'])).toEqual({
      attached: false,
      reason: 'stage-failed',
    });
  });

  test('an empty inventory is a staging failure, not an attach', () => {
    expect(resolveMinidumpAttachment(staging, [])).toEqual({
      attached: false,
      reason: 'stage-failed',
    });
  });
});

describe('handleBugReportCreate — screenshot opt-in', () => {
  // A PNG signature wrapping a would-be-redacted token: the screenshot must
  // arrive byte-identical — images ride the `extra/` seam raw, never scrubbed.
  const pngBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('sk-ant-api03-abcdefghijklmnopqrstuvwx'),
    Buffer.from([0x00, 0x1f, 0x8b]),
  ]);

  test('includeScreenshot stages the capture byte-for-byte at extra/screenshot.png', async () => {
    const deps = makeDeps({ screenshotPngBytes: () => pngBytes });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeScreenshot: true,
    });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(listZipEntries(result.zipPath)).toContain('extra/screenshot.png');
    expect(readZipEntryBytes(result.zipPath, 'extra/screenshot.png').equals(pngBytes)).toBe(true);
  });

  test('without the opt-in no screenshot is included even when one was captured', async () => {
    const deps = makeDeps({ screenshotPngBytes: () => pngBytes });

    const result = await handleBugReportCreate(deps, { kind: 'create', level: 'standard' });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(listZipEntries(result.zipPath).some((e) => e.startsWith('extra/'))).toBe(false);
  });

  test('opting in with no captured screenshot still builds the bundle', async () => {
    const deps = makeDeps({ screenshotPngBytes: () => null });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeScreenshot: true,
    });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(listZipEntries(result.zipPath).some((e) => e.startsWith('extra/'))).toBe(false);
  });

  test('an opted-in screenshot and crash dump both land under extra/', async () => {
    const dumpPath = join(makeTmpDir(), 'renderer-crash.dmp');
    const dumpBytes = Buffer.from([0x4d, 0x44, 0x4d, 0x50, 0x00, 0xff]);
    writeFileSync(dumpPath, dumpBytes);
    const deps = makeDeps({
      newestMinidumpForReport: () => dumpLookup(dumpPath),
      screenshotPngBytes: () => pngBytes,
    });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeCrashDump: true,
      includeScreenshot: true,
    });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    const entries = listZipEntries(result.zipPath);
    expect(entries).toContain('extra/screenshot.png');
    expect(entries).toContain('extra/renderer-crash.dmp');
    expect(readZipEntryBytes(result.zipPath, 'extra/screenshot.png').equals(pngBytes)).toBe(true);
    expect(readZipEntryBytes(result.zipPath, 'extra/renderer-crash.dmp').equals(dumpBytes)).toBe(
      true,
    );
  });

  test('a non-boolean includeScreenshot is refused as invalid-request', async () => {
    const deps = makeDeps({ screenshotPngBytes: () => pngBytes });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeScreenshot: 'yes',
    } as unknown as Parameters<typeof handleBugReportCreate>[1]);

    expect(result).toEqual({ ok: false, error: 'invalid-request' });
  });
});

describe('handleBugReportCaptureScreenshot', () => {
  function fakeImage(spec: {
    png: Buffer;
    width: number;
    height: number;
    dataUrl?: string;
  }): CapturableImage {
    return {
      toPNG: () => spec.png,
      getSize: () => ({ width: spec.width, height: spec.height }),
      resize: ({ width }) => fakeImage({ ...spec, width, dataUrl: `resized:${width}` }),
      toDataURL: () => spec.dataUrl ?? `full:${spec.width}x${spec.height}`,
    };
  }

  function makeCaptureDeps(overrides: Partial<CaptureScreenshotDeps> = {}): {
    deps: CaptureScreenshotDeps;
    store: Map<number, BugReportScreenshotEntry>;
    registered: Array<() => void>;
    unregistered: Array<() => void>;
  } {
    const store = new Map<number, BugReportScreenshotEntry>();
    const registered: Array<() => void> = [];
    const unregistered: Array<() => void> = [];
    return {
      store,
      registered,
      unregistered,
      deps: {
        store,
        senderId: 7,
        previewWidth: 720,
        capturePage: async () =>
          fakeImage({ png: Buffer.from([1, 2, 3]), width: 1000, height: 800 }),
        registerCleanup: (cb) => registered.push(cb),
        unregisterCleanup: (cb) => unregistered.push(cb),
        ...overrides,
      },
    };
  }

  test('a successful capture stores full-res bytes, registers a reaper, and returns a downscaled preview', async () => {
    const { deps, store, registered } = makeCaptureDeps();

    const result = await handleBugReportCaptureScreenshot(deps);

    // Wide capture (1000 > 720) downscales for the preview data-URL...
    expect(result).toEqual({ dataUrl: 'resized:720', width: 1000, height: 800 });
    // ...while the FULL-resolution bytes are what get stored for the bundle.
    expect(store.get(7)?.png.equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(registered).toHaveLength(1);
  });

  test('a capture no wider than the preview cap is not resized', async () => {
    const { deps } = makeCaptureDeps({
      capturePage: async () => fakeImage({ png: Buffer.from([9]), width: 640, height: 480 }),
    });

    expect(await handleBugReportCaptureScreenshot(deps)).toEqual({
      dataUrl: 'full:640x480',
      width: 640,
      height: 480,
    });
  });

  test('a zero-byte capture returns null and stores nothing', async () => {
    const { deps, store } = makeCaptureDeps({
      capturePage: async () => fakeImage({ png: Buffer.alloc(0), width: 800, height: 600 }),
    });

    expect(await handleBugReportCaptureScreenshot(deps)).toBeNull();
    expect(store.has(7)).toBe(false);
  });

  test('re-capture on the same window unregisters the prior reaper before registering the next', async () => {
    const { deps, store, registered, unregistered } = makeCaptureDeps();

    await handleBugReportCaptureScreenshot(deps);
    const firstReaper = registered[0];
    await handleBugReportCaptureScreenshot(deps);

    // The first capture's listener is removed, so repeated opens don't
    // accumulate MaxListeners-worth of reapers on one WebContents.
    expect(unregistered).toContain(firstReaper);
    expect(registered).toHaveLength(2);
    expect(store.size).toBe(1);
  });

  test('the registered reaper deletes the window entry on window close', async () => {
    const { deps, store, registered } = makeCaptureDeps();

    await handleBugReportCaptureScreenshot(deps);
    expect(store.has(7)).toBe(true);
    registered[0]?.(); // simulate the 'destroyed' event firing
    expect(store.has(7)).toBe(false);
  });

  test('a capturePage rejection resolves to null, is logged, and never throws', async () => {
    const warnings: Array<{ payload: Record<string, unknown>; message: string }> = [];
    const { deps, store } = makeCaptureDeps({
      capturePage: async () => {
        throw new Error('offscreen surface');
      },
      logger: {
        info: () => {},
        warn: (payload, message) => {
          warnings.push({ payload, message });
        },
      },
    });

    expect(await handleBugReportCaptureScreenshot(deps)).toBeNull();
    expect(store.has(7)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect((warnings[0]?.payload.err as Error).message).toContain('offscreen surface');
  });
});

describe('handleBugReportCreate — failure modes', () => {
  test('an unwritable destination maps to a discriminated error instead of throwing', async () => {
    const blockerFile = join(makeTmpDir(), 'not-a-dir');
    writeFileSync(blockerFile, 'occupied\n');
    const deps = makeDeps({ outputPath: join(blockerFile, 'report.zip') });

    const result = await handleBugReportCreate(deps, { kind: 'create', level: 'standard' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.length).toBeGreaterThan(0);
  });

  test('a malformed renderer payload is refused as invalid-request', async () => {
    const deps = makeDeps();

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'verbose',
    } as unknown as Parameters<typeof handleBugReportCreate>[1]);

    expect(result).toEqual({ ok: false, error: 'invalid-request' });
  });
});

describe('handleBugReportCrashAck', () => {
  /**
   * Real crash-detection instance over tmpdir paths with a deterministic
   * advancing clock, so the ack round-trip is proven against the persisted
   * store rather than a recording double.
   */
  function makeCrashDetectionRig() {
    const dir = makeTmpDir('ok-bugreport-crashack-');
    let clockMs = Date.parse('2026-07-10T00:00:00.000Z');
    const deps = {
      sentinelPath: join(dir, 'sentinel.json'),
      ackStorePath: join(dir, 'crash-acks.json'),
      crashDumpsDir: join(dir, 'dumps'),
      appBundleRoot: join(dir, 'OpenKnowledge.app'),
      emit: () => true,
      now: () => {
        clockMs += 10_000;
        return new Date(clockMs);
      },
      // Constant identity: every simulated restart happens inside one kernel
      // session, so reboot suppression never engages in this ack round-trip.
      currentBootSessionUuid: () => 'boot-epoch-test',
      logger: { info: () => {}, warn: () => {} },
    };
    // Not a real minidump, so ownership reads as indeterminate — which the
    // boot scan deliberately treats as arm-worthy. That is what makes the ack
    // round-trip below observable; the dump itself is never attached.
    const seedMinidump = (relPath: string): void => {
      const dumpPath = join(deps.crashDumpsDir, relPath);
      mkdirSync(dirname(dumpPath), { recursive: true });
      writeFileSync(dumpPath, 'minidump-bytes');
      clockMs += 10_000;
      const at = new Date(clockMs);
      utimesSync(dumpPath, at, at);
    };
    return { deps, seedMinidump };
  }

  test('a crash-ack round-trip retires the crash event across restarts', () => {
    const { deps, seedMinidump } = makeCrashDetectionRig();

    const sessionA = createCrashDetection(deps);
    expect(sessionA.detectBootCrash()).toBeNull();
    sessionA.markCleanQuit();

    seedMinidump('pending/native.dmp');

    const sessionB = createCrashDetection(deps);
    const invited = sessionB.detectBootCrash();
    if (!invited) throw new Error('expected a boot invitation for the fresh minidump');
    sessionB.markCleanQuit();

    // Unanswered, the same crash re-invites on the next boot...
    const sessionC = createCrashDetection(deps);
    expect(sessionC.detectBootCrash()?.eventId).toBe(invited.eventId);

    // ...until the renderer's ack lands through the dispatch surface.
    const ackResult = handleBugReportCrashAck(
      { ackCrashEvent: (eventId) => sessionC.ack(eventId) },
      { kind: 'crash-ack', eventId: invited.eventId },
    );
    expect(ackResult).toEqual({ ok: true });
    sessionC.markCleanQuit();

    const sessionD = createCrashDetection(deps);
    expect(sessionD.detectBootCrash()).toBeNull();
  });

  test('a malformed renderer payload is refused and never touches the acknowledgment store', () => {
    const acked: string[] = [];
    const deps = { ackCrashEvent: (eventId: string) => acked.push(eventId) };
    const malformed = [
      { kind: 'crash-ack' },
      { kind: 'crash-ack', eventId: '' },
      { kind: 'crash-ack', eventId: 42 },
      { kind: 'ack', eventId: 'crash:render:1:0' },
      null,
    ];

    for (const request of malformed) {
      const result = handleBugReportCrashAck(
        deps,
        request as unknown as Parameters<typeof handleBugReportCrashAck>[1],
      );
      expect(result).toEqual({ ok: false, error: 'invalid-request' });
    }

    // The handler's contract: malformed renderer input never mutates the store.
    expect(acked).toEqual([]);
  });
});

describe('handleBugReportCrashDumpAvailability', () => {
  test('reports available when the ownership walk found a dump this app owns', () => {
    const result = handleBugReportCrashDumpAvailability({
      newestMinidumpForReport: () => ({
        path: '/crash-dumps/pending/a44001a4.dmp',
        foreignSkipped: 0,
        unknownSkipped: 0,
      }),
    });

    expect(result).toEqual({ available: true });
  });

  test('reports unavailable when the walk rejected everything it found', () => {
    // Foreign and unreadable dumps are not ours to offer, and the lookup has
    // already excluded them — a nonzero skip count is not availability.
    const result = handleBugReportCrashDumpAvailability({
      newestMinidumpForReport: () => ({ path: null, foreignSkipped: 3, unknownSkipped: 1 }),
    });

    expect(result).toEqual({ available: false });
  });

  test('reports unavailable rather than throwing when no lookup is wired', () => {
    expect(handleBugReportCrashDumpAvailability({})).toEqual({ available: false });
  });

  test('a lookup that throws loses the option, not the report, and says so', () => {
    // A walk that keeps throwing is indistinguishable from an empty crash
    // database at the checkbox, so the failure has to leave a record.
    const warnings: Record<string, unknown>[] = [];
    const result = handleBugReportCrashDumpAvailability({
      newestMinidumpForReport: () => {
        throw new Error('crash-dumps dir is unreadable');
      },
      logger: {
        info: () => {},
        warn: (payload: Record<string, unknown>) => {
          warnings.push(payload);
        },
      } as unknown as Parameters<typeof handleBugReportCrashDumpAvailability>[0]['logger'],
    });

    expect(result).toEqual({ available: false });
    expect(warnings[0]?.event).toBe('bug-report.crash-dump-availability-failed');
  });

  test('a logger that throws cannot fail the probe', () => {
    const result = handleBugReportCrashDumpAvailability({
      newestMinidumpForReport: () => {
        throw new Error('crash-dumps dir is unreadable');
      },
      logger: {
        info: () => {},
        warn: () => {
          throw new Error('logger is down too');
        },
      } as unknown as Parameters<typeof handleBugReportCrashDumpAvailability>[0]['logger'],
    });

    expect(result).toEqual({ available: false });
  });
});

describe('bug-report sidecar wiring — create writes the record, send tracks state', () => {
  const REPORT_ID = '2026-07-15T18-30-00-000Z-bugreport.zip';

  /**
   * A create rig whose output lands in a shared bug-reports dir with a real
   * report basename, wired to a live sidecar store — so the generated sidecar
   * and the send transitions are asserted against the on-disk file.
   */
  function makeSidecarRig() {
    const dir = makeTmpDir('ok-bugreport-sidecar-wiring-');
    const store = createBugReportSidecarStore({ dir });
    const zipPath = join(dir, REPORT_ID);
    const createDeps: BugReportCreateDeps = {
      projectDir: makeProjectDir(),
      desktopMeta: DESKTOP_META,
      outputPath: zipPath,
      userLogsDir: makeTmpDir(),
      onReportGenerated: store.recordGenerated,
    };
    return { dir, store, zipPath, createDeps };
  }

  test('create persists a generated sidecar next to the zip', async () => {
    const { dir, createDeps, zipPath } = makeSidecarRig();

    const result = await handleBugReportCreate(createDeps, { kind: 'create', level: 'standard' });
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(result.zipPath).toBe(zipPath);

    const sidecar = await readReportSidecar(sidecarPathForId(dir, REPORT_ID));
    expect(sidecar?.id).toBe(REPORT_ID);
    expect(sidecar?.state).toBe('generated');
    expect(sidecar?.bundleLevel).toBe('standard');
    expect(sidecar?.zipBytes).toBe(result.zipSizeBytes);
  });

  test('a successful send flips the sidecar to sent + reference and reclaims the zip', async () => {
    const { dir, store, createDeps, zipPath } = makeSidecarRig();
    await handleBugReportCreate(createDeps, { kind: 'create', level: 'standard' });
    const stub = await startIntakeStub();

    const result = await handleBugReportSend(
      { ...makeSendDeps(stub.url, dir), sidecar: store.sendHooks },
      { kind: 'send', zipPath, metadata: SEND_METADATA },
    );

    expect(result).toEqual({ ok: true, reference: 'OK-1042' });
    const sidecar = await readReportSidecar(sidecarPathForId(dir, REPORT_ID));
    expect(sidecar?.state).toBe('sent');
    expect(sidecar?.reference).toBe('OK-1042');
    expect(sidecar?.zipDeleted).toBe(true);
    expect(sidecar?.attempts?.at(-1)).toMatchObject({ transport: 'upload', outcome: 'success' });
    // Retention reclaimed the confirmed-sent zip.
    expect(existsSync(zipPath)).toBe(false);
  });

  test('a failed send records upload-failed and keeps the zip for a later retry', async () => {
    const { dir, store, createDeps, zipPath } = makeSidecarRig();
    await handleBugReportCreate(createDeps, { kind: 'create', level: 'standard' });
    const stub = await startIntakeStub({ mintStatus: 500 });

    const result = await handleBugReportSend(
      { ...makeSendDeps(stub.url, dir), sidecar: store.sendHooks },
      { kind: 'send', zipPath, metadata: SEND_METADATA },
    );

    expect(result.ok).toBe(false);
    const sidecar = await readReportSidecar(sidecarPathForId(dir, REPORT_ID));
    expect(sidecar?.state).toBe('upload-failed');
    expect(sidecar?.lastError?.reason).toContain('mint-rejected');
    expect(existsSync(zipPath)).toBe(true);

    // The list now surfaces the failed report as retryable.
    const listed = await store.list();
    if (!listed.ok) throw new Error('expected ok');
    const row = listed.reports.find((r) => r.id === REPORT_ID);
    expect(row?.state).toBe('upload-failed');
    expect(row?.retryable).toBe(true);
  });

  test('a transport failure persists its leg and its errno in the durable ledger', async () => {
    // The ledger outlives the log. `desktop.*.log` rotates on a seven-day
    // budget, and a reporter filing about a send that failed last week still
    // has the sidecar beside the zip they are retrying. Whatever the ledger
    // does not record is unrecoverable by then.
    //
    // Driven through real `fetch` against an unresolvable host so the errno is
    // produced the way undici produces it — hung one level down in `cause`
    // under an opaque `TypeError: fetch failed` — rather than by a fake that
    // would let a top-level `err.code` read pass.
    const { dir, store, createDeps, zipPath } = makeSidecarRig();
    await handleBugReportCreate(createDeps, { kind: 'create', level: 'standard' });

    const result = await handleBugReportSend(
      {
        ...makeSendDeps('https://intake.invalid-tld-for-test.invalid', dir),
        sidecar: store.sendHooks,
      },
      { kind: 'send', zipPath, metadata: SEND_METADATA },
    );

    expect(result.ok).toBe(false);
    const sidecar = await readReportSidecar(sidecarPathForId(dir, REPORT_ID));
    expect(sidecar?.lastError).toMatchObject({
      reason: 'mint-network-error',
      errorCode: 'ENOTFOUND',
    });
    expect(sidecar?.attempts?.at(-1)).toMatchObject({
      outcome: 'failed',
      error: 'mint-network-error',
      errorCode: 'ENOTFOUND',
    });
    // The message and the stack stay out: this file is readable by the reporter
    // and ships inside the bundle they hand to support.
    expect(JSON.stringify(sidecar)).not.toContain('fetch failed');
  });

  test('a send refused by the in-flight lock never reaches the intake', async () => {
    const { dir, store, createDeps, zipPath } = makeSidecarRig();
    await handleBugReportCreate(createDeps, { kind: 'create', level: 'standard' });
    const stub = await startIntakeStub();
    // Take the lock as the owning send would, then drive a second send for the
    // same report through the handler — the double-upload this gate prevents.
    const owner = await store.sendHooks.onSendStart(REPORT_ID);
    expect(owner.proceed).toBe(true);

    const result = await handleBugReportSend(
      { ...makeSendDeps(stub.url, dir), sidecar: store.sendHooks },
      { kind: 'send', zipPath, metadata: SEND_METADATA },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    // Distinct from a genuine failure: the owning send is still running, so a
    // renderer that renders this as "couldn't send" would be lying about a
    // report that is about to succeed.
    expect(result.reason).toBe('send-in-flight');
    // The refusal must happen BEFORE any network work: the bundle is uploaded
    // exactly once no matter how many retries race.
    expect(stub.requests).toHaveLength(0);
    // The owning send still holds the report: the refusal returned before the
    // terminal hook, so it wrote no state and released no lock the owner is
    // still relying on.
    expect((await readReportSidecar(sidecarPathForId(dir, REPORT_ID)))?.state).toBe('uploading');
    expect((await store.sendHooks.onSendStart(REPORT_ID)).proceed).toBe(false);
  });

  test('a zip inside the reports dir with a non-report basename is refused', async () => {
    const { dir, store, createDeps } = makeSidecarRig();
    await handleBugReportCreate(createDeps, { kind: 'create', level: 'standard' });
    const stub = await startIntakeStub();
    // Contained, readable, but not a report basename — the same shape gate
    // `delete` applies, so no renderer-supplied path skips it on the send side.
    const strayPath = join(dir, 'not-a-report.zip');
    writeFileSync(strayPath, Buffer.alloc(64));

    const result = await handleBugReportSend(
      { ...makeSendDeps(stub.url, dir), sidecar: store.sendHooks },
      { kind: 'send', zipPath: strayPath, metadata: SEND_METADATA },
    );

    expect(result.ok).toBe(false);
    expect(stub.requests).toHaveLength(0);
  });

  test('the unconfigured (no-intake) send path records email-drafted', async () => {
    const { dir, store, createDeps, zipPath } = makeSidecarRig();
    await handleBugReportCreate(createDeps, { kind: 'create', level: 'standard' });

    const result = await handleBugReportSend(
      { ...makeSendDeps(undefined, dir), sidecar: store.sendHooks },
      { kind: 'send', zipPath, metadata: SEND_METADATA },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fallback');
    expect(result.reason).toBe('email-draft');
    expect((await readReportSidecar(sidecarPathForId(dir, REPORT_ID)))?.state).toBe(
      'email-drafted',
    );
  });
});

describe('handleBugReportSend — structured failure diagnostics', () => {
  /** The `logIpcError` lines emitted while `fn` ran, parsed. */
  async function captureIpcErrors(fn: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
    const lines: Record<string, unknown>[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      try {
        lines.push(JSON.parse(String(args[0])) as Record<string, unknown>);
      } catch {
        // Not a structured line — irrelevant here.
      }
    };
    try {
      await fn();
    } finally {
      console.warn = original;
    }
    return lines;
  }

  function dispatchFailure(lines: Record<string, unknown>[]): Record<string, unknown> {
    const line = lines.find(
      (l) => l.channel === 'ok:bug-report:dispatch' && l.handler === 'handleBugReportSend',
    );
    if (line === undefined) throw new Error('no dispatch failure line was logged');
    return line;
  }

  test('an unresolvable intake names the step, the errno, and the host', async () => {
    // Driven through real `fetch` rather than a thrown fake because the
    // behavior under test is undici-specific: it reports
    // every transport failure as the same opaque `TypeError: fetch failed`
    // and hangs the errno one level down in `cause`, so an implementation
    // that read `err.code` off the caught value would pass a fake and still
    // log nothing useful in production.
    const { deps, zipPath } = makeSendRig('https://intake.invalid-tld-for-test.invalid');

    const lines = await captureIpcErrors(() =>
      handleBugReportSend(deps, { kind: 'send', zipPath, metadata: SEND_METADATA }),
    );

    const details = dispatchFailure(lines).details as Record<string, unknown>;
    expect(details.step).toBe('mint');
    expect(details.host).toBe('intake.invalid-tld-for-test.invalid');
    expect(details.errName).toBe('TypeError');
    // The field that separates "this machine cannot resolve" from "the intake
    // refused" from "the certificate expired" — all previously indistinguishable
    // under the single token `network-error`.
    expect(details.errCode).toBe('ENOTFOUND');
  });

  test('a failing upload names the storage host without leaking the signature', async () => {
    // The upload step targets a MINTED, signed URL. Its host is the fact that
    // makes a failure triageable; its query is a live credential. Logging the
    // whole URL would write that credential into a bundle the user hands to
    // support, so this pins host-only rather than trusting the convention.
    const stub = await startIntakeStub({
      mintBody: {
        uploadUrl: 'https://storage.example.invalid/dest?X-Signature=SUPERSECRETSIG&exp=99',
        assetUrl: 'https://uploads.example.invalid/asset/dest',
        headers: {},
      },
    });
    const { deps, zipPath } = makeSendRig(stub.url);

    const lines = await captureIpcErrors(() =>
      handleBugReportSend(deps, { kind: 'send', zipPath, metadata: SEND_METADATA }),
    );

    const line = dispatchFailure(lines);
    const details = line.details as Record<string, unknown>;
    expect(details.step).toBe('upload');
    expect(details.host).toBe('storage.example.invalid');
    // Nothing anywhere on the line may carry the signature.
    expect(JSON.stringify(line)).not.toContain('SUPERSECRETSIG');
  });

  test('a rejected mint carries the step and the status it was rejected with', async () => {
    const stub = await startIntakeStub({ mintStatus: 503 });
    const { deps, zipPath } = makeSendRig(stub.url);

    const lines = await captureIpcErrors(() =>
      handleBugReportSend(deps, { kind: 'send', zipPath, metadata: SEND_METADATA }),
    );

    const details = dispatchFailure(lines).details as Record<string, unknown>;
    expect(details).toMatchObject({ step: 'mint', status: 503 });
  });

  test('a transport throw names its leg in the reason, not just in the details', async () => {
    // Every other failure return already carries its leg — `mint-rejected`,
    // `upload-rejected`, `upload-redirected`, `complete-rejected`,
    // `mint-malformed`, `complete-malformed`, `upload-url-rejected`. The
    // throw branch was the one exception, so the three-leg flow across two
    // different hosts collapsed to one word and could not say whether the
    // intake or the storage bucket was unreachable.
    //
    // The reason, unlike `details`, is what the durable per-report ledger
    // stores and what the history row shows, so the leg has to live in the
    // string as well as beside it.
    const { deps, zipPath } = makeSendRig('https://intake.invalid-tld-for-test.invalid');

    const lines = await captureIpcErrors(() =>
      handleBugReportSend(deps, { kind: 'send', zipPath, metadata: SEND_METADATA }),
    );

    expect(dispatchFailure(lines).reason).toBe('mint-network-error');
  });
});

describe('handleBugReportSend — transport phase spans', () => {
  beforeEach(() => {
    startedSpanNames.length = 0;
    // The tracer is opt-in; without this every span call is a silent no-op,
    // which is precisely why the mint gap below went unnoticed.
    process.env.OTEL_SDK_DISABLED = 'false';
  });

  afterEach(() => {
    process.env.OTEL_SDK_DISABLED = undefined;
  });

  test('a REJECTED mint still records how long the mint took', async () => {
    // The failure this pins: the mint phase span used to be recorded after the
    // status checks, so a 500 skipped it entirely - the span was absent on
    // exactly the mint failures it exists to time, while upload and complete
    // recorded theirs before their own checks. A slow-then-rejecting intake
    // looked identical to an instant one.
    const stub = await startIntakeStub({ mintStatus: 500 });
    const { deps, zipPath } = makeSendRig(stub.url);

    const result = await handleBugReportSend(deps, {
      kind: 'send',
      zipPath,
      metadata: SEND_METADATA,
    });

    expect(result.ok).toBe(false);
    expect(startedSpanNames).toContain('ok.bug-report.mint');
  });

  test('a successful send records all three transport phases', async () => {
    const stub = await startIntakeStub();
    const { deps, zipPath } = makeSendRig(stub.url);

    await handleBugReportSend(deps, { kind: 'send', zipPath, metadata: SEND_METADATA });

    expect(startedSpanNames).toEqual(
      expect.arrayContaining([
        'ok.bug-report.send',
        'ok.bug-report.mint',
        'ok.bug-report.upload',
        'ok.bug-report.complete',
      ]),
    );
  });
});
