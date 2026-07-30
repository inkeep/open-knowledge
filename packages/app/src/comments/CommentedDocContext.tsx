/**
 * Which document the property panel is editing — for the comment affordances
 * inside it.
 *
 * A sibling to `FrontmatterBindingContext`, which is deliberately scoped to the
 * binding handle alone. Nested object and array rows are recursive widgets
 * several layers below the panel, and every one of them can host a comment
 * button; threading a `docName` prop through each would touch widgets that have
 * nothing else to do with comments.
 *
 * `null` is the ordinary case for the other panels built from the same rows —
 * templates, skills, folder cards. Only a real document has comment threads, so
 * a button that finds no doc name renders nothing rather than posting somewhere
 * that cannot receive it.
 */

import { createContext, type ReactNode, use } from 'react';

const CommentedDocContext = createContext<string | null>(null);

export function CommentedDocProvider({
  docName,
  children,
}: {
  docName: string | null;
  children: ReactNode;
}) {
  return <CommentedDocContext value={docName}>{children}</CommentedDocContext>;
}

/** The document whose properties are being edited, or null when there isn't one. */
export function useCommentedDocName(): string | null {
  return use(CommentedDocContext);
}
