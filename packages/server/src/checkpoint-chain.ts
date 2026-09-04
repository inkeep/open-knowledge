import {
  isChainAnchorCheckpointKind,
  parseCheckpoint,
} from '@inkeep/open-knowledge-core/shadow-repo-layout';
import type { SimpleGit } from 'simple-git';
import { getLogger } from './logger.ts';

const log = getLogger('checkpoint-chain');

const SHA_LENGTH = 40;

export async function resolveCheckpointChainAnchors(
  sg: SimpleGit,
  branch: string,
): Promise<string[]> {
  let refOutput: string;
  try {
    refOutput = await sg.raw(
      'for-each-ref',
      '--format=%(objectname)',
      `refs/checkpoints/${branch}/`,
    );
  } catch (err) {
    log.warn({ branch, err }, '[checkpoint-chain] for-each-ref failed; anchors are unknown');
    throw err;
  }

  const shas = refOutput
    .trim()
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length === SHA_LENGTH);
  if (shas.length === 0) return [];

  let logRaw: string;
  try {
    logRaw = await sg.raw('log', '--no-walk', '--format=%H%x00%B%x1e', ...shas);
  } catch (err) {
    log.warn(
      { branch, shaCount: shas.length, err },
      '[checkpoint-chain] checkpoint body read failed; anchors are unknown',
    );
    throw err;
  }

  const anchors: string[] = [];
  for (const record of logRaw.split('\x1e')) {
    const trimmed = record.trimStart();
    if (!trimmed) continue;
    const [sha = '', body = ''] = trimmed.split('\x00');
    if (sha.length !== SHA_LENGTH) continue;
    if (isChainAnchorCheckpointKind(parseCheckpoint(body)?.kind ?? null)) anchors.push(sha);
  }
  if (anchors.length <= 1) return anchors;

  try {
    const independent = await sg.raw('merge-base', '--independent', ...anchors);
    const tips = independent
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length === SHA_LENGTH);
    return tips.length > 0 ? tips : anchors;
  } catch (err) {
    log.warn(
      { branch, anchorCount: anchors.length, err },
      '[checkpoint-chain] tip reduction failed; adopting the full anchor set',
    );
    return anchors;
  }
}
