import type { HocuspocusProvider } from '@hocuspocus/provider';
import { useEffect, useState } from 'react';
import { useDocumentContext } from '@/editor/DocumentContext';

type LifecycleStatus = 'conflict' | null;

function readStatus(provider: HocuspocusProvider | null): LifecycleStatus {
  if (!provider) return null;
  const raw = provider.document.getMap('lifecycle').get('status');
  return raw === 'conflict' ? 'conflict' : null;
}

export function useLifecycleStatus(docName: string | null): LifecycleStatus {
  const { poolEntries } = useDocumentContext();
  const entry = docName ? (poolEntries.find((e) => e.docName === docName) ?? null) : null;
  const provider = entry?.provider ?? null;
  const [status, setStatus] = useState<LifecycleStatus>(() => readStatus(provider));

  useEffect(() => {
    if (!provider) {
      setStatus(null);
      return;
    }
    const lifecycleMap = provider.document.getMap('lifecycle');
    setStatus(readStatus(provider));
    const onChange = () => setStatus(readStatus(provider));
    lifecycleMap.observe(onChange);
    return () => {
      lifecycleMap.unobserve(onChange);
    };
  }, [provider]);

  return status;
}
