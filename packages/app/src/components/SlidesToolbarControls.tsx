import type { HocuspocusProvider } from '@hocuspocus/provider';
import { Trans, useLingui } from '@lingui/react/macro';
import { Presentation } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { recordSlidesOpened } from '@/lib/slides-telemetry';
import { useBooleanFrontmatterField } from '@/lib/use-boolean-frontmatter-field';
import { useWorkspace } from '@/lib/use-workspace';
import { docNameToRelativePath, joinWorkspacePath } from '@/lib/workspace-paths';

/**
 * Lazy-loaded Slides action for the editor toolbar. `EditorToolbar` mounts it
 * only past the cheap synchronous gate (plugin enabled ∧ slides host ∧ a live
 * provider ∧ an active doc name — the last is what makes `docName` a non-null
 * `string` here), so this cluster stays out of the eager bundle and this
 * component only decides the two remaining conditions: the active doc declares
 * `slides: true`, and a runnable `slidev` resolved for the project. Both false →
 * renders nothing. Activating it opens the deck in its own window via the
 * `ok:slides:dispatch` `open` action.
 */

/**
 * Availability of a runnable `slidev` for this window's project, resolved once
 * per deck via the `status` probe. `'pending'` holds the action hidden until the
 * probe answers, so a deck never flashes an action that turns out not to work.
 */
type SlidevAvailability = 'pending' | 'available' | 'unavailable';

function useSlidevAvailability(isDeck: boolean): SlidevAvailability {
  const [availability, setAvailability] = useState<SlidevAvailability>('pending');
  useEffect(() => {
    // Only a deck can show the action, so a non-deck skips the fs-stat +
    // login-shell probe entirely.
    if (!isDeck) return;
    let active = true;
    // A FOUND slidev unsubscribes the focus listener below, so the steady state
    // is already free. A MISSING one keeps listening — that is the case this
    // throttle bounds: with the plugin on, a deck open, and slidev never
    // installed, every alt-tab would otherwise spawn a login shell, forever.
    // The interval is far shorter than any real install, so the mid-session
    // install-then-return path still lands on the first focus after it finishes.
    const MIN_REPROBE_INTERVAL_MS = 10_000;
    let lastProbeAt = 0;
    let resolved = false;
    const probe = () => {
      lastProbeAt = Date.now();
      const slides = window.okDesktop?.slides;
      if (slides == null) {
        setAvailability('unavailable');
        return;
      }
      slides
        .status()
        .then((result) => {
          if (!active) return;
          setAvailability(result.available ? 'available' : 'unavailable');
          // Stop re-probing once found. A resolvable slidev rarely disappears
          // mid-session, and each status() runs a login-shell PATH probe for a
          // global install — so an open deck's steady state must not spawn a
          // shell on every window focus. A flag rather than an inline
          // removeEventListener: naming the handler here would be a forward
          // reference to a function declared below, which the React Compiler
          // rejects at build time even though tsc and the tests accept it.
          if (result.available) resolved = true;
        })
        // Trust boundary: status is an IPC round-trip to a separate process; a
        // rejected invoke reads as "no runnable slidev" rather than crashing the
        // effect. Log it so a broken bridge is distinguishable in diagnostics
        // from a genuinely-absent slidev — both hide the action, but only one is
        // a bug.
        .catch((err: unknown) => {
          console.warn(
            '[slides] availability probe failed:',
            err instanceof Error ? err : String(err),
          );
          if (active) setAvailability('unavailable');
        });
    };
    // Focus fires on every window return; the throttle keeps a not-yet-found
    // slidev from turning that into a shell spawn each time.
    const probeOnFocus = () => {
      if (resolved) return;
      if (Date.now() - lastProbeAt < MIN_REPROBE_INTERVAL_MS) return;
      probe();
    };
    probe();
    // Re-probe when the user returns to the window until slidev resolves,
    // mirroring the Settings panel. The mid-session first-run path is: open a
    // deck, see no action, install slidev in a terminal, switch back — that
    // switch is the focus event, so the action appears without reopening the
    // document. Once found, the probe above unsubscribes this listener.
    window.addEventListener('focus', probeOnFocus);
    return () => {
      active = false;
      window.removeEventListener('focus', probeOnFocus);
    };
  }, [isDeck]);
  return availability;
}

export function SlidesToolbarControls({
  provider,
  docName,
}: {
  provider: HocuspocusProvider;
  docName: string;
}) {
  const { t } = useLingui();
  const isDeck = useBooleanFrontmatterField(provider, 'slides');
  const availability = useSlidevAvailability(isDeck);
  const workspace = useWorkspace();

  if (!isDeck || availability !== 'available') return null;

  async function openAsSlides() {
    const slides = window.okDesktop?.slides;
    // `slides` is present by the same gate that mounted this control, and
    // `workspace` resolves synchronously on that desktop host — both are narrowed
    // here for the absolute-path build and the IPC call.
    if (slides == null || workspace == null) return;
    // Activation marker — the user used the Slides action. Emitted before the
    // dispatch so intent is recorded independently of whether the server starts.
    recordSlidesOpened();
    const docPath = joinWorkspacePath(
      workspace.contentDir,
      docNameToRelativePath(docName),
      workspace.pathSeparator,
    );
    try {
      const result = await slides.open(docPath);
      if (!result.ok) {
        // Each reachable failure implies a different next step, so distinguish
        // them: a boot that crashed Slidev (exited-early), a boot that hung
        // (timeout), and a foreign/too-old server on the port
        // (unsupported-server) are not the same problem. The generic copy stays
        // for the rest (and the transport catch below, where the reason is
        // genuinely unknown).
        let message: string;
        switch (result.reason) {
          case 'timeout':
            message = t`Slidev timed out while starting. Try again.`;
            break;
          case 'exited-early':
            message = t`Slidev couldn't render this document.`;
            break;
          case 'unsupported-server':
            message = t`This isn't a supported version of Slidev.`;
            break;
          case 'spawn-error':
            message = t`Couldn't start Slidev.`;
            break;
          case 'not-available':
          case 'invalid-path':
            // Rare races (slidev disappeared, or the deck path stopped
            // resolving, after the action was shown) with no next step beyond
            // the generic copy — but enumerated so the anchor below flags a new
            // reason at compile time rather than letting it fall through silently.
            message = t`Couldn't open this document in Slidev.`;
            break;
          default: {
            // Exhaustiveness anchor: every SlidevOpenFailureReason is handled
            // above, so a new variant fails to compile here until it is given
            // copy, instead of being absorbed into the generic message.
            const _exhaustive: never = result.reason;
            message = t`Couldn't open this document in Slidev.`;
          }
        }
        toast.error(message);
      }
    } catch (err) {
      // Trust boundary: the open dispatch crosses into the main process; a
      // rejected invoke (transport / preload) surfaces the same failure as a
      // returned not-ok result rather than failing silently. Log the cause so a
      // broken bridge is distinguishable from a returned not-ok result — the
      // same way the sibling status probe logs its rejection.
      console.warn('[slides] open dispatch failed:', err instanceof Error ? err : String(err));
      toast.error(t`Couldn't open this document in Slidev.`);
    }
  }

  return (
    <Tooltip>
      <Button
        variant="ghost"
        size="icon"
        onClick={openAsSlides}
        aria-label={t`Open in Slidev`}
        data-testid="slides-toolbar-action"
        asChild
      >
        <TooltipTrigger>
          <Presentation aria-hidden />
        </TooltipTrigger>
      </Button>
      <TooltipContent side="bottom">
        <Trans>Open in Slidev</Trans>
      </TooltipContent>
    </Tooltip>
  );
}
