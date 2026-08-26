// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  isEditableTextDocFile,
  isExcalidrawDocFile,
  type LintDiagnostic,
  parseExternalSkillDocName,
  parseManagedArtifactName,
  type SkillScope,
} from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { AddPropertiesButton } from '@/components/AddPropertiesButton';
import { Button } from '@/components/ui/button.tsx';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { EditorModeValue } from '@/editor/use-editor-mode.ts';
import { useConfigContextOptional } from '@/lib/config-context';
import { formatShortcut, formatShortcutLabel } from '@/lib/keyboard-shortcuts';
import { parseProjectSkillContentDocName } from '@/lib/managed-artifact-doc-name';
import { isNoteWindow } from '@/lib/note-window-mode';
import {
  NO_RESERVED_KEYS,
  SKILL_RESERVED_KEYS,
  withoutReservedProperties,
} from '@/lib/reserved-property-keys';
import { cn } from '@/lib/utils';
import { EditorBreadcrumb } from './EditorBreadcrumb';
import { EditorModeToggle } from './EditorModeToggle';
import { NotInSidebarIndicator } from './NotInSidebarIndicator';
import { isSlidesHost } from './slides-host-gate';

// Lazy-loaded: the skill-specific toolbar cluster (level + install + overflow)
// only mounts when the active doc is a skill, so it stays out of the eager
// toolbar bundle that every document loads.
const SkillToolbarControls = lazy(async () => ({
  default: (await import('./SkillToolbarControls')).SkillToolbarControls,
}));

// Import-provenance line shown in the toolbar's left cell for skill docs —
// lazy for the same reason as the skill cluster above.
const SkillOriginInline = lazy(async () => ({
  default: (await import('./SkillOriginInline')).SkillOriginInline,
}));

// The Slides action mounts only past the cheap host+plugin gate below, so its
// frontmatter read + slidev-status probe stay out of the eager toolbar bundle
// that every document loads.
const SlidesToolbarControls = lazy(async () => ({
  default: (await import('./SlidesToolbarControls')).SlidesToolbarControls,
}));

const NO_FRONTMATTER_PROBLEMS: readonly LintDiagnostic[] = [];

interface EditorToolbarProps {
  activeDocName: string | null;
  /** The active document's collab provider, used to live-read the `slides: true`
   *  frontmatter flag that gates the Slides action. Null while a doc is loading. */
  activeProvider?: HocuspocusProvider | null;
  isSourceMode: boolean;
  sourceDisabled: boolean;
  onModeChange: (mode: EditorModeValue) => void;
  showAddPropertyButton: boolean;
  onAddProperty: () => void;
  /** Schema-required properties the active doc is missing — badged on the
   *  Add-properties button, which is where those report (they have no body
   *  anchor to squiggle). Handed over as diagnostics rather than a count and
   *  messages because only this component knows whether the doc reserves any of
   *  those keys, and a reserved one is not the button's to offer. */
  frontmatterProblems?: readonly LintDiagnostic[];
  isPanelCollapsed: boolean;
  onTogglePanel: () => void;
  /** Reserve right-side room in the action cluster so it sits left of the
   *  right-dock "Open session dock" reveal tab (which pins to the far-right corner
   *  the cluster reaches once the doc panel is collapsed) — keeping the two in
   *  one row instead of overlapping. */
  reserveRightGutter?: boolean;
}

export function EditorToolbar({
  activeDocName,
  activeProvider,
  isSourceMode,
  sourceDisabled,
  onModeChange,
  showAddPropertyButton,
  onAddProperty,
  frontmatterProblems = NO_FRONTMATTER_PROBLEMS,
  isPanelCollapsed,
  onTogglePanel,
  reserveRightGutter = false,
}: EditorToolbarProps) {
  const { t } = useLingui();
  // Cheap synchronous gate for the Slides action: the plugin is enabled (ships
  // off, so strict `=== true`) and the host exposes the slides bridge. The
  // frontmatter flag and the slidev-status probe — the costlier, per-deck
  // conditions — live inside the lazily-loaded cluster.
  //
  // The OPTIONAL reader is load-bearing. This toolbar renders for every
  // document, including in harnesses and mount orderings where no
  // `<ConfigProvider />` is above it; the throwing `useConfigContext` would take
  // the whole toolbar subtree down with it, and the toolbar owns the
  // frontmatter-problems badge — so an off-by-default slides gate would make an
  // unrelated badge silently vanish. Absent config simply means "not enabled".
  const slidesPluginEnabled = useConfigContextOptional()?.merged?.slides?.enabled === true;
  const panelShortcut = formatShortcut('toggle-document-panel');
  const panelShortcutLabel = formatShortcutLabel('toggle-document-panel');
  const showPanelToggle = !isNoteWindow();
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
  // The button's tooltip promises the click will add and fill these in, so it
  // may only advertise what the property panel will actually stage. A skill's
  // reserved `name` is not the panel's to add, so it is dropped here — the
  // Problems panel still carries the schema violation.
  const stageableProblems = withoutReservedProperties(
    frontmatterProblems,
    activeSkill ? SKILL_RESERVED_KEYS : NO_RESERVED_KEYS,
  );
  const problemMessages = stageableProblems.map((diagnostic) => diagnostic.message);
  // A detected-skill edit buffer (`__extskill__/<name>`): reduced mode —
  // no level/install/history/scope-move/provenance chrome; the edit-in-place
  // banner above the editor carries the messaging.
  const externalSkill = activeDocName ? parseExternalSkillDocName(activeDocName) : null;
  // Editable-text documents have no frontmatter region, so the ordinary
  // Properties action cannot stage a meaningful edit for this document class.
  const showDocumentAddPropertyButton =
    showAddPropertyButton && (activeDocName === null || !isEditableTextDocFile(activeDocName));
  return (
    <div
      data-testid="editor-toolbar"
      className="pointer-events-none absolute inset-x-0 top-0 z-10 @container/toolbar"
    >
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
          <div className="pointer-events-auto flex min-w-0 items-center gap-2">
            {/* Skills show their identity (name/scope) in the panel, so the
                `.ok/skills/<name>` path breadcrumb is noise — suppress it for
                both scopes to match the global-skill editor. The cell instead
                carries the skill's import provenance (source + Update). The
                source text hides as the pane narrows, but the Update action
                stays (handled inside SkillOriginInline). */}
            {activeSkill ? (
              <Suspense fallback={null}>
                <SkillOriginInline scope={activeSkill.scope} name={activeSkill.name} />
              </Suspense>
            ) : externalSkill ? // Identity + reduced-mode messaging live in the edit-in-place banner
            // (SkillEditBanner) above the editor, not here — keep the cell empty.
            null : (
              <EditorBreadcrumb docName={activeDocName} />
            )}
            {/* Self-gating: renders only when a visibility toggle hides this
                doc's tree row, and never for skills/templates (their names
                attribute no axis). */}
            {activeDocName === null ? null : (
              <NotInSidebarIndicator
                entry={{ kind: 'document', docName: activeDocName }}
                className="shrink-0"
              />
            )}
          </div>
          <div className="pointer-events-auto flex justify-center">
            {/* Editable text docs have exactly one surface (CodeMirror) and
                Excalidraw canvas docs have exactly one surface (the canvas —
                the raw JSON snapshot is not something to hand-edit), so the
                wysiwyg/source switch would be a no-op pair of buttons. */}
            {activeDocName !== null &&
            (isEditableTextDocFile(activeDocName) || isExcalidrawDocFile(activeDocName)) ? null : (
              <EditorModeToggle
                isSourceMode={isSourceMode}
                onModeChange={onModeChange}
                sourceDisabled={sourceDisabled}
              />
            )}
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
          'pointer-events-auto absolute top-0 right-0 flex min-w-0 max-w-[calc(50%_-_3rem)] items-center justify-end gap-1 py-2 pr-2',
          // Clear the far-right "Open session dock" reveal tab (icon-sm, flush to the
          // edge) so the action buttons sit to its left in the same row.
          reserveRightGutter && 'pr-9',
        )}
      >
        {activeSkill && activeDocName ? (
          // Skill docs carry level + install + add-properties, which collapse
          // into an overflow menu on a narrow pane (handled inside).
          <Suspense fallback={null}>
            <SkillToolbarControls
              scope={activeSkill.scope}
              name={activeSkill.name}
              showAddPropertyButton={showDocumentAddPropertyButton}
              onAddProperty={onAddProperty}
              problemCount={stageableProblems.length}
              problemMessages={problemMessages}
            />
          </Suspense>
        ) : externalSkill ? // Detected-skill edit buffer: reduced mode. Messaging lives in the
        // edit-in-place banner above the editor, so nothing renders here.
        null : (
          // Non-skill docs only carry add-properties here (no level/install), so
          // there's nothing to overflow — the breadcrumb truncates on its own.
          showDocumentAddPropertyButton && (
            <AddPropertiesButton
              onAddProperty={onAddProperty}
              problemCount={stageableProblems.length}
              problemMessages={problemMessages}
            />
          )
        )}
        {slidesPluginEnabled &&
        isSlidesHost() &&
        activeProvider != null &&
        activeDocName !== null ? (
          <Suspense fallback={null}>
            <SlidesToolbarControls provider={activeProvider} docName={activeDocName} />
          </Suspense>
        ) : null}
        {showPanelToggle ? (
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
              <span>{isPanelCollapsed ? t`Show panel` : t`Hide panel`}</span>{' '}
              <Kbd aria-label={panelShortcutLabel}>{panelShortcut}</Kbd>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div
        aria-hidden
        className="pointer-events-none h-2 bg-linear-to-b from-background to-transparent"
      />
    </div>
  );
}
