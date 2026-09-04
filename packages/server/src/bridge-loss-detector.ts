import { findDroppedContent, fnv1aDigest, pendingContentLines } from '@inkeep/open-knowledge-core';
import { getLogger } from './logger.ts';
import { LOSS_EVENT_DETECTOR_TRIP, type LossCaptureRing } from './loss-capture.ts';
import { type ShadowHandle, saveInMemoryCheckpoint } from './shadow-repo.ts';

const log = getLogger('bridge-loss-detector');
const checkpointLog = getLogger('checkpoint');

export function detectApplyArmDrop(
  intendedMd: string,
  normIntended: string,
  appliedYText: string,
  normApplied: string,
): string[] {
  if (intendedMd === appliedYText) return [];
  if (normApplied === normIntended) return [];
  return findDroppedContent(normIntended, normApplied, normApplied);
}

export interface DeriveLossObservation {
  pendingBody: string;
  baselineBody: string;
  ytextDerivedBody: string;
  rebuiltBody: string;
  restorePayload: string;
}

export function detectDeriveLoss(obs: DeriveLossObservation): string[] {
  const producer = findDroppedContent(obs.pendingBody, obs.baselineBody, obs.rebuiltBody);
  const consumer = findDroppedContent(obs.pendingBody, obs.baselineBody, obs.ytextDerivedBody);
  if (consumer.length === 0) return producer;
  const merged = [...producer];
  const seen = new Set(producer);
  for (const seg of consumer) {
    if (!seen.has(seg)) {
      seen.add(seg);
      merged.push(seg);
    }
  }
  return merged;
}

export function detectPairedIntakeLoss(obs: DeriveLossObservation): string[] {
  const dropped = detectDeriveLoss(obs);
  const pending = pendingContentLines(obs.pendingBody, obs.ytextDerivedBody, obs.baselineBody);
  if (pending.length === 0) return dropped;
  const seen = new Set(dropped);
  const merged = [...dropped];
  for (const line of pending) {
    if (!seen.has(line)) {
      seen.add(line);
      merged.push(line);
    }
  }
  return merged;
}

export interface DeriveLossDetectOptions {
  report: (obs: DeriveLossObservation) => void;
  baselineFullMd: string;
}

export const DERIVE_LOSS_SITE_AGENT_UNDO = 'agent-undo-derive';
export const DERIVE_LOSS_SITE_FILE_WATCHER_INTAKE = 'file-watcher-intake';
export const DERIVE_LOSS_SITE_AGENT_WRITE_INTAKE = 'agent-write-intake';

export type BridgeDeriveLossReporter = (
  docName: string,
  obs: DeriveLossObservation,
  writerId?: string | null,
  site?: string,
) => void;

export interface BridgeDeriveLossReporterDeps {
  shadow: () => ShadowHandle | undefined;
  ring?: Pick<LossCaptureRing, 'record'>;
  getBranch: () => string;
  contentRoot: string;
}

export function createBridgeDeriveLossReporter(
  deps: BridgeDeriveLossReporterDeps,
): BridgeDeriveLossReporter {
  return (docName, obs, writerId = null, site = DERIVE_LOSS_SITE_AGENT_UNDO) => {
    const dropped = detectPairedIntakeLoss(obs);
    if (dropped.length === 0) return;
    const lostLen = dropped.reduce((n, s) => n + s.length, 0);
    const digest = fnv1aDigest(dropped.join('\n'));
    const shadow = deps.shadow();
    if (!shadow) {
      void deps.ring?.record({
        event: LOSS_EVENT_DETECTOR_TRIP,
        docName,
        writerId,
        direction: 'b',
        site,
        lostLen,
        digest,
      });
      return;
    }
    const branch = deps.getBranch();
    const contentRoot = deps.contentRoot;
    queueMicrotask(() => {
      saveInMemoryCheckpoint(shadow, contentRoot, {
        kind: 'bridge-derive-loss',
        docName,
        contents: obs.restorePayload,
        label: `Before ${site} content-loss @ ${new Date().toISOString()}`,
        branch,
        metadata: { lostSubstrings: dropped },
      })
        .then((sha) => {
          void deps.ring?.record({
            event: LOSS_EVENT_DETECTOR_TRIP,
            docName,
            writerId,
            direction: 'b',
            site,
            lostLen,
            digest,
            checkpointSha: sha,
          });
          console.warn(
            JSON.stringify({
              event: 'bridge-derive-loss-checkpoint-created',
              docName,
              sha,
              kind: 'bridge-derive-loss',
              site,
              timestamp: new Date().toISOString(),
            }),
          );
        })
        .catch((checkpointErr: unknown) => {
          const e =
            checkpointErr instanceof Error ? checkpointErr : new Error(String(checkpointErr));
          log.warn({ docName, err: e }, '[bridge-derive-loss] checkpoint write failed');
          checkpointLog.warn(
            { err: e, 'doc.name': docName, branch, kind: 'bridge-derive-loss' },
            'checkpoint write failed',
          );
        });
    });
  };
}
