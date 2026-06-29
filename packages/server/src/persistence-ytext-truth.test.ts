
import { describe as _bunDescribe, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';

const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import simpleGit from 'simple-git';
import { __resetQuiescenceForTests, __setQuiescentOverrideForTests } from './bridge-quiescence.ts';
import { __resetBridgeWatchdogForTests } from './bridge-watchdog.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import { getReconciledBase } from './persistence.ts';
import { createServer } from './server-factory.ts';

interface Fixture {
  tmpDir: string;
  contentDir: string;
  cleanup: () => void;
}

async function setupFixture(): Promise<Fixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ok-ytext-truth-'));
  const contentDir = tmpDir;
  const git = simpleGit({ baseDir: tmpDir });
  await git.init();
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');
  return {
    tmpDir,
    contentDir,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

async function waitForCondition(
  predicate: () => boolean,
  {
    timeoutMs = 5_000,
    pollMs = 25,
    describe,
  }: { timeoutMs?: number; pollMs?: number; describe?: () => string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const diagnostic = describe ? ` — ${describe()}` : '';
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms${diagnostic}`);
}

beforeEach(() => {
  resetMetrics();
  __resetQuiescenceForTests();
  __resetBridgeWatchdogForTests();
});

describe('FR-33: persistence reads body from Y.Text', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test('source-form delimiter `__foo__` survives ytext write → disk write', async () => {
    const docName = 'fr33-source-form';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    writeFileSync(docPath, '', 'utf-8');

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      const userOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-fr33' } },
      };
      serverDoc.transact(() => {
        serverDoc.getText('source').insert(0, '__foo__\n');
      }, userOrigin);

      await waitForCondition(
        () => {
          if (!existsSync(docPath)) return false;
          return readFileSync(docPath, 'utf-8').includes('__foo__');
        },
        {
          describe: () =>
            `disk read at ${docPath} did not contain '__foo__' (file exists: ${existsSync(docPath)})`,
        },
      );
      const diskBytes = readFileSync(docPath, 'utf-8');
      expect(diskBytes).toContain('__foo__');
      expect(diskBytes).not.toContain('**foo**');

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  });

  test('CRLF line endings survive ytext write → disk write (modulo normalizeBridge tolerance)', async () => {
    const docName = 'fr33-crlf';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    writeFileSync(docPath, '', 'utf-8');

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      if (!serverDoc) return;

      const userOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-fr33-crlf' } },
      };
      serverDoc.transact(() => {
        serverDoc.getText('source').insert(0, 'Line1\r\nLine2\r\n');
      }, userOrigin);

      await waitForCondition(
        () => {
          if (!existsSync(docPath)) return false;
          const bytes = readFileSync(docPath, 'utf-8');
          return bytes.length > 0 && bytes.includes('Line1');
        },
        {
          describe: () =>
            `disk read at ${docPath} did not contain 'Line1' (file exists: ${existsSync(docPath)}, size: ${existsSync(docPath) ? readFileSync(docPath, 'utf-8').length : 'n/a'})`,
        },
      );
      const diskBytes = readFileSync(docPath, 'utf-8');
      expect(diskBytes).toContain('Line1');
      expect(diskBytes).toContain('Line2');

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  });
});

describe('FR-35: cold-load setReconciledBase stores raw disk bytes', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test('reconciledBase stores the raw disk content verbatim (not serialize(fragment))', async () => {
    const docName = 'fr35-raw-base';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    const rawDiskContent = '# Heading\n\nA __strong__ paragraph.\n';
    writeFileSync(docPath, rawDiskContent, 'utf-8');

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);

      await waitForCondition(() => getReconciledBase(docName) !== undefined);
      expect(getReconciledBase(docName)).toBe(rawDiskContent);

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  });

  test('cold-load + first onStoreDocument tolerates fragment-canonical-vs-ytext-raw via normalizeBridge', async () => {
    const docName = 'fr35-no-phantom-write';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    const rawDiskContent = '# Title\n\nBody text.\n';
    writeFileSync(docPath, rawDiskContent, 'utf-8');

    const initialMtime = (await Bun.file(docPath).stat()).mtimeMs;

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      await waitForCondition(() => getReconciledBase(docName) !== undefined);

      await new Promise((r) => setTimeout(r, 250));

      const finalMtime = (await Bun.file(docPath).stat()).mtimeMs;
      expect(finalMtime).toBe(initialMtime);

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  });
});

describe('FR-33: full round-trip preserves user-form bytes', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test('source bytes survive: write disk → cold-load → mutate (no canonical edit) → save → disk-bytes byte-equal', async () => {
    const docName = 'fr33-roundtrip';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    const initialContent = '# Title\n\n__bold__ source.\n';
    writeFileSync(docPath, initialContent, 'utf-8');

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      if (!serverDoc) return;

      await waitForCondition(() => getReconciledBase(docName) !== undefined);
      const ytextAfterLoad = serverDoc.getText('source').toString();
      expect(ytextAfterLoad).toBe(initialContent);

      const userOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-fr33-rt' } },
      };
      const _newContent = `${initialContent}__more__\n`;
      serverDoc.transact(() => {
        const ytext = serverDoc.getText('source');
        ytext.insert(ytext.length, '__more__\n');
      }, userOrigin);

      await waitForCondition(
        () => {
          if (!existsSync(docPath)) return false;
          return readFileSync(docPath, 'utf-8').includes('__more__');
        },
        {
          describe: () =>
            `disk read at ${docPath} did not contain '__more__' (file exists: ${existsSync(docPath)})`,
        },
      );

      const diskAfterEdit = readFileSync(docPath, 'utf-8');
      expect(diskAfterEdit).toContain('__bold__');
      expect(diskAfterEdit).toContain('__more__');
      expect(diskAfterEdit).not.toContain('**bold**');
      expect(diskAfterEdit).not.toContain('**more**');

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  });
});

describe('Quiescence gate via direct counter manipulation', () => {

  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test('non-quiescent doc → onStoreDocument skips with persistence-skip-non-quiescent telemetry', async () => {
    const docName = 'gate-skip';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    writeFileSync(docPath, 'initial\n', 'utf-8');
    const initialMtime = (await Bun.file(docPath).stat()).mtimeMs;

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      if (!serverDoc) return;

      await waitForCondition(() => getReconciledBase(docName) !== undefined);

      __setQuiescentOverrideForTests(serverDoc, false);

      const userOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-gate' } },
      };
      serverDoc.transact(() => {
        serverDoc.getText('source').insert(0, 'edit ');
      }, userOrigin);

      await waitForCondition(() => {
        return warnSpy.mock.calls.some((call) => {
          const arg = String(call[0] ?? '');
          return arg.includes('"event":"persistence-skip-non-quiescent"');
        });
      });

      const skipCalls = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((s) => s.includes('"event":"persistence-skip-non-quiescent"'));
      expect(skipCalls.length).toBeGreaterThan(0);
      const payload = JSON.parse(skipCalls[0] ?? '{}') as Record<string, unknown>;
      expect(payload.event).toBe('persistence-skip-non-quiescent');
      expect(payload['doc.name']).toBe(docName);
      expect(typeof payload.deferCount).toBe('number');
      expect(payload.deferCount).toBeGreaterThanOrEqual(0);
      expect(['number', 'object']).toContain(typeof payload.wallClockMsSinceLastTransaction);

      expect(getMetrics().persistenceSkipNonQuiescent).toBeGreaterThan(0);

      const finalMtime = (await Bun.file(docPath).stat()).mtimeMs;
      expect(finalMtime).toBe(initialMtime);

      __setQuiescentOverrideForTests(serverDoc, undefined);
      conn.disconnect();
    } finally {
      warnSpy.mockRestore();
      await server.destroy();
    }
  });

  test('after QUIESCENCE_MAX_DEFER skips → force-flush emits persistence-force-flush-during-burst', async () => {
    const docName = 'gate-force-flush';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    writeFileSync(docPath, 'initial\n', 'utf-8');

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 80,
      maxDebounce: 200,
      gitEnabled: false,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      if (!serverDoc) return;
      await waitForCondition(() => getReconciledBase(docName) !== undefined);

      __setQuiescentOverrideForTests(serverDoc, false);

      const userOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-force' } },
      };
      for (let i = 0; i < 12; i++) {
        serverDoc.transact(() => {
          serverDoc.getText('source').insert(0, `e${i} `);
        }, userOrigin);
        await new Promise((r) => setTimeout(r, 250));
      }

      await waitForCondition(() => {
        return warnSpy.mock.calls.some((call) => {
          const arg = String(call[0] ?? '');
          return arg.includes('"event":"persistence-force-flush-during-burst"');
        });
      });

      const forceCalls = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((s) => s.includes('"event":"persistence-force-flush-during-burst"'));
      expect(forceCalls.length).toBeGreaterThan(0);
      const payload = JSON.parse(forceCalls[0] ?? '{}') as Record<string, unknown>;
      expect(payload.event).toBe('persistence-force-flush-during-burst');
      expect(payload['doc.name']).toBe(docName);
      expect(typeof payload.deferCount).toBe('number');
      expect(payload.deferCount).toBeGreaterThanOrEqual(8);

      expect(getMetrics().persistenceForceFlushDuringBurst).toBeGreaterThan(0);

      __setQuiescentOverrideForTests(serverDoc, undefined);
      conn.disconnect();
    } finally {
      warnSpy.mockRestore();
      await server.destroy();
    }
  }, 30_000);

  test('quiescence resumes naturally → next debounce flushes successfully', async () => {
    const docName = 'gate-recover';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    writeFileSync(docPath, 'initial\n', 'utf-8');

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      if (!serverDoc) return;
      await waitForCondition(() => getReconciledBase(docName) !== undefined);

      const userOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-recover' } },
      };
      serverDoc.transact(() => {
        serverDoc.getText('source').insert(0, 'recovered ');
      }, userOrigin);

      await waitForCondition(() => {
        if (!existsSync(docPath)) return false;
        return readFileSync(docPath, 'utf-8').includes('recovered');
      });

      const diskBytes = readFileSync(docPath, 'utf-8');
      expect(diskBytes).toContain('recovered');

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  });
});

describe('Pre-write sanity check: divergence at persistence-fire time', () => {

  let fixture: Fixture;
  let originalNodeEnv: string | undefined;

  beforeEach(async () => {
    fixture = await setupFixture();
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    fixture.cleanup();
  });

  test('divergent serialize at persistence-time → ytext bytes win on disk + telemetry fires', async () => {
    const docName = 'fr33-divergence';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    writeFileSync(docPath, '', 'utf-8');

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const msg = args.map(String).join(' ');
      warnings.push(msg);
    };

    const testMdManager = new MarkdownManager({ extensions: sharedExtensions });
    spyOn(testMdManager, 'serialize').mockImplementation(() => 'INJECTED-DIVERGENT-CANONICAL\n');

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
      mdManager: testMdManager,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      const userOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-divergence' } },
      };
      serverDoc.transact(() => {
        serverDoc.getText('source').insert(0, 'user-typed-bytes\n');
      }, userOrigin);

      await waitForCondition(() => {
        if (!existsSync(docPath)) return false;
        const bytes = readFileSync(docPath, 'utf-8');
        return bytes.includes('user-typed-bytes');
      });

      const diskBytes = readFileSync(docPath, 'utf-8');
      expect(diskBytes).toContain('user-typed-bytes');
      expect(diskBytes).not.toContain('INJECTED-DIVERGENT-CANONICAL');

      const persistenceViolations = warnings.filter(
        (w) =>
          w.includes('"event":"bridge-invariant-violation"') && w.includes('"site":"persistence"'),
      );
      expect(persistenceViolations.length).toBeGreaterThan(0);

      expect(getMetrics().bridgeInvariantViolations).toBeGreaterThan(0);


      conn.disconnect();
    } finally {
      console.warn = originalWarn;
      await server.destroy();
    }
  });

  test('mdManager.serialize THROWS at persistence-time → ytext bytes still land on disk + dedicated telemetry fires', async () => {
    const docName = 'fr33-serialize-throw';
    const docPath = join(fixture.contentDir, `${docName}.md`);
    writeFileSync(docPath, '', 'utf-8');

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const msg = args.map(String).join(' ');
      warnings.push(msg);
    };

    const testMdManager = new MarkdownManager({ extensions: sharedExtensions });
    spyOn(testMdManager, 'serialize').mockImplementation(() => {
      throw new Error('synthetic schema-rejection: invalid Y.XmlElement type');
    });

    const server = createServer({
      contentDir: fixture.contentDir,
      projectDir: fixture.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
      mdManager: testMdManager,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      const userOrigin = {
        source: 'connection' as const,
        connection: { context: { principalId: 'principal-test-serialize-throw' } },
      };
      serverDoc.transact(() => {
        serverDoc.getText('source').insert(0, 'survives-serialize-throw\n');
      }, userOrigin);

      await waitForCondition(() => {
        if (!existsSync(docPath)) return false;
        const bytes = readFileSync(docPath, 'utf-8');
        return bytes.includes('survives-serialize-throw');
      });

      const diskBytes = readFileSync(docPath, 'utf-8');
      expect(diskBytes).toContain('survives-serialize-throw');

      expect(getMetrics().persistenceSanityCheckSerializeFailures).toBeGreaterThan(0);

      const serializeFailEvents = warnings.filter((w) =>
        w.includes('"event":"persistence-sanity-check-serialize-failed"'),
      );
      expect(serializeFailEvents.length).toBeGreaterThan(0);
      const payload = JSON.parse(serializeFailEvents[0] ?? '{}') as Record<string, unknown>;
      expect(payload.event).toBe('persistence-sanity-check-serialize-failed');
      expect(payload['doc.name']).toBe(docName);


      conn.disconnect();
    } finally {
      console.warn = originalWarn;
      await server.destroy();
    }
  });
});
