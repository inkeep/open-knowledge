import { useEffect } from 'react';
import { getAgentThreadClient, threadUrlFromCollabUrl } from '@/lib/acp/thread-client';
import { useCollabUrl } from '@/lib/use-collab-url';

async function loadDevThreadHarnessInstaller(): Promise<
  typeof import('@/lib/acp/dev-thread-harness').installAcpThreadHarness
> {
  const mod = await import('@/lib/acp/dev-thread-harness');
  return mod.installAcpThreadHarness;
}

export function AgentThreadClientBinder(): null {
  const { collabUrl } = useCollabUrl();

  useEffect(() => {
    getAgentThreadClient().setUrl(threadUrlFromCollabUrl(collabUrl));
  }, [collabUrl]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let uninstall: (() => void) | null = null;
    let unmounted = false;
    loadDevThreadHarnessInstaller()
      .then((install) => {
        if (unmounted) return;
        uninstall = install(getAgentThreadClient());
      })
      .catch((err: unknown) => {
        console.warn(
          '[acp] dev thread harness unavailable; window.__acpThreadHarness will not be published',
          err,
        );
      });
    return () => {
      unmounted = true;
      uninstall?.();
    };
  }, []);

  return null;
}
