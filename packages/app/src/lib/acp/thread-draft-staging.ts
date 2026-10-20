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

const listeners = new Map<string, (text: string) => boolean>();

const pendingContent = new Map<string, ThreadDraftContent>();

const contentListeners = new Map<string, (content: ThreadDraftContent) => boolean>();

const readers = new Map<string, () => ThreadDraftSnapshot>();

export function stageThreadDraft(threadId: string, text: string): void {
  if (text.trim() === '') return;
  pending.set(threadId, text);
  flushStagedThreadDraft(threadId);
}

export function flushStagedThreadDraft(threadId: string): void {
  const text = pending.get(threadId);
  const listener = listeners.get(threadId);
  if (text === undefined || listener === undefined) return;
  if (listener(text) === true) pending.delete(threadId);
}

export function subscribeStagedThreadDraft(
  threadId: string,
  onDraft: (text: string) => boolean,
): () => void {
  listeners.set(threadId, onDraft);
  flushStagedThreadDraft(threadId);
  return () => {
    if (listeners.get(threadId) === onDraft) listeners.delete(threadId);
  };
}

export function stageThreadDraftContent(threadId: string, content: ThreadDraftContent): void {
  pendingContent.set(threadId, content);
  flushStagedThreadDraftContent(threadId);
}

export function flushStagedThreadDraftContent(threadId: string): void {
  const content = pendingContent.get(threadId);
  const listener = contentListeners.get(threadId);
  if (content === undefined || listener === undefined) return;
  if (listener(content) === true) pendingContent.delete(threadId);
}

export function subscribeStagedThreadDraftContent(
  threadId: string,
  onContent: (content: ThreadDraftContent) => boolean,
): () => void {
  contentListeners.set(threadId, onContent);
  flushStagedThreadDraftContent(threadId);
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
