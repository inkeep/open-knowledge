import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DISPLACED_VERSION_LIMIT,
  DISPLACED_VERSION_TTL_MS,
  DocumentDurabilityState,
} from './document-durability-state.ts';
import * as tracedFs from './fs-traced.ts';
import { contentHash } from './version-hash.ts';

const fixtures: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ok-durability-cache-'));
  fixtures.push(dir);
  const persistencePath = join(dir, 'state.json');
  return { dir, persistencePath, state: new DocumentDurabilityState('main', { persistencePath }) };
}

describe('durable snapshot serialization cache', () => {
  test.each(['__proto__', 'constructor', 'toString'])(
    'restores protected rows on the valid prototype-like branch %s',
    (branch) => {
      const { persistencePath, state } = setup();
      state.switchReconciledBaseScope(branch);
      state.recordSuccessfulStore('doc', 'acknowledged', 'old');

      const restored = new DocumentDurabilityState(branch, { persistencePath });

      expect(restored.getReconciledBase('doc')).toBe('acknowledged');
      expect(restored.isDisplacedVersion('doc', 'old')).toBe(true);
    },
  );

  test('records a successful agent store as one synchronous snapshot replacement', () => {
    const { persistencePath, state } = setup();
    state.setReconciledBase('doc', 'original');
    state.recordDisplacedVersion('doc', 'previous');
    const writes = vi.spyOn(tracedFs, 'tracedWriteFileSync');
    const renames = vi.spyOn(tracedFs, 'tracedRenameSync');

    state.recordSuccessfulStore('doc', 'acknowledged', 'original');

    expect(writes).toHaveBeenCalledTimes(1);
    expect(renames).toHaveBeenCalledTimes(1);
    const restored = new DocumentDurabilityState('main', { persistencePath });
    expect(restored.getReconciledBase('doc')).toBe('acknowledged');
    expect(restored.isDisplacedVersion('doc', 'original')).toBe(true);
    expect(restored.isDisplacedVersion('doc', 'previous')).toBe(true);
  });

  test('unchanged protected bases avoid serialization and writes until expiry is due', () => {
    const { persistencePath, state } = setup();
    state.setReconciledBase('doc', 'acknowledged');
    state.recordDisplacedVersion('doc', 'old');
    utimesSync(persistencePath, 1, 1);
    const before = statSync(persistencePath);
    const serialize = vi.spyOn(JSON, 'stringify');
    const writes = vi.spyOn(tracedFs, 'tracedWriteFileSync');

    state.setReconciledBase('doc', 'acknowledged');

    expect(serialize).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(statSync(persistencePath).mtimeMs).toBe(before.mtimeMs);
  });

  test('an unchanged base still sweeps due history without dropping unresolved conflicts', () => {
    vi.useFakeTimers();
    const { persistencePath, state } = setup();
    state.setReconciledBase('expired', 'old plaintext');
    state.recordDisplacedVersion('expired', 'older');
    state.setReconciledBase('conflict', 'protected');
    state.recordStaleExternalWrite('conflict', 'disk', 'retained');
    vi.advanceTimersByTime(DISPLACED_VERSION_TTL_MS + 1);

    state.setReconciledBase('conflict', 'protected');

    expect(readFileSync(persistencePath, 'utf8')).not.toContain('old plaintext');
    const restored = new DocumentDurabilityState('main', { persistencePath });
    expect(restored.getReconciledBase('expired')).toBeUndefined();
    expect(restored.getStaleExternalWrite('conflict')).toMatchObject({
      diskContent: 'disk',
      retainedContent: 'retained',
    });
  });

  test('failed replacement restores base and history, and retry commits both', () => {
    const { dir, persistencePath, state } = setup();
    state.setReconciledBase('doc', 'original');
    state.recordDisplacedVersion('doc', 'previous');
    const before = readFileSync(persistencePath, 'utf8');
    const backup = `${persistencePath}.backup`;
    renameSync(persistencePath, backup);
    mkdirSync(persistencePath);

    expect(() => state.recordSuccessfulStore('doc', 'acknowledged', 'original')).toThrow(
      expect.objectContaining({
        code: expect.stringMatching(/^(EISDIR|EACCES|EPERM|ENOTEMPTY|EEXIST)$/),
      }),
    );

    expect(state.getReconciledBase('doc')).toBe('original');
    expect(state.isDisplacedVersion('doc', 'original')).toBe(false);
    expect(state.isDisplacedVersion('doc', 'previous')).toBe(true);
    expect(readFileSync(backup, 'utf8')).toBe(before);
    expect(readdirSync(dir).filter((name) => name.includes('.tmp.'))).toEqual([]);
    rmSync(persistencePath, { recursive: true });
    renameSync(backup, persistencePath);
    state.recordSuccessfulStore('doc', 'acknowledged', 'original');

    const restored = new DocumentDurabilityState('main', { persistencePath });
    expect(restored.getReconciledBase('doc')).toBe('acknowledged');
    expect(restored.isDisplacedVersion('doc', 'original')).toBe(true);
    expect(restored.isDisplacedVersion('doc', 'previous')).toBe(true);
  });

  test('first-snapshot failure restores absent state and does not poison its retry', () => {
    const { persistencePath, state } = setup();
    mkdirSync(persistencePath);

    expect(() => state.recordSuccessfulStore('doc', 'acknowledged', 'original')).toThrow(
      expect.objectContaining({
        code: expect.stringMatching(/^(EISDIR|EACCES|EPERM|ENOTEMPTY|EEXIST)$/),
      }),
    );
    expect(state.getReconciledBase('doc')).toBeUndefined();
    expect(state.isDisplacedVersion('doc', 'original')).toBe(false);
    rmSync(persistencePath, { recursive: true });
    state.recordSuccessfulStore('doc', 'acknowledged', 'original');

    const restored = new DocumentDurabilityState('main', { persistencePath });
    expect(restored.getReconciledBase('doc')).toBe('acknowledged');
    expect(restored.isDisplacedVersion('doc', 'original')).toBe(true);
  });

  test('a failed snapshot preparation preserves the committed cache through an unrelated save', () => {
    const { dir, persistencePath, state } = setup();
    state.recordSuccessfulStore('doc', 'original', 'previous');
    const before = readFileSync(persistencePath, 'utf8');
    const movedDir = `${dir}-moved`;
    fixtures.push(movedDir);
    renameSync(dir, movedDir);
    writeFileSync(dir, 'file blocks the snapshot parent');

    expect(() => state.recordSuccessfulStore('doc', 'acknowledged', 'original')).toThrow(
      expect.objectContaining({ code: expect.stringMatching(/^(EEXIST|ENOTDIR|EACCES|EPERM)$/) }),
    );
    expect(state.getReconciledBase('doc')).toBe('original');
    expect(state.isDisplacedVersion('doc', 'original')).toBe(false);
    expect(readFileSync(join(movedDir, 'state.json'), 'utf8')).toBe(before);
    unlinkSync(dir);
    renameSync(movedDir, dir);
    state.recordSuccessfulStore('other', 'other acknowledged', 'other old');
    const afterOther = new DocumentDurabilityState('main', { persistencePath });
    expect(afterOther.getReconciledBase('doc')).toBe('original');
    expect(afterOther.isDisplacedVersion('doc', 'original')).toBe(false);
    state.recordSuccessfulStore('doc', 'acknowledged', 'original');
    const afterRetry = new DocumentDurabilityState('main', { persistencePath });
    expect(afterRetry.getReconciledBase('doc')).toBe('acknowledged');
    expect(afterRetry.getReconciledBase('other')).toBe('other acknowledged');
    expect(afterRetry.isDisplacedVersion('doc', 'original')).toBe(true);
  });

  test('cached rows isolate branch identity and invalidate conflicts, clears, and deletion', () => {
    const { persistencePath, state } = setup();
    state.recordSuccessfulStore('doc', 'main acknowledged', 'main old');
    state.recordStaleExternalWrite('doc', 'main old', 'main candidate');
    state.switchReconciledBaseScope('feature/"quoted"');
    state.recordSuccessfulStore('doc', 'feature acknowledged', 'feature old');
    state.recordStaleExternalWrite('doc', 'feature old', 'feature candidate');
    state.recordStaleExternalWrite('doc', 'different rejected bytes', '');
    state.clearDisplacedVersions('doc');
    state.switchReconciledBaseScope('main');
    state.clearStaleExternalWrite('doc');
    state.recordSuccessfulStore('other', 'other preserved', 'other old');
    state.deleteReconciledBase('doc');

    const main = new DocumentDurabilityState('main', { persistencePath });
    expect(main.getReconciledBase('doc')).toBeUndefined();
    expect(main.getReconciledBase('other')).toBe('other preserved');
    const feature = new DocumentDurabilityState('feature/"quoted"', { persistencePath });
    expect(feature.getReconciledBase('doc')).toBe('feature acknowledged');
    expect(feature.isDisplacedVersion('doc', 'feature old')).toBe(false);
    expect(feature.getStaleExternalWrite('doc')).toMatchObject({
      diskContent: 'different rejected bytes',
      retainedContent: '',
    });
    feature.clearStaleExternalWrite('doc');
    expect(
      new DocumentDurabilityState('feature/"quoted"', { persistencePath }).getReconciledBase('doc'),
    ).toBeUndefined();
  });

  test('changing one document serializes only that row and retains untouched document bytes', () => {
    const { persistencePath, state } = setup();
    state.recordSuccessfulStore('doc', 'original', 'previous');
    state.recordSuccessfulStore('untouched', 'large preserved text '.repeat(1000), 'old untouched');
    const serialize = vi.spyOn(JSON, 'stringify');

    state.recordSuccessfulStore('doc', 'acknowledged', 'original');

    const objects = serialize.mock.calls
      .map(([value]) => value)
      .filter((value) => value !== null && typeof value === 'object');
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({ docName: 'doc', acknowledgedContent: 'acknowledged' });
    serialize.mockRestore();
    expect(
      new DocumentDurabilityState('main', { persistencePath }).getReconciledBase('untouched'),
    ).toBe('large preserved text '.repeat(1000));
  });

  test('a returned conflict changed in place invalidates its cached encoding on the next store', () => {
    const { persistencePath, state } = setup();
    state.recordSuccessfulStore('doc', 'acknowledged', 'old');
    const conflict = state.recordStaleExternalWrite('doc', 'old', 'first candidate');
    conflict.retainedContent = 'updated candidate';

    state.recordSuccessfulStore('other', 'other acknowledged', 'other old');

    expect(
      new DocumentDurabilityState('main', { persistencePath }).getStaleExternalWrite('doc')
        ?.retainedContent,
    ).toBe('updated candidate');
  });

  test('combined updates deduplicate and bound history without a separate expiry write', () => {
    vi.useFakeTimers();
    const { persistencePath, state } = setup();
    state.recordSuccessfulStore('doc', 'current', 'expired');
    vi.advanceTimersByTime(DISPLACED_VERSION_TTL_MS + 1);
    const writes = vi.spyOn(tracedFs, 'tracedWriteFileSync');
    state.recordSuccessfulStore('doc', 'current 2', 'fresh');
    expect(writes).toHaveBeenCalledTimes(1);
    for (let index = 0; index <= DISPLACED_VERSION_LIMIT; index += 1) {
      state.recordSuccessfulStore('doc', `current ${index}`, `old ${index}`);
    }
    state.recordSuccessfulStore('doc', 'final', `old ${DISPLACED_VERSION_LIMIT}`);

    const restored = new DocumentDurabilityState('main', { persistencePath });
    expect(restored.isDisplacedVersion('doc', 'expired')).toBe(false);
    expect(restored.isDisplacedVersion('doc', 'fresh')).toBe(false);
    expect(restored.isDisplacedVersion('doc', 'old 0')).toBe(false);
    expect(restored.isDisplacedVersion('doc', 'old 1')).toBe(true);
    expect(restored.isDisplacedVersion('doc', `old ${DISPLACED_VERSION_LIMIT}`)).toBe(true);
  });

  test('retains the v1 JSON byte shape including numeric branch ordering and escaped content', () => {
    vi.useFakeTimers();
    const { persistencePath, state } = setup();
    const at = Date.now();
    state.switchReconciledBaseScope('10');
    state.recordSuccessfulStore('doc', 'line\n"quote" 🍊', 'old ten');
    state.switchReconciledBaseScope('2');
    state.recordSuccessfulStore('doc', 'two', 'old two');
    expect(readFileSync(persistencePath, 'utf8')).toBe(
      JSON.stringify({
        version: 1,
        branches: {
          2: [
            {
              docName: 'doc',
              acknowledgedContent: 'two',
              displacedVersions: [{ hash: contentHash('old two'), at }],
            },
          ],
          10: [
            {
              docName: 'doc',
              acknowledgedContent: 'line\n"quote" 🍊',
              displacedVersions: [{ hash: contentHash('old ten'), at }],
            },
          ],
        },
      }),
    );
  });
});
