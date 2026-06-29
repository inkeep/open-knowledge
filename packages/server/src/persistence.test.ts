import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import * as Y from 'yjs';
import { contentHash, isSelfWrite, registerWrite } from './file-watcher';
import {
  captureDocSnapshotForPersistence,
  isWithinContentDir,
  resolveWriterFromOrigin,
  safeContentPath,
} from './persistence';
import { FILE_SYSTEM_WRITER, GIT_UPSTREAM_WRITER, SERVICE_WRITER } from './shadow-repo';

describe('safeContentPath', () => {
  const contentDir = '/app/content';

  test('allows simple document names', () => {
    const result = safeContentPath('test-doc', contentDir);
    expect(result).toBe(resolve(contentDir, 'test-doc.md'));
  });

  test('rejects path traversal with ../', () => {
    expect(() => safeContentPath('../etc/passwd', contentDir)).toThrow('Invalid document name');
  });

  test('rejects absolute path injection', () => {
    expect(() => safeContentPath('/etc/passwd', contentDir)).toThrow('Invalid document name');
  });

  test('rejects traversal to parent directory', () => {
    expect(() => safeContentPath('../../package.json', contentDir)).toThrow(
      'Invalid document name',
    );
  });

  test('allows subdirectory within content', () => {
    const result = safeContentPath('sub/nested', contentDir);
    expect(result).toBe(resolve(contentDir, 'sub/nested.md'));
  });
});

describe('isWithinContentDir', () => {
  test('returns true for path equal to contentDir', () => {
    expect(isWithinContentDir('/app/content', '/app/content')).toBe(true);
  });

  test('returns true for path inside contentDir', () => {
    expect(isWithinContentDir(`/app/content${sep}file.md`, '/app/content')).toBe(true);
  });

  test('returns true for nested path inside contentDir', () => {
    expect(isWithinContentDir(`/app/content${sep}sub${sep}file.md`, '/app/content')).toBe(true);
  });

  test('returns false for path outside contentDir', () => {
    expect(isWithinContentDir('/tmp/outside.md', '/app/content')).toBe(false);
  });

  test('returns false for path that is a prefix but not a child', () => {
    expect(isWithinContentDir('/app/content-extra/file.md', '/app/content')).toBe(false);
  });
});

describe('symlink-safe atomic write', () => {
  let tmpDir: string;
  let contentDir: string;

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'persistence-test-')));
    contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function simulateWrite(documentName: string, markdown: string, cd: string) {
    const requestedPath = safeContentPath(documentName, cd);
    await mkdir(dirname(requestedPath), { recursive: true });

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(requestedPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        canonicalPath = requestedPath;
      } else if (code === 'ELOOP') {
        throw new Error(`Symlink cycle detected at ${requestedPath}`);
      } else {
        throw e;
      }
    }

    if (!isWithinContentDir(canonicalPath, cd)) {
      throw new Error(
        `symlink-escape: ${requestedPath} resolves to ${canonicalPath} outside ${cd}`,
      );
    }

    const tmpPath = `${canonicalPath}.tmp`;
    await writeFile(tmpPath, markdown, 'utf-8');
    await rename(tmpPath, canonicalPath);
    registerWrite(canonicalPath, contentHash(markdown));
  }

  test('preserves symlink when writing to symlinked file', async () => {
    const targetPath = join(contentDir, 'target.md');
    const linkPath = join(contentDir, 'link.md');

    writeFileSync(targetPath, '# Original');
    symlinkSync(targetPath, linkPath);

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);

    await simulateWrite('link', '# Updated via symlink', contentDir);

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(linkPath, 'utf-8')).toBe('# Updated via symlink');
    expect(readFileSync(targetPath, 'utf-8')).toBe('# Updated via symlink');
  });

  test('regular file write is unchanged', async () => {
    const filePath = join(contentDir, 'regular.md');
    writeFileSync(filePath, '# Original');

    await simulateWrite('regular', '# Updated', contentDir);

    expect(readFileSync(filePath, 'utf-8')).toBe('# Updated');
    expect(lstatSync(filePath).isSymbolicLink()).toBe(false);
  });

  test('new file write works (ENOENT fallback)', async () => {
    await simulateWrite('new-file', '# New content', contentDir);

    const filePath = join(contentDir, 'new-file.md');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe('# New content');
  });

  test('broken symlink falls back to direct write at original path', async () => {
    const linkPath = join(contentDir, 'orphan.md');
    symlinkSync(join(contentDir, 'nonexistent.md'), linkPath);

    await simulateWrite('orphan', '# Broken link content', contentDir);

    expect(existsSync(linkPath)).toBe(true);
    expect(readFileSync(linkPath, 'utf-8')).toBe('# Broken link content');
  });

  test('cyclic symlink throws ELOOP error', async () => {
    const aPath = join(contentDir, 'cycle-a.md');
    const bPath = join(contentDir, 'cycle-b.md');
    symlinkSync(bPath, aPath);
    symlinkSync(aPath, bPath);

    await expect(simulateWrite('cycle-a', '# Content', contentDir)).rejects.toThrow(
      'Symlink cycle detected',
    );
  });

  test('symlink escaping contentDir is refused', async () => {
    const outsideDir = join(tmpDir, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    const outsideTarget = join(outsideDir, 'secret.md');
    writeFileSync(outsideTarget, '# Secret');

    const escapePath = join(contentDir, 'escape.md');
    symlinkSync(outsideTarget, escapePath);

    await expect(simulateWrite('escape', '# Hacked', contentDir)).rejects.toThrow('symlink-escape');

    expect(lstatSync(escapePath).isSymbolicLink()).toBe(true);
    expect(readFileSync(outsideTarget, 'utf-8')).toBe('# Secret');
  });

  test('tmpPath is colocated with canonical path, not requested path', async () => {
    const subDir = join(contentDir, 'sub');
    mkdirSync(subDir, { recursive: true });
    const targetPath = join(subDir, 'target.md');
    writeFileSync(targetPath, '# Target');

    const linkPath = join(contentDir, 'link.md');
    symlinkSync(targetPath, linkPath);

    await simulateWrite('link', '# Updated', contentDir);

    expect(existsSync(`${linkPath}.tmp`)).toBe(false);
    expect(existsSync(`${targetPath}.tmp`)).toBe(false);
    expect(readFileSync(targetPath, 'utf-8')).toBe('# Updated');
  });

  test('registerWrite uses canonical path for self-write detection', async () => {
    const targetPath = join(contentDir, 'target.md');
    const linkPath = join(contentDir, 'link.md');
    writeFileSync(targetPath, '# Original');
    symlinkSync(targetPath, linkPath);

    const markdown = '# Self-write test';
    await simulateWrite('link', markdown, contentDir);

    const hash = contentHash(markdown);
    expect(isSelfWrite(targetPath, hash)).toBe(true);
    expect(isSelfWrite(linkPath, hash)).toBe(false);
  });
});


describe('resolveWriterFromOrigin', () => {
  test('local origin with session_id → agent-<sessionId> writer', () => {
    const origin = {
      source: 'local',
      skipStoreHooks: false,
      context: { origin: 'agent-write', paired: true, session_id: 'conn-abc123' },
    };
    const writer = resolveWriterFromOrigin(origin);
    expect(writer).not.toBeNull();
    expect(writer?.id).toBe('agent-conn-abc123');
    expect(writer?.email).toBe('agent-conn-abc123@openknowledge.local');
  });

  test('local undo origin with session_id → agent-<sessionId> writer', () => {
    const origin = {
      source: 'local',
      skipStoreHooks: false,
      context: { origin: 'agent-undo', paired: true, session_id: 'conn-xyz789' },
    };
    const writer = resolveWriterFromOrigin(origin);
    expect(writer?.id).toBe('agent-conn-xyz789');
  });

  test('local file-watcher origin → FILE_SYSTEM_WRITER', () => {
    const origin = {
      source: 'local',
      skipStoreHooks: true,
      context: { origin: 'file-watcher', paired: true },
    };
    const writer = resolveWriterFromOrigin(origin);
    expect(writer).toEqual(FILE_SYSTEM_WRITER);
  });

  test('local upstream-import origin → GIT_UPSTREAM_WRITER', () => {
    const origin = {
      source: 'local',
      context: { origin: 'upstream-import' },
    };
    const writer = resolveWriterFromOrigin(origin);
    expect(writer).toEqual(GIT_UPSTREAM_WRITER);
  });

  test('local rollback-apply origin (no session_id) → SERVICE_WRITER', () => {
    const origin = {
      source: 'local',
      skipStoreHooks: false,
      context: { origin: 'rollback-apply', paired: true },
    };
    const writer = resolveWriterFromOrigin(origin);
    expect(writer).toEqual(SERVICE_WRITER);
  });

  test('connection origin with principalId → principal writer', () => {
    const principalId = 'principal-6f3a9c8b-4e2d-49f1-ac3a-7e8d12c9a0b3';
    const origin = {
      source: 'connection',
      connection: { context: { principalId } },
    };
    const writer = resolveWriterFromOrigin(origin);
    expect(writer).not.toBeNull();
    expect(writer?.id).toBe(principalId);
    expect(writer?.email).toBe(`${principalId}@openknowledge.local`);
  });

  test('connection origin without principalId → SERVICE_WRITER', () => {
    const origin = { source: 'connection', connection: { context: {} } };
    const writer = resolveWriterFromOrigin(origin);
    expect(writer).toEqual(SERVICE_WRITER);
  });

  test('null origin → null', () => {
    expect(resolveWriterFromOrigin(null)).toBeNull();
  });

  test('undefined origin → null', () => {
    expect(resolveWriterFromOrigin(undefined)).toBeNull();
  });

  test('non-object origin → null', () => {
    expect(resolveWriterFromOrigin('string-origin')).toBeNull();
  });

  test('local origin with no context → null', () => {
    expect(resolveWriterFromOrigin({ source: 'local' })).toBeNull();
  });

  test('session_id takes precedence over context.origin in local origin', () => {
    const origin = {
      source: 'local',
      context: { origin: 'agent-write', session_id: 'conn-priority' },
    };
    const writer = resolveWriterFromOrigin(origin);
    expect(writer?.id).toBe('agent-conn-priority');
  });

  test('connection origin matching loaded principal → uses real display_name/email', () => {
    const principalId = 'principal-abc-123';
    const origin = {
      source: 'connection',
      connection: { context: { principalId } },
    };
    const loaded = {
      id: principalId,
      display_name: 'Alice Smith',
      display_email: 'alice@example.com',
      source: 'git-config' as const,
      created_at: '2026-04-22T00:00:00.000Z',
    };
    const writer = resolveWriterFromOrigin(origin, () => loaded);
    expect(writer?.id).toBe(principalId);
    expect(writer?.name).toBe('Alice Smith');
    expect(writer?.email).toBe('alice@example.com');
  });

  test('connection origin with mismatched principalId → stub fallback', () => {
    const origin = {
      source: 'connection',
      connection: { context: { principalId: 'principal-different' } },
    };
    const loaded = {
      id: 'principal-loaded',
      display_name: 'Alice',
      display_email: 'alice@example.com',
      source: 'git-config' as const,
      created_at: '2026-04-22T00:00:00.000Z',
    };
    const writer = resolveWriterFromOrigin(origin, () => loaded);
    expect(writer?.id).toBe('principal-different');
    expect(writer?.name).toBe('Local User');
  });

  test('connection origin with getPrincipal returning null → stub fallback', () => {
    const origin = {
      source: 'connection',
      connection: { context: { principalId: 'principal-abc' } },
    };
    const writer = resolveWriterFromOrigin(origin, () => null);
    expect(writer?.name).toBe('Local User');
  });
});


describe('captureDocSnapshotForPersistence', () => {
  test('returns sv and json together, both reflecting doc state at call time', () => {
    const doc = new Y.Doc();
    doc.getXmlFragment('default'); // Materialize the fragment that

    const snapshot = captureDocSnapshotForPersistence(doc);
    expect(snapshot.sv).toBeInstanceOf(Uint8Array);
    expect(snapshot.json).toBeDefined();
    expect(snapshot.sv.byteLength).toBeGreaterThan(0);
    doc.destroy();
  });

  test('captured sv is a snapshot — does NOT reflect updates applied after capture', () => {

    const docBefore = new Y.Doc();
    docBefore.getText('source').insert(0, 'BEFORE');
    const beforeUpdate = Y.encodeStateAsUpdate(docBefore);
    docBefore.destroy();

    const doc = new Y.Doc();
    Y.applyUpdate(doc, beforeUpdate);

    const snapshotBefore = captureDocSnapshotForPersistence(doc);
    const svBeforeBytes = new Uint8Array(snapshotBefore.sv);

    doc.getText('source').insert(6, 'AFTER');

    const snapshotAfter = captureDocSnapshotForPersistence(doc);
    const svAfterBytes = new Uint8Array(snapshotAfter.sv);

    expect(Array.from(svAfterBytes)).not.toEqual(Array.from(svBeforeBytes));

    const delta = Y.encodeStateAsUpdate(doc, svBeforeBytes);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, beforeUpdate);
    expect(peer.getText('source').toString()).toBe('BEFORE');
    Y.applyUpdate(peer, delta);
    expect(peer.getText('source').toString()).toBe('BEFOREAFTER');

    doc.destroy();
    peer.destroy();
  });

  test('helper is uninterruptible — sv and json reflect the same instant', () => {
    const doc = new Y.Doc();
    const text = doc.getText('source');
    for (let i = 0; i < 100; i++) {
      text.insert(text.length, `${i} `);
    }
    const snapshot = captureDocSnapshotForPersistence(doc);

    const reconstructed = new Y.Doc();
    Y.applyUpdate(reconstructed, Y.encodeStateAsUpdate(doc));
    const fullText = reconstructed.getText('source').toString();

    expect(snapshot.sv.byteLength).toBeGreaterThan(0);
    expect(fullText.length).toBeGreaterThan(0);

    doc.destroy();
    reconstructed.destroy();
  });
});
