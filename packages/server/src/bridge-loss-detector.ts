import { findDroppedContent, pendingContentLines } from '@inkeep/open-knowledge-core';

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

export const DERIVE_LOSS_SITE_FILE_WATCHER_INTAKE = 'file-watcher-intake';
