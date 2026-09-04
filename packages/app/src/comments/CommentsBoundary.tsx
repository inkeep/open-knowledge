import type { ReactNode } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

export function CommentsBoundary({ children }: { children: ReactNode }) {
  return <ErrorBoundary fallbackRender={() => null}>{children}</ErrorBoundary>;
}
