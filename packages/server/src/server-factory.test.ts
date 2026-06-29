import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import shellQuote from 'shell-quote';
import simpleGit from 'simple-git';
import * as Y from 'yjs';
import type {
  CheckPushPermissionOptions,
  DetectGhFn,
  ProbeTokenStore,
  PushPermission,
} from './github-permissions.ts';
import { loggerFactory, type PinoLogger } from './logger.ts';
import {
  createManagedRenameRecoveryJournal,
  managedRenameJournalPath,
  writeManagedRenameJournal,
} from './managed-rename-journal.ts';
import { ensureProjectGit } from './project-git.ts';
import { buildSyncCredentialArgs, createServer, type ServerInstance } from './server-factory.ts';
import { initShadowRepo, shadowGit } from './shadow-repo.ts';

interface LogEntry {
  level: 'info' | 'warn' | 'error' | 'debug';
  msg: string;
  payload: Record<string, unknown>;
}

class CaptureLogger {
  readonly entries: LogEntry[] = [];

  info(data: unknown, message: string): void {
    this.entries.push({
      level: 'info',
      msg: message,
      payload: (data as Record<string, unknown>) ?? {},
    });
  }

  warn(data: unknown, message: string): void {
    this.entries.push({
      level: 'warn',
      msg: message,
      payload: (data as Record<string, unknown>) ?? {},
    });
  }

  error(data: unknown, message: string): void {
    this.entries.push({
      level: 'error',
      msg: message,
      payload: (data as Record<string, unknown>) ?? {},
    });
  }

  debug(data: unknown, message: string): void {
    this.entries.push({
      level: 'debug',
      msg: message,
      payload: (data as Record<string, unknown>) ?? {},
    });
  }
}

const captureLoggers = new Map<string, CaptureLogger>();

function captureAllLoggers(): {
  getCalls: (level?: string, msgContains?: string) => LogEntry[];
  getLoggerEntries: (name: string) => LogEntry[];
  reset: () => void;
} {
  captureLoggers.clear();
  loggerFactory.configure({
    loggerFactory: (name: string) => {
      const capture = new CaptureLogger();
      captureLoggers.set(name, capture);
      return capture as unknown as PinoLogger;
    },
  });

  return {
    getCalls(level?: string, msgContains?: string) {
      const all: LogEntry[] = [];
      for (const logger of captureLoggers.values()) {
        all.push(...logger.entries);
      }
      return all.filter((e) => {
        if (level && e.level !== level) return false;
        if (msgContains && !e.msg.includes(msgContains)) return false;
        return true;
      });
    },
    getLoggerEntries(name: string) {
      return captureLoggers.get(name)?.entries ?? [];
    },
    reset() {
      captureLoggers.clear();
    },
  };
}

describe('createServer().destroy() — graceful shutdown flush', () => {
  let tmpDir: string;
  let logCapture: ReturnType<typeof captureAllLoggers>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-destroy-test-'));
    logCapture = captureAllLoggers();
  });

  afterEach(async () => {
    loggerFactory.reset();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('flushes L1 markdown writes before destroy() resolves + emits shutdown log', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      debounce: 60_000, // Prevent natural debounce from firing — proves destroy-time flush
    });
    await server.ready;

    const conn = await server.hocuspocus.openDirectConnection('test-doc');
    await conn.transact((doc) => {
      const xmlFragment = doc.getXmlFragment('default');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('hello world')]);
      xmlFragment.insert(0, [paragraph]);
    });

    const doc = server.hocuspocus.documents.get('test-doc');
    expect(doc).toBeDefined();
    doc?.removeDirectConnection();

    await server.destroy();

    const onDisk = await readFile(join(tmpDir, 'test-doc.md'), 'utf-8');
    expect(onDisk).toContain('hello world');

    const shutdownLogs = logCapture.getCalls('info', 'shutdown flushed');
    expect(shutdownLogs).toHaveLength(1);
    expect(shutdownLogs[0].payload.documentCount).toBeGreaterThanOrEqual(1);

    const warnShutdownLogs = logCapture.getCalls('warn', 'shutdown');
    expect(warnShutdownLogs).toHaveLength(0);
  });

  test('flushes L2 git commit after L1 drain', async () => {
    const { mkdirSync } = await import('node:fs');
    const projectDir = tmpDir;
    const contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    await ensureProjectGit(projectDir);
    const shadowHandle = await initShadowRepo(projectDir);

    const server = createServer({
      contentDir,
      projectDir,
      contentRoot: 'content',
      quiet: true,
      debounce: 60_000,
      shadowRepo: shadowHandle,
    });
    await server.ready;

    const conn = await server.hocuspocus.openDirectConnection('test-doc-2');
    await conn.transact((doc) => {
      const xmlFragment = doc.getXmlFragment('default');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('commit me')]);
      xmlFragment.insert(0, [paragraph]);
    });

    const doc = server.hocuspocus.documents.get('test-doc-2');
    expect(doc).toBeDefined();
    doc?.removeDirectConnection();

    await server.destroy();

    const sg = shadowGit(shadowHandle);
    const wipRefs = (await sg.raw('for-each-ref', '--format=%(refname)', 'refs/wip/')).trim();
    expect(wipRefs).toBeTruthy();
  });

  test('shutdown order: lock release happens AFTER L1 disk flush completes', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      debounce: 60_000, // Suppress natural flush — proves destroy-time path
    });
    await server.ready;

    const lockPath = join(tmpDir, '.ok', LOCAL_DIR, 'server.lock');
    const docName = 'shutdown-order';
    const contentPath = join(tmpDir, `${docName}.md`);
    const captures: Array<{ lockExists: boolean; contentOnDisk: boolean; payload: string }> = [];

    server.hocuspocus.configuration.extensions.push({
      async afterUnloadDocument(payload: { documentName: string }) {
        if (payload.documentName !== docName) return;
        captures.push({
          lockExists: existsSync(lockPath),
          contentOnDisk: existsSync(contentPath),
          payload: existsSync(contentPath) ? readFileSync(contentPath, 'utf-8') : '',
        });
      },
    });

    const conn = await server.hocuspocus.openDirectConnection(docName);
    await conn.transact((doc) => {
      const xmlFragment = doc.getXmlFragment('default');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('order-marker')]);
      xmlFragment.insert(0, [paragraph]);
    });
    const doc = server.hocuspocus.documents.get(docName);
    expect(doc).toBeDefined();
    doc?.removeDirectConnection();

    expect(existsSync(lockPath)).toBe(true);
    await server.destroy();

    expect(captures.length).toBe(1);
    expect(captures[0]?.lockExists).toBe(true);
    expect(captures[0]?.contentOnDisk).toBe(true);
    expect(captures[0]?.payload).toContain('order-marker');

    expect(existsSync(lockPath)).toBe(false);
    expect(readFileSync(contentPath, 'utf-8')).toContain('order-marker');
  });

  test('destroy() completes within destroyTimeoutMs AND rescues hung docs when onStoreDocument throws', async () => {
    const { mkdirSync } = await import('node:fs');
    const projectDir = tmpDir;
    const contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    await ensureProjectGit(projectDir);
    const shadowHandle = await initShadowRepo(projectDir);

    const server = createServer({
      contentDir,
      projectDir,
      contentRoot: 'content',
      quiet: true,
      destroyTimeoutMs: 500, // D11: fast timeout for CI — not the 10s default
      shadowRepo: shadowHandle,
    });
    await server.ready;

    server.hocuspocus.configuration.extensions.push({
      async onStoreDocument() {
        throw new Error('simulated store failure');
      },
    });

    const conn = await server.hocuspocus.openDirectConnection('pathological-doc');
    await conn.transact((doc) => {
      const xmlFragment = doc.getXmlFragment('default');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('will not be flushed')]);
      xmlFragment.insert(0, [paragraph]);
    });

    const doc = server.hocuspocus.documents.get('pathological-doc');
    expect(doc).toBeDefined();
    doc?.removeDirectConnection();

    const startedAt = Date.now();
    await server.destroy();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(5_000);

    const warnLogs = logCapture.getCalls('warn', 'shutdown flushed');
    expect(warnLogs).toHaveLength(1);
    expect(warnLogs[0].payload.phaseErrors).toContainEqual(
      expect.objectContaining({
        phase: 'flush-all-stores',
        error: expect.stringContaining('timeout'),
      }),
    );

    const rescuePath = join(shadowHandle.gitDir, 'rescue', 'pathological-doc.md');
    expect(existsSync(rescuePath)).toBe(true);
    expect(readFileSync(rescuePath, 'utf-8')).toContain('will not be flushed');

    const phaseError = warnLogs[0].payload.phaseErrors as Array<{
      phase: string;
      error: string;
    }>;
    const flushErr = phaseError.find((e) => e.phase === 'flush-all-stores');
    expect(flushErr?.error).toContain('rescued [pathological-doc]');

    const rescueLogs = logCapture.getCalls('info', '[rescue]');
    expect(rescueLogs.length).toBeGreaterThanOrEqual(1);
    expect(rescueLogs[0].payload.docName).toBe('pathological-doc');
  });

  test('destroy() is idempotent under concurrent calls', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      debounce: 60_000,
    });
    await server.ready;

    const conn = await server.hocuspocus.openDirectConnection('test-idempotent');
    await conn.transact((doc) => {
      const xmlFragment = doc.getXmlFragment('default');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('idempotent content')]);
      xmlFragment.insert(0, [paragraph]);
    });
    const doc = server.hocuspocus.documents.get('test-idempotent');
    expect(doc).toBeDefined();
    doc?.removeDirectConnection();

    await Promise.all([server.destroy(), server.destroy()]);

    const shutdownLogs = logCapture.getCalls('info', 'shutdown flushed');
    expect(shutdownLogs).toHaveLength(1);

    await server.destroy();
  });

  test('destroy() during async init — before ready resolves', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
    });
    await server.destroy();

    const shutdownLogs = logCapture.getCalls('info', 'shutdown flushed');
    expect(shutdownLogs).toHaveLength(1);
  });

  test('destroy() with zero documents loaded (short-circuit path)', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
    });
    await server.ready;

    const startedAt = Date.now();
    await server.destroy();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2_000);

    const shutdownLogs = logCapture.getCalls('info', 'shutdown flushed');
    expect(shutdownLogs).toHaveLength(1);
    expect(shutdownLogs[0].payload.documentCount).toBe(5);
  });

  test('destroy() flushes multiple documents before resolving (multi-doc drain)', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      debounce: 60_000,
    });
    await server.ready;

    const conn1 = await server.hocuspocus.openDirectConnection('doc-a');
    const conn2 = await server.hocuspocus.openDirectConnection('doc-b');
    const conn3 = await server.hocuspocus.openDirectConnection('doc-c');

    await conn1.transact((doc) => {
      const frag = doc.getXmlFragment('default');
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText('content A')]);
      frag.insert(0, [p]);
    });
    await conn2.transact((doc) => {
      const frag = doc.getXmlFragment('default');
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText('content B')]);
      frag.insert(0, [p]);
    });
    await conn3.transact((doc) => {
      const frag = doc.getXmlFragment('default');
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText('content C')]);
      frag.insert(0, [p]);
    });

    for (const name of ['doc-a', 'doc-b', 'doc-c']) {
      const doc = server.hocuspocus.documents.get(name);
      expect(doc).toBeDefined();
      doc?.removeDirectConnection();
    }

    await server.destroy();

    expect(await readFile(join(tmpDir, 'doc-a.md'), 'utf-8')).toContain('content A');
    expect(await readFile(join(tmpDir, 'doc-b.md'), 'utf-8')).toContain('content B');
    expect(await readFile(join(tmpDir, 'doc-c.md'), 'utf-8')).toContain('content C');

    const shutdownLogs = logCapture.getCalls('info', 'shutdown flushed');
    expect(shutdownLogs).toHaveLength(1);
    expect(shutdownLogs[0].payload.documentCount).toBe(8);
  });
});

describe('createServer() degraded signal', () => {
  let testProjectDir: string;

  beforeEach(() => {
    testProjectDir = mkdtempSync(resolve(tmpdir(), 'ok-degraded-test-'));
  });

  afterEach(() => {
    rmSync(testProjectDir, { recursive: true, force: true });
  });

  test('clean init — degraded is empty array', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
    });

    await srv.ready;

    expect(Array.isArray(srv.degraded)).toBe(true);
    expect(srv.degraded).toEqual([]);

    await srv.destroy();
  });

  test('shadow-repo init failure — degraded includes "shadow-repo"', async () => {
    mkdirSync(resolve(testProjectDir, '.git'));
    writeFileSync(resolve(testProjectDir, '.git', 'ok'), 'I am a file, not a directory');

    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
    });

    await srv.ready;

    expect(srv.degraded).toContain('shadow-repo');
    expect(srv.degraded.filter((s) => s === 'shadow-repo')).toHaveLength(1);

    await srv.destroy();
  });

  test('degraded push wiring exists for all three subsystems', () => {
    const dir = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
    const src = readFileSync(resolve(dir, 'server-factory.ts'), 'utf-8');

    expect(src).toContain("degraded.push('shadow-repo')");
    expect(src).toContain("degraded.push('file-watcher')");
    expect(src).toContain("degraded.push('head-watcher')");

    expect(src).toMatch(/return\s*\{[^}]*degraded[^}]*\}/s);
  });

  test('degraded is readonly — push and reassignment are compile-time errors', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv: ServerInstance = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
    });

    // @ts-expect-error — readonly array: push is not allowed
    srv.degraded.push('test');

    // @ts-expect-error — readonly field: reassignment is not allowed
    srv.degraded = [];

    await srv.ready;
    await srv.destroy();
  });
});

describe('createServer() — config-doc admission (US-005)', () => {
  let testProjectDir: string;

  beforeEach(() => {
    testProjectDir = mkdtempSync(resolve(tmpdir(), 'ok-config-admission-test-'));
  });

  afterEach(() => {
    rmSync(testProjectDir, { recursive: true, force: true });
  });

  test('boot admits all three config docs alongside __system__', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
    });

    await srv.ready;

    expect(srv.hocuspocus.documents.has('__system__')).toBe(true);
    expect(srv.hocuspocus.documents.has('__config__/project')).toBe(true);
    expect(srv.hocuspocus.documents.has('__local__/project')).toBe(true);
    expect(srv.hocuspocus.documents.has('__user__/config.yml')).toBe(true);
    expect(srv.degraded.filter((s) => s.startsWith('config-doc:'))).toEqual([]);

    await srv.destroy();
  });

  test('Y.Text mutation on a config doc does NOT engage the markdown bridge (D41)', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
    });

    await srv.ready;

    const configDoc = srv.hocuspocus.documents.get('__config__/project');
    expect(configDoc).toBeDefined();
    if (!configDoc) return;

    const ytext = configDoc.getText('source');
    const xmlFragment = configDoc.getXmlFragment('default');
    expect(xmlFragment.length).toBe(0);

    configDoc.transact(() => {
      ytext.insert(0, 'theme: dark\n');
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(ytext.toString()).toBe('theme: dark\n');
    expect(xmlFragment.length).toBe(0);

    await srv.destroy();
  });

  test('connecting a transient client to a config doc succeeds via existing collab WS (D49)', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
    });

    await srv.ready;

    const conn = await srv.hocuspocus.openDirectConnection('__config__/project');
    try {
      const document = conn.document;
      expect(document).toBeDefined();
      const text = document.getText('source');
      expect(typeof text.toString()).toBe('string');
    } finally {
      await conn.disconnect();
    }

    await srv.destroy();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

describe('createServer() — config file watcher (US-007)', () => {
  let testProjectDir: string;
  let testHomedir: string;

  beforeEach(() => {
    testProjectDir = mkdtempSync(resolve(tmpdir(), 'ok-cfg-watcher-test-'));
    testHomedir = mkdtempSync(resolve(tmpdir(), 'ok-cfg-watcher-home-'));
  });

  afterEach(() => {
    rmSync(testProjectDir, { recursive: true, force: true });
    rmSync(testHomedir, { recursive: true, force: true });
  });

  test('external write to project config.yml propagates to Y.Text within 4s', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;

    const configDoc = srv.hocuspocus.documents.get('__config__/project');
    expect(configDoc).toBeDefined();
    if (!configDoc) {
      await srv.destroy();
      return;
    }
    const ytext = configDoc.getText('source');

    expect(ytext.toString()).toBe('');

    const configPath = join(testProjectDir, '.ok', 'config.yml');
    mkdirSync(join(testProjectDir, '.ok'), { recursive: true });
    const newContent = 'mcp:\n  autoStart: false\n';
    writeFileSync(configPath, newContent, 'utf-8');

    const fired = await waitFor(() => ytext.toString() === newContent);
    expect(fired).toBe(true);

    await srv.destroy();
  });

  test('external broken-YAML write keeps Y.Text at LKG and does not crash the server', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const configPath = join(testProjectDir, '.ok', 'config.yml');
    mkdirSync(join(testProjectDir, '.ok'), { recursive: true });
    const validContent = 'mcp:\n  autoStart: false\n';
    writeFileSync(configPath, validContent, 'utf-8');

    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;

    const configDoc = srv.hocuspocus.documents.get('__config__/project');
    expect(configDoc).toBeDefined();
    if (!configDoc) {
      await srv.destroy();
      return;
    }
    const ytext = configDoc.getText('source');

    expect(ytext.toString()).toBe(validContent);

    writeFileSync(configPath, 'mcp:\n  autoStart: !!!!!!!\n', 'utf-8');
    await new Promise((r) => setTimeout(r, 1_500));

    expect(ytext.toString()).toBe(validContent);

    await srv.destroy();
  });

  test('persistence-hook write does not produce a feedback-loop mutation (LKG-equality short-circuit)', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;

    const configDoc = srv.hocuspocus.documents.get('__config__/project');
    expect(configDoc).toBeDefined();
    if (!configDoc) {
      await srv.destroy();
      return;
    }
    const ytext = configDoc.getText('source');

    const newContent = 'mcp:\n  autoStart: false\n';
    configDoc.transact(() => {
      ytext.insert(0, newContent);
    });

    const configPath = join(testProjectDir, '.ok', 'config.yml');
    const fileLanded = await waitFor(
      () => existsSync(configPath) && readFileSync(configPath, 'utf-8') === newContent,
    );
    expect(fileLanded).toBe(true);

    const observedOrigins: unknown[] = [];
    configDoc.on('afterTransaction', (tx: { origin: unknown }) => {
      observedOrigins.push(tx.origin);
    });
    await new Promise((r) => setTimeout(r, 1_500));

    expect(ytext.toString()).toBe(newContent);

    const filewatcherOrigins = observedOrigins.filter(
      (o) =>
        o !== null &&
        typeof o === 'object' &&
        'context' in o &&
        typeof (o as { context: unknown }).context === 'object' &&
        (o as { context: { origin?: unknown } }).context.origin === 'config-file-watcher',
    );
    expect(filewatcherOrigins).toEqual([]);

    await srv.destroy();
  });
});

describe('createServer() — project-local file watcher → engine.setEnabled', () => {
  let testProjectDir: string;
  let testHomedir: string;

  beforeEach(() => {
    testProjectDir = mkdtempSync(resolve(tmpdir(), 'ok-pl-engine-test-'));
    testHomedir = mkdtempSync(resolve(tmpdir(), 'ok-pl-engine-home-'));
  });

  afterEach(() => {
    rmSync(testProjectDir, { recursive: true, force: true });
    rmSync(testHomedir, { recursive: true, force: true });
  });

  test('external write of autoSync.enabled: true to project-local flips engine state', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;

    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(false);

    const localDir = join(testProjectDir, '.ok', LOCAL_DIR);
    mkdirSync(localDir, { recursive: true });
    const configPath = join(localDir, 'config.yml');
    writeFileSync(configPath, 'autoSync:\n  enabled: true\n', 'utf-8');

    const flipped = await waitFor(() => srv.syncEngine?.getStatus().syncEnabled === true);
    expect(flipped).toBe(true);

    await srv.destroy();
  });

  test('toggling autoSync.enabled: false on disk disables the engine within 4s', async () => {
    mkdirSync(join(testProjectDir, '.ok', LOCAL_DIR), { recursive: true });
    writeFileSync(
      join(testProjectDir, '.ok', LOCAL_DIR, 'config.yml'),
      'autoSync:\n  enabled: true\n',
      'utf-8',
    );

    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;

    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(true);

    writeFileSync(
      join(testProjectDir, '.ok', LOCAL_DIR, 'config.yml'),
      'autoSync:\n  enabled: false\n',
      'utf-8',
    );

    const disabled = await waitFor(() => srv.syncEngine?.getStatus().syncEnabled === false);
    expect(disabled).toBe(true);

    await srv.destroy();
  });

  test('external write of committed autoSync.default: true flips engine state (unanswered machine)', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;

    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(false);

    mkdirSync(join(testProjectDir, '.ok'), { recursive: true });
    writeFileSync(
      join(testProjectDir, '.ok', 'config.yml'),
      'autoSync:\n  default: true\n',
      'utf-8',
    );

    const flipped = await waitFor(() => srv.syncEngine?.getStatus().syncEnabled === true);
    expect(flipped).toBe(true);

    await srv.destroy();
  });
});

describe('createServer() — okignore + gitignore multi-path watcher (US-005)', () => {
  let testProjectDir: string;

  beforeEach(() => {
    testProjectDir = mkdtempSync(resolve(tmpdir(), 'ok-okignore-watcher-test-'));
  });

  afterEach(() => {
    rmSync(testProjectDir, { recursive: true, force: true });
  });

  test('external write to .okignore propagates to __config__/okignore Y.Text + ContentFilter rebuilds', async () => {
    mkdirSync(join(testProjectDir, 'drafts'), { recursive: true });
    writeFileSync(join(testProjectDir, 'keep.md'), '# Keep\n', 'utf-8');
    writeFileSync(join(testProjectDir, 'drafts', 'foo.md'), '# Foo\n', 'utf-8');

    const srv = createServer({
      contentDir: testProjectDir,
      projectDir: testProjectDir,
      quiet: true,
    });
    await srv.ready;

    expect(srv.contentFilter.isExcluded('drafts/foo.md')).toBe(false);
    expect(srv.contentFilter.isExcluded('keep.md')).toBe(false);

    const okignoreDoc = srv.hocuspocus.documents.get('__config__/okignore');
    expect(okignoreDoc).toBeDefined();
    if (!okignoreDoc) {
      await srv.destroy();
      return;
    }
    const ytext = okignoreDoc.getText('source');
    expect(ytext.toString()).toBe('');

    const okignorePath = join(testProjectDir, '.okignore');
    const newContent = 'drafts/\n';
    writeFileSync(okignorePath, newContent, 'utf-8');

    const ytextSynced = await waitFor(() => ytext.toString() === newContent);
    expect(ytextSynced).toBe(true);

    const filterUpdated = await waitFor(() => srv.contentFilter.isExcluded('drafts/foo.md'));
    expect(filterUpdated).toBe(true);
    expect(srv.contentFilter.isExcluded('keep.md')).toBe(false);

    await srv.destroy();
  });

  test('external write to .gitignore triggers ContentFilter rebuild WITHOUT mutating __config__/okignore Y.Text', async () => {
    mkdirSync(join(testProjectDir, 'logs'), { recursive: true });
    writeFileSync(join(testProjectDir, 'index.md'), '# Index\n', 'utf-8');
    writeFileSync(join(testProjectDir, 'logs', 'debug.md'), '# Debug\n', 'utf-8');

    const srv = createServer({
      contentDir: testProjectDir,
      projectDir: testProjectDir,
      quiet: true,
    });
    await srv.ready;

    expect(srv.contentFilter.isExcluded('logs/debug.md')).toBe(false);

    const okignoreDoc = srv.hocuspocus.documents.get('__config__/okignore');
    if (!okignoreDoc) {
      await srv.destroy();
      return;
    }
    const ytext = okignoreDoc.getText('source');
    expect(ytext.toString()).toBe('');

    const gitignorePath = join(testProjectDir, '.gitignore');
    writeFileSync(gitignorePath, 'logs/\n', 'utf-8');

    const filterUpdated = await waitFor(() => srv.contentFilter.isExcluded('logs/debug.md'));
    expect(filterUpdated).toBe(true);
    expect(srv.contentFilter.isExcluded('index.md')).toBe(false);
    expect(ytext.toString()).toBe('');

    await srv.destroy();
  });

  test('persistence-hook write of __config__/okignore Y.Text ends in atomic .okignore on disk + ContentFilter visibility change', async () => {
    writeFileSync(join(testProjectDir, 'visible.md'), '# Visible\n', 'utf-8');
    mkdirSync(join(testProjectDir, 'tmp'), { recursive: true });
    writeFileSync(join(testProjectDir, 'tmp', 'cache.md'), '# Cache\n', 'utf-8');

    const srv = createServer({
      contentDir: testProjectDir,
      projectDir: testProjectDir,
      quiet: true,
    });
    await srv.ready;

    expect(srv.contentFilter.isExcluded('tmp/cache.md')).toBe(false);

    const okignoreDoc = srv.hocuspocus.documents.get('__config__/okignore');
    if (!okignoreDoc) {
      await srv.destroy();
      return;
    }
    const ytext = okignoreDoc.getText('source');

    const newContent = 'tmp/\n';
    okignoreDoc.transact(() => {
      ytext.insert(0, newContent);
    });

    const okignorePath = join(testProjectDir, '.okignore');
    const fileLanded = await waitFor(
      () => existsSync(okignorePath) && readFileSync(okignorePath, 'utf-8') === newContent,
    );
    expect(fileLanded).toBe(true);

    const filterUpdated = await waitFor(() => srv.contentFilter.isExcluded('tmp/cache.md'));
    expect(filterUpdated).toBe(true);
    expect(srv.contentFilter.isExcluded('visible.md')).toBe(false);

    await srv.destroy();
  });

  test('Y.Text mirror throw does NOT block ContentFilter rebuild', async () => {
    mkdirSync(join(testProjectDir, 'drafts'), { recursive: true });
    writeFileSync(join(testProjectDir, 'keep.md'), '# Keep\n', 'utf-8');
    writeFileSync(join(testProjectDir, 'drafts', 'foo.md'), '# Foo\n', 'utf-8');

    const logCapture = captureAllLoggers();
    const srv = createServer({
      contentDir: testProjectDir,
      projectDir: testProjectDir,
      quiet: true,
    });
    try {
      await srv.ready;
      expect(srv.contentFilter.isExcluded('drafts/foo.md')).toBe(false);

      const okignoreDoc = srv.hocuspocus.documents.get('__config__/okignore');
      expect(okignoreDoc).toBeDefined();
      if (!okignoreDoc) return;

      const origTransact = okignoreDoc.transact.bind(okignoreDoc);
      Object.defineProperty(okignoreDoc, 'transact', {
        value: () => {
          throw new Error('test-injected: simulated Y.Doc transact failure');
        },
        writable: true,
        configurable: true,
      });

      try {
        const okignorePath = join(testProjectDir, '.okignore');
        writeFileSync(okignorePath, 'drafts/\n', 'utf-8');

        const filterUpdated = await waitFor(() => srv.contentFilter.isExcluded('drafts/foo.md'));
        expect(filterUpdated).toBe(true);
        expect(srv.contentFilter.isExcluded('keep.md')).toBe(false);

        const errorEntries = logCapture.getCalls('error', 'applyExternalConfigChange failed');
        expect(errorEntries.length).toBeGreaterThanOrEqual(1);
      } finally {
        Object.defineProperty(okignoreDoc, 'transact', {
          value: origTransact,
          writable: true,
          configurable: true,
        });
      }
    } finally {
      loggerFactory.reset();
      await srv.destroy();
    }
  });
});

describe('createServer() managed rename recovery', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-managed-rename-recovery-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('replays a pending managed rename journal before watcher startup', async () => {
    writeFileSync(join(tmpDir, 'beta.md'), '# Alpha\n', 'utf-8');
    writeFileSync(join(tmpDir, 'referrer.md'), 'See [[beta]].\n', 'utf-8');
    writeManagedRenameJournal(
      tmpDir,
      createManagedRenameRecoveryJournal({
        fromPath: 'alpha',
        toPath: 'beta',
        affectedDocs: [{ from: 'alpha', to: 'beta' }],
        snapshots: [
          { docName: 'alpha', content: '# Alpha\n' },
          { docName: 'referrer', content: 'See [[alpha]].\n' },
        ],
      }),
    );

    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
    });
    await server.ready;

    expect(readFileSync(join(tmpDir, 'alpha.md'), 'utf-8')).toBe('# Alpha\n');
    expect(readFileSync(join(tmpDir, 'referrer.md'), 'utf-8')).toBe('See [[alpha]].\n');
    expect(existsSync(join(tmpDir, 'beta.md'))).toBe(false);
    expect(existsSync(managedRenameJournalPath(tmpDir))).toBe(false);

    await server.destroy();
  });

  test('marks the server degraded when the managed rename journal is corrupt', async () => {
    mkdirSync(join(tmpDir, '.ok', LOCAL_DIR), { recursive: true });
    writeFileSync(managedRenameJournalPath(tmpDir), '{not valid json', 'utf-8');

    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
    });
    await server.ready;

    expect(server.degraded).toContain('managed-rename-recovery');

    await server.destroy();
  });
});

describe('createServer() server-lock integration (V0-1)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-server-lock-int-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('acquires server.lock at createServer(), releases on destroy()', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
    });
    await server.ready;

    const lockPath = join(tmpDir, '.ok', LOCAL_DIR, 'server.lock');
    expect(existsSync(lockPath)).toBe(true);
    const md = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.pid).toBe(process.pid);
    expect(md.worktreeRoot).toBe(tmpDir);

    await server.destroy();

    expect(existsSync(lockPath)).toBe(false);
  });

  test('exposes lockDir on ServerInstance', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
    });
    await server.ready;

    expect(server.lockDir).toBe(join(tmpDir, '.ok', LOCAL_DIR));

    await server.destroy();
  });

  test('second createServer() on same contentDir rejects with collision error', async () => {
    const first = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
    });
    await first.ready;

    const { hostname } = await import('node:os');
    const foreignPid = process.ppid > 1 ? process.ppid : process.pid + 1;
    const lockPath = join(tmpDir, '.ok', LOCAL_DIR, 'server.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: foreignPid,
        hostname: hostname(),
        port: 9999,
        startedAt: new Date().toISOString(),
        worktreeRoot: tmpDir,
      }),
      'utf-8',
    );

    expect(() => createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true })).toThrow(
      /already running on port 9999/,
    );

    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        port: 0,
        startedAt: new Date().toISOString(),
        worktreeRoot: tmpDir,
      }),
      'utf-8',
    );

    await first.destroy();
  });

  test('updateServerLockPort through createServer().lockDir updates on-disk port', async () => {
    const { updateServerLockPort, readServerLock } = await import('./server-lock.ts');
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
    });
    await server.ready;

    const lockPath = join(tmpDir, '.ok', LOCAL_DIR, 'server.lock');
    const before = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(before.port).toBe(0);

    updateServerLockPort(server.lockDir, 5173);

    const after = readServerLock(server.lockDir);
    expect(after).not.toBeNull();
    expect(after?.port).toBe(5173);
    expect(after?.pid).toBe(process.pid);

    await server.destroy();
  });

  test('destroy() releases server.lock even when a shutdown phase throws (CC8)', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
    });
    await server.ready;

    const lockPath = join(tmpDir, '.ok', LOCAL_DIR, 'server.lock');
    expect(existsSync(lockPath)).toBe(true);

    const origCloseAll = server.sessionManager.closeAll.bind(server.sessionManager);
    server.sessionManager.closeAll = async () => {
      await origCloseAll();
      throw new Error('Injected Phase 2 failure');
    };

    await server.destroy();
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('createServer() — serverInstanceId', () => {
  let tmpDirA: string;
  let tmpDirB: string;

  beforeEach(async () => {
    tmpDirA = await mkdtemp(join(tmpdir(), 'ok-iid-a-'));
    tmpDirB = await mkdtemp(join(tmpdir(), 'ok-iid-b-'));
  });

  afterEach(async () => {
    await rm(tmpDirA, { recursive: true, force: true });
    await rm(tmpDirB, { recursive: true, force: true });
  });

  test('each createServer() call produces a distinct serverInstanceId (UUID)', async () => {
    const serverA = createServer({ contentDir: tmpDirA, projectDir: tmpDirA, quiet: true });
    const serverB = createServer({ contentDir: tmpDirB, projectDir: tmpDirB, quiet: true });
    try {
      await serverA.ready;
      await serverB.ready;

      expect(typeof serverA.serverInstanceId).toBe('string');
      expect(serverA.serverInstanceId.length).toBeGreaterThan(0);
      expect(typeof serverB.serverInstanceId).toBe('string');
      expect(serverB.serverInstanceId.length).toBeGreaterThan(0);

      expect(serverA.serverInstanceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(serverB.serverInstanceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      expect(serverA.serverInstanceId).not.toBe(serverB.serverInstanceId);
    } finally {
      await serverA.destroy();
      await serverB.destroy();
    }
  });
});

describe("createServer() — onAuthenticate rejects 'server-instance-mismatch'", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-auth-mismatch-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function getAuthExtension(server: Awaited<ReturnType<typeof createServer>>): {
    onAuthenticate: (payload: unknown) => Promise<void>;
  } {
    const ext = server.hocuspocus.configuration.extensions.find(
      (e) => (e as { __kind?: string }).__kind === 'principal-auth',
    ) as { onAuthenticate: (payload: unknown) => Promise<void> } | undefined;
    if (!ext) throw new Error('expected principalAuthExtension on hocuspocus.configuration');
    return ext;
  }

  test('token claiming a mismatched expectedServerInstanceId is rejected', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const authExt = getAuthExtension(server);

      const staleToken = JSON.stringify({
        principalId: 'p-1',
        tabSessionId: 's-1',
        expectedServerInstanceId: 'stale-server-id-from-prior-process',
      });
      const context: Record<string, unknown> = {};

      let thrown: unknown = null;
      try {
        await authExt.onAuthenticate({
          token: staleToken,
          context,
          documentName: 'test-doc',
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).not.toBeNull();
      expect((thrown as { reason?: string }).reason).toBe('server-instance-mismatch');
      expect(context.principalId).toBeUndefined();
      expect(context.kind).toBeUndefined();
    } finally {
      await server.destroy();
    }
  });

  test('token claiming the matching serverInstanceId is accepted', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const authExt = getAuthExtension(server);

      const goodToken = JSON.stringify({
        principalId: 'p-1',
        tabSessionId: 's-1',
        expectedServerInstanceId: server.serverInstanceId,
      });
      const context: Record<string, unknown> = {};

      await authExt.onAuthenticate({
        token: goodToken,
        context,
        documentName: 'test-doc',
      });

      expect(context.kind).toBe('human');
      expect(context.tabSessionId).toBe('s-1');
    } finally {
      await server.destroy();
    }
  });

  test('legacy token without expectedServerInstanceId is accepted (backward compat)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const authExt = getAuthExtension(server);

      const legacyToken = JSON.stringify({
        principalId: 'p-1',
        tabSessionId: 's-1',
      });
      const context: Record<string, unknown> = {};

      await authExt.onAuthenticate({
        token: legacyToken,
        context,
        documentName: 'test-doc',
      });

      expect(context.kind).toBe('human');
      expect(context.tabSessionId).toBe('s-1');
    } finally {
      await server.destroy();
    }
  });

  test('missing token is accepted (anonymous legacy path)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const authExt = getAuthExtension(server);
      const context: Record<string, unknown> = {};

      await authExt.onAuthenticate({
        token: undefined,
        context,
        documentName: 'test-doc',
      });

      expect(context.principalId).toBeUndefined();
      expect(context.kind).toBeUndefined();
    } finally {
      await server.destroy();
    }
  });

  test('empty-string expectedServerInstanceId claim is treated as absent (not rejected)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const authExt = getAuthExtension(server);

      const emptyClaimToken = JSON.stringify({
        principalId: 'p-1',
        tabSessionId: 's-1',
        expectedServerInstanceId: '',
      });
      const context: Record<string, unknown> = {};

      await authExt.onAuthenticate({
        token: emptyClaimToken,
        context,
        documentName: 'test-doc',
      });

      expect(context.kind).toBe('human');
    } finally {
      await server.destroy();
    }
  });
});

describe("createServer() — onAuthenticate rejects 'branch-mismatch'", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-auth-branch-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function getAuthExtension(server: Awaited<ReturnType<typeof createServer>>): {
    onAuthenticate: (payload: unknown) => Promise<void>;
  } {
    const ext = server.hocuspocus.configuration.extensions.find(
      (e) => (e as { __kind?: string }).__kind === 'principal-auth',
    ) as { onAuthenticate: (payload: unknown) => Promise<void> } | undefined;
    if (!ext) throw new Error('expected principalAuthExtension on hocuspocus.configuration');
    return ext;
  }

  test('token claiming a mismatched expectedBranch is rejected', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const authExt = getAuthExtension(server);
      const staleToken = JSON.stringify({
        principalId: 'p-1',
        tabSessionId: 's-1',
        expectedBranch: 'feature',
      });
      const context: Record<string, unknown> = {};

      let thrown: unknown = null;
      try {
        await authExt.onAuthenticate({
          token: staleToken,
          context,
          documentName: 'test-doc',
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).not.toBeNull();
      expect((thrown as { reason?: string }).reason).toBe('branch-mismatch');
      expect(context.principalId).toBeUndefined();
    } finally {
      await server.destroy();
    }
  });

  test('token claiming the matching branch is accepted', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const authExt = getAuthExtension(server);

      const goodToken = JSON.stringify({
        principalId: 'p-1',
        tabSessionId: 's-1',
        expectedBranch: 'main', // server default
      });
      const context: Record<string, unknown> = {};

      await authExt.onAuthenticate({
        token: goodToken,
        context,
        documentName: 'test-doc',
      });

      expect(context.kind).toBe('human');
      expect(context.tabSessionId).toBe('s-1');
    } finally {
      await server.destroy();
    }
  });

  test('empty-string expectedBranch is treated as absent (legacy path)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const authExt = getAuthExtension(server);

      const emptyClaimToken = JSON.stringify({
        principalId: 'p-1',
        tabSessionId: 's-1',
        expectedBranch: '',
      });
      const context: Record<string, unknown> = {};

      await authExt.onAuthenticate({
        token: emptyClaimToken,
        context,
        documentName: 'test-doc',
      });

      expect(context.kind).toBe('human');
    } finally {
      await server.destroy();
    }
  });

  test('legacy token without expectedBranch is accepted', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const authExt = getAuthExtension(server);

      const legacyToken = JSON.stringify({
        principalId: 'p-1',
        tabSessionId: 's-1',
      });
      const context: Record<string, unknown> = {};

      await authExt.onAuthenticate({
        token: legacyToken,
        context,
        documentName: 'test-doc',
      });

      expect(context.kind).toBe('human');
    } finally {
      await server.destroy();
    }
  });
});

describe('createServer() — config-doc admission guard', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-config-admission-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function getConfigDocAdmissionGuard(server: Awaited<ReturnType<typeof createServer>>): {
    onAuthenticate: (payload: unknown) => Promise<void>;
  } {
    const ext = server.hocuspocus.configuration.extensions.find(
      (e) => (e as { __kind?: string }).__kind === 'config-doc-admission-guard',
    ) as { onAuthenticate: (payload: unknown) => Promise<void> } | undefined;
    if (!ext) throw new Error('expected configDocAdmissionGuard on hocuspocus.configuration');
    return ext;
  }

  function makePayload(opts: {
    documentName: string;
    peer?: string;
    host?: string | null;
  }): unknown {
    const headers: Record<string, string> = {};
    if (opts.host !== null && opts.host !== undefined) headers.host = opts.host;
    return {
      token: undefined,
      documentName: opts.documentName,
      context: {} as Record<string, unknown>,
      request: {
        socket: opts.peer === undefined ? undefined : { remoteAddress: opts.peer },
        headers,
      },
      requestHeaders: new Headers(opts.host ? { host: opts.host } : {}),
    };
  }

  test('non-config doc bypasses the gate (no peer, no host)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const guard = getConfigDocAdmissionGuard(server);
      await guard.onAuthenticate(
        makePayload({ documentName: 'some-user-doc', peer: undefined, host: null }),
      );
    } finally {
      await server.destroy();
    }
  });

  test('config doc accepts loopback IPv4 peer + localhost Host', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const guard = getConfigDocAdmissionGuard(server);
      await guard.onAuthenticate(
        makePayload({
          documentName: '__config__/project',
          peer: '127.0.0.1',
          host: 'localhost:5173',
        }),
      );
    } finally {
      await server.destroy();
    }
  });

  test('config doc accepts IPv6 loopback peer + bracketed Host', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const guard = getConfigDocAdmissionGuard(server);
      await guard.onAuthenticate(
        makePayload({ documentName: '__user__/config.yml', peer: '::1', host: '[::1]:5173' }),
      );
    } finally {
      await server.destroy();
    }
  });

  test('config doc rejects non-loopback peer (LAN)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const guard = getConfigDocAdmissionGuard(server);
      let thrown: unknown = null;
      try {
        await guard.onAuthenticate(
          makePayload({
            documentName: '__config__/project',
            peer: '192.168.1.5',
            host: 'localhost:5173',
          }),
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).not.toBeNull();
      expect((thrown as Error).message).toContain('loopback peer');
    } finally {
      await server.destroy();
    }
  });

  test('config doc rejects IPv4-mapped non-loopback peer', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const guard = getConfigDocAdmissionGuard(server);
      let thrown: unknown = null;
      try {
        await guard.onAuthenticate(
          makePayload({
            documentName: '__user__/config.yml',
            peer: '::ffff:192.168.1.5',
            host: 'localhost',
          }),
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).not.toBeNull();
      expect((thrown as Error).message).toContain('loopback peer');
    } finally {
      await server.destroy();
    }
  });

  test('config doc rejects loopback peer with attacker-domain Host (DNS rebinding)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const guard = getConfigDocAdmissionGuard(server);
      let thrown: unknown = null;
      try {
        await guard.onAuthenticate(
          makePayload({
            documentName: '__config__/project',
            peer: '127.0.0.1',
            host: 'attacker.example.com',
          }),
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).not.toBeNull();
      expect((thrown as Error).message).toContain('loopback Host header');
    } finally {
      await server.destroy();
    }
  });

  test('config doc rejects missing Host header (no fallback to permissive accept)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const guard = getConfigDocAdmissionGuard(server);
      let thrown: unknown = null;
      try {
        await guard.onAuthenticate(
          makePayload({ documentName: '__config__/project', peer: '127.0.0.1', host: null }),
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).not.toBeNull();
      expect((thrown as Error).message).toContain('loopback Host header');
    } finally {
      await server.destroy();
    }
  });

  test('config doc accepts undefined peer when Host is loopback (test harness shape)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const guard = getConfigDocAdmissionGuard(server);
      await guard.onAuthenticate(
        makePayload({ documentName: '__config__/project', peer: undefined, host: 'localhost' }),
      );
    } finally {
      await server.destroy();
    }
  });

  test('config doc rejects attacker Host when peer is undefined (DNS rebinding with no socket)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const guard = getConfigDocAdmissionGuard(server);
      let thrown: unknown = null;
      try {
        await guard.onAuthenticate(
          makePayload({
            documentName: '__config__/project',
            peer: undefined,
            host: 'attacker.example.com',
          }),
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).not.toBeNull();
      expect((thrown as Error).message).toContain('loopback Host header');
    } finally {
      await server.destroy();
    }
  });

  test('config doc accepts loopback Host via req.headers fallback when requestHeaders absent', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const guard = getConfigDocAdmissionGuard(server);
      await guard.onAuthenticate({
        token: undefined,
        documentName: '__config__/project',
        context: {},
        request: {
          socket: { remoteAddress: '127.0.0.1' },
          headers: { host: 'localhost:5173' },
        },
      } as unknown as Parameters<typeof guard.onAuthenticate>[0]);
    } finally {
      await server.destroy();
    }
  });
});

describe('createServer() — readProjectAutoSyncEnabled precedence', () => {
  let testProjectDir: string;
  let testHomedir: string;

  beforeEach(() => {
    testProjectDir = mkdtempSync(resolve(tmpdir(), 'ok-autosync-read-test-'));
    testHomedir = mkdtempSync(resolve(tmpdir(), 'ok-autosync-read-home-'));
  });

  afterEach(() => {
    rmSync(testProjectDir, { recursive: true, force: true });
    rmSync(testHomedir, { recursive: true, force: true });
  });

  function seedProjectLocalConfig(content: string): void {
    mkdirSync(join(testProjectDir, '.ok', LOCAL_DIR), { recursive: true });
    writeFileSync(join(testProjectDir, '.ok', LOCAL_DIR, 'config.yml'), content, 'utf-8');
  }

  function seedProjectConfig(content: string): void {
    mkdirSync(join(testProjectDir, '.ok'), { recursive: true });
    writeFileSync(join(testProjectDir, '.ok', 'config.yml'), content, 'utf-8');
  }

  test('project-local autoSync.enabled: true → engine boots enabled', async () => {
    seedProjectLocalConfig('autoSync:\n  enabled: true\n');
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(true);
    await srv.destroy();
  });

  test('project-local absent + committed autoSync.default: true → engine boots enabled', async () => {
    seedProjectConfig('autoSync:\n  default: true\n');
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(true);
    await srv.destroy();
  });

  test('project-local absent + committed autoSync.default: false → engine boots disabled', async () => {
    seedProjectConfig('autoSync:\n  default: false\n');
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(false);
    await srv.destroy();
  });

  test('committed autoSync.enabled is ignored (scope-mismatched) → engine boots disabled', async () => {
    seedProjectConfig('autoSync:\n  enabled: true\n');
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(false);
    await srv.destroy();
  });

  test('both absent → engine boots disabled (default)', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(false);
    await srv.destroy();
  });

  test('project-local enabled: false beats committed default: true (machine override wins)', async () => {
    seedProjectLocalConfig('autoSync:\n  enabled: false\n');
    seedProjectConfig('autoSync:\n  default: true\n');
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(false);
    await srv.destroy();
  });

  test('project-local enabled: true beats committed default: false (machine override wins)', async () => {
    seedProjectLocalConfig('autoSync:\n  enabled: true\n');
    seedProjectConfig('autoSync:\n  default: false\n');
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(true);
    await srv.destroy();
  });

  test('project-local autoSync.enabled: null falls through to committed default: true', async () => {
    seedProjectLocalConfig('autoSync:\n  enabled: null\n');
    seedProjectConfig('autoSync:\n  default: true\n');
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(true);
    await srv.destroy();
  });

  test('invalid project-local YAML falls through to committed default (degraded path)', async () => {
    seedProjectLocalConfig('autoSync:\n  enabled: : not-yaml [[[\n');
    seedProjectConfig('autoSync:\n  default: true\n');
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(true);
    await srv.destroy();
  });

  test('invalid committed config defaults to disabled (degraded path)', async () => {
    seedProjectConfig('autoSync:\n  default: : not-yaml [[[\n');
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(false);
    await srv.destroy();
  });
});

describe('createServer() — onAutoDisable scope pinning', () => {
  test('onAutoDisable callback writes via scope: project-local', () => {
    const dir = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
    const src = readFileSync(resolve(dir, 'server-factory.ts'), 'utf-8');
    const onAutoDisableMatch = src.match(
      /onAutoDisable:\s*async\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\n\s{8}\},/,
    );
    expect(onAutoDisableMatch).not.toBeNull();
    const body = onAutoDisableMatch?.[0] ?? '';
    expect(body).toContain("scope: 'project-local'");
    expect(body).toContain('autoSync: { enabled: false }');
    expect(body).not.toMatch(/scope:\s*'project'(?!-local)/);
  });
});
describe('createServer() — phantom-doc unload', () => {
  let phantomTmpDir: string;

  beforeEach(async () => {
    phantomTmpDir = await mkdtemp(join(tmpdir(), 'ok-phantom-unload-'));
  });

  afterEach(async () => {
    await rm(phantomTmpDir, { recursive: true, force: true });
  });

  async function waitForUnload(
    server: ServerInstance,
    docName: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!server.hocuspocus.documents.has(docName)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return !server.hocuspocus.documents.has(docName);
  }

  test('phantom doc (no on-disk file, no content) unloads after last disconnect', async () => {
    const server = createServer({
      contentDir: phantomTmpDir,
      projectDir: phantomTmpDir,
      quiet: true,
      debounce: 50,
      maxDebounce: 100,
    });
    try {
      await server.ready;

      const docName = 'never-on-disk';
      const conn = await server.hocuspocus.openDirectConnection(docName);
      expect(server.hocuspocus.documents.has(docName)).toBe(true);
      await conn.disconnect();

      const unloaded = await waitForUnload(server, docName, 2_000);
      expect(unloaded).toBe(true);
    } finally {
      await server.destroy();
    }
  });

  test('file-backed doc stays resident after disconnect', async () => {
    const docName = 'on-disk';
    writeFileSync(join(phantomTmpDir, `${docName}.md`), '# hello\n', 'utf-8');

    const server = createServer({
      contentDir: phantomTmpDir,
      projectDir: phantomTmpDir,
      quiet: true,
      debounce: 50,
      maxDebounce: 100,
    });
    try {
      await server.ready;

      const conn = await server.hocuspocus.openDirectConnection(docName);
      expect(server.hocuspocus.documents.has(docName)).toBe(true);
      await conn.disconnect();

      const controlName = 'phantom-control';
      const controlConn = await server.hocuspocus.openDirectConnection(controlName);
      await controlConn.disconnect();
      const controlUnloaded = await waitForUnload(server, controlName, 2_000);
      expect(controlUnloaded).toBe(true);

      expect(server.hocuspocus.documents.has(docName)).toBe(true);
    } finally {
      await server.destroy();
    }
  }, 15_000);

  test('transient doc with CRDT content but no disk file stays resident', async () => {
    const server = createServer({
      contentDir: phantomTmpDir,
      projectDir: phantomTmpDir,
      quiet: true,
      debounce: 60_000,
      maxDebounce: 60_000,
    });
    try {
      await server.ready;

      const docName = 'transient-with-content';
      const conn = await server.hocuspocus.openDirectConnection(docName);
      await conn.transact((doc) => {
        const fragment = doc.getXmlFragment('default');
        const paragraph = new Y.XmlElement('paragraph');
        paragraph.insert(0, [new Y.XmlText('user-typed-content')]);
        fragment.insert(0, [paragraph]);
      });
      await conn.disconnect();

      await new Promise((r) => setTimeout(r, 200));
      expect(server.hocuspocus.documents.has(docName)).toBe(true);
    } finally {
      await server.destroy();
    }
  });
});

describe('createServer() — shouldUnloadDocument forceUnloadSet branched guard', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-shouldunload-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('force-unload via delete-path unloads document despite live in-process connection and non-empty content', async () => {
    const docName = 'force-unload-target';
    writeFileSync(join(tmpDir, `${docName}.md`), '# initial-content\n', 'utf-8');

    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
    });

    let localHttp: import('node:http').Server | undefined;
    try {
      await server.ready;

      const conn = await server.hocuspocus.openDirectConnection(docName);
      expect(server.hocuspocus.documents.has(docName)).toBe(true);

      await conn.transact((doc) => {
        const ytext = doc.getText('source');
        ytext.insert(0, 'pending-bytes');
      });
      const doc = server.hocuspocus.documents.get(docName);
      if (!doc) throw new Error('document missing after transact');
      expect(doc.getText('source').toString().length).toBeGreaterThan(0);

      const apiExt = server.hocuspocus.configuration.extensions.find(
        (e: unknown) =>
          typeof (e as { onRequest?: unknown }).onRequest === 'function' &&
          (e as { priority?: number }).priority === 100,
      ) as
        | {
            onRequest: (ctx: {
              request: import('node:http').IncomingMessage;
              response: import('node:http').ServerResponse;
            }) => Promise<void>;
          }
        | undefined;
      if (!apiExt) throw new Error('api-extension not found in extensions array');

      const { createServer: createNodeHttp } = await import('node:http');
      localHttp = createNodeHttp((req, res) => {
        void apiExt.onRequest({ request: req, response: res });
      });
      await new Promise<void>((resolve) => localHttp?.listen(0, '127.0.0.1', resolve));
      const address = localHttp.address();
      if (typeof address !== 'object' || address === null) {
        throw new Error('local HTTP server did not bind to a port');
      }
      const baseURL = `http://127.0.0.1:${address.port}`;

      const res = await fetch(`${baseURL}/api/delete-path`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'file', path: docName }),
      });
      expect(res.status).toBe(200);

      expect(server.hocuspocus.documents.has(docName)).toBe(false);
    } finally {
      if (localHttp) {
        await new Promise<void>((resolve, reject) =>
          localHttp?.close((err) => (err ? reject(err) : resolve())),
        );
      }
      await server.destroy();
    }
  });
});

describe('createServer() — removalRedirectGuard registration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-removal-redirect-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('extension is registered with __kind: removal-redirect-guard', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const ext = server.hocuspocus.configuration.extensions.find(
        (e) => (e as { __kind?: string }).__kind === 'removal-redirect-guard',
      ) as { onAuthenticate?: (payload: unknown) => Promise<void> } | undefined;
      expect(ext).toBeDefined();
      expect(typeof ext?.onAuthenticate).toBe('function');
    } finally {
      await server.destroy();
    }
  });

  test('extension order: after configDocAdmissionGuard, before apiExtension', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const exts = server.hocuspocus.configuration.extensions;
      const idx = (kind: string): number =>
        exts.findIndex((e) => (e as { __kind?: string }).__kind === kind);
      const principal = idx('principal-auth');
      const configGuard = idx('config-doc-admission-guard');
      const removal = idx('removal-redirect-guard');
      expect(principal).toBeGreaterThan(-1);
      expect(configGuard).toBeGreaterThan(principal);
      expect(removal).toBeGreaterThan(configGuard);
    } finally {
      await server.destroy();
    }
  });

  test('onAuthenticate admits a fresh docName (no file, no cache state)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const ext = server.hocuspocus.configuration.extensions.find(
        (e) => (e as { __kind?: string }).__kind === 'removal-redirect-guard',
      ) as { onAuthenticate: (payload: unknown) => Promise<void> } | undefined;
      if (!ext) throw new Error('removal-redirect-guard not registered');
      let thrown: unknown = null;
      try {
        await ext.onAuthenticate({
          token: undefined,
          context: {},
          documentName: 'fresh-doc',
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeNull();
    } finally {
      await server.destroy();
    }
  });

  test('onAuthenticate is a no-op for system docs (cache lookup never happens)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const ext = server.hocuspocus.configuration.extensions.find(
        (e) => (e as { __kind?: string }).__kind === 'removal-redirect-guard',
      ) as { onAuthenticate: (payload: unknown) => Promise<void> } | undefined;
      if (!ext) throw new Error('removal-redirect-guard not registered');
      let thrown: unknown = null;
      try {
        await ext.onAuthenticate({
          token: undefined,
          context: {},
          documentName: '__system__',
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeNull();
    } finally {
      await server.destroy();
    }
  });
});

describe('createServer() — push-permission auth wiring', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-auth-wiring-'));
    const git = simpleGit(tmpDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');
    writeFileSync(join(tmpDir, 'README.md'), 'seed\n', 'utf-8');
    await git.add('.');
    await git.commit('seed');
    await git.addRemote('origin', 'https://github.com/inkeep/open-knowledge.git');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('forwards detectGh + tokenStore through createServer → SyncEngine → probe call', async () => {
    const detectGhStub: DetectGhFn = (host?: string) => ({
      available: true,
      token: `stub-token-for-${host ?? 'github.com'}`,
    });
    const tokenStoreStub: ProbeTokenStore = {
      async get(host: string) {
        return { token: `store-token-for-${host}` };
      },
    };

    const probeCalls: CheckPushPermissionOptions[] = [];
    const probeSpy = async (opts: CheckPushPermissionOptions): Promise<PushPermission> => {
      probeCalls.push(opts);
      return { kind: 'allowed' };
    };

    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      debounce: 60_000,
      destroyTimeoutMs: 1_000,
      detectGh: detectGhStub,
      tokenStore: tokenStoreStub,
      checkPushPermissionFn: probeSpy,
    });

    try {
      await server.ready;
      expect(server.syncEngine).not.toBeNull();

      await server.syncEngine?.refreshPushPermission();

      expect(probeCalls.length).toBeGreaterThan(0);
      const firstCall = probeCalls[0];
      expect(firstCall.detectGh).toBe(detectGhStub);
      expect(firstCall.tokenStore).toBe(tokenStoreStub);
      expect(firstCall.owner).toBe('inkeep');
      expect(firstCall.repo).toBe('open-knowledge');
    } finally {
      await server.destroy();
    }
  });

  test('omitting detectGh + tokenStore leaves the probe call with undefined seams (no silent default substitution)', async () => {
    const probeCalls: CheckPushPermissionOptions[] = [];
    const probeSpy = async (opts: CheckPushPermissionOptions): Promise<PushPermission> => {
      probeCalls.push(opts);
      return { kind: 'allowed' };
    };

    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      debounce: 60_000,
      destroyTimeoutMs: 1_000,
      checkPushPermissionFn: probeSpy,
    });

    try {
      await server.ready;
      await server.syncEngine?.refreshPushPermission();
      expect(probeCalls.length).toBeGreaterThan(0);
      expect(probeCalls[0].detectGh).toBeUndefined();
      expect(probeCalls[0].tokenStore).toBeUndefined();
    } finally {
      await server.destroy();
    }
  });
});

describe('buildSyncCredentialArgs()', () => {
  const argvFromHelper = (args: string[]): unknown[] => {
    expect(args[0]).toBe('-c');
    const prefix = 'credential.helper=!';
    expect(args[1].startsWith(prefix)).toBe(true);
    const suffix = ' auth git-credential';
    expect(args[1].endsWith(suffix)).toBe(true);
    const shellCmd = args[1].slice(prefix.length);
    return shellQuote.parse(shellCmd);
  };

  test('packaged macOS bundle path survives the shell as one intact token', () => {
    const bundlePath = '/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh';
    const args = buildSyncCredentialArgs([bundlePath]);
    expect(argvFromHelper(args)).toEqual([bundlePath, 'auth', 'git-credential']);
  });

  test('bare command (dev default) stays unquoted', () => {
    const args = buildSyncCredentialArgs(['open-knowledge']);
    expect(args).toEqual(['-c', 'credential.helper=!open-knowledge auth git-credential']);
    expect(argvFromHelper(args)).toEqual(['open-knowledge', 'auth', 'git-credential']);
  });

  test('undefined / empty argv falls back to the bare CLI name', () => {
    const expected = ['-c', 'credential.helper=!open-knowledge auth git-credential'];
    expect(buildSyncCredentialArgs(undefined)).toEqual(expected);
    expect(buildSyncCredentialArgs([])).toEqual(expected);
  });

  test('multi-element argv escapes each element independently', () => {
    const argv = ['/Users/me/Library/Application Support/bun', '/opt/ok cli/cli.mjs'];
    const args = buildSyncCredentialArgs(argv);
    expect(argvFromHelper(args)).toEqual([...argv, 'auth', 'git-credential']);
  });

  test('embedded single quote in the path round-trips safely', () => {
    const argv = ["/Users/o'brien/OpenKnowledge.app/cli.sh"];
    const args = buildSyncCredentialArgs(argv);
    expect(argvFromHelper(args)).toEqual([...argv, 'auth', 'git-credential']);
  });
});
