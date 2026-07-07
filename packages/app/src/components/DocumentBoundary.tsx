/**
 * DocumentBoundary — the Suspense-unwrap point for a pooled document.
 *
 * Calls `use(syncPromise(docName, provider))` so the component body suspends
 * until the provider's `synced` event fires (or the promise rejects and bubbles
 * to the nearest `DocumentErrorBoundary`). Once settled, renders `children`.
 *
 * Kept deliberately small — the primitive in `sync-promise.ts` does all the
 * lifecycle work; this component is just the React-land bridge.
 *
 * StrictMode safety: the sync-promise module-level cache keys by docName, so
 * React's dev-mode double-invoke lands the same promise reference on both
 * invocations. `use()` on a stable reference is safe against infinite suspend
 * loops.
 *
 * Placement: intended to sit inside each `<Activity>` entry emitted by
 * `EditorActivityPool`, wrapping the concrete TipTap/CodeMirror editor mount.
 */

import type { HocuspocusProvider } from '@hocuspocus/provider';
import { type ReactNode, use } from 'react';
import { syncPromise } from '@/editor/sync-promise';

interface DocumentBoundaryProps {
  docName: string;
  provider: HocuspocusProvider;
  children: ReactNode;
}

export function DocumentBoundary({ docName, provider, children }: DocumentBoundaryProps) {
  use(syncPromise(docName, provider));
  return <>{children}</>;
}
