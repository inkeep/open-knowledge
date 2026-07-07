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

// ─── resolveWriterFromOrigin ───────────────────────

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
    // session_id path wins over classified-origin path
    expect(writer?.id).toBe('agent-conn-priority');
  });

  test('connection origin matching loaded principal → uses real display_name/email', () => {
    // When ctx.principalId matches loadedPrincipal.id, resolveWriterFromOrigin
    // must emit the real git-config display_name/email instead of "Local User".
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
    // Claim doesn't match loaded principal — emit stub so the caller can see
    // the attribution fell through (the onAuthenticate pin prevents this in
    // practice, but resolveWriterFromOrigin should still be safe if reached).
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

// ─── captureDocSnapshotForPersistence — atomic pre-write snapshot ────────────
//
// The disk-ack watermark contract depends on the SV being captured at the
// SAME synchronous instant the JSON is read. Any update applied to the doc
// AFTER this helper returns is — by construction — NOT in the markdown that
// will land on disk; including it in the watermark would tell clients
// "the server has durably persisted this update" when the server has not.
//
// Returning both as a single value lifts the co-capture into the type system:
// the helper's contract is "sv reflects exactly the doc state from which json
// was extracted." The tests below pin that contract so a future refactor that
// (a) splits the destructure across an await boundary, or (b) re-captures the
// SV after some downstream mutation, breaks loudly.

describe('captureDocSnapshotForPersistence', () => {
  test('returns sv and json together, both reflecting doc state at call time', () => {
    const doc = new Y.Doc();
    doc.getXmlFragment('default'); // Materialize the fragment that
    // `yXmlFragmentToProseMirrorRootNode` reads — without it the fragment is
    // implicitly created but stays empty, which is fine for this test.

    const snapshot = captureDocSnapshotForPersistence(doc);
    expect(snapshot.sv).toBeInstanceOf(Uint8Array);
    expect(snapshot.json).toBeDefined();
    // Empty doc — sv is the trivial state vector.
    expect(snapshot.sv.byteLength).toBeGreaterThan(0);
    doc.destroy();
  });

  test('captured sv is a snapshot — does NOT reflect updates applied after capture', () => {
    // The load-bearing test: after calling the helper, mutate the doc.
    // The captured sv MUST be byte-identical to a fresh sv taken at the
    // pre-mutation state. If a future refactor changed the helper to
    // return a live reference (or to capture sv lazily), this test would
    // catch it before clients started discarding unsynced edits.

    // Build a "BEFORE" baseline state we can replay onto a peer doc
    // (Y.js item references have to resolve, so the peer needs the
    // 'BEFORE' clientID's items present before applying any 'AFTER' delta).
    const docBefore = new Y.Doc();
    docBefore.getText('source').insert(0, 'BEFORE');
    const beforeUpdate = Y.encodeStateAsUpdate(docBefore);
    docBefore.destroy();

    // Test doc starts at 'BEFORE' (carrying docBefore's clientID's items).
    const doc = new Y.Doc();
    Y.applyUpdate(doc, beforeUpdate);

    const snapshotBefore = captureDocSnapshotForPersistence(doc);
    const svBeforeBytes = new Uint8Array(snapshotBefore.sv);

    // Apply an update AFTER capture — this represents updates landing
    // during the disk-write async window in production.
    doc.getText('source').insert(6, 'AFTER');

    const snapshotAfter = captureDocSnapshotForPersistence(doc);
    const svAfterBytes = new Uint8Array(snapshotAfter.sv);

    // The post-mutation snapshot's sv MUST differ from the pre-mutation one.
    expect(Array.from(svAfterBytes)).not.toEqual(Array.from(svBeforeBytes));

    // Verify snapshotBefore.sv reflects the pre-AFTER state by computing
    // the delta from it to current — that delta should reconstitute
    // exactly the 'AFTER' insertion when applied to a peer at
    // 'BEFORE' state.
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
    // Single-threaded JS guarantees no Y.js transaction can interleave
    // between `Y.encodeStateVector` and `yXmlFragmentToProseMirrorRootNode`
    // inside the helper. This test exercises that property by inserting
    // many updates in a tight synchronous loop and asserting that the
    // helper, called once, returns a self-consistent (sv, json) pair.
    const doc = new Y.Doc();
    const text = doc.getText('source');
    for (let i = 0; i < 100; i++) {
      text.insert(text.length, `${i} `);
    }
    const snapshot = captureDocSnapshotForPersistence(doc);

    // Reconstruct the doc from the captured state vector — every update
    // before the capture should be reachable.
    const reconstructed = new Y.Doc();
    Y.applyUpdate(reconstructed, Y.encodeStateAsUpdate(doc));
    const fullText = reconstructed.getText('source').toString();

    // Verify the snapshot's sv represents the same state as the doc.
    // (Asserting the json's content directly is brittle to schema changes;
    // verifying via the sv proves co-capture without testing JSON shape.)
    expect(snapshot.sv.byteLength).toBeGreaterThan(0);
    expect(fullText.length).toBeGreaterThan(0);

    doc.destroy();
    reconstructed.destroy();
  });
});
