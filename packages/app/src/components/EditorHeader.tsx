import { parseManagedArtifactName } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDocumentContext } from '@/editor/DocumentContext';
import { formatShortcut } from '@/lib/keyboard-shortcuts';
import {
  buildDocShareInput,
  buildFolderShareInput,
  type ShareTargetInput,
} from '@/lib/share/run-share-action';
import { useSingleFileMode } from '@/lib/single-file-mode';
import { cn } from '@/lib/utils';
import { PresenceBar } from '@/presence/PresenceBar';
import { BetaBadge } from './BetaBadge';
import { EditorTabs } from './EditorTabs';
import { HelpPopover } from './HelpPopover';
import { PublishToGitHubDialog } from './PublishToGitHubDialog';
import { SettingsButton } from './SettingsButton';
import { ShareButton } from './ShareButton';
import { SyncStatusBadge } from './SyncStatusBadge';

interface EditorHeaderProps {
  onSignIn?: () => void;
  onSetIdentity?: () => void;
  onOpenSearch?: () => void;
}

export function EditorHeader({ onSignIn, onSetIdentity, onOpenSearch }: EditorHeaderProps) {
  const { t } = useLingui();
  const { activeDocName, activeTarget } = useDocumentContext();
  // Managed-artifact tabs (skills/templates) are ordinary docs but carry their
  // own header treatment: neither skills nor templates are shareable (the
  // synthetic doc name isn't a real on-disk path to share), so the ShareButton
  // trigger gates on this. The agent-handoff for a skill lives in the Skills
  // sidebar (SkillRow / skill-actions), not the header.
  const managedArtifact = activeDocName ? parseManagedArtifactName(activeDocName) : null;
  const { state: sidebarState, isDraggingRail } = useSidebar();
  // No-project single-file session (`ok <file>`): drop the project chrome
  // (sidebar toggle, tab strip, Settings) while leaving the editor + the
  // doc-scoped actions (Share / sync / agent handoff) intact.
  const singleFile = useSingleFileMode();
  const sidebarShortcut = formatShortcut('toggle-files-sidebar');
  const searchShortcut = formatShortcut('command-palette');
  const [publishOpen, setPublishOpen] = useState(false);
  // Share input for the header button: folder → folder-scope, doc → doc-scope,
  // empty editor → project root; non-shareable surfaces yield null (disabled).
  const shareInput: ShareTargetInput | null = (() => {
    if (activeTarget?.kind === 'folder') {
      return buildFolderShareInput(activeTarget.folderPath);
    }
    // Managed-artifact tabs aren't shareable — their synthetic doc name has no
    // shareable on-disk path.
    if (activeDocName && !managedArtifact) {
      return buildDocShareInput(activeDocName);
    }
    if (!activeTarget && !activeDocName) {
      return buildFolderShareInput('');
    }
    return null;
  })();

  // Electron host gates the macOS chrome-row treatment: a traffic-light
  // reserve at the inset position, plus a draggable header surface with
  // explicit no-drag opt-outs on every interactive child. Web hosts (CLI
  // distribution at `ok ui` localhost) keep the existing layout — no padding
  // shift, no drag region, no traffic-light reserve. Detection mirrors the
  // canonical idiom used in OpenInAgentMenu and FileTree.
  const isElectronHost = typeof window !== 'undefined' && window.okDesktop != null;
  // Sidebar collapse drives the traffic-light reserve. When the sidebar is
  // expanded, the macOS traffic lights overlap the SIDEBAR (not the
  // EditorHeader), so the reserve is unnecessary and would push every
  // editor-header child uselessly to the right. When the sidebar collapses
  // offcanvas, the EditorHeader's left edge becomes the window's left edge
  // and the reserve is required to keep the SidebarTrigger clear of the
  // traffic lights. The reserve uses the shared `--ok-titlebar-reserve-left`
  // token (defined under `html.electron-mode`) so the magic 78px lives in one
  // place; the `,1rem` fallback is the precedent-#49 safe form. The padding
  // transition (and its drag-snap exception) is documented at the className.
  const isCollapsed = sidebarState === 'collapsed';

  return (
    <header
      data-electron-drag={isElectronHost ? '' : undefined}
      className={cn(
        'flex h-12 shrink-0 items-center bg-muted/35 shadow-[inset_0_-1px_0_var(--border)]',
        isElectronHost && '[-webkit-app-region:drag]',
        isElectronHost && isCollapsed && 'pl-[var(--ok-titlebar-reserve-left,1rem)]',
        // Animate the reserve in lockstep with the sidebar's 200ms offcanvas
        // slide on a button/keyboard toggle — but SNAP it while the rail is
        // being dragged. A drag-collapse sets `data-dragging` on the sidebar
        // group, which forces `duration-0` on the sidebar's own slide, so the
        // sidebar vanishes instantly; an animated reserve would lag ~200ms
        // behind and park the collapse/search controls under the macOS traffic
        // lights for the length of the animation.
        isElectronHost &&
          !isDraggingRail &&
          'motion-safe:transition-[padding] motion-safe:duration-200 motion-safe:ease-linear',
      )}
    >
      {/*
        Left zone uses per-child `no-drag` opt-outs (instead of the
        right zone's `[&>*]:` child-combinator) because EditorTabs is a
        direct child whose own root MUST stay draggable so the empty
        space inside the tab strip continues to drag the window. Adding
        a future interactive control here? Apply `[-webkit-app-region:
        no-drag]` (gated on `isElectronHost`) explicitly on the new
        element — the right zone's blanket opt-out is intentionally
        scoped to its zone.
      */}
      {/* The left zone (files toggle, search, tab strip) is project chrome —
          empty in single-file mode. The flex-1 container stays so the right
          zone keeps its position and the window-drag spacer is preserved. */}
      <div className="flex min-w-0 flex-1 items-center gap-1 px-3">
        {!singleFile && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <SidebarTrigger
                  className={cn(
                    '-ml-1 shrink-0 text-muted-foreground',
                    isElectronHost && '[-webkit-app-region:no-drag]',
                  )}
                />
              </TooltipTrigger>
              <TooltipContent>
                {sidebarState === 'expanded' ? (
                  <Trans>Hide Files ({sidebarShortcut})</Trans>
                ) : (
                  <Trans>Show Files ({sidebarShortcut})</Trans>
                )}
              </TooltipContent>
            </Tooltip>
            {isCollapsed && onOpenSearch && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={onOpenSearch}
                    aria-label={t`Search (${searchShortcut})`}
                    data-telemetry-event="ok.editor_header.search.click"
                    className={cn(
                      'shrink-0 text-muted-foreground',
                      isElectronHost && '[-webkit-app-region:no-drag]',
                    )}
                  >
                    <Search aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <Trans>Search ({searchShortcut})</Trans>
                </TooltipContent>
              </Tooltip>
            )}
            <Separator
              orientation="vertical"
              className="mr-1 h-4 shrink-0 data-vertical:self-center"
            />
            <EditorTabs />
          </>
        )}
      </div>

      <div
        className={cn(
          'flex shrink-0 items-center justify-end gap-2 px-3',
          // Child-combinator opt-out: every direct DOM child of the right zone
          // gets `app-region: no-drag` so clicks on Save / OpenInAgentMenu /
          // SyncStatusBadge / PresenceBar / BetaBadge / SettingsButton /
          // HelpPopover (and the visual Separator) fire their handlers instead
          // of initiating a window drag. Each consumer uses Radix asChild so
          // the rendered DOM root is a single direct child of this zone.
          isElectronHost && '[&>*]:[-webkit-app-region:no-drag]',
        )}
      >
        {/* Share is a project surface: single-file `ok <file>` runs agents/MCP
            off and on a throwaway server, so a share link would point at a
            session that's gone on close. Hidden here (mirrors the
            sidebar/Settings gates) rather than rendered disabled. */}
        {!singleFile && (
          <>
            <ShareButton input={shareInput} onClickWhenNoRemote={() => setPublishOpen(true)} />
            <PublishToGitHubDialog open={publishOpen} onOpenChange={setPublishOpen} />
          </>
        )}
        <SyncStatusBadge onSignIn={onSignIn} onSetIdentity={onSetIdentity} />
        <PresenceBar />
        <Separator orientation="vertical" className="h-4 shrink-0 data-vertical:self-center" />
        <BetaBadge />
        {/* Settings is unavailable in single-file mode (config editing is inert). */}
        {!singleFile && <SettingsButton />}
        <HelpPopover />
      </div>
    </header>
  );
}
