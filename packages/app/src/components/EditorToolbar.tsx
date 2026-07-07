import { parseManagedArtifactName, type SkillScope } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ListPlus, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { EditorModeValue } from '@/editor/use-editor-mode.ts';
import { formatShortcut, formatShortcutLabel } from '@/lib/keyboard-shortcuts';
import { parseProjectSkillContentDocName } from '@/lib/managed-artifact-doc-name';
import { cn } from '@/lib/utils';
import { EditorBreadcrumb } from './EditorBreadcrumb';
import { EditorModeToggle } from './EditorModeToggle';

// Lazy-loaded: skill install/history chrome (+ the shared useSkillActions
// dialogs) only mounts when the active doc is a skill, so it stays out of the
// eager toolbar bundle that every document loads.
const SkillEditorActions = lazy(async () => ({
  default: (await import('./SkillEditorActions')).SkillEditorActions,
}));

interface EditorToolbarProps {
  activeDocName: string | null;
  isSourceMode: boolean;
  sourceDisabled: boolean;
  onModeChange: (mode: EditorModeValue) => void;
  showAddPropertyButton: boolean;
  onAddProperty: () => void;
  isPanelCollapsed: boolean;
  onTogglePanel: () => void;
  /** Reserve right-side room in the action cluster so it sits left of the
   *  right-dock "Show terminal" reveal tab (which pins to the far-right corner
   *  the cluster reaches once the doc panel is collapsed) — keeping the two in
   *  one row instead of overlapping. */
  reserveRightGutter?: boolean;
}

export function EditorToolbar({
  activeDocName,
  isSourceMode,
  sourceDisabled,
  onModeChange,
  showAddPropertyButton,
  onAddProperty,
  isPanelCollapsed,
  onTogglePanel,
  reserveRightGutter = false,
}: EditorToolbarProps) {
  const { t } = useLingui();
  const panelShortcut = formatShortcut('toggle-document-panel');
  const panelShortcutLabel = formatShortcutLabel('toggle-document-panel');
  // Skills carry install/uninstall + history chrome in this per-doc toolbar
  // (templates + documents don't — only skills are installed). Install is a
  // live symlink, so there's no reinstall step.
  const managed = activeDocName ? parseManagedArtifactName(activeDocName) : null;
  // Skills carry the install chrome whether they're global (managed-artifact
  // docs) or project (content docs `.ok/skills/<name>/SKILL`) — same identity,
  // same toolbar chrome, so the two scopes aren't disconnected.
  const projectSkillName = activeDocName ? parseProjectSkillContentDocName(activeDocName) : null;
  const activeSkill: { scope: SkillScope; name: string } | null =
    managed?.kind === 'skill'
      ? { scope: managed.scope, name: managed.name }
      : projectSkillName
        ? { scope: 'project', name: projectSkillName }
        : null;
  return (
    <div data-testid="editor-toolbar" className="pointer-events-none absolute inset-x-0 top-0 z-10">
      {/*
        Outer wrapper mirrors the editor's content-column grid so the inner
        3-col layout aligns with the WYSIWYG content area. Without this, the
        previous `px-2` on the inner grid pushed the breadcrumb cell ~8px
        right of the editor's first text block. Cells inside `.editor-content-aligned`
        land on the `content` column automatically via the `> *` rule.
      */}
      <div className="editor-content-aligned bg-background py-2">
        <div className="grid grid-cols-3 items-center">
          {/*
          Breadcrumb cell. The parent grid is `pointer-events-none` so the
          editor canvas underneath remains clickable through the toolbar's
          empty regions; this cell must scope its own `pointer-events-auto`
          so the breadcrumb's per-segment `title` tooltips actually surface.
          Future siblings dropped into this cell must follow the same rule.
        */}
          <div className="pointer-events-auto flex min-w-0 items-center">
            {/* Skills show their identity (name/scope) in the panel, so the
                `.ok/skills/<name>` path breadcrumb is noise — suppress it for
                both scopes to match the global-skill editor. */}
            {activeSkill ? null : <EditorBreadcrumb docName={activeDocName} />}
          </div>
          <div className="pointer-events-auto flex justify-center">
            <EditorModeToggle
              isSourceMode={isSourceMode}
              onModeChange={onModeChange}
              sourceDisabled={sourceDisabled}
            />
          </div>
          {/*
            Third column kept empty so the mode toggle stays centered in the
            content column. The action buttons render in the pane-edge
            cluster below, not here.
          */}
        </div>
      </div>
      {/*
        Action buttons sit flush against the doc-panel divider (the editor
        pane's right edge), not the narrower content column. `absolute` lifts
        them clear of the `.editor-content-aligned` grid; `pointer-events-auto`
        re-enables clicks under the toolbar's `pointer-events-none` root.
      */}
      <div
        className={cn(
          'pointer-events-auto absolute top-0 right-0 flex items-center justify-end gap-1 py-2 pr-2',
          // Clear the far-right "Show terminal" reveal tab (icon-sm, flush to the
          // edge) so the action buttons sit to its left in the same row.
          reserveRightGutter && 'pr-9',
        )}
      >
        {activeSkill ? (
          <Suspense fallback={null}>
            <SkillEditorActions scope={activeSkill.scope} name={activeSkill.name} />
          </Suspense>
        ) : null}
        {showAddPropertyButton && (
          // PropertyPanel only mounts in WYSIWYG mode (gated in
          // EditorActivityPool). Hiding the button in source mode prevents
          // the click → CustomEvent → no-listener no-op that surfaces as
          // unresponsive UI. Source-mode users edit FM directly in the
          // CodeMirror YAML.
          <Tooltip>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t`Add properties`}
              onClick={onAddProperty}
              data-testid="add-properties-button"
              asChild
            >
              <TooltipTrigger>
                <ListPlus />
              </TooltipTrigger>
            </Button>
            <TooltipContent side="bottom">
              <Trans>Add properties</Trans>
            </TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <Button
            data-doc-panel-toggle=""
            variant="ghost"
            size="icon"
            onClick={onTogglePanel}
            aria-expanded={!isPanelCollapsed}
            aria-controls="doc-panel"
            aria-label={
              isPanelCollapsed
                ? t`Show panel (${panelShortcutLabel})`
                : t`Hide panel (${panelShortcutLabel})`
            }
            asChild
          >
            <TooltipTrigger>
              {isPanelCollapsed ? <PanelRightOpen /> : <PanelRightClose />}
            </TooltipTrigger>
          </Button>
          <TooltipContent side="bottom">
            {isPanelCollapsed ? (
              <Trans>Show panel ({panelShortcut})</Trans>
            ) : (
              <Trans>Hide panel ({panelShortcut})</Trans>
            )}
          </TooltipContent>
        </Tooltip>
      </div>
      <div
        aria-hidden
        className="pointer-events-none h-2 bg-linear-to-b from-background to-transparent"
      />
    </div>
  );
}
