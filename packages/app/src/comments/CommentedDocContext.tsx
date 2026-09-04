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

export function useCommentedDocName(): string | null {
  return use(CommentedDocContext);
}
