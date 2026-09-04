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
