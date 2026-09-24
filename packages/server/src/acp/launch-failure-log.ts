import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ACP_LAUNCH_FAILURE_LOG, spawnErrorLogOpenMode } from '@inkeep/open-knowledge-core';
import type { ThreadFailureDetail } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { tracedAppendFile, tracedWriteFile } from '../fs-traced.ts';
import { redactDiagnostic } from './diagnostics.ts';

export type AcpLaunchFailureReason = Extract<
  ThreadFailureDetail['reason'],
  'connect' | 'session-setup'
>;

export function isAcpLaunchFailureReason(
  reason: ThreadFailureDetail['reason'],
): reason is AcpLaunchFailureReason {
  return reason === 'connect' || reason === 'session-setup';
}

export interface AcpLaunchFailureEntry {
  at: Date;
  threadId: string;
  agentId: string;
  agentSource: 'registry' | 'custom';
  reason: AcpLaunchFailureReason;
  detail: string | undefined;
  machineDetail: string | undefined;
}

export function acpLaunchFailureLogPath(localDir: string): string {
  return join(localDir, ACP_LAUNCH_FAILURE_LOG);
}

function formatAcpLaunchFailureEntry(entry: AcpLaunchFailureEntry): string {
  const lines = [
    `=== acp launch failure ${entry.at.toISOString()} thread=${entry.threadId} agent=${entry.agentId} source=${entry.agentSource} reason=${entry.reason} ===`,
  ];
  if (entry.detail !== undefined && entry.detail !== '') lines.push(entry.detail);
  if (entry.machineDetail !== undefined && entry.machineDetail !== '') {
    lines.push('--- stderr tail ---', entry.machineDetail);
  }
  return redactDiagnostic(`${lines.join('\n')}\n\n`);
}

const pendingWrites = new Map<string, Promise<void>>();

export function recordAcpLaunchFailure(
  localDir: string,
  entry: AcpLaunchFailureEntry,
): Promise<void> {
  const path = acpLaunchFailureLogPath(localDir);
  const text = formatAcpLaunchFailureEntry(entry);
  const previous = pendingWrites.get(path) ?? Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(async () => {
      const currentSize = await stat(path).then(
        (stats) => stats.size,
        () => undefined,
      );
      if (spawnErrorLogOpenMode(currentSize) === 'w') await tracedWriteFile(path, text);
      else await tracedAppendFile(path, text);
    });
  pendingWrites.set(path, write);
  void write.finally(() => {
    if (pendingWrites.get(path) === write) pendingWrites.delete(path);
  });
  return write;
}
