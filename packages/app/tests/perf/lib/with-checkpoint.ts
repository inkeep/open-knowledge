/**
 * Resume-after-crash primitive for long-running operations.
 *
 * Sweep campaigns and similar long-running probes run for hours; a
 * mid-run crash (Bun panic, OS reboot, terminal kill) should not force
 * the engineer to restart from input 0. This primitive flushes each
 * successful operation's result to disk so a re-run skips-replays
 * completed work and resumes from the missing inputs.
 *
 * Sweep-agnostic by design — `defineSweep` is the first consumer,
 * but any operation
 * with a stable per-input key qualifies: fuzz/stress harnesses,
 * replication probes, batch transcoders. The primitive intentionally
 * takes a generic `operation: (input) => Promise<output>` and a
 * `keyOf(input)` so it composes with anything that has stable inputs.
 *
 * Architectural contract:
 *
 *   - Inputs are processed in order; the returned array order matches
 *     `inputs` (NOT checkpoint-file order). Resume merges loaded
 *     entries into the in-memory map and the iteration order drives
 *     the output array, so the contract holds regardless of how the
 *     checkpoint file was written.
 *
 *   - Atomic writes (write-to-`.tmp` + rename) protect prior progress
 *     from partial-write corruption. A SIGKILL during flush leaves
 *     either the old file intact or the new file present — never a
 *     half-written file.
 *
 *   - `flushAfterEach: true` is the sweep-cell mode: every successful
 *     op flushes immediately. Survives SIGKILL between cells. Pay one
 *     fs.rename per cell.
 *
 *   - `flushAfterEach: false` is the sub-cell-replication mode:
 *     accumulate in memory, flush once at the end. Cheaper I/O when
 *     the inner unit is sub-second; ALSO flushes on error so prior
 *     successes are durable before the throw bubbles.
 *
 *   - On error from `operation`, the error is re-thrown to the caller
 *     AFTER prior successes are flushed. The caller does NOT get a
 *     partial result array — partial state lives on disk only.
 *
 *   - Corrupted / wrong-schema / missing-required-field checkpoint
 *     files are rejected with an actionable error referencing the
 *     path. The primitive never silently treats malformed state as a
 *     cold start — that risk would be far worse than the explicit
 *     "delete this file to start fresh" affordance.
 *
 *   - Output values must be JSON-serializable. `undefined` is rejected
 *     at flush time (cannot round-trip through `JSON.stringify`).
 *     `Date` instances serialize as ISO strings (caller's responsibility
 *     to revive on read if needed). Functions / symbols / circular
 *     references will throw.
 *
 * Naming + path convention:
 *
 *   `<outDir>/<harness>.<baselineKey>.checkpoint.json`
 *
 *   The caller constructs the path. The substrate primitive does NOT
 *   construct paths from harness/baselineKey — that's the consumer's
 *   responsibility, mirroring `defineSweep`'s `baselineKey` ownership.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 1 as const;

interface CheckpointEntry<TOutput> {
  readonly key: string;
  readonly output: TOutput;
  readonly recordedAt: string;
}

interface CheckpointFile<TOutput> {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly entries: ReadonlyArray<CheckpointEntry<TOutput>>;
}

export interface WithCheckpointConfig<TInput> {
  /**
   * Absolute path to the checkpoint file. Caller-constructed
   * (`<outDir>/<harness>.<baselineKey>.checkpoint.json` is the
   * convention). Parent directory is auto-created on first flush.
   */
  readonly checkpointPath: string;

  /**
   * Map an input to its stable identifying string. The key MUST be
   * unique across the entire `inputs` array (collisions surface as a
   * caller-bug error). Stable across runs — that's how resume
   * identifies which inputs are already done.
   */
  readonly keyOf: (input: TInput) => string;

  /**
   * `true`  — flush after every successful operation (sweep-cell mode;
   *           survives SIGKILL between cells; one fs.rename per op).
   * `false` — accumulate in memory, flush once at end (or on error).
   *           Cheaper for high-frequency inner units; loses partial
   *           progress on SIGKILL.
   */
  readonly flushAfterEach: boolean;
}

/**
 * Run `operation` over each `inputs[i]`, persisting successful results
 * to a checkpoint file at `config.checkpointPath` so a re-run resumes
 * from the missing inputs. See module-level JSDoc for the full
 * architectural contract.
 *
 * Returns the array of outputs in `inputs` order. Throws if:
 *   - `keyOf` produces duplicate keys for distinct inputs (caller bug);
 *   - the existing checkpoint file is malformed (parse / schema /
 *     entry-shape errors);
 *   - the `operation` throws (re-thrown after prior successes flush).
 *
 * @example
 *   const cells = await withCheckpoint(
 *     async (input) => runOneCell(input),
 *     sweepCellInputs,
 *     {
 *       checkpointPath: `${outDir}/sweep-cache-regime.${baselineKey}.checkpoint.json`,
 *       keyOf: (c) => `${c.fixture}.${c.maxPool}.${c.maxCache}.${c.activity}`,
 *       flushAfterEach: true,
 *     },
 *   );
 */
export async function withCheckpoint<TInput, TOutput>(
  operation: (input: TInput) => Promise<TOutput>,
  inputs: ReadonlyArray<TInput>,
  config: WithCheckpointConfig<TInput>,
): Promise<ReadonlyArray<TOutput>> {
  if (inputs.length === 0) return [];

  const inputKeysInOrder: string[] = inputs.map(config.keyOf);
  const duplicates = findDuplicateKeys(inputKeysInOrder);
  if (duplicates.length > 0) {
    throw new Error(
      `withCheckpoint: keyOf produced duplicate keys for distinct inputs ` +
        `(programmer error — inputs must map 1:1 to keys). ` +
        `Duplicates: ${duplicates.join(', ')}`,
    );
  }

  const completed = await readCheckpoint<TOutput>(config.checkpointPath);

  const outputs: TOutput[] = [];
  let pendingError: unknown = null;

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i] as TInput;
    const key = inputKeysInOrder[i] as string;
    const prior = completed.get(key);
    if (prior !== undefined) {
      outputs.push(prior.output);
      continue;
    }

    let result: TOutput;
    try {
      result = await operation(input);
    } catch (err) {
      pendingError = err;
      break;
    }

    completed.set(key, { output: result, recordedAt: new Date().toISOString() });
    outputs.push(result);

    if (config.flushAfterEach) {
      await flushCheckpoint(config.checkpointPath, inputKeysInOrder, completed);
    }
  }

  // flushAfterEach=false: we've accumulated all results in memory;
  // flush exactly once at the end (or before the throw bubbles).
  // flushAfterEach=true:  per-cell flushes already covered the
  // success path. On error mid-stream, the LAST successful cell's
  // flush is durable; no extra write needed.
  //
  // If both pendingError AND the final flush fail (e.g. ENOSPC during
  // flush after an upstream operation threw), we surface both — losing
  // the original operation error to a downstream filesystem failure
  // would force the engineer to fix the disk, re-run the campaign, and
  // re-discover the operation failure with no diagnostic trail. The
  // AggregateError carries both causes so a single inspection surfaces
  // root-cause + secondary-failure.
  if (!config.flushAfterEach) {
    try {
      await flushCheckpoint(config.checkpointPath, inputKeysInOrder, completed);
    } catch (flushErr) {
      if (pendingError !== null) {
        throw new AggregateError(
          [pendingError, flushErr],
          'withCheckpoint: operation failed AND final flush failed. Prior successes may not be durable. Inspect .errors for both causes.',
        );
      }
      throw flushErr;
    }
  }

  if (pendingError !== null) throw pendingError;

  return outputs;
}

// ──────────────────────────── Helpers ─────────────────────────────

interface InMemoryEntry<TOutput> {
  readonly output: TOutput;
  readonly recordedAt: string;
}

function findDuplicateKeys(keys: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const k of keys) {
    if (seen.has(k)) duplicates.push(k);
    seen.add(k);
  }
  return duplicates;
}

async function readCheckpoint<TOutput>(path: string): Promise<Map<string, InMemoryEntry<TOutput>>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isNoEnt(err)) return new Map();
    throw new Error(
      `withCheckpoint: failed to read checkpoint at ${path}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `withCheckpoint: checkpoint at ${path} is not valid JSON ` +
        `(corrupted? delete the file to start fresh). Parse error: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return validateCheckpoint<TOutput>(parsed, path);
}

function validateCheckpoint<TOutput>(
  parsed: unknown,
  path: string,
): Map<string, InMemoryEntry<TOutput>> {
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(
      `withCheckpoint: checkpoint at ${path} is not a JSON object ` +
        `(corrupted? delete the file to start fresh).`,
    );
  }
  if (!('schemaVersion' in parsed)) {
    throw new Error(
      `withCheckpoint: checkpoint at ${path} is missing 'schemaVersion' field ` +
        `(corrupted or pre-versioned? delete the file to start fresh).`,
    );
  }
  const schemaVersion = (parsed as { schemaVersion: unknown }).schemaVersion;
  if (schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `withCheckpoint: checkpoint at ${path} has schemaVersion ` +
        `${String(schemaVersion)}, expected ${SCHEMA_VERSION}. ` +
        `The checkpoint format has changed; delete the file to start fresh.`,
    );
  }
  if (!('entries' in parsed)) {
    throw new Error(
      `withCheckpoint: checkpoint at ${path} is missing 'entries' field ` +
        `(corrupted? delete the file to start fresh).`,
    );
  }
  const entries = (parsed as { entries: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new Error(
      `withCheckpoint: checkpoint at ${path} has non-array 'entries' ` +
        `(corrupted? delete the file to start fresh).`,
    );
  }

  const map = new Map<string, InMemoryEntry<TOutput>>();
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(
        `withCheckpoint: checkpoint at ${path} contains a non-object entry ` +
          `(corrupted? delete the file to start fresh).`,
      );
    }
    if (!('key' in entry) || !('output' in entry) || !('recordedAt' in entry)) {
      throw new Error(
        `withCheckpoint: checkpoint at ${path} contains an entry missing ` +
          `key/output/recordedAt (corrupted? delete the file to start fresh).`,
      );
    }
    const { key, output, recordedAt } = entry as {
      key: unknown;
      output: unknown;
      recordedAt: unknown;
    };
    if (typeof key !== 'string') {
      throw new Error(
        `withCheckpoint: checkpoint at ${path} contains a non-string key ` +
          `(corrupted? delete the file to start fresh).`,
      );
    }
    if (typeof recordedAt !== 'string') {
      throw new Error(
        `withCheckpoint: checkpoint at ${path} contains a non-string recordedAt ` +
          `(corrupted? delete the file to start fresh).`,
      );
    }
    map.set(key, { output: output as TOutput, recordedAt });
  }
  return map;
}

async function flushCheckpoint<TOutput>(
  path: string,
  inputKeysInOrder: ReadonlyArray<string>,
  completed: ReadonlyMap<string, InMemoryEntry<TOutput>>,
): Promise<void> {
  const entries: Array<CheckpointEntry<TOutput>> = [];
  for (const key of inputKeysInOrder) {
    const e = completed.get(key);
    if (e !== undefined) {
      entries.push({ key, output: e.output, recordedAt: e.recordedAt });
    }
  }
  const file: CheckpointFile<TOutput> = {
    schemaVersion: SCHEMA_VERSION,
    entries,
  };
  const tmpPath = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  await rename(tmpPath, path);
}

function isNoEnt(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
