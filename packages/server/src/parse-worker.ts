import { parentPort } from 'node:worker_threads';
import type { JSONContent } from '@tiptap/core';
import { mdManager } from './md-manager.ts';

export interface ParseWorkerEmbedResolution {
  path: string | null;
  size: number | null;
}

export interface ParseWorkerTask {
  id: number;
  body: string;
  sourcePath?: string;
  recordEmbeds?: boolean;
  wantSizes?: boolean;
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
