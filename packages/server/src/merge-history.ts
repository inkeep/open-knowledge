import type { ParsedCheckpoint } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import type { DocNoticeSink, MoveReason } from './doc-notices.ts';
import { type BackupCopy, backUpDisplacedVersion } from './edit-backups.ts';
import { getLogger } from './logger.ts';
import {
  incrementMergeHistoryCheckpointCreated,
  incrementMergeHistoryCheckpointFailures,
  incrementMergeHistoryUnavailable,
  incrementNoEngineHistoryCheckpointCreated,
  incrementNoEngineHistoryCheckpointFailures,
} from './metrics.ts';
import { countKeptBlocks, type KeptBlockPair } from './reconciliation.ts';
import type { VisibleHoldCause } from './save-hold.ts';
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

type NoEngineFileType = Extract<
  ParsedCheckpoint,
  { kind: 'external-change-no-engine' }
>['metadata']['fileType'];

export type EnginelessFileType = Exclude<NoEngineFileType, 'config'>;

export type KeptCopy =
  | { readonly where: 'history'; readonly entry: string }
  | { readonly where: 'backup'; readonly backup: BackupCopy };

type MergeHistoryParams = Extract<
  InMemoryCheckpointParams,
  { kind: 'external-change-both-kept' | 'external-change-kept-live' | 'external-change-no-engine' }
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
  saveNoEngine(
    docName: string,
    displaced: { side: MergeSide; bytes: string },
    fileType: NoEngineFileType,
  ): Promise<string | null>;
  noticeNoEngine(
    docName: string,
    side: MergeSide,
    fileType: NoEngineFileType,
    copy: KeptCopy,
  ): void;
  noticeBackup(docName: string, side: MergeSide, reason: MoveReason, backup: BackupCopy): void;
  noticeHeld(docName: string, cause: VisibleHoldCause): void;
  clearHeld(docName: string): void;
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

function noEngineNoticeReason(
  fileType: NoEngineFileType,
  side: MergeSide,
): Extract<
  MoveReason,
  'no-merge-engine' | 'outside-settings-applied' | 'outside-settings-invalid'
> {
  if (fileType !== 'config') return 'no-merge-engine';
  return side === 'ours' ? 'outside-settings-applied' : 'outside-settings-invalid';
}

const HISTORY_COUNTERS: Record<
  MergeHistoryParams['kind'],
  { created: () => void; failed: () => void }
> = {
  'external-change-both-kept': {
    created: incrementMergeHistoryCheckpointCreated,
    failed: incrementMergeHistoryCheckpointFailures,
  },
  'external-change-kept-live': {
    created: incrementMergeHistoryCheckpointCreated,
    failed: incrementMergeHistoryCheckpointFailures,
  },
  'external-change-no-engine': {
    created: incrementNoEngineHistoryCheckpointCreated,
    failed: incrementNoEngineHistoryCheckpointFailures,
  },
};

export function createMergeHistoryRecorder(
  options: MergeHistoryRecorderOptions,
): MergeHistoryRecorder {
  const writeCheckpoint = options.writeCheckpoint ?? saveInMemoryCheckpoint;
  const write = (shadow: ShadowHandle, params: MergeHistoryParams): Promise<string | null> =>
    writeCheckpoint(shadow, options.contentRoot, params).then(
      (sha) => {
        HISTORY_COUNTERS[params.kind].created();
        log.info(
          { docName: params.docName, kind: params.kind, side: params.metadata.side, sha },
          `[reconcile] history entry saved (${params.kind}, ${params.metadata.side}): ${params.docName}`,
        );
        return sha;
      },
      (err: unknown) => {
        HISTORY_COUNTERS[params.kind].failed();
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

  const saveNoEngine: MergeHistoryRecorder['saveNoEngine'] = async (
    docName,
    displaced,
    fileType,
  ) => {
    const shadow = options.getShadow();
    if (!shadow) {
      unavailable(docName, 'external-change-no-engine');
      return null;
    }
    return write(shadow, {
      kind: 'external-change-no-engine',
      docName,
      contents: displaced.bytes,
      label: `${SIDE_LABEL[displaced.side]} moved to history (no merge for ${fileType}) @ ${new Date().toISOString()}`,
      branch: options.getBranch() ?? 'main',
      metadata: { side: displaced.side, fileType },
    });
  };

  const noticeBackup: MergeHistoryRecorder['noticeBackup'] = (docName, side, reason, backup) => {
    options.notices?.record(docName, options.getBranch() ?? 'main', {
      kind: 'moved-to-backup',
      side,
      reason,
      backup: backup.display,
    });
  };

  const noticeNoEngine: MergeHistoryRecorder['noticeNoEngine'] = (
    docName,
    side,
    fileType,
    copy,
  ) => {
    const reason = noEngineNoticeReason(fileType, side);
    if (copy.where === 'backup') {
      noticeBackup(docName, side, reason, copy.backup);
      return;
    }
    options.notices?.record(docName, options.getBranch() ?? 'main', {
      kind: 'moved-to-history',
      side,
      reason,
      entry: copy.entry,
    });
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

    saveNoEngine,
    noticeNoEngine,
    noticeBackup,

    noticeHeld(docName, cause) {
      options.notices?.record(docName, options.getBranch() ?? 'main', { kind: 'save-held', cause });
    },

    clearHeld(docName) {
      options.notices?.withdrawHeld(docName, options.getBranch() ?? 'main');
    },
  };
}

export async function keepNoEngineVersion(
  history: Pick<MergeHistoryRecorder, 'saveNoEngine'> | null,
  home: string,
  project: string,
  docName: string,
  displaced: { side: MergeSide; bytes: string },
  fileType: NoEngineFileType,
  fileName: string,
): Promise<KeptCopy | null> {
  const entry = history === null ? null : await history.saveNoEngine(docName, displaced, fileType);
  if (entry !== null) return { where: 'history', entry };
  const backup = await backUpDisplacedVersion(home, project, docName, displaced.bytes, fileName);
  return backup === null ? null : { where: 'backup', backup };
}
