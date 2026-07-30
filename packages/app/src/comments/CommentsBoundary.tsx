/**
 * Error boundary isolating the comment UI from the document.
 *
 * Comment surfaces render inside the editor's React tree, so without this a bug
 * in any of them bubbles to the editor's `DocumentErrorBoundary` and BLANKS the
 * whole document. Contained here, a comment-side failure costs the comment UI
 * and nothing else — the document keeps rendering and stays editable.
 */

import type { ReactNode } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

export function CommentsBoundary({ children }: { children: ReactNode }) {
  return <ErrorBoundary fallbackRender={() => null}>{children}</ErrorBoundary>;
}
