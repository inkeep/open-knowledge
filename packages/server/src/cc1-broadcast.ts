import type { Hocuspocus } from '@hocuspocus/server';
import {
  CC1_CHANNEL_BRANCH_SWITCHED,
  CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR,
  CC1_CHANNEL_CONFIG_VALIDATION_REJECTED,
  CC1_CHANNEL_DISK_ACK,
  CC1_CHANNEL_SERVER_INFO,
  CC1_CONTRACT_VERSION,
  CC1BranchSwitchedPayloadSchema,
  CC1ConfigIgnoreNestedErrorPayloadSchema,
  CC1ConfigValidationRejectedPayloadSchema,
  CC1DerivedViewPayloadSchema,
  CC1DiskAckPayloadSchema,
  CC1ServerInfoPayloadSchema,
  CONFIG_DOC_NAMES,
  type ConfigValidationError,
  type DerivedViewChannel,
  isEditableTextDocFile,
  isExcalidrawDocFile,
  isManagedArtifactDocName,
  isMermaidDocFile,
  isProjectSkillBundlePath,
  SYSTEM_DOC_NAME,
} from '@inkeep/open-knowledge-core';
import { isRegisteredMarkdownDocName } from './doc-extensions.ts';
import { getLogger } from './logger.ts';
import {
  incrementCC1Broadcast,
  incrementCC1BroadcastDrop,
  setCC1LastSeq,
  setCC1SubscriberCount,
} from './metrics.ts';

const DEBOUNCE_MS = 100;

const MAX_DISK_ACK_SVS = 1000;

export { CC1_CONTRACT_VERSION, SYSTEM_DOC_NAME };

export function isSystemDoc(documentName: string): boolean {
  return documentName === SYSTEM_DOC_NAME;
}

const CONFIG_DOC_NAME_SET: ReadonlySet<string> = new Set(CONFIG_DOC_NAMES);

export function isConfigDoc(documentName: string): boolean {
  return CONFIG_DOC_NAME_SET.has(documentName);
}

export function isManagedArtifactDoc(documentName: string): boolean {
  return isManagedArtifactDocName(documentName);
}

export function isMermaidDoc(documentName: string): boolean {
  return isMermaidDocFile(documentName);
}

export function isExcalidrawDoc(documentName: string): boolean {
  return isExcalidrawDocFile(documentName);
}

export function isEditableTextDoc(documentName: string): boolean {
  return isEditableTextDocFile(documentName) && !isRegisteredMarkdownDocName(documentName);
}

export function isReservedForUserTree(documentName: string): boolean {
  return (
    isSystemDoc(documentName) || isConfigDoc(documentName) || isManagedArtifactDoc(documentName)
  );
}

export function isLinkIndexExcludedDoc(documentName: string): boolean {
  return isSystemDoc(documentName) || isConfigDoc(documentName);
}

export function isProblemsPlaneExcludedDoc(documentName: string): boolean {
  return isProjectSkillBundlePath(documentName) || isManagedArtifactDocName(documentName);
}

export function isPersistenceExcludedDoc(documentName: string): boolean {
  return (
    isSystemDoc(documentName) ||
    isConfigDoc(documentName) ||
    isManagedArtifactDoc(documentName) ||
    isMermaidDoc(documentName) ||
    isExcalidrawDoc(documentName) ||
    isEditableTextDoc(documentName)
  );
}

export class CC1Broadcaster {
  private readonly hocuspocus: Hocuspocus;
  private readonly seqs = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly log = getLogger('cc1');
  private warnedMissing = false;
  private readonly latestDiskAckSVs = new Map<string, Uint8Array>();

  constructor(hocuspocus: Hocuspocus) {
    this.hocuspocus = hocuspocus;
  }

  signal(channel: DerivedViewChannel): void {
    const existing = this.timers.get(channel);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    this.timers.set(
      channel,
      setTimeout(() => {
        this.timers.delete(channel);
        this.broadcast(channel);
      }, DEBOUNCE_MS),
    );
  }

  private broadcast(channel: DerivedViewChannel): void {
    try {
      const doc = this.hocuspocus.documents.get(SYSTEM_DOC_NAME);
      if (!doc) {
        if (!this.warnedMissing) {
          this.log.warn(
            {},
            `[cc1] __system__ document not found — broadcasts will be dropped until it is materialized`,
          );
          this.warnedMissing = true;
        }
        incrementCC1BroadcastDrop();
        return;
      }

      const seq = (this.seqs.get(channel) ?? 0) + 1;
      this.seqs.set(channel, seq);

      const payload = CC1DerivedViewPayloadSchema.parse({
        v: CC1_CONTRACT_VERSION,
        ch: channel,
        seq,
      });

      doc.broadcastStateless(JSON.stringify(payload));

      incrementCC1Broadcast();
      setCC1LastSeq(channel, seq);
      setCC1SubscriberCount(doc.getConnectionsCount());
    } catch (err) {
      this.log.error({ err, channel }, '[cc1] broadcast failed');
    }
  }

  emitServerInfo(serverInstanceId: string, currentBranch?: string): void {
    try {
      const doc = this.hocuspocus.documents.get(SYSTEM_DOC_NAME);
      if (!doc) {
        if (!this.warnedMissing) {
          this.log.warn({}, `[cc1] __system__ document not found at emitServerInfo — dropped`);
          this.warnedMissing = true;
        }
        incrementCC1BroadcastDrop();
        return;
      }
      const payload = CC1ServerInfoPayloadSchema.parse({
        v: CC1_CONTRACT_VERSION,
        ch: CC1_CHANNEL_SERVER_INFO,
        seq: 0,
        serverInstanceId,
        ...(currentBranch !== undefined ? { currentBranch } : {}),
      });
      doc.broadcastStateless(JSON.stringify(payload));
      incrementCC1Broadcast();
      setCC1LastSeq(CC1_CHANNEL_SERVER_INFO, 0);
    } catch (err) {
      this.log.error({ err }, '[cc1] emitServerInfo failed');
    }
  }

  emitBranchSwitched(branch: string): void {
    try {
      const doc = this.hocuspocus.documents.get(SYSTEM_DOC_NAME);
      if (!doc) {
        if (!this.warnedMissing) {
          this.log.warn({}, `[cc1] __system__ document not found at emitBranchSwitched — dropped`);
          this.warnedMissing = true;
        }
        incrementCC1BroadcastDrop();
        return;
      }
      const seq = (this.seqs.get(CC1_CHANNEL_BRANCH_SWITCHED) ?? 0) + 1;
      this.seqs.set(CC1_CHANNEL_BRANCH_SWITCHED, seq);
      const payload = CC1BranchSwitchedPayloadSchema.parse({
        v: CC1_CONTRACT_VERSION,
        ch: CC1_CHANNEL_BRANCH_SWITCHED,
        seq,
        branch,
      });
      doc.broadcastStateless(JSON.stringify(payload));
      incrementCC1Broadcast();
      setCC1LastSeq(CC1_CHANNEL_BRANCH_SWITCHED, seq);
    } catch (err) {
      this.log.error({ err }, '[cc1] emitBranchSwitched failed');
    }
  }

  emitDiskAck(docName: string, sv: Uint8Array): void {
    this.latestDiskAckSVs.delete(docName);
    this.latestDiskAckSVs.set(docName, sv);
    if (this.latestDiskAckSVs.size > MAX_DISK_ACK_SVS) {
      const oldest = this.latestDiskAckSVs.keys().next().value;
      if (oldest !== undefined) {
        this.latestDiskAckSVs.delete(oldest);
      }
    }
    try {
      const doc = this.hocuspocus.documents.get(SYSTEM_DOC_NAME);
      if (!doc) {
        if (!this.warnedMissing) {
          this.log.warn({}, `[cc1] __system__ document not found at emitDiskAck — dropped`);
          this.warnedMissing = true;
        }
        incrementCC1BroadcastDrop();
        return;
      }
      const seq = (this.seqs.get(CC1_CHANNEL_DISK_ACK) ?? 0) + 1;
      this.seqs.set(CC1_CHANNEL_DISK_ACK, seq);
      const payload = CC1DiskAckPayloadSchema.parse({
        v: CC1_CONTRACT_VERSION,
        ch: CC1_CHANNEL_DISK_ACK,
        seq,
        docName,
        sv: Buffer.from(sv).toString('base64'),
      });
      doc.broadcastStateless(JSON.stringify(payload));
      incrementCC1Broadcast();
      setCC1LastSeq(CC1_CHANNEL_DISK_ACK, seq);
    } catch (err) {
      this.log.error({ err, docName }, '[cc1] emitDiskAck failed');
    }
  }

  getLatestDiskAckSVsAsBase64(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [docName, sv] of this.latestDiskAckSVs) {
      out[docName] = Buffer.from(sv).toString('base64');
    }
    return out;
  }

  emitConfigValidationRejected(docName: string, error: ConfigValidationError): void {
    try {
      const doc = this.hocuspocus.documents.get(SYSTEM_DOC_NAME);
      if (!doc) {
        if (!this.warnedMissing) {
          this.log.warn(
            {},
            `[cc1] __system__ document not found at emitConfigValidationRejected — dropped`,
          );
          this.warnedMissing = true;
        }
        incrementCC1BroadcastDrop();
        return;
      }
      const seq = (this.seqs.get(CC1_CHANNEL_CONFIG_VALIDATION_REJECTED) ?? 0) + 1;
      this.seqs.set(CC1_CHANNEL_CONFIG_VALIDATION_REJECTED, seq);
      const payload = CC1ConfigValidationRejectedPayloadSchema.parse({
        v: CC1_CONTRACT_VERSION,
        ch: CC1_CHANNEL_CONFIG_VALIDATION_REJECTED,
        seq,
        docName,
        error,
      });
      doc.broadcastStateless(JSON.stringify(payload));
      incrementCC1Broadcast();
      setCC1LastSeq(CC1_CHANNEL_CONFIG_VALIDATION_REJECTED, seq);
    } catch (err) {
      this.log.error({ err, docName }, '[cc1] emitConfigValidationRejected failed');
    }
  }

  emitConfigIgnoreNestedError(path: string, error: string): void {
    try {
      const doc = this.hocuspocus.documents.get(SYSTEM_DOC_NAME);
      if (!doc) {
        if (!this.warnedMissing) {
          this.log.warn(
            {},
            `[cc1] __system__ document not found at emitConfigIgnoreNestedError — dropped`,
          );
          this.warnedMissing = true;
        }
        incrementCC1BroadcastDrop();
        return;
      }
      const seq = (this.seqs.get(CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR) ?? 0) + 1;
      this.seqs.set(CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR, seq);
      const payload = CC1ConfigIgnoreNestedErrorPayloadSchema.parse({
        v: CC1_CONTRACT_VERSION,
        ch: CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR,
        seq,
        path,
        error,
      });
      doc.broadcastStateless(JSON.stringify(payload));
      incrementCC1Broadcast();
      setCC1LastSeq(CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR, seq);
    } catch (err) {
      this.log.error({ err, path }, '[cc1] emitConfigIgnoreNestedError failed');
    }
  }

  get subscriberCount(): number {
    const doc = this.hocuspocus.documents.get(SYSTEM_DOC_NAME);
    return doc ? doc.getConnectionsCount() : 0;
  }

  destroy(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
