/**
 * Single-file mode — is this editor a no-project ephemeral single-file session
 * (`ok <file>`)? When true, the App drops project chrome (file sidebar, tabs,
 * project switcher, Settings) while keeping the editor editable.
 *
 * Dual-channel, mirroring `useCollabUrl`'s Electron short-circuit because the
 * signal's source differs by surface:
 *   - **Desktop** — the renderer loads from `file://` (off-origin from the collab
 *     server), so `/api/config` is unreachable. The flag rides the bridge config
 *     (`window.okDesktop.config.singleFile`), the same channel as `collabUrl` /
 *     `apiOrigin`. Resolves synchronously at mount → no chrome flash.
 *   - **Browser fallback** — the shell IS served from the ephemeral server
 *     origin, so `/api/config` answers same-origin with `singleFile`. One fetch
 *     at mount; a brief pre-resolution frame may show chrome (cosmetic, fallback
 *     surface only).
 *
 * Exposed via a provider + context so the (browser) fetch runs once for the whole
 * tree rather than per consumer. `useSingleFileMode()` returns `false` outside a
 * provider — the default for every normal project window.
 */
import { createContext, type ReactNode, use, useEffect, useState } from 'react';
import { fetchApiConfig } from '@/lib/api-config';
// Loads the `Window.okDesktop?` global augmentation (side-effect import).
import '@/lib/desktop-bridge-types';

const SingleFileModeContext = createContext<boolean>(false);

export function SingleFileModeProvider({ children }: { children: ReactNode }) {
  const [singleFile, setSingleFile] = useState<boolean>(() =>
    typeof window !== 'undefined' ? (window.okDesktop?.config.singleFile ?? false) : false,
  );

  useEffect(() => {
    // Desktop: the bridge config is authoritative and already resolved
    // synchronously above — no fetch (and `/api/config` is off-origin anyway).
    // `useEffect` is client-side, so `window` is always defined here.
    if (window.okDesktop) return;

    const controller = new AbortController();
    void fetchApiConfig(controller.signal)
      .then((result) => {
        if (controller.signal.aborted || result.status !== 'ok') return;
        setSingleFile(result.config.singleFile);
      })
      // fetchApiConfig rethrows AbortError on unmount — expected, swallow it.
      .catch(() => {});
    return () => controller.abort();
  }, []);

  return <SingleFileModeContext value={singleFile}>{children}</SingleFileModeContext>;
}

/** `true` when this editor is an ephemeral single-file session (`ok <file>`). */
export function useSingleFileMode(): boolean {
  return use(SingleFileModeContext);
}
