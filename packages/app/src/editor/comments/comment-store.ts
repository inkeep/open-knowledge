import { useSyncExternalStore } from 'react';

export interface CommentAnchor {
  readonly docName: string;
  readonly textStart: number;
  readonly textEnd: number;
  readonly anchorText: string;
  readonly markdown: string;
  readonly charLen: number;
  readonly lineCount: number;
}

export interface DocumentComment extends CommentAnchor {
  readonly id: string;
  readonly body: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DocumentCommentSnapshot {
  readonly comments: readonly DocumentComment[];
  readonly pending: CommentAnchor | null;
  readonly activeCommentId: string | null;
}

const EMPTY_SNAPSHOT: DocumentCommentSnapshot = Object.freeze({
  comments: Object.freeze([]) as readonly DocumentComment[],
  pending: null,
  activeCommentId: null,
});

const byDoc = new Map<string, DocumentCommentSnapshot>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeDocumentComments(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDocumentCommentSnapshot(docName: string | null): DocumentCommentSnapshot {
  if (docName === null) return EMPTY_SNAPSHOT;
  return byDoc.get(docName) ?? EMPTY_SNAPSHOT;
}

function updateDocSnapshot(
  docName: string,
  updater: (prev: DocumentCommentSnapshot) => DocumentCommentSnapshot,
): void {
  const prev = getDocumentCommentSnapshot(docName);
  const next = updater(prev);
  if (next === prev) return;
  byDoc.set(docName, next);
  notify();
}

function createCommentId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `comment-${Date.now()}-${Math.random()}`;
}

export function setPendingDocumentComment(anchor: CommentAnchor): void {
  updateDocSnapshot(anchor.docName, (prev) => ({
    ...prev,
    pending: anchor,
    activeCommentId: null,
  }));
}

export function clearPendingDocumentComment(docName: string): void {
  updateDocSnapshot(docName, (prev) => {
    if (prev.pending === null) return prev;
    return { ...prev, pending: null };
  });
}

export function addPendingDocumentComment(docName: string, body: string): DocumentComment | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  const prev = getDocumentCommentSnapshot(docName);
  if (prev.pending === null) return null;

  const now = Date.now();
  const comment: DocumentComment = {
    ...prev.pending,
    id: createCommentId(),
    body: trimmed,
    createdAt: now,
    updatedAt: now,
  };
  byDoc.set(docName, {
    comments: [...prev.comments, comment],
    pending: null,
    activeCommentId: comment.id,
  });
  notify();
  return comment;
}

export function setActiveDocumentComment(docName: string, commentId: string | null): void {
  updateDocSnapshot(docName, (prev) => {
    if (prev.activeCommentId === commentId && prev.pending === null) return prev;
    return { ...prev, activeCommentId: commentId, pending: null };
  });
}

export function updateDocumentCommentBody(docName: string, commentId: string, body: string): void {
  const trimmed = body.trim();
  if (!trimmed) return;
  updateDocSnapshot(docName, (prev) => {
    let changed = false;
    const comments = prev.comments.map((comment) => {
      if (comment.id !== commentId) return comment;
      changed = true;
      return { ...comment, body: trimmed, updatedAt: Date.now() };
    });
    return changed ? { ...prev, comments } : prev;
  });
}

export function deleteDocumentComment(docName: string, commentId: string): void {
  updateDocSnapshot(docName, (prev) => {
    const comments = prev.comments.filter((comment) => comment.id !== commentId);
    if (comments.length === prev.comments.length) return prev;
    return {
      comments,
      pending: prev.pending,
      activeCommentId: prev.activeCommentId === commentId ? null : prev.activeCommentId,
    };
  });
}

export function clearDocumentComments(docName: string, commentIds?: readonly string[]): void {
  updateDocSnapshot(docName, (prev) => {
    if (commentIds === undefined) {
      if (prev.comments.length === 0 && prev.activeCommentId === null) return prev;
      return { ...prev, comments: [], activeCommentId: null };
    }
    const ids = new Set(commentIds);
    const comments = prev.comments.filter((comment) => !ids.has(comment.id));
    if (comments.length === prev.comments.length) return prev;
    return {
      comments,
      pending: prev.pending,
      activeCommentId:
        prev.activeCommentId !== null && ids.has(prev.activeCommentId)
          ? null
          : prev.activeCommentId,
    };
  });
}

export function useDocumentComments(docName: string | null): DocumentCommentSnapshot {
  return useSyncExternalStore(
    subscribeDocumentComments,
    () => getDocumentCommentSnapshot(docName),
    () => getDocumentCommentSnapshot(docName),
  );
}

function fenceFor(value: string): string {
  let longest = 0;
  for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function quoteBody(body: string): string {
  return body
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

export function formatCommentsForAgent(comments: readonly DocumentComment[]): string {
  if (comments.length === 0) return '';
  const blocks = comments.map((comment, index) => {
    const selected = comment.markdown.trim() || comment.anchorText.trim();
    const fence = fenceFor(selected);
    return [
      `Comment ${index + 1}`,
      '',
      'Selected passage:',
      fence,
      selected,
      fence,
      '',
      'Feedback:',
      quoteBody(comment.body),
    ].join('\n');
  });
  return [
    'Please address the following review comments in this document. For each item, inspect the selected passage and update the document as needed.',
    '',
    ...blocks,
  ].join('\n\n');
}

export function resetDocumentCommentsForTests(): void {
  byDoc.clear();
  notify();
}
