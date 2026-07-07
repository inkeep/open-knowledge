/**
 * ShareButton — rightmost-cluster editor-toolbar action that produces a
 * marketing-safe share URL for the focused doc and copies it to the clipboard.
 *
 * The with-remote case is read-only against the local git state: the click
 * fires `POST /api/share/construct-url`, which reads `.git/HEAD` +
 * `.git/config` + `refs/remotes/origin/<branch>` on the server and emits the
 * encoded URL. No commits, no pushes — the github-sync
 * auto-sync layer (when onboarded) keeps the remote current.
 *
 * The no-remote case routes through `onClickWhenNoRemote` (the Publish
 * wizard wires here) instead of the construct endpoint. Surfaces own the
 * wizard mount state; the button keeps the contract narrow.
 *
 * On a successful share the button auto-copies, fires a confirmation toast,
 * AND surfaces a popover anchored to itself showing the URL as a selectable
 * code snippet with a `CopyButton` (icon swaps Copy → Check) plus a link to
 * the share docs — a more discoverable confirmation than the toast alone.
 * When the auto-copy is rejected (typically because the browser is embedded
 * in a parent frame whose Permissions-Policy doesn't include
 * `clipboard-write`), the same popover opens with a manual Cmd/Ctrl+C hint so
 * the user always has a copy path.
 *
 * All side effects (fetch, clipboard, toast, log) flow through
 * `runShareAction` in `@/lib/share/run-share-action` so the orchestration is
 * unit-testable without React.
 */

import type { ShareFreshness } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { CircleHelp, Share2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { useGitSyncStatusDetailed } from '@/hooks/use-git-sync-status';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { scheduleClipboardWrite } from '@/lib/share/clipboard-adapter';
import {
  CLIPBOARD_ERROR_TOAST,
  runShareAction,
  type ShareTargetInput,
} from '@/lib/share/run-share-action';
import { cn } from '@/lib/utils';
import { ShareFreshnessWarning, shareFreshnessRowVisible } from './ShareFreshnessWarning';

/** Docs page explaining the share flow (links out of the popover). */
const SHARE_DOCS_URL = 'https://openknowledge.ai/docs/features/share';

export interface ShareButtonProps {
  /**
   * Active share target. When `null` the trigger renders disabled (nothing to
   * share — folder/empty/asset views with no active doc). Surfaces own the
   * doc-vs-folder discrimination via `buildDocShareInput` / `buildFolderShareInput`;
   * mirrors the `OpenInAgentMenu.input` always-render-but-disable-when-null
   * contract so the button stays visible across every editor view.
   */
  input: ShareTargetInput | null;
  /**
   * Called when the click lands on a no-remote project. The surface (an
   * editor wrapper, typically) is responsible for mounting the Publish
   * wizard modal in response. The button itself never holds wizard state.
   */
  onClickWhenNoRemote: () => void;
}

export function ShareButton({ input, onClickWhenNoRemote }: ShareButtonProps) {
  const { t } = useLingui();
  const { status } = useGitSyncStatusDetailed();
  const [busy, setBusy] = useState(false);
  // Drives the share popover. On a successful share we open it to confirm the
  // (already-performed) auto-copy and offer a re-copy button. When the
  // auto-copy was refused (commonly an iframe Permissions-Policy refusal),
  // `autoCopyFailed` flips the popover into manual-copy mode. Cleared on next
  // click + on popover close.
  const [sharePopover, setSharePopover] = useState<{
    url: string;
    autoCopyFailed: boolean;
    freshness?: ShareFreshness;
  } | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);

  // In the auto-copy-failed case, pre-select the URL when the popover opens so
  // Cmd/Ctrl+C is one keystroke. On success the CopyButton is the primary
  // affordance, so we don't steal focus from the trigger.
  useEffect(() => {
    if (!sharePopover?.autoCopyFailed || !urlInputRef.current) return;
    urlInputRef.current.focus();
    urlInputRef.current.select();
  }, [sharePopover]);

  const hasRemote = status?.hasRemote === true;
  const triggerDisabled = input === null;
  const showFreshnessRow = shareFreshnessRowVisible(sharePopover?.freshness, status);

  async function handleClick() {
    if (busy) return;
    if (input === null) return;
    setBusy(true);
    setSharePopover(null);
    try {
      const result = await runShareAction(
        {
          ...input,
          hasRemote,
          onClickWhenNoRemote,
        },
        {
          clipboardWrite: scheduleClipboardWrite,
          toastSuccess: (msg) => toast.success(msg),
          toastError: (msg) => {
            // Suppress runShareAction's own clipboard-failure toast — we
            // surface the URL in a popover instead. Other error toasts
            // (transport / business errors) still fire normally.
            if (msg === CLIPBOARD_ERROR_TOAST) return;
            toast.error(msg);
          },
          logEvent: (msg) => console.log(msg),
        },
      );
      if (result.kind === 'copied') {
        setSharePopover({
          url: result.shareUrl,
          autoCopyFailed: false,
          freshness: result.freshness,
        });
      } else if (result.kind === 'clipboard-failed') {
        setSharePopover({
          url: result.shareUrl,
          autoCopyFailed: true,
          freshness: result.freshness,
        });
      }
    } catch {
      // runShareAction handles its own transport + clipboard rejections
      // internally; this catch defends against a synchronous throw from
      // `onClickWhenNoRemote`. React Compiler (BuildHIR) does not support
      // `try`/`finally`, so the busy reset lives outside the try/catch.
      toast.error(t`Could not construct share URL.`);
    }
    setBusy(false);
  }

  return (
    <Popover
      open={sharePopover !== null}
      onOpenChange={(open) => {
        if (!open) setSharePopover(null);
      }}
    >
      {/* No tooltip: the visible "Share" label already names the control, so a
          tooltip repeating it would be redundant. Icon-only toolbar siblings
          (e.g. SyncStatusBadge) still carry a tooltip — they have no visible
          text. */}
      <PopoverAnchor asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={input?.kind === 'folder' ? t`Share folder` : t`Share doc`}
          onClick={handleClick}
          disabled={busy || triggerDisabled}
          className="gap-1.5 text-muted-foreground px-1.5"
          data-testid="share-button"
        >
          <Share2 className="size-3.5" aria-hidden />
          <Trans>Share</Trans>
        </Button>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        className={cn('flex flex-col gap-2', showFreshnessRow ? 'w-96' : 'w-80')}
        data-testid="share-button-popover"
      >
        {/* Mono/uppercase muted label — the same treatment the help menu uses
            for its section labels; spacing here comes from the popover's flex gap. */}
        <p className="font-mono tracking-wide uppercase text-muted-foreground text-xs">
          <Trans>Share</Trans>
        </p>
        {sharePopover?.autoCopyFailed ? (
          <p className="text-xs text-muted-foreground">
            <Trans>Use Cmd/Ctrl+C to copy the link below, or open OK in the desktop app.</Trans>
          </p>
        ) : null}
        <div className="relative">
          <Input
            ref={urlInputRef}
            readOnly
            value={sharePopover?.url ?? ''}
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.currentTarget.select()}
            // Right-click must land with the URL selected so any native
            // context menu the host provides offers an enabled Copy.
            onContextMenu={(e) => e.currentTarget.select()}
            // Muted fill + mono reads as a non-editable code snippet; the
            // trailing copy button floats over the end, so no
            // reserved right padding — long URLs slide under the frosted button.
            className="select-all bg-muted font-mono text-xs text-muted-foreground"
            data-testid="share-button-url"
            aria-label={t`Share URL`}
          />
          {/* Copy button sits on top of the snippet with a frosted backdrop so
              it stays legible over the URL text underneath it. */}
          <div className="absolute inset-y-0 right-1 flex items-center">
            <div className="rounded-md bg-background/50 backdrop-blur-sm">
              <CopyButton
                copyContent={sharePopover?.url ?? ''}
                clipboardWrite={scheduleClipboardWrite}
                // Success path already copied at click time → open showing the
                // check; the failed path hasn't copied, so start as Copy.
                initialCopied={sharePopover?.autoCopyFailed === false}
              />
            </div>
          </div>
        </div>
        <ShareFreshnessWarning
          freshness={sharePopover?.freshness}
          status={status}
          kind={input?.kind ?? 'doc'}
        />
        <a
          href={SHARE_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => dispatchExternalLinkClick(e, SHARE_DOCS_URL)}
          onAuxClick={(e) => dispatchExternalLinkClick(e, SHARE_DOCS_URL)}
          className="mt-2 flex items-center gap-1.5 self-start text-xs text-muted-foreground transition-colors hover:text-primary"
        >
          <CircleHelp aria-hidden="true" className="size-3.5 shrink-0" />
          <Trans>How does sharing work?</Trans>
        </a>
      </PopoverContent>
    </Popover>
  );
}
