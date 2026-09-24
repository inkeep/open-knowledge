import type { AttachmentPart } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import type { JSONContent } from '@tiptap/core';

export interface ThreadDraftContent {
  readonly doc: JSONContent;
  readonly attachments: readonly AttachmentPart[];
}

export interface ThreadDraftSnapshot {
  readonly text: string;
  readonly doc: JSONContent | null;
  readonly attachments: readonly AttachmentPart[];
  readonly uploadsPending: boolean;
}

const pending = new Map<string, string>();

const listeners = new Map<string, (text: string) => void>();

const pendingContent = new Map<string, ThreadDraftContent>();

const contentListeners = new Map<string, (content: ThreadDraftContent) => void>();

const readers = new Map<string, () => ThreadDraftSnapshot>();

export function stageThreadDraft(threadId: string, text: string): void {
  if (text.trim() === '') return;
  const listener = listeners.get(threadId);
  if (listener !== undefined) {
    listener(text);
    return;
  }
  pending.set(threadId, text);
}

export function subscribeStagedThreadDraft(
  threadId: string,
  onDraft: (text: string) => void,
): () => void {
  listeners.set(threadId, onDraft);
  const held = pending.get(threadId);
  if (held !== undefined) {
    pending.delete(threadId);
    onDraft(held);
  }
  return () => {
    if (listeners.get(threadId) === onDraft) listeners.delete(threadId);
  };
}

export function stageThreadDraftContent(threadId: string, content: ThreadDraftContent): void {
  const listener = contentListeners.get(threadId);
  if (listener !== undefined) {
    listener(content);
    return;
  }
  pendingContent.set(threadId, content);
}

export function subscribeStagedThreadDraftContent(
  threadId: string,
  onContent: (content: ThreadDraftContent) => void,
): () => void {
  contentListeners.set(threadId, onContent);
  const held = pendingContent.get(threadId);
  if (held !== undefined) {
    pendingContent.delete(threadId);
    onContent(held);
  }
  return () => {
    if (contentListeners.get(threadId) === onContent) contentListeners.delete(threadId);
  };
}

export function registerThreadDraftReader(
  threadId: string,
  read: () => ThreadDraftSnapshot,
): () => void {
  readers.set(threadId, read);
  return () => {
    if (readers.get(threadId) === read) readers.delete(threadId);
  };
}

export function readThreadDraft(threadId: string): ThreadDraftSnapshot | null {
  const read = readers.get(threadId);
  return read === undefined ? null : read();
}

export function isEmptyThreadDraft(snapshot: ThreadDraftSnapshot): boolean {
  return snapshot.text === '' && snapshot.attachments.length === 0;
}

export function resetStagedThreadDrafts(): void {
  pending.clear();
  listeners.clear();
  pendingContent.clear();
  contentListeners.clear();
  readers.clear();
}
