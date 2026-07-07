import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import {
  assertCompatibleStateManifest,
  detectProjectShape,
  readStateManifest,
  STATE_MANIFEST_FILENAME,
  StateManifestError,
  type StateManifestRecord,
  writeStateManifest,
} from './state-manifest.ts';

function makeTmp(): { lockDir: string; shadowRepoDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'state-manifest-test-'));
  const lockDir = join(root, '.ok', LOCAL_DIR);
  const shadowRepoDir = join(root, '.git', 'ok');
  return {
    lockDir,
    shadowRepoDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('detectProjectShape', () => {
  test('returns "fresh" when neither lockDir nor shadowRepoDir exist', () => {
    const { lockDir, shadowRepoDir, cleanup } = makeTmp();
    try {
      expect(detectProjectShape({ lockDir, shadowRepoDir })).toBe('fresh');
    } finally {
      cleanup();
    }
  });

  test('returns "fresh" when only lockDir exists (lockDir is NOT an adoption signal)', () => {
    // Regression: `initContent` and `acquireServerLock` both create `.ok/`
    // before the manifest check runs. If lockDir-existence triggered "adopt",
    // every fresh project would misclassify and stamp schema-0. Only the shadow
    // repo signals adoption.
    const { lockDir, shadowRepoDir, cleanup } = makeTmp();
    try {
      mkdirSync(lockDir, { recursive: true });
      expect(detectProjectShape({ lockDir, shadowRepoDir })).toBe('fresh');
    } finally {
      cleanup();
    }
  });

  test('returns "adopt" when shadowRepoDir exists', () => {
    const { lockDir, shadowRepoDir, cleanup } = makeTmp();
    try {
      mkdirSync(shadowRepoDir, { recursive: true });
      expect(detectProjectShape({ lockDir, shadowRepoDir })).toBe('adopt');
    } finally {
      cleanup();
    }
  });

  test('returns "adopt" when both exist (shadow repo wins over lockDir absence)', () => {
    const { lockDir, shadowRepoDir, cleanup } = makeTmp();
    try {
      mkdirSync(lockDir, { recursive: true });
      mkdirSync(shadowRepoDir, { recursive: true });
      expect(detectProjectShape({ lockDir, shadowRepoDir })).toBe('adopt');
    } finally {
      cleanup();
    }
  });

  test('only the configured shadowRepoDir triggers adopt — unrelated dirs nearby do not leak', () => {
    // Existence of unrelated directories under `.git/` (e.g. left over from a
    // prior tooling layout) MUST NOT affect the signal — `detectProjectShape`
    // checks only the path it was passed.
    const root = mkdtempSync(join(tmpdir(), 'state-manifest-shadow-only-'));
    try {
      const lockDir = join(root, '.ok', LOCAL_DIR);
      const shadowRepoDir = join(root, '.git', 'ok');
      const unrelatedSiblingDir = join(root, '.git', 'some-other-tooling-dir');

      mkdirSync(unrelatedSiblingDir, { recursive: true });
      expect(detectProjectShape({ lockDir, shadowRepoDir })).toBe('fresh');

      mkdirSync(shadowRepoDir, { recursive: true });
      expect(detectProjectShape({ lockDir, shadowRepoDir })).toBe('adopt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('readStateManifest', () => {
  test('returns absent when file does not exist', () => {
    const { lockDir, cleanup } = makeTmp();
    try {
      expect(readStateManifest(lockDir)).toEqual({ status: 'absent' });
    } finally {
      cleanup();
    }
  });

  test('returns present + manifest when file is valid', () => {
    const { lockDir, cleanup } = makeTmp();
    try {
      const record: StateManifestRecord = {
        stateSchemaVersion: 1,
        createdAt: '2026-04-27T00:00:00.000Z',
        createdBy: { runtimeVersion: '0.2.0', protocolVersion: 1 },
      };
      writeStateManifest(lockDir, record);
      expect(readStateManifest(lockDir)).toEqual({ status: 'present', manifest: record });
    } finally {
      cleanup();
    }
  });

  test('throws on invalid JSON (corrupt, NOT absent)', () => {
    const { lockDir, cleanup } = makeTmp();
    try {
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, STATE_MANIFEST_FILENAME), '{ not valid json');
      expect(() => readStateManifest(lockDir)).toThrow(StateManifestError);
      try {
        readStateManifest(lockDir);
      } catch (err) {
        expect(err).toBeInstanceOf(StateManifestError);
        expect((err as StateManifestError).kind).toBe('corrupt');
      }
    } finally {
      cleanup();
    }
  });

  test('throws on shape violation (missing required fields)', () => {
    const { lockDir, cleanup } = makeTmp();
    try {
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(
        join(lockDir, STATE_MANIFEST_FILENAME),
        JSON.stringify({ stateSchemaVersion: 1 }),
      );
      expect(() => readStateManifest(lockDir)).toThrow(StateManifestError);
    } finally {
      cleanup();
    }
  });
});

describe('assertCompatibleStateManifest', () => {
  test('writes fresh manifest on a genuinely fresh project', () => {
    const { lockDir, shadowRepoDir, cleanup } = makeTmp();
    try {
      const result = assertCompatibleStateManifest({
        lockDir,
        shadowRepoDir,
        currentStateSchemaVersion: 1,
        currentRuntimeVersion: '0.2.0',
        currentProtocolVersion: 1,
        now: () => new Date('2026-04-27T12:00:00.000Z'),
      });
      expect(result.stateSchemaVersion).toBe(1);
      expect(result.createdBy.runtimeVersion).toBe('0.2.0');
      expect(result.createdBy.protocolVersion).toBe(1);
      expect(result.createdBy.adoptedAt).toBeUndefined();
      expect(result.createdAt).toBe('2026-04-27T12:00:00.000Z');

      // Manifest is now persisted.
      const re = readStateManifest(lockDir);
      expect(re.status).toBe('present');
    } finally {
      cleanup();
    }
  });

  test('writes schema-0 + adoptedAt on adoption (pre-existing shadow repo)', () => {
    const { lockDir, shadowRepoDir, cleanup } = makeTmp();
    try {
      mkdirSync(shadowRepoDir, { recursive: true });
      const result = assertCompatibleStateManifest({
        lockDir,
        shadowRepoDir,
        currentStateSchemaVersion: 1,
        currentRuntimeVersion: '0.2.0',
        currentProtocolVersion: 1,
        now: () => new Date('2026-04-27T12:00:00.000Z'),
      });
      expect(result.stateSchemaVersion).toBe(0);
      expect(result.createdBy.adoptedAt).toBe('2026-04-27T12:00:00.000Z');
      expect(result.createdAt).toBe('2026-04-27T12:00:00.000Z');
    } finally {
      cleanup();
    }
  });

  test('writes fresh manifest when only .ok dir exists (no shadow repo)', () => {
    // Regression for the smoke-test bug: `initContent` / `acquireServerLock`
    // create `.ok/` before the manifest check runs. That alone is
    // NOT adoption — only the shadow repo signals durable pre-version-field
    // state. This is the user's exact scenario from the smoke test.
    const { lockDir, shadowRepoDir, cleanup } = makeTmp();
    try {
      mkdirSync(lockDir, { recursive: true });
      const result = assertCompatibleStateManifest({
        lockDir,
        shadowRepoDir,
        currentStateSchemaVersion: 1,
        currentRuntimeVersion: '0.2.0',
        currentProtocolVersion: 1,
        now: () => new Date('2026-04-27T12:00:00.000Z'),
      });
      expect(result.stateSchemaVersion).toBe(1);
      expect(result.createdBy.adoptedAt).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test('proceeds + updates lastWriteBy when manifest matches current version', () => {
    const { lockDir, shadowRepoDir, cleanup } = makeTmp();
    try {
      const initial: StateManifestRecord = {
        stateSchemaVersion: 1,
        createdAt: '2026-04-27T00:00:00.000Z',
        createdBy: { runtimeVersion: '0.2.0', protocolVersion: 1 },
      };
      writeStateManifest(lockDir, initial);
      const result = assertCompatibleStateManifest({
        lockDir,
        shadowRepoDir,
        currentStateSchemaVersion: 1,
        currentRuntimeVersion: '0.2.1',
        currentProtocolVersion: 1,
        now: () => new Date('2026-04-27T13:00:00.000Z'),
      });
      expect(result.stateSchemaVersion).toBe(1);
      expect(result.createdBy.runtimeVersion).toBe('0.2.0'); // unchanged
      expect(result.lastWriteBy?.runtimeVersion).toBe('0.2.1'); // updated
      expect(result.lastWriteBy?.at).toBe('2026-04-27T13:00:00.000Z');

      // Persisted on disk.
      const re = readStateManifest(lockDir);
      if (re.status !== 'present') throw new Error('expected present');
      expect(re.manifest.lastWriteBy?.runtimeVersion).toBe('0.2.1');
    } finally {
      cleanup();
    }
  });

  test('throws when manifest stateSchemaVersion does not match current binary', () => {
    const { lockDir, shadowRepoDir, cleanup } = makeTmp();
    try {
      const manifest: StateManifestRecord = {
        stateSchemaVersion: 2,
        createdAt: '2026-04-27T00:00:00.000Z',
        createdBy: { runtimeVersion: '0.3.0', protocolVersion: 1 },
      };
      writeStateManifest(lockDir, manifest);
      expect(() =>
        assertCompatibleStateManifest({
          lockDir,
          shadowRepoDir,
          currentStateSchemaVersion: 1,
          currentRuntimeVersion: '0.2.0',
          currentProtocolVersion: 1,
        }),
      ).toThrow(StateManifestError);

      try {
        assertCompatibleStateManifest({
          lockDir,
          shadowRepoDir,
          currentStateSchemaVersion: 1,
          currentRuntimeVersion: '0.2.0',
          currentProtocolVersion: 1,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(StateManifestError);
        expect((err as StateManifestError).kind).toBe('incompatible');
        expect((err as StateManifestError).message).toContain('stateSchemaVersion=2');
        expect((err as StateManifestError).message).toContain('this binary supports 1');
      }
    } finally {
      cleanup();
    }
  });

  test('schema-0 manifest is readable by v1 binary (adoption path round-trips)', () => {
    // the isCompatibleSchema table in state-manifest.ts:
    // schema-0 is the pre-manifest adoption sentinel; v1 was the first
    // manifest-aware schema. v1 binaries MUST accept schema-0 manifests on
    // re-boot, otherwise the adoption path self-incompatibilizes after one
    // write. This test guards that compatibility.
    const { lockDir, shadowRepoDir, cleanup } = makeTmp();
    try {
      const adopted: StateManifestRecord = {
        stateSchemaVersion: 0,
        createdAt: '2026-04-27T12:00:00.000Z',
        createdBy: {
          runtimeVersion: '0.2.0',
          protocolVersion: 1,
          adoptedAt: '2026-04-27T12:00:00.000Z',
        },
      };
      writeStateManifest(lockDir, adopted);

      const result = assertCompatibleStateManifest({
        lockDir,
        shadowRepoDir,
        currentStateSchemaVersion: 1,
        currentRuntimeVersion: '0.2.1',
        currentProtocolVersion: 1,
        now: () => new Date('2026-04-27T13:00:00.000Z'),
      });

      // Schema-0 is preserved (NOT silently bumped to 1) — adoption stays
      // recorded. lastWriteBy is updated.
      expect(result.stateSchemaVersion).toBe(0);
      expect(result.createdBy.adoptedAt).toBe('2026-04-27T12:00:00.000Z');
      expect(result.lastWriteBy?.runtimeVersion).toBe('0.2.1');
    } finally {
      cleanup();
    }
  });

  test('throws on corrupt manifest (does NOT treat as fresh)', () => {
    const { lockDir, shadowRepoDir, cleanup } = makeTmp();
    try {
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, STATE_MANIFEST_FILENAME), 'not json');
      expect(() =>
        assertCompatibleStateManifest({
          lockDir,
          shadowRepoDir,
          currentStateSchemaVersion: 1,
          currentRuntimeVersion: '0.2.0',
          currentProtocolVersion: 1,
        }),
      ).toThrow(StateManifestError);
    } finally {
      cleanup();
    }
  });
});

describe('backward compatibility', () => {
  test('reads manifests written before the protocolVersion field existed', () => {
    // Pre-protocolVersion shipped binaries wrote manifests with only
    // `runtimeVersion` in `createdBy`. The schema check must still accept
    // those records — refusing them would brick every existing project
    // when the protocolVersion-aware binary rolls out.
    const { lockDir, cleanup } = makeTmp();
    try {
      mkdirSync(lockDir, { recursive: true });
      const legacy = {
        stateSchemaVersion: 1,
        createdAt: '2026-04-27T00:00:00.000Z',
        createdBy: { runtimeVersion: '0.2.0' },
      };
      writeFileSync(join(lockDir, STATE_MANIFEST_FILENAME), JSON.stringify(legacy), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      const result = readStateManifest(lockDir);
      expect(result.status).toBe('present');
      if (result.status !== 'present') return;
      expect(result.manifest.createdBy.runtimeVersion).toBe('0.2.0');
      expect(result.manifest.createdBy.protocolVersion).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test('opportunistic update backfills protocolVersion onto a legacy manifest', () => {
    // The compat path must do more than read — it should also stamp the
    // current protocolVersion into `lastWriteBy` so subsequent boots see
    // the value (and any future migration logic can use it).
    const { lockDir, shadowRepoDir, cleanup } = makeTmp();
    try {
      mkdirSync(lockDir, { recursive: true });
      const legacy = {
        stateSchemaVersion: 1,
        createdAt: '2026-04-27T00:00:00.000Z',
        createdBy: { runtimeVersion: '0.2.0' },
      };
      writeFileSync(join(lockDir, STATE_MANIFEST_FILENAME), JSON.stringify(legacy), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      const result = assertCompatibleStateManifest({
        lockDir,
        shadowRepoDir,
        currentStateSchemaVersion: 1,
        currentRuntimeVersion: '0.2.1',
        currentProtocolVersion: 1,
        now: () => new Date('2026-05-04T00:00:00.000Z'),
      });
      expect(result.lastWriteBy?.protocolVersion).toBe(1);
      expect(result.lastWriteBy?.runtimeVersion).toBe('0.2.1');
      const re = readStateManifest(lockDir);
      if (re.status !== 'present') throw new Error('expected present');
      expect(re.manifest.lastWriteBy?.protocolVersion).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe('writeStateManifest', () => {
  test('creates the lock directory if absent', () => {
    const { lockDir, cleanup } = makeTmp();
    try {
      const record: StateManifestRecord = {
        stateSchemaVersion: 1,
        createdAt: '2026-04-27T00:00:00.000Z',
        createdBy: { runtimeVersion: '0.2.0', protocolVersion: 1 },
      };
      writeStateManifest(lockDir, record);
      const written = JSON.parse(readFileSync(join(lockDir, STATE_MANIFEST_FILENAME), 'utf-8'));
      expect(written).toEqual(record);
    } finally {
      cleanup();
    }
  });
});
