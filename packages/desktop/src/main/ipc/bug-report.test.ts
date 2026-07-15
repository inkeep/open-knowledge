/**
 * IPC handler tests for the `ok:bug-report:dispatch` create operation.
 *
 * Exercise the pure handler directly against tmpdir-backed fixtures with the
 * real `collectReportBundle` (no capture mocks) — zip contents are the
 * observable contract. The IPC wrapping in main/index.ts is one createHandler
 * call whose ctx-resolution behavior is shared with every project-scoped IPC
 * and covered by the existing main-side siblings.
 *
 * HOME and the `OK_DESKTOP_*` block are snapshot/restored around every test:
 * bun runs all test files in one process, so an unrestored env mutation here
 * becomes a load-order-dependent failure in another suite.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, execSync } from 'node:child_process';
import {
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
import { dirname, join, resolve } from 'node:path';
import { createCrashDetection } from '../crash-detection.ts';
import { handleShellOpenExternal } from '../shell-allowlist.ts';
import {
  type BugReportCreateDeps,
  type BugReportSendDeps,
  handleBugReportCrashAck,
  handleBugReportCreate,
  handleBugReportSend,
  MAX_UPLOAD_ZIP_BYTES,
  parseTransportSafeUrl,
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
    // Bun resolves `os.homedir()` at process launch, so the default path can
    // only be steered hermetically by a subprocess launched with a fake HOME
    // (mutating `process.env.HOME` in this process would not take, and the
    // real `~/.ok` must never be touched by tests).
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
  } = {},
): Promise<IntakeStub> {
  const requests: RecordedRequest[] = [];
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

/** Non-UTF-8 byte pattern so the PUT byte-identity assertion is meaningful. */
function makeZipFixture(bugReportsRoot: string): string {
  const bytes = Buffer.alloc(2048);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) % 256;
  const zipPath = join(bugReportsRoot, 'report.zip');
  writeFileSync(zipPath, bytes);
  return zipPath;
}

/** Deps plus a zip fixture placed inside the deps' containment root. */
function makeSendRig(intakeBaseUrl: string | undefined): {
  deps: BugReportSendDeps;
  zipPath: string;
} {
  const bugReportsRoot = makeBugReportsRoot();
  return {
    deps: makeSendDeps(intakeBaseUrl, bugReportsRoot),
    zipPath: makeZipFixture(bugReportsRoot),
  };
}

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
      filename: 'report.zip',
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
    const deps = makeDeps({ newestMinidumpPath: () => dumpPath });

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
    const deps = makeDeps({ newestMinidumpPath: () => dumpPath });

    const result = await handleBugReportCreate(deps, { kind: 'create', level: 'standard' });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(listZipEntries(result.zipPath).some((e) => e.startsWith('extra/'))).toBe(false);
  });

  test('opting in with no relevant dump on disk still builds the bundle', async () => {
    const deps = makeDeps({ newestMinidumpPath: () => null });

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
    const warnings: Array<{ payload: Record<string, unknown>; message: string }> = [];
    const deps = makeDeps({
      newestMinidumpPath: () => vanishedDump,
      logger: {
        info: () => {},
        warn: (payload, message) => {
          warnings.push({ payload, message });
        },
      },
    });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeCrashDump: true,
    });

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(listZipEntries(result.zipPath).some((e) => e.startsWith('extra/'))).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.payload.sourcePath).toBe(vanishedDump);
  });

  test('a non-boolean includeCrashDump is refused as invalid-request', async () => {
    const deps = makeDeps({ newestMinidumpPath: () => '/never-read.dmp' });

    const result = await handleBugReportCreate(deps, {
      kind: 'create',
      level: 'standard',
      includeCrashDump: 'yes',
    } as unknown as Parameters<typeof handleBugReportCreate>[1]);

    expect(result).toEqual({ ok: false, error: 'invalid-request' });
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
      emit: () => true,
      now: () => {
        clockMs += 10_000;
        return new Date(clockMs);
      },
      logger: { info: () => {}, warn: () => {} },
    };
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
