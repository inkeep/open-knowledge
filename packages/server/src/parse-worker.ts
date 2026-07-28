/**
 * Markdown parse worker — the compute half of the bridge-intake parse
 * offload (`parse-pool.ts`).
 *
 * PURE COMPUTE ONLY: markdown body bytes in, ProseMirror JSON out. No
 * Y.js type ever crosses this boundary (Y.Doc / Y.Text are not
 * structured-clonable), no fs access, no session or document state. All
 * CRDT mutation stays on the main thread inside the caller's
 * `doc.transact(..., origin)` and the bridge-intake primitives.
 *
 * Embed resolution (`![[photo.png]]` → disk path) needs the server's
 * basename index and fs, so it cannot run here. The two-pass protocol
 * keeps it exact without duplicating resolver logic: pass 1 parses with a
 * recording resolver and reports which targets the parser actually asked
 * for; the pool resolves those on the main thread and dispatches pass 2
 * with a plain-object table. A doc with no wiki-embeds (the common case)
 * completes in pass 1 because the recording resolver is never invoked.
 *
 * Output is byte-identical to an inline `mdManager.parseWithFallback`
 * call: both sides load the same `md-manager.ts` configuration (same
 * `sharedExtensions`, same pinned+patched markdown dependencies out of
 * the same install). `parse-pool.test.ts` pins the equivalence.
 */
import { parentPort } from 'node:worker_threads';
import type { JSONContent } from '@tiptap/core';
import { mdManager } from './md-manager.ts';

/** One embed target's main-thread resolution, shipped to pass 2. */
export interface ParseWorkerEmbedResolution {
  path: string | null;
  size: number | null;
}

export interface ParseWorkerTask {
  id: number;
  /** Frontmatter-free markdown body (callers strip the YAML region first). */
  body: string;
  /** docName threaded to the embed resolvers for shortest-path computation. */
  sourcePath?: string;
  /** Pass 1: install a recording resolver (caller has a live resolver). */
  recordEmbeds?: boolean;
  /**
   * Mirror the presence of the caller's `resolveSize`. The parse handlers
   * key behavior off resolver PRESENCE, so the worker must not install a
   * size resolver the inline path would not have had.
   */
  wantSizes?: boolean;
  /** Pass 2: resolved embed table keyed by the pass-1 recorded targets. */
  embedTable?: Record<string, ParseWorkerEmbedResolution>;
}

export type ParseWorkerResult =
  | { id: number; ok: true; parsedJson: JSONContent; requestedTargets?: string[] }
  | { id: number; ok: false; message: string };

function runTask(task: ParseWorkerTask): ParseWorkerResult {
  try {
    let requested: Set<string> | undefined;
    let opts:
      | {
          sourcePath: string;
          resolveEmbed: (target: string, sourcePath: string) => string | null;
          resolveSize?: (target: string, sourcePath: string) => number | null;
        }
      | undefined;
    if (task.embedTable !== undefined && task.sourcePath !== undefined) {
      const table = task.embedTable;
      opts = {
        sourcePath: task.sourcePath,
        resolveEmbed: (target) => table[target]?.path ?? null,
        ...(task.wantSizes ? { resolveSize: (target) => table[target]?.size ?? null } : {}),
      };
    } else if (task.recordEmbeds && task.sourcePath !== undefined) {
      const record = new Set<string>();
      requested = record;
      opts = {
        sourcePath: task.sourcePath,
        resolveEmbed: (target) => {
          record.add(target);
          return null;
        },
        ...(task.wantSizes
          ? {
              resolveSize: (target: string) => {
                record.add(target);
                return null;
              },
            }
          : {}),
      };
    }
    const parsedJson = mdManager.parseWithFallback(task.body, opts);
    return requested !== undefined && requested.size > 0
      ? { id: task.id, ok: true, parsedJson, requestedTargets: [...requested] }
      : { id: task.id, ok: true, parsedJson };
  } catch (err) {
    // parseWithFallback never throws by contract; this catch is the wire-
    // level backstop so a worker bug degrades to the pool's inline
    // fallback instead of an unhandled worker crash.
    return {
      id: task.id,
      ok: false,
      message: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
    };
  }
}

parentPort?.on('message', (task: ParseWorkerTask) => {
  parentPort?.postMessage(runTask(task));
});
