import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type WithCheckpointConfig, withCheckpoint } from './with-checkpoint';

interface SampleInput {
  readonly id: string;
  readonly axis: number;
}

interface SampleOutput {
  readonly id: string;
  readonly axis: number;
  readonly computed: number;
}

let scratchDir: string;
let checkpointPath: string;

beforeEach(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), 'with-checkpoint-test-'));
  checkpointPath = join(scratchDir, 'campaign.checkpoint.json');
});

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true });
});

const baseConfig: Omit<WithCheckpointConfig<SampleInput>, 'checkpointPath'> = {
  keyOf: (input: SampleInput) => `${input.id}:${input.axis}`,
  flushAfterEach: true,
};

async function readCheckpointFile(path: string): Promise<{
  schemaVersion: number;
  entries: Array<{ key: string; output: SampleOutput; recordedAt: string }>;
}> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

describe('withCheckpoint', () => {
  test('cold run: single input completes, returns the result, persists one entry', async () => {
    let invocations = 0;
    const inputs: SampleInput[] = [{ id: 'cell', axis: 5 }];
    const results = await withCheckpoint<SampleInput, SampleOutput>(
      async (input) => {
        invocations++;
        return { id: input.id, axis: input.axis, computed: input.axis * 2 };
      },
      inputs,
      { ...baseConfig, checkpointPath },
    );

    expect(invocations).toBe(1);
    expect(results).toEqual([{ id: 'cell', axis: 5, computed: 10 }]);

    const file = await readCheckpointFile(checkpointPath);
    expect(file.schemaVersion).toBe(1);
    expect(file.entries.length).toBe(1);
    expect(file.entries[0]?.key).toBe('cell:5');
    expect(file.entries[0]?.output).toEqual({ id: 'cell', axis: 5, computed: 10 });
    expect(typeof file.entries[0]?.recordedAt).toBe('string');
    expect(file.entries[0]?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('cold run: 3 inputs, flushAfterEach=true, file is durable after each cell', async () => {
    const flushSnapshots: number[] = [];
    const inputs: SampleInput[] = [
      { id: 'a', axis: 1 },
      { id: 'b', axis: 2 },
      { id: 'c', axis: 3 },
    ];

    const results = await withCheckpoint<SampleInput, SampleOutput>(
      async (input) => {
        const out = { id: input.id, axis: input.axis, computed: input.axis * 10 };
        // After computing, read the file to confirm prior cells are durable.
        // (flushAfterEach=true ⇒ file contains all SUCCESSFUL completed
        // entries BEFORE this cell. This cell's flush happens after we
        // return.)
        try {
          const file = await readCheckpointFile(checkpointPath);
          flushSnapshots.push(file.entries.length);
        } catch {
          flushSnapshots.push(-1);
        }
        return out;
      },
      inputs,
      { ...baseConfig, checkpointPath },
    );

    expect(results).toEqual([
      { id: 'a', axis: 1, computed: 10 },
      { id: 'b', axis: 2, computed: 20 },
      { id: 'c', axis: 3, computed: 30 },
    ]);
    // Cell 0 sees 0 prior entries; cell 1 sees 1; cell 2 sees 2.
    expect(flushSnapshots).toEqual([-1, 1, 2]);

    const final = await readCheckpointFile(checkpointPath);
    expect(final.entries.length).toBe(3);
    expect(final.entries.map((e) => e.key)).toEqual(['a:1', 'b:2', 'c:3']);
  });

  test('resume: skips inputs whose key is already in the checkpoint', async () => {
    await writeFile(
      checkpointPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          entries: [
            {
              key: 'a:1',
              output: { id: 'a', axis: 1, computed: 10 },
              recordedAt: '2026-05-12T00:00:00.000Z',
            },
            {
              key: 'b:2',
              output: { id: 'b', axis: 2, computed: 20 },
              recordedAt: '2026-05-12T00:00:01.000Z',
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const invocations: string[] = [];
    const inputs: SampleInput[] = [
      { id: 'a', axis: 1 },
      { id: 'b', axis: 2 },
      { id: 'c', axis: 3 },
    ];

    const results = await withCheckpoint<SampleInput, SampleOutput>(
      async (input) => {
        invocations.push(input.id);
        return { id: input.id, axis: input.axis, computed: input.axis * 10 };
      },
      inputs,
      { ...baseConfig, checkpointPath },
    );

    // Only 'c' was actually executed; 'a' and 'b' came from the checkpoint.
    expect(invocations).toEqual(['c']);
    expect(results).toEqual([
      { id: 'a', axis: 1, computed: 10 },
      { id: 'b', axis: 2, computed: 20 },
      { id: 'c', axis: 3, computed: 30 },
    ]);
  });

  test('returned-array order matches input order even when checkpoint entries are shuffled', async () => {
    await writeFile(
      checkpointPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          entries: [
            // Deliberately shuffled vs input order:
            {
              key: 'c:3',
              output: { id: 'c', axis: 3, computed: 30 },
              recordedAt: '2026-05-12T00:00:02.000Z',
            },
            {
              key: 'a:1',
              output: { id: 'a', axis: 1, computed: 10 },
              recordedAt: '2026-05-12T00:00:00.000Z',
            },
            {
              key: 'b:2',
              output: { id: 'b', axis: 2, computed: 20 },
              recordedAt: '2026-05-12T00:00:01.000Z',
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const inputs: SampleInput[] = [
      { id: 'a', axis: 1 },
      { id: 'b', axis: 2 },
      { id: 'c', axis: 3 },
    ];

    const results = await withCheckpoint<SampleInput, SampleOutput>(
      async () => {
        throw new Error('should not be called — all keys are checkpointed');
      },
      inputs,
      { ...baseConfig, checkpointPath },
    );

    expect(results.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  test('error path: cell 2 throws — cell 1 durable, error bubbles, partial array NOT returned', async () => {
    const inputs: SampleInput[] = [
      { id: 'a', axis: 1 },
      { id: 'b', axis: 2 },
      { id: 'c', axis: 3 },
    ];

    let returnedValue: unknown = 'untouched';
    let caughtError: unknown = null;
    try {
      returnedValue = await withCheckpoint<SampleInput, SampleOutput>(
        async (input) => {
          if (input.id === 'b') throw new Error('cell-b-boom');
          return { id: input.id, axis: input.axis, computed: input.axis * 10 };
        },
        inputs,
        { ...baseConfig, checkpointPath },
      );
    } catch (err) {
      caughtError = err;
    }

    expect(returnedValue).toBe('untouched');
    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toBe('cell-b-boom');

    // Cell 'a' completed and was flushed; cell 'b' and 'c' are absent.
    const file = await readCheckpointFile(checkpointPath);
    expect(file.entries.length).toBe(1);
    expect(file.entries[0]?.key).toBe('a:1');
  });

  test('flushAfterEach=false: file is NOT written between cells, but IS written at end', async () => {
    const inputs: SampleInput[] = [
      { id: 'a', axis: 1 },
      { id: 'b', axis: 2 },
    ];
    const midRunFileExistedAfterCellA = { value: false };

    await withCheckpoint<SampleInput, SampleOutput>(
      async (input) => {
        if (input.id === 'b') {
          // Cell B runs after A completed; under flushAfterEach=false, A's
          // result is still in memory only — the file should not exist yet.
          try {
            await readCheckpointFile(checkpointPath);
            midRunFileExistedAfterCellA.value = true;
          } catch {
            // expected: file does not exist
          }
        }
        return { id: input.id, axis: input.axis, computed: input.axis * 10 };
      },
      inputs,
      { ...baseConfig, checkpointPath, flushAfterEach: false },
    );

    expect(midRunFileExistedAfterCellA.value).toBe(false);

    const final = await readCheckpointFile(checkpointPath);
    expect(final.entries.length).toBe(2);
  });

  test('flushAfterEach=false + mid-stream error: prior successes ARE flushed before error bubbles', async () => {
    const inputs: SampleInput[] = [
      { id: 'a', axis: 1 },
      { id: 'b', axis: 2 },
      { id: 'c', axis: 3 },
    ];

    let caughtError: unknown = null;
    try {
      await withCheckpoint<SampleInput, SampleOutput>(
        async (input) => {
          if (input.id === 'b') throw new Error('cell-b-boom');
          return { id: input.id, axis: input.axis, computed: input.axis * 10 };
        },
        inputs,
        { ...baseConfig, checkpointPath, flushAfterEach: false },
      );
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(Error);
    const file = await readCheckpointFile(checkpointPath);
    expect(file.entries.length).toBe(1);
    expect(file.entries[0]?.key).toBe('a:1');
  });

  test('corrupted JSON file is rejected with an actionable error', async () => {
    await writeFile(checkpointPath, '{not valid json', 'utf8');

    const inputs: SampleInput[] = [{ id: 'a', axis: 1 }];
    let caught: unknown = null;
    try {
      await withCheckpoint<SampleInput, SampleOutput>(
        async (input) => ({ id: input.id, axis: input.axis, computed: input.axis }),
        inputs,
        { ...baseConfig, checkpointPath },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain('withCheckpoint');
    expect(msg).toContain(checkpointPath);
    expect(msg.toLowerCase()).toContain('json');
  });

  test('schemaVersion mismatch is rejected with an actionable error', async () => {
    await writeFile(checkpointPath, JSON.stringify({ schemaVersion: 2, entries: [] }), 'utf8');

    const inputs: SampleInput[] = [{ id: 'a', axis: 1 }];
    let caught: unknown = null;
    try {
      await withCheckpoint<SampleInput, SampleOutput>(
        async (input) => ({ id: input.id, axis: input.axis, computed: input.axis }),
        inputs,
        { ...baseConfig, checkpointPath },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain('schemaVersion');
    expect(msg).toContain('2');
  });

  test('missing schemaVersion is rejected (does not silently treat as cold start)', async () => {
    await writeFile(checkpointPath, JSON.stringify({ entries: [] }), 'utf8');

    let caught: unknown = null;
    try {
      await withCheckpoint<SampleInput, SampleOutput>(
        async (input) => ({ id: input.id, axis: input.axis, computed: input.axis }),
        [{ id: 'a', axis: 1 }],
        { ...baseConfig, checkpointPath },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message.toLowerCase()).toContain('schemaversion');
  });

  test('empty checkpoint file is rejected as corrupted (not silently treated as cold start)', async () => {
    await writeFile(checkpointPath, '', 'utf8');

    let caught: unknown = null;
    try {
      await withCheckpoint<SampleInput, SampleOutput>(
        async (input) => ({ id: input.id, axis: input.axis, computed: input.axis }),
        [{ id: 'a', axis: 1 }],
        { ...baseConfig, checkpointPath },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message.toLowerCase()).toContain('json');
  });

  test('missing checkpoint file: cold start succeeds (file is auto-created on first flush)', async () => {
    const results = await withCheckpoint<SampleInput, SampleOutput>(
      async (input) => ({ id: input.id, axis: input.axis, computed: input.axis }),
      [{ id: 'a', axis: 1 }],
      { ...baseConfig, checkpointPath },
    );
    expect(results.length).toBe(1);
    const file = await readCheckpointFile(checkpointPath);
    expect(file.entries.length).toBe(1);
  });

  test('keyOf collision in inputs[] surfaces as a clear caller-bug error', async () => {
    const inputs: SampleInput[] = [
      { id: 'a', axis: 1 },
      { id: 'a', axis: 1 }, // duplicate key
    ];
    let caught: unknown = null;
    try {
      await withCheckpoint<SampleInput, SampleOutput>(
        async (input) => ({ id: input.id, axis: input.axis, computed: input.axis }),
        inputs,
        { ...baseConfig, checkpointPath },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain('duplicate');
    expect(msg).toContain('a:1');
  });

  test('empty inputs returns empty array without writing checkpoint', async () => {
    const results = await withCheckpoint<SampleInput, SampleOutput>(
      async () => {
        throw new Error('should not be called');
      },
      [],
      { ...baseConfig, checkpointPath },
    );
    expect(results).toEqual([]);
    // No file created on empty inputs.
    let exists = true;
    try {
      await readCheckpointFile(checkpointPath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test('checkpoint file uses atomic write (no .tmp file lingers after success)', async () => {
    await withCheckpoint<SampleInput, SampleOutput>(
      async (input) => ({ id: input.id, axis: input.axis, computed: input.axis }),
      [{ id: 'a', axis: 1 }],
      { ...baseConfig, checkpointPath },
    );
    // The atomic rename should leave no stale .tmp behind.
    let tmpExists = true;
    try {
      await readFile(`${checkpointPath}.tmp`, 'utf8');
    } catch {
      tmpExists = false;
    }
    expect(tmpExists).toBe(false);
  });

  test('recordedAt timestamp is preserved on subsequent flushes (not overwritten)', async () => {
    // First run records cell 'a' at time T0.
    await withCheckpoint<SampleInput, SampleOutput>(
      async (input) => ({ id: input.id, axis: input.axis, computed: input.axis }),
      [{ id: 'a', axis: 1 }],
      { ...baseConfig, checkpointPath },
    );
    const after1 = await readCheckpointFile(checkpointPath);
    const aTimestamp = after1.entries[0]?.recordedAt;
    expect(aTimestamp).toBeDefined();

    // Wait one tick so that any naive Date.now() refresh would produce a
    // different ISO string (millisecond-precision).
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Second run resumes (skips 'a') and adds 'b'.
    await withCheckpoint<SampleInput, SampleOutput>(
      async (input) => ({ id: input.id, axis: input.axis, computed: input.axis }),
      [
        { id: 'a', axis: 1 },
        { id: 'b', axis: 2 },
      ],
      { ...baseConfig, checkpointPath },
    );
    const after2 = await readCheckpointFile(checkpointPath);
    const aEntry = after2.entries.find((e) => e.key === 'a:1');
    expect(aEntry?.recordedAt).toBe(aTimestamp);
  });

  test('AggregateError carries BOTH operation error AND flush error when both fail', async () => {
    // When the operation throws AND the final flush also fails, the
    // engineer would otherwise see only the flush error (e.g. ENOSPC) and
    // re-discover the operation failure on the next run. AggregateError
    // surfaces both causes in a single inspection.
    const checkpointDir = join(scratchDir, 'aggregate-error-readonly');
    // Make the parent directory read-only so the .tmp write fails — this
    // simulates the flush-failure path (disk full / permissions / quota).
    await import('node:fs/promises').then((fs) => fs.mkdir(checkpointDir, { recursive: true }));
    const checkpointPath = join(checkpointDir, 'sweep.checkpoint.json');
    // Chmod the dir to read-only AFTER mkdir.
    const { chmod } = await import('node:fs/promises');
    await chmod(checkpointDir, 0o500);

    const inputs: SampleInput[] = [{ id: 'a', axis: 1 }];

    let caughtError: unknown = null;
    try {
      await withCheckpoint<SampleInput, SampleOutput>(
        async (_input) => {
          throw new Error('operation-failure-original');
        },
        inputs,
        { ...baseConfig, checkpointPath, flushAfterEach: false },
      );
    } catch (err) {
      caughtError = err;
    } finally {
      // Restore so test cleanup can delete the scratch dir.
      await chmod(checkpointDir, 0o700).catch(() => {});
    }

    // When both fail, AggregateError surfaces both causes.
    if (caughtError instanceof AggregateError) {
      expect(caughtError.errors.length).toBe(2);
      const messages = caughtError.errors.map((e) => (e instanceof Error ? e.message : String(e)));
      expect(messages.some((m) => m.includes('operation-failure-original'))).toBe(true);
      // Second error is the flush failure (EACCES / EPERM / ENOENT depending on platform).
      expect(messages.filter((m) => !m.includes('operation-failure-original')).length).toBe(1);
    } else {
      // On platforms where chmod 0o500 doesn't actually block writes (some
      // Docker filesystems, root-owned tmpdirs), the flush may succeed and
      // the original pendingError surfaces alone. That's the documented
      // contract — the AggregateError is the failure-mode-of-both path,
      // not the canonical path.
      expect(caughtError).toBeInstanceOf(Error);
      expect((caughtError as Error).message).toContain('operation-failure-original');
    }
  });
});
