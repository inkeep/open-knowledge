import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { composeAndWriteRawBody } from './bridge-intake.ts';
import {
  DocumentDurabilityState,
  OK_PATH_UNRESOLVABLE,
  OK_STORE_REFUSED,
} from './document-durability-state.ts';
import { getLogger } from './logger.ts';
import { lossCaptureCurrentPath, parseLossCaptureLines } from './loss-capture.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import { createPersistenceExtension } from './persistence.ts';
import { classifyDuplication } from './persistence-tripwire.ts';
import { createServer } from './server-factory.ts';
import { initShadowRepo, type ShadowHandle, shadowGit } from './shadow-repo.ts';
import { getDocumentHistory } from './timeline-query.ts';

const FIXTURE_DIR = resolve(import.meta.dirname, 'persistence-tripwire.fixtures');

const USER_DOC = 'hello\n\n\nkjnekandkjawnkjd\n\n\nwkajnd\n\n\nwk\n\n\nwwjwj\n';
const USER_DOC_LINE = 'kjnekandkjawnkjd';

const BROWSER_ORIGIN = {
  source: 'connection',
  connection: { context: { principalId: 'principal-test-paste' } },
} as const;

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf-8');
}

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 8_000, pollMs = 25 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function expectStable<T>(
  read: () => T,
  { durationMs = 700, pollMs = 50 }: { durationMs?: number; pollMs?: number } = {},
): Promise<T> {
  const initial = read();
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    if (read() !== initial) throw new Error('value changed during stability window');
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return initial;
}

interface Rig {
  tmpDir: string;
  shadow: ShadowHandle;
  cleanup: () => void;
}

async function setupRig(prefix: string): Promise<Rig> {
  const tmpDir = await realpath(mkdtempSync(join(tmpdir(), prefix)));
  const git = simpleGit({ baseDir: tmpDir });
  await git.init();
  await git.raw('symbolic-ref', 'HEAD', 'refs/heads/main');
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');
  const shadow = await initShadowRepo(tmpDir);
  return {
    tmpDir,
    shadow,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function replaceSource(doc: Y.Doc, markdown: string): void {
  const ytext = doc.getText('source');
  doc.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, markdown);
  }, BROWSER_ORIGIN);
}

function blockedEvents(warnSpy: { mock: { calls: unknown[][] } }): string[] {
  return warnSpy.mock.calls
    .map((call) => String(call[0] ?? ''))
    .filter((s) => s.includes('"event":"ok-persistence-duplication-blocked"'));
}

describe('persistence tripwire vs a whole-document paste', () => {
  let rig: Rig;

  beforeEach(() => {
    resetMetrics();
  });

  afterEach(() => {
    rig?.cleanup();
  });

  test('the classifier still reads a whole-document double as a block verdict', () => {
    expect(USER_DOC.length).toBe(47);
    expect(classifyDuplication(`${USER_DOC}\n${USER_DOC}`, USER_DOC)).toEqual({
      kind: 'block',
      reason: 'structural-duplication',
      copies: 2,
    });
  });

  test('select-all copy paste after a settled write survives and reaches disk', async () => {
    rig = await setupRig('ok-tripwire-paste-');
    const docName = 'Untitled';
    const docPath = join(rig.tmpDir, `${docName}.md`);
    writeFileSync(docPath, '', 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = createServer({
      contentDir: rig.tmpDir,
      projectDir: rig.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
      shadowRepo: rig.shadow,
    });

    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      replaceSource(serverDoc, USER_DOC);
      await waitFor(() => readFileSync(docPath, 'utf-8').length > 0);
      const baseline = readFileSync(docPath, 'utf-8');
      expect(baseline).toBe(USER_DOC);

      replaceSource(serverDoc, `${USER_DOC}\n${USER_DOC}`);
      expect(occurrences(serverDoc.getText('source').toString(), USER_DOC_LINE)).toBe(2);

      await waitFor(() => readFileSync(docPath, 'utf-8') !== baseline);
      const persisted = await expectStable(() => readFileSync(docPath, 'utf-8'));
      expect(occurrences(persisted, USER_DOC_LINE)).toBe(2);
      expect(persisted.length).toBeGreaterThan(baseline.length);

      expect(occurrences(serverDoc.getText('source').toString(), USER_DOC_LINE)).toBe(2);

      expect(blockedEvents(warnSpy)).toHaveLength(0);
      expect(getMetrics().persistenceDuplicationReset).toBe(0);
      expect(getMetrics().persistenceDuplicationSpared).toBe(1);

      const spared = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((s) => s.includes('"event":"ok-persistence-duplication-spared"'));
      expect(spared).toHaveLength(1);
      const sparedPayload = JSON.parse(spared[0] ?? '{}') as Record<string, unknown>;
      expect(new Set(Object.keys(sparedPayload))).toEqual(
        new Set(['event', 'doc.name', 'candidateBytes', 'baseBytes', 'copies', 'reason']),
      );
      expect(sparedPayload['doc.name']).toBe(docName);
      expect(sparedPayload.copies).toBe(2);

      conn.disconnect();
    } finally {
      warnSpy.mockRestore();
      await server.destroy();
    }
  }, 30_000);

  test('a doubling with no settled write behind it still blocks, resets, and checkpoints', async () => {
    rig = await setupRig('ok-tripwire-incident-');
    const docName = 'incident-changeset-readme';
    const docPath = join(rig.tmpDir, `${docName}.md`);
    const baseMarkdown = loadFixture('incident-changeset-readme-doubled.base.md');
    const doubledMarkdown = loadFixture('incident-changeset-readme-doubled.candidate.md');
    writeFileSync(docPath, baseMarkdown, 'utf-8');
    const baselineBytes = readFileSync(docPath, 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = createServer({
      contentDir: rig.tmpDir,
      projectDir: rig.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
      shadowRepo: rig.shadow,
    });

    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      expect(serverDoc.getText('source').toString()).toBe(baselineBytes);

      replaceSource(serverDoc, doubledMarkdown);
      expect(serverDoc.getText('source').toString()).toBe(doubledMarkdown);

      await waitFor(() => blockedEvents(warnSpy).length > 0);

      await expectStable(() => readFileSync(docPath, 'utf-8'));
      expect(readFileSync(docPath, 'utf-8')).toBe(baselineBytes);
      await waitFor(() => serverDoc.getText('source').toString() === baselineBytes);
      expect(getMetrics().persistenceDuplicationReset).toBe(1);

      await waitFor(() => getMetrics().persistenceDuplicationResetCheckpointCreated >= 1, {
        timeoutMs: 10_000,
      });
      const shas = (
        await shadowGit(rig.shadow).raw(
          'for-each-ref',
          '--format=%(objectname)',
          'refs/checkpoints',
        )
      )
        .toString()
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      expect(shas).toHaveLength(1);
      const sha = shas[0] ?? '';

      const blob = (await shadowGit(rig.shadow).raw('show', `${sha}:${docName}`)).toString();
      expect(occurrences(blob, 'changeset')).toBeGreaterThan(
        occurrences(baselineBytes, 'changeset'),
      );
      const hist = await getDocumentHistory(rig.shadow, { docName }, '');
      const row = hist.entries.find((e) => e.sha === sha);
      expect(row?.checkpoint?.kind).toBe('persistence-duplication-reset');
      expect(row?.checkpoint?.metadata).toEqual({ copies: 2 });

      const ring = parseLossCaptureLines(
        readFileSync(lossCaptureCurrentPath(rig.tmpDir), 'utf-8'),
      ).filter((e) => e.site === 'persistence-duplication-reset');
      const trips = ring.filter((e) => e.event === 'detector-trip');
      expect(trips).toHaveLength(1);
      expect(trips[0]?.docName).toBe(docName);
      expect(trips[0]?.lostLen ?? 0).toBeGreaterThan(0);
      expect(ring.some((e) => e.event === 'checkpoint-write' && e.checkpointSha === sha)).toBe(
        true,
      );

      conn.disconnect();
    } finally {
      warnSpy.mockRestore();
      await server.destroy();
    }
  }, 30_000);
});

describe('persistence tripwire with an absent reconciled base', () => {
  let rig: Rig;

  beforeEach(() => {
    resetMetrics();
  });

  afterEach(() => {
    rig?.cleanup();
  });

  test('a doubling with no settled write still blocks, resets from disk, and checkpoints when the base is absent', async () => {
    rig = await setupRig('ok-tripwire-absent-base-');
    const docName = 'absent-base-tripwire';
    const docPath = join(rig.tmpDir, `${docName}.md`);
    const baseMarkdown = loadFixture('incident-changeset-readme-doubled.base.md');
    const doubledMarkdown = loadFixture('incident-changeset-readme-doubled.candidate.md');
    writeFileSync(docPath, baseMarkdown, 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = createServer({
      contentDir: rig.tmpDir,
      projectDir: rig.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
      shadowRepo: rig.shadow,
    });

    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;
      await waitFor(() => server.durabilityState.getReconciledBase(docName) === baseMarkdown);

      server.durabilityState.deleteReconciledBase(docName);
      expect(server.durabilityState.getReconciledBase(docName)).toBeUndefined();

      replaceSource(serverDoc, doubledMarkdown);
      expect(serverDoc.getText('source').toString()).toBe(doubledMarkdown);

      await vi.waitFor(
        () => expect(getMetrics().persistenceDuplicationReset).toBeGreaterThanOrEqual(1),
        { timeout: 10_000, interval: 25 },
      );

      await expectStable(() => readFileSync(docPath, 'utf-8'));
      expect(readFileSync(docPath, 'utf-8')).toBe(baseMarkdown);
      await waitFor(() => serverDoc.getText('source').toString() === baseMarkdown);
      expect(getMetrics().persistenceDuplicationSpared).toBe(0);

      await waitFor(() => getMetrics().persistenceDuplicationResetCheckpointCreated >= 1, {
        timeoutMs: 10_000,
      });
      const hist = await getDocumentHistory(rig.shadow, { docName }, '');
      expect(hist.entries.some((e) => e.checkpoint?.kind === 'persistence-duplication-reset')).toBe(
        true,
      );

      conn.disconnect();
    } finally {
      warnSpy.mockRestore();
      await server.destroy();
    }
  }, 40_000);

  test('a doubling with a settled write behind it is still spared when the base is absent', async () => {
    rig = await setupRig('ok-tripwire-absent-spare-');
    const docName = 'absent-base-spare';
    const docPath = join(rig.tmpDir, `${docName}.md`);
    const baseMarkdown = loadFixture('incident-changeset-readme-doubled.base.md');
    const settledMarker = 'A settled paragraph recorded before the base went missing.';
    const settledMarkdown = `${baseMarkdown}\n\n${settledMarker}\n`;
    writeFileSync(docPath, baseMarkdown, 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = createServer({
      contentDir: rig.tmpDir,
      projectDir: rig.tmpDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
      shadowRepo: rig.shadow,
    });

    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;

      replaceSource(serverDoc, settledMarkdown);
      await waitFor(() => readFileSync(docPath, 'utf-8').length > baseMarkdown.length);
      const settledStored = readFileSync(docPath, 'utf-8');
      await waitFor(() => server.durabilityState.getReconciledBase(docName) === settledStored);

      server.durabilityState.deleteReconciledBase(docName);
      expect(server.durabilityState.getReconciledBase(docName)).toBeUndefined();

      const settledSource = serverDoc.getText('source').toString();
      replaceSource(serverDoc, `${settledSource.trimEnd()}\n\n${settledSource}`);
      await waitFor(() => occurrences(serverDoc.getText('source').toString(), settledMarker) === 2);

      await vi.waitFor(
        () => expect(getMetrics().persistenceDuplicationSpared).toBeGreaterThanOrEqual(1),
        { timeout: 10_000, interval: 25 },
      );
      expect(getMetrics().persistenceDuplicationSpared).toBe(1);
      const spared = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((s) => s.includes('"event":"ok-persistence-duplication-spared"'));
      expect(spared).toHaveLength(1);

      await waitFor(() => occurrences(readFileSync(docPath, 'utf-8'), settledMarker) === 2);
      const doubledDisk = readFileSync(docPath, 'utf-8');
      await expectStable(() => readFileSync(docPath, 'utf-8'));
      expect(readFileSync(docPath, 'utf-8')).toBe(doubledDisk);
      expect(getMetrics().persistenceDuplicationReset).toBe(0);

      conn.disconnect();
    } finally {
      warnSpy.mockRestore();
      await server.destroy();
    }
  }, 40_000);

  test('a symlink-escaping disk baseline skips the store fail-closed instead of allowing a doubled write', async () => {
    rig = await setupRig('ok-tripwire-baseline-unavailable-');
    const outsideDir = await realpath(mkdtempSync(join(tmpdir(), 'ok-tripwire-outside-')));
    const secretPath = join(outsideDir, 'secret.md');
    const secretContent = '# SECRET\n\nThis content lives outside the content root.\n';
    writeFileSync(secretPath, secretContent, 'utf-8');
    const docName = 'baseline-unavailable';
    symlinkSync(secretPath, join(rig.tmpDir, `${docName}.md`));
    const doubledMarkdown = loadFixture('incident-changeset-readme-doubled.candidate.md');

    const durabilityState = new DocumentDurabilityState();
    const persistence = createPersistenceExtension({
      contentDir: rig.tmpDir,
      projectDir: rig.tmpDir,
      gitEnabled: false,
      durabilityState,
    });
    const document = new Y.Doc();
    composeAndWriteRawBody(document, doubledMarkdown, 'agent');

    const warnSpy = vi.spyOn(getLogger('persistence'), 'warn');
    try {
      await expect(
        persistence.extension.onStoreDocument?.({
          document,
          documentName: docName,
          lastTransactionOrigin: BROWSER_ORIGIN,
          lastContext: {},
        } as never),
      ).rejects.toThrow('fail-closed');

      expect(readFileSync(secretPath, 'utf-8')).toBe(secretContent);
      expect(
        occurrences(document.getText('source').toString(), 'thanks for opening this PR'),
      ).toBeGreaterThanOrEqual(2);
      const warnTexts = warnSpy.mock.calls.map((call) => String(call[1] ?? ''));
      expect(
        warnTexts.some((s) => s.includes('baseline unavailable') && s.includes('fail-closed')),
      ).toBe(true);
      expect(getMetrics().persistenceDuplicationReset).toBe(0);
    } finally {
      warnSpy.mockRestore();
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('an agent-triggered store refused for an escaping baseline reports the escape as an unresolvable path', async () => {
    rig = await setupRig('ok-tripwire-refusal-channel-');
    const outsideDir = await realpath(mkdtempSync(join(tmpdir(), 'ok-tripwire-outside-')));
    const secretPath = join(outsideDir, 'secret.md');
    const secretContent = '# SECRET\n\nThis content lives outside the content root.\n';
    writeFileSync(secretPath, secretContent, 'utf-8');
    const docName = 'refusal-channel';
    symlinkSync(secretPath, join(rig.tmpDir, `${docName}.md`));
    const doubledMarkdown = loadFixture('incident-changeset-readme-doubled.candidate.md');

    const durabilityState = new DocumentDurabilityState();
    const persistence = createPersistenceExtension({
      contentDir: rig.tmpDir,
      projectDir: rig.tmpDir,
      gitEnabled: false,
      durabilityState,
    });
    const document = new Y.Doc();
    composeAndWriteRawBody(document, doubledMarkdown, 'agent');
    durabilityState.markAgentWriteStore(docName);

    try {
      await expect(
        persistence.extension.onStoreDocument?.({
          document,
          documentName: docName,
          lastTransactionOrigin: BROWSER_ORIGIN,
          lastContext: {},
        } as never),
      ).rejects.toThrow('fail-closed');

      const failure = durabilityState.takeStoreFailure(docName);
      expect(failure).not.toBeNull();
      expect(failure?.code).toBe(OK_PATH_UNRESOLVABLE);
      expect(durabilityState.isStoreRefused(docName)).toBe(true);
      expect(readFileSync(secretPath, 'utf-8')).toBe(secretContent);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('an agent-triggered store refused for an unreadable baseline stays a retryable store refusal', async () => {
    rig = await setupRig('ok-tripwire-refusal-unreadable-');
    const docName = 'refusal-unreadable';
    const docPath = join(rig.tmpDir, `${docName}.md`);
    mkdirSync(docPath);
    const doubledMarkdown = loadFixture('incident-changeset-readme-doubled.candidate.md');

    const durabilityState = new DocumentDurabilityState();
    const persistence = createPersistenceExtension({
      contentDir: rig.tmpDir,
      projectDir: rig.tmpDir,
      gitEnabled: false,
      durabilityState,
    });
    const document = new Y.Doc();
    composeAndWriteRawBody(document, doubledMarkdown, 'agent');
    durabilityState.markAgentWriteStore(docName);

    await expect(
      persistence.extension.onStoreDocument?.({
        document,
        documentName: docName,
        lastTransactionOrigin: BROWSER_ORIGIN,
        lastContext: {},
      } as never),
    ).rejects.toThrow('fail-closed');

    const failure = durabilityState.takeStoreFailure(docName);
    expect(failure).not.toBeNull();
    expect(failure?.code).toBe(OK_STORE_REFUSED);
    expect(durabilityState.isStoreRefused(docName)).toBe(true);
    expect(statSync(docPath).isDirectory()).toBe(true);
  });

  test('a background store refused fail-closed records no store failure for a later caller to misattribute', async () => {
    rig = await setupRig('ok-tripwire-refusal-background-');
    const outsideDir = await realpath(mkdtempSync(join(tmpdir(), 'ok-tripwire-outside-')));
    const secretPath = join(outsideDir, 'secret.md');
    const secretContent = '# SECRET\n\nThis content lives outside the content root.\n';
    writeFileSync(secretPath, secretContent, 'utf-8');
    const docName = 'refusal-background';
    symlinkSync(secretPath, join(rig.tmpDir, `${docName}.md`));
    const doubledMarkdown = loadFixture('incident-changeset-readme-doubled.candidate.md');

    const durabilityState = new DocumentDurabilityState();
    const persistence = createPersistenceExtension({
      contentDir: rig.tmpDir,
      projectDir: rig.tmpDir,
      gitEnabled: false,
      durabilityState,
    });
    const document = new Y.Doc();
    composeAndWriteRawBody(document, doubledMarkdown, 'agent');

    try {
      await expect(
        persistence.extension.onStoreDocument?.({
          document,
          documentName: docName,
          lastTransactionOrigin: BROWSER_ORIGIN,
          lastContext: {},
        } as never),
      ).rejects.toThrow('fail-closed');

      expect(durabilityState.takeStoreFailure(docName)).toBeNull();
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('a refused doc that stores successfully after the baseline is repaired clears the refused mark', async () => {
    rig = await setupRig('ok-tripwire-refusal-recovery-');
    const outsideDir = await realpath(mkdtempSync(join(tmpdir(), 'ok-tripwire-outside-')));
    const secretPath = join(outsideDir, 'secret.md');
    const secretContent = '# SECRET\n\nThis content lives outside the content root.\n';
    writeFileSync(secretPath, secretContent, 'utf-8');
    const docName = 'refusal-recovery';
    symlinkSync(secretPath, join(rig.tmpDir, `${docName}.md`));
    const doubledMarkdown = loadFixture('incident-changeset-readme-doubled.candidate.md');

    const durabilityState = new DocumentDurabilityState();
    const persistence = createPersistenceExtension({
      contentDir: rig.tmpDir,
      projectDir: rig.tmpDir,
      gitEnabled: false,
      durabilityState,
    });
    const document = new Y.Doc();
    composeAndWriteRawBody(document, doubledMarkdown, 'agent');

    try {
      await expect(
        persistence.extension.onStoreDocument?.({
          document,
          documentName: docName,
          lastTransactionOrigin: BROWSER_ORIGIN,
          lastContext: {},
        } as never),
      ).rejects.toThrow('fail-closed');
      expect(durabilityState.isStoreRefused(docName)).toBe(true);

      const heldContent = document.getText('source').toString();
      rmSync(join(rig.tmpDir, `${docName}.md`));
      writeFileSync(join(rig.tmpDir, `${docName}.md`), heldContent, 'utf-8');

      await expect(
        persistence.extension.onStoreDocument?.({
          document,
          documentName: docName,
          lastTransactionOrigin: BROWSER_ORIGIN,
          lastContext: {},
        } as never),
      ).resolves.toBeUndefined();
      expect(durabilityState.isStoreRefused(docName)).toBe(false);

      await expect(
        persistence.extension.onStoreDocument?.({
          document,
          documentName: docName,
          lastTransactionOrigin: BROWSER_ORIGIN,
          lastContext: {},
        } as never),
      ).resolves.toBeUndefined();
      expect(durabilityState.isStoreRefused(docName)).toBe(false);
      expect(readFileSync(join(rig.tmpDir, `${docName}.md`), 'utf-8')).toBe(heldContent);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('a store whose markdown matches an adopted reconciled base clears the refused mark through the early-return path', async () => {
    rig = await setupRig('ok-tripwire-refusal-earlyclear-');
    const outsideDir = await realpath(mkdtempSync(join(tmpdir(), 'ok-tripwire-outside-')));
    const secretPath = join(outsideDir, 'secret.md');
    const secretContent = '# SECRET\n\nThis content lives outside the content root.\n';
    writeFileSync(secretPath, secretContent, 'utf-8');
    const docName = 'refusal-early-clear';
    symlinkSync(secretPath, join(rig.tmpDir, `${docName}.md`));
    const doubledMarkdown = loadFixture('incident-changeset-readme-doubled.candidate.md');

    const durabilityState = new DocumentDurabilityState();
    const persistence = createPersistenceExtension({
      contentDir: rig.tmpDir,
      projectDir: rig.tmpDir,
      gitEnabled: false,
      durabilityState,
    });
    const document = new Y.Doc();
    composeAndWriteRawBody(document, doubledMarkdown, 'agent');

    try {
      await expect(
        persistence.extension.onStoreDocument?.({
          document,
          documentName: docName,
          lastTransactionOrigin: BROWSER_ORIGIN,
          lastContext: {},
        } as never),
      ).rejects.toThrow('fail-closed');
      expect(durabilityState.isStoreRefused(docName)).toBe(true);

      const heldContent = document.getText('source').toString();
      rmSync(join(rig.tmpDir, `${docName}.md`));
      writeFileSync(join(rig.tmpDir, `${docName}.md`), heldContent, 'utf-8');
      durabilityState.setReconciledBase(docName, heldContent);

      const infoSpy = vi.spyOn(getLogger('persistence'), 'info');
      try {
        await persistence.extension.onStoreDocument?.({
          document,
          documentName: docName,
          lastTransactionOrigin: BROWSER_ORIGIN,
          lastContext: {},
        } as never);

        expect(durabilityState.isStoreRefused(docName)).toBe(false);
        const infoTexts = infoSpy.mock.calls.map((call) => String(call[1] ?? ''));
        expect(infoTexts.some((s) => s.includes('[persistence] Wrote'))).toBe(false);
        expect(readFileSync(join(rig.tmpDir, `${docName}.md`), 'utf-8')).toBe(heldContent);
      } finally {
        infoSpy.mockRestore();
      }
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('a first store of a never-observed doc skips the missing-baseline counter and recreates the file', async () => {
    rig = await setupRig('ok-tripwire-baseline-missing-');
    const docName = 'baseline-missing';
    const doubledMarkdown = loadFixture('incident-changeset-readme-doubled.candidate.md');

    const durabilityState = new DocumentDurabilityState();
    const persistence = createPersistenceExtension({
      contentDir: rig.tmpDir,
      projectDir: rig.tmpDir,
      gitEnabled: false,
      durabilityState,
    });
    const document = new Y.Doc();
    composeAndWriteRawBody(document, doubledMarkdown, 'agent');

    const warnSpy = vi.spyOn(getLogger('persistence'), 'warn');
    try {
      await persistence.extension.onStoreDocument?.({
        document,
        documentName: docName,
        lastTransactionOrigin: BROWSER_ORIGIN,
        lastContext: {},
      } as never);

      expect(getMetrics().persistenceDuplicationBaselineMissing).toBe(0);
      const warnTexts = warnSpy.mock.calls.map((call) => String(call[1] ?? ''));
      expect(warnTexts.some((s) => s.includes('no baseline'))).toBe(false);
      expect(
        occurrences(
          readFileSync(join(rig.tmpDir, `${docName}.md`), 'utf-8'),
          'thanks for opening this PR',
        ),
      ).toBeGreaterThanOrEqual(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('a lost baseline on a doc the server observed on disk is counted, and the deleted file is not recreated', async () => {
    rig = await setupRig('ok-tripwire-baseline-lost-');
    const docName = 'baseline-lost';
    const seeded = '# Baseline lost\n\nOriginal on-disk body.\n';
    writeFileSync(join(rig.tmpDir, `${docName}.md`), seeded, 'utf-8');
    const doubledMarkdown = loadFixture('incident-changeset-readme-doubled.candidate.md');

    const durabilityState = new DocumentDurabilityState();
    const persistence = createPersistenceExtension({
      contentDir: rig.tmpDir,
      projectDir: rig.tmpDir,
      gitEnabled: false,
      durabilityState,
    });
    const document = new Y.Doc();
    composeAndWriteRawBody(document, doubledMarkdown, 'agent');

    await persistence.extension.onLoadDocument?.({
      document,
      documentName: docName,
    } as never);
    durabilityState.deleteReconciledBase(docName);
    rmSync(join(rig.tmpDir, `${docName}.md`));

    const warnSpy = vi.spyOn(getLogger('persistence'), 'warn');
    try {
      await persistence.extension.onStoreDocument?.({
        document,
        documentName: docName,
        lastTransactionOrigin: BROWSER_ORIGIN,
        lastContext: {},
      } as never);

      expect(getMetrics().persistenceDuplicationBaselineMissing).toBe(1);
      const warnTexts = warnSpy.mock.calls.map((call) => String(call[1] ?? ''));
      expect(warnTexts.some((s) => s.includes('no baseline'))).toBe(true);
      expect(existsSync(join(rig.tmpDir, `${docName}.md`))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
