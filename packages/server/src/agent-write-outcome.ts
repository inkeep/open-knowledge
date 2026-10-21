import type {
  AgentWriteOutcomeFields,
  ProblemType,
  ReconcileMergeOutcome,
} from '@inkeep/open-knowledge-core';
import {
  isConfigDoc,
  isEditableTextDoc,
  isExcalidrawDoc,
  isManagedArtifactDoc,
  isMermaidDoc,
} from './cc1-broadcast.ts';
import {
  OK_DOC_MOVED,
  OK_DOC_REMOVED,
  OK_PATH_UNRESOLVABLE,
  OK_SERVER_STOPPED,
  OK_STORE_DISCARDED,
  OK_STORE_HELD,
  OK_STORE_REFUSED,
  OK_WRITE_REPLACED,
  type StoreFailure,
} from './document-durability-state.ts';

const APPLIED: AgentWriteOutcomeFields = {
  outcome: 'applied',
  saved: true,
  nextStep: 'none',
};

const APPLIED_WITH_DIVERGENCE: AgentWriteOutcomeFields = {
  outcome: 'applied',
  saved: true,
  nextStep: 're-read',
};

const MERGED_FIRST: AgentWriteOutcomeFields = {
  outcome: 'merged-first',
  saved: true,
  nextStep: 're-read',
};

const BOTH_KEPT: AgentWriteOutcomeFields = {
  outcome: 'both-kept',
  saved: true,
  nextStep: 're-read',
};

const PROJECTION_HELD: AgentWriteOutcomeFields = {
  outcome: 'projection-held',
  saved: false,
  nextStep: 're-read',
};

const REFUSED_RETRY: AgentWriteOutcomeFields = {
  outcome: 'refused',
  saved: false,
  nextStep: 'retry',
};

const REFUSED_RE_READ: AgentWriteOutcomeFields = {
  outcome: 'refused',
  saved: false,
  nextStep: 're-read',
};

const REFUSED_NONE: AgentWriteOutcomeFields = {
  outcome: 'refused',
  saved: false,
  nextStep: 'none',
};

export const REFUSAL_OUTCOMES = {
  'urn:ok:error:concurrent-overwrite-refused': REFUSED_RETRY,
  'urn:ok:error:too-many-agent-sessions': REFUSED_RETRY,
  'urn:ok:error:doc-not-found': REFUSED_RETRY,
  'urn:ok:error:reserved-doc-name': REFUSED_RETRY,
  'urn:ok:error:frontmatter-malformed': REFUSED_RETRY,
  'urn:ok:error:frontmatter-edit-not-supported': REFUSED_RETRY,
  'urn:ok:error:invalid-frontmatter-patch': REFUSED_RETRY,
  'urn:ok:error:target-not-found': REFUSED_RE_READ,
  'urn:ok:error:stale-target': REFUSED_RE_READ,
  'urn:ok:error:doc-in-conflict': REFUSED_NONE,
  'urn:ok:error:stale-external-write': REFUSED_NONE,
} as const satisfies Partial<Record<ProblemType, AgentWriteOutcomeFields>>;

export function outcomeOfStoreFailure(failure: StoreFailure): AgentWriteOutcomeFields {
  switch (failure.code) {
    case OK_STORE_HELD:
      return failure.held?.noBase === true || failure.held?.reason === 'pending-conflict'
        ? REFUSED_NONE
        : PROJECTION_HELD;
    case OK_DOC_MOVED:
    case OK_STORE_DISCARDED:
      return PROJECTION_HELD;
    case OK_DOC_REMOVED:
    case OK_SERVER_STOPPED:
      return failure.removal?.kind === 'renamed' ? REFUSED_RE_READ : REFUSED_NONE;
    case OK_PATH_UNRESOLVABLE:
      return REFUSED_NONE;
    case OK_STORE_REFUSED:
    case OK_WRITE_REPLACED:
      return REFUSED_RE_READ;
    default:
      return REFUSED_RE_READ;
  }
}

export function answeredWithSuccessOnAppRoutes(failure: StoreFailure): boolean {
  return (
    failure.code === OK_WRITE_REPLACED ||
    (failure.code === OK_STORE_HELD &&
      (failure.held?.reason === 'pending-unsettled' || failure.held?.reason === 'pending-rename'))
  );
}

function savesOutsideTheMarkdownStore(docName: string): boolean {
  return (
    isConfigDoc(docName) ||
    isManagedArtifactDoc(docName) ||
    isMermaidDoc(docName) ||
    isExcalidrawDoc(docName) ||
    isEditableTextDoc(docName)
  );
}

export type AgentWriteFlushOutcome =
  | { kind: 'failure'; failure: StoreFailure }
  | { kind: 'stale-external-write' }
  | { kind: 'taken-in'; merge: ReconcileMergeOutcome }
  | null;

export function outcomeOfSavedWrite(
  beforeWrite:
    | { readonly reconciled: boolean; readonly mergeOutcome?: ReconcileMergeOutcome }
    | undefined,
  flush: AgentWriteFlushOutcome,
  landedWithDivergence = false,
): AgentWriteOutcomeFields {
  if (flush?.kind === 'failure') return outcomeOfStoreFailure(flush.failure);
  if (flush?.kind === 'stale-external-write') {
    return REFUSAL_OUTCOMES['urn:ok:error:stale-external-write'];
  }
  const atSave = flush?.kind === 'taken-in' ? flush.merge : undefined;
  if (beforeWrite?.mergeOutcome === 'both-kept' || atSave === 'both-kept') return BOTH_KEPT;
  if (beforeWrite?.reconciled === true || atSave !== undefined) return MERGED_FIRST;
  return landedWithDivergence ? APPLIED_WITH_DIVERGENCE : APPLIED;
}

export function reportedOutcome(
  docName: string,
  outcome: AgentWriteOutcomeFields,
): AgentWriteOutcomeFields | undefined {
  return savesOutsideTheMarkdownStore(docName) ? undefined : outcome;
}
