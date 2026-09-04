// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import type { ShareFreshness } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { CircleHelp, Share2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { useGitSyncStatusDetailed } from '@/hooks/use-git-sync-status';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { formatShortcutBinding, formatShortcutBindingLabel } from '@/lib/keyboard-shortcuts';
import { scheduleClipboardWrite } from '@/lib/share/clipboard-adapter';
import { runShareAction, type ShareTargetInput } from '@/lib/share/run-share-action';
import { cn } from '@/lib/utils';
import { ShareFreshnessWarning, shareFreshnessRowVisible } from './ShareFreshnessWarning';

const SHARE_DOCS_URL = 'https://openknowledge.ai/docs/features/share';
const COPY_SHORTCUT = { mac: '⌘ C', windowsLinux: 'Ctrl C' };

export interface ShareButtonProps {
  input: ShareTargetInput | null;
  onClickWhenNoRemote: () => void;
}

export function ShareButton({ input, onClickWhenNoRemote }: ShareButtonProps) {
  const { t } = useLingui();
  const { status } = useGitSyncStatusDetailed();
  const [busy, setBusy] = useState(false);
  const [sharePopover, setSharePopover] = useState<{
    url: string;
    autoCopyFailed: boolean;
    freshness?: ShareFreshness;
  } | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!sharePopover?.autoCopyFailed || !urlInputRef.current) return;
    urlInputRef.current.focus();
    urlInputRef.current.select();
  }, [sharePopover]);

  const hasRemote = status?.hasRemote === true;
  const triggerDisabled = input === null;
  const showFreshnessRow = shareFreshnessRowVisible(sharePopover?.freshness, status);
  const copyShortcut = formatShortcutBinding(COPY_SHORTCUT);
  const copyShortcutLabel = formatShortcutBindingLabel(COPY_SHORTCUT);

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
          toastError: (msg, reason) => {
            if (reason === 'clipboard') return;
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
      {}
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
        {}
        <p className="font-mono tracking-wide uppercase text-muted-foreground text-xs">
          <Trans>Share</Trans>
        </p>
        {sharePopover?.autoCopyFailed ? (
          <p className="text-xs text-muted-foreground">
            <Trans>
              Use <Kbd aria-label={copyShortcutLabel}>{copyShortcut}</Kbd> to copy the link below,
              or open OK in the desktop app.
            </Trans>
          </p>
        ) : null}
        <div className="relative">
          <Input
            ref={urlInputRef}
            readOnly
            value={sharePopover?.url ?? ''}
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.currentTarget.select()}
            onContextMenu={(e) => e.currentTarget.select()}
            className="select-all bg-muted font-mono text-xs text-muted-foreground"
            data-testid="share-button-url"
            aria-label={t`Share URL`}
          />
          {}
          <div className="absolute inset-y-0 right-1 flex items-center">
            <div className="rounded-md bg-background/50 backdrop-blur-sm">
              <CopyButton
                copyContent={sharePopover?.url ?? ''}
                clipboardWrite={scheduleClipboardWrite}
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
