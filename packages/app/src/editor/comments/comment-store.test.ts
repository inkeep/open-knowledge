import { beforeEach, describe, expect, test } from 'bun:test';
import {
  addPendingDocumentComment,
  type CommentAnchor,
  clearDocumentComments,
  deleteDocumentComment,
  formatCommentsForAgent,
  getDocumentCommentSnapshot,
  resetDocumentCommentsForTests,
  setPendingDocumentComment,
} from './comment-store';

function makeAnchor(overrides: Partial<CommentAnchor> = {}): CommentAnchor {
  return {
    docName: 'notes',
    textStart: 0,
    textEnd: 5,
    anchorText: 'hello',
    markdown: '**hello**',
    charLen: 9,
    lineCount: 1,
    ...overrides,
  };
}

beforeEach(() => {
  resetDocumentCommentsForTests();
});

describe('document comment store', () => {
  test('promotes a pending selection into an active comment and formats it for agents', () => {
    const anchor = makeAnchor();
    setPendingDocumentComment(anchor);

    const comment = addPendingDocumentComment('notes', '  Tighten this wording.  ');

    expect(comment).not.toBeNull();
    const snapshot = getDocumentCommentSnapshot('notes');
    expect(snapshot.pending).toBeNull();
    expect(snapshot.comments).toHaveLength(1);
    expect(snapshot.comments[0]?.body).toBe('Tighten this wording.');
    expect(snapshot.activeCommentId).toBe(comment?.id);

    const formatted = formatCommentsForAgent(snapshot.comments);
    expect(formatted).toContain('Comment 1');
    expect(formatted).toContain('Selected passage:\n```\n**hello**\n```');
    expect(formatted).toContain('Feedback:\n> Tighten this wording.');
  });

  test('uses a longer markdown fence when the selected passage contains backticks', () => {
    setPendingDocumentComment(
      makeAnchor({
        markdown: '```ts\nconst value = 1;\n```',
        anchorText: 'const value = 1;',
      }),
    );
    const comment = addPendingDocumentComment('notes', 'Keep the code block intact.');

    expect(comment).not.toBeNull();
    expect(formatCommentsForAgent(getDocumentCommentSnapshot('notes').comments)).toContain(
      'Selected passage:\n````\n```ts\nconst value = 1;\n```\n````',
    );
  });

  test('clears individual comments without dropping the rest of the stack', () => {
    setPendingDocumentComment(makeAnchor({ textStart: 0, textEnd: 5, anchorText: 'first' }));
    const first = addPendingDocumentComment('notes', 'First note.');
    setPendingDocumentComment(makeAnchor({ textStart: 12, textEnd: 18, anchorText: 'second' }));
    const second = addPendingDocumentComment('notes', 'Second note.');

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    clearDocumentComments('notes', first ? [first.id] : []);

    const snapshot = getDocumentCommentSnapshot('notes');
    expect(snapshot.comments.map((comment) => comment.id)).toEqual(second ? [second.id] : []);
    expect(snapshot.comments[0]?.body).toBe('Second note.');
  });

  test('deleting the active comment clears the active pointer', () => {
    setPendingDocumentComment(makeAnchor());
    const comment = addPendingDocumentComment('notes', 'Remove me.');

    expect(comment).not.toBeNull();
    if (comment) deleteDocumentComment('notes', comment.id);

    const snapshot = getDocumentCommentSnapshot('notes');
    expect(snapshot.comments).toHaveLength(0);
    expect(snapshot.activeCommentId).toBeNull();
  });
});
