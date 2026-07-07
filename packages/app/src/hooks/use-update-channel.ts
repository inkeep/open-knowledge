/**
 * React hook exposing the desktop auto-updater channel (read-only).
 *
 * The channel is a property of the installed binary — `'beta'` for a
 * prerelease build, `'latest'` for a stable one — derived in the main process
 * from `app.getVersion()`. It cannot change at runtime, so this hook is a
 * one-shot `bridge.state.query()` on mount; there is no setter and no
 * cross-window broadcast to track.
 *
 * Returns `null` for `channel` until the query resolves, AND when
 * `window.okDesktop` is undefined (web / CLI distribution). Consumers should
 * treat `null` as "hide the channel-aware UI".
 *
 * Side-effect import on the bridge types module loads the
 * `Window.okDesktop?` global augmentation — same pattern as
 * `use-installed-agents.ts`.
 */
import { useEffect, useState } from 'react';
import '@/lib/desktop-bridge-types';

type UpdateChannel = 'latest' | 'beta';

interface UseUpdateChannelResult {
  /** Build-derived channel, or `null` while loading / when no desktop bridge is present. */
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
        // Bridge surface failure — leave channel null; the consuming
        // components hide entirely when channel is null. Log so a regression
        // in the bridge wiring stays observable rather than surfacing as
        // silent UI hiding.
        console.warn('[use-update-channel] bridge.state.query() failed', err);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { channel };
}
