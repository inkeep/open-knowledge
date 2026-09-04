import { useEffect, useState } from 'react';
import '@/lib/desktop-bridge-types';

type UpdateChannel = 'latest' | 'beta';

interface UseUpdateChannelResult {
  readonly channel: UpdateChannel | null;
}

export function useUpdateChannel(): UseUpdateChannelResult {
  const [channel, setChannelState] = useState<UpdateChannel | null>(null);

  useEffect(() => {
    const bridge = window.okDesktop;
    if (!bridge) return;

    let cancelled = false;
    void bridge.state
      .query()
      .then((snap) => {
        if (!cancelled) setChannelState(snap.channel);
      })
      .catch((err: unknown) => {
        console.warn('[use-update-channel] bridge.state.query() failed', err);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { channel };
}
