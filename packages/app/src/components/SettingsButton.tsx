/**
 * Settings entry-point button for the editor header.
 *
 * Sibling to `<HelpPopover>` — opens the Settings dialog by writing the
 * canonical `#settings` hash. `useSettingsRoute` (mounted by
 * `EditorArea` via `SettingsDialogPortal`) reacts to the hash change
 * and renders the dialog.
 *
 * Same hash-routed open contract used by Cmd-,, the CommandPalette
 * entry, and the Electron menu — see App.tsx + use-settings-route.ts.
 * Funneling all four trigger surfaces through one literal keeps the
 * dialog's open semantics single-sourced.
 *
 * Prefetch-on-intent
 *   The Settings dialog body lives in a lazy chunk (~330kB of form
 *   harness, schema-walker, RHF, ConfigSchema, Sync/Templates/Okignore
 *   sections). Warming that chunk on hover/focus removes the network
 *   round-trip from the cold-open path — by the time the click fires
 *   the chunk is resolved or in-flight, so on a slow connection the
 *   body is ready meaningfully sooner. It does NOT eliminate the
 *   cold-open content skeleton on a fast connection: the skeleton is
 *   gated by the body subtree's first-render cost (React.lazy's
 *   mandatory first-render Suspense tick plus the RHF form +
 *   schema-walker + sections mounting), which prefetch cannot shortcut.
 *   Only a warm reopen is skeleton-free (the committed body tree is
 *   retained). Making the cold first-open itself skeleton-free would
 *   require pre-rendering the body tree off-screen (`<Activity>`),
 *   which is a deliberate non-goal of this surface.
 *
 *   Pattern: a 50ms debounce gates the preload so micro-hovers (mouse
 *   passing over the button on the way to something else) don't fire
 *   the import. The timer is cancelled on leave/blur. The underlying
 *   `SettingsDialogBodyLazy.preload()` is itself idempotent — repeated
 *   calls return the same memoized promise — so this debounce is a UX
 *   guard, not a correctness one.
 */

import { Trans } from '@lingui/react/macro';
import { Settings } from 'lucide-react';
import { type FC, useEffect, useRef } from 'react';
import { SettingsDialogBodyLazy } from '@/components/settings/SettingsDialogBodyLazy';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SETTINGS_OPEN_HASH } from '@/lib/use-settings-route';

const PREFETCH_INTENT_DELAY_MS = 50;

export const SettingsButton: FC = () => {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedulePreload = () => {
    if (timerRef.current !== null) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      SettingsDialogBodyLazy.preload();
    }, PREFETCH_INTENT_DELAY_MS);
  };

  const cancelPreload = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // Cleanup on unmount: clears any pending preload timer the leave/blur
  // handlers didn't catch (e.g. component unmounts mid-hover). The
  // current callback is ref-only + idempotent preload, so this guard is
  // preventive — keeps the React idiom consistent and avoids a stale-ref
  // footgun if the callback ever gains a setState.
  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    },
    [],
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 hover:bg-accent text-muted-foreground"
          data-testid="header-settings-button"
          onMouseEnter={schedulePreload}
          onMouseLeave={cancelPreload}
          onFocus={schedulePreload}
          onBlur={cancelPreload}
          onClick={() => {
            cancelPreload();
            if (window.location.hash !== SETTINGS_OPEN_HASH) {
              window.location.hash = SETTINGS_OPEN_HASH;
            }
          }}
        >
          <Settings className="size-4" />
          <span className="sr-only">
            <Trans>Settings</Trans>
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <Trans>Settings</Trans>
      </TooltipContent>
    </Tooltip>
  );
};
