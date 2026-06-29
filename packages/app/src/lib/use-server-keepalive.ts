import { startKeepalive as defaultStartKeepalive } from '@inkeep/open-knowledge-core/keepalive';
import { useEffect, useRef } from 'react';
import { tryElectronBridge } from '@/lib/use-collab-url';

export function keepaliveBaseFromCollabUrl(collabUrl: string | null): string | undefined {
  if (!collabUrl) return undefined;
  return collabUrl.replace(/\/collab\/?$/, '');
}

export interface UseServerKeepaliveOptions {
  startKeepalive?: typeof defaultStartKeepalive;
  isElectronHost?: () => boolean;
}

function defaultIsElectronHost(): boolean {
  return tryElectronBridge(window) !== null;
}

export function useServerKeepalive(
  collabUrl: string | null,
  options?: UseServerKeepaliveOptions,
): void {
  const collabUrlRef = useRef(collabUrl);
  const optionsRef = useRef(options);

  useEffect(() => {
    collabUrlRef.current = collabUrl;
  }, [collabUrl]);

  useEffect(() => {
    const start = optionsRef.current?.startKeepalive ?? defaultStartKeepalive;
    const isElectronHost = optionsRef.current?.isElectronHost ?? defaultIsElectronHost;
    if (isElectronHost()) return;
    const handle = start({
      resolveWsUrl: async () => keepaliveBaseFromCollabUrl(collabUrlRef.current),
    });
    return () => handle.close();
  }, []);
}
