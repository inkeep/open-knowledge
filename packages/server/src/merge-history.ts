import type { ParsedCheckpoint } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import type { DocNoticeSink } from './doc-notices.ts';
import { getLogger } from './logger.ts';
import {
  incrementMergeHistoryCheckpointCreated,
  incrementMergeHistoryCheckpointFailures,
  incrementMergeHistoryUnavailable,
} from './metrics.ts';
import { countKeptBlocks, type KeptBlockPair } from './reconciliation.ts';
import {
  type InMemoryCheckpointParams,
  type ShadowHandle,
  saveInMemoryCheckpoint,
} from './shadow-repo.ts';

type KeptLiveMetadata = Extract<
  ParsedCheckpoint,
  { kind: 'external-change-kept-live' }
>['metadata'];

type MergeSide = KeptLiveMetadata['side'];

type MergeHistoryParams = Extract<
  InMemoryCheckpointParams,
  { kind: 'external-change-both-kept' | 'external-change-kept-live' }
>;

export interface MergeHistoryRecorder {
  bothKept(
    docName: string,
    versions: Readonly<Record<MergeSide, string>>,
    kept: readonly KeptBlockPair[],
  ): void;
  keptLive(
    docName: string,
    displaced: { side: MergeSide; bytes: string },
    reason: KeptLiveMetadata['reason'],
  ): Promise<boolean>;
}

export type MergeHistoryWriter = typeof saveInMemoryCheckpoint;

export interface MergeHistoryRecorderOptions {
  getShadow: () => ShadowHandle | null | undefined;
  contentRoot: string;
  getBranch: () => string | null;
  writeCheckpoint?: MergeHistoryWriter;
  notices?: DocNoticeSink;
}

const log = getLogger('reconcile');

const SIDE_LABEL: Record<MergeSide, string> = {
  ours: 'Version here',
  theirs: 'Outside version',
};

export function createMergeHistoryRecorder(
  options: MergeHistoryRecorderOptions,
): MergeHistoryRecorder {
  const writeCheckpoint = options.writeCheckpoint ?? saveInMemoryCheckpoint;
  const write = (shadow: ShadowHandle, params: MergeHistoryParams): Promise<string | null> =>
    writeCheckpoint(shadow, options.contentRoot, params).then(
      (sha) => {
        incrementMergeHistoryCheckpointCreated();
        log.info(
          { docName: params.docName, kind: params.kind, side: params.metadata.side, sha },
          `[reconcile] history entry saved (${params.kind}, ${params.metadata.side}): ${params.docName}`,
        );
        return sha;
      },
      (err: unknown) => {
        incrementMergeHistoryCheckpointFailures();
        log.error(
          { err, docName: params.docName, kind: params.kind, side: params.metadata.side },
          `[reconcile] history entry write failed (${params.kind}, ${params.metadata.side}): ${params.docName}`,
        );
        return null;
      },
    );

  const unavailable = (docName: string, kind: MergeHistoryParams['kind']): void => {
    incrementMergeHistoryUnavailable();
    log.info(
      { docName, kind },
      `[reconcile] history entry not saved for ${docName} (${kind}): the shadow repo is unavailable`,
    );
  };

  return {
    bothKept(docName, versions, kept) {
      const counts = countKeptBlocks(kept);
      const branch = options.getBranch() ?? 'main';
      const noticeId =
        options.notices?.record(docName, branch, { kind: 'both-kept', kept: counts }) ?? null;
      const shadow = options.getShadow();
      if (!shadow) {
        unavailable(docName, 'external-change-both-kept');
        return;
      }
      const at = new Date().toISOString();
      for (const side of ['ours', 'theirs'] as const) {
        const params: MergeHistoryParams = {
          kind: 'external-change-both-kept',
          docName,
          contents: versions[side],
          label: `${SIDE_LABEL[side]} before both versions were kept @ ${at}`,
          branch,
          metadata: { side, keptBlocks: counts.duplicated },
        };
        queueMicrotask(() => {
          void write(shadow, params).then((sha) => {
            if (sha !== null && noticeId !== null) {
              options.notices?.attachEntry(docName, noticeId, sha);
            }
          });
        });
      }
    },

    async keptLive(docName, displaced, reason) {
      const shadow = options.getShadow();
      if (!shadow) {
        unavailable(docName, 'external-change-kept-live');
        return false;
      }
      const branch = options.getBranch() ?? 'main';
      const sha = await write(shadow, {
        kind: 'external-change-kept-live',
        docName,
        contents: displaced.bytes,
        label: `${SIDE_LABEL[displaced.side]} moved to history (${reason}) @ ${new Date().toISOString()}`,
        branch,
        metadata: { side: displaced.side, reason },
      });
      if (sha === null) return false;
      options.notices?.record(docName, branch, {
        kind: 'moved-to-history',
        side: displaced.side,
        reason,
        entry: sha,
      });
      return true;
    },
  };
}
