/**
 * Editor pane for an opened frontmatter schema file (`.ok/schemas/*.json`).
 * Offers a segmented toggle between the raw read-only Source view
 * (`TextViewer`) and the WYSIWYG Fields view (`FrontmatterSchemaFieldEditor`,
 * the same per-field editor the Settings frontmatter plugin panel uses), so a
 * schema owner can edit fields without hand-writing JSON while still able to
 * inspect keywords the friendly rows don't model.
 *
 * The field editor reads the RESOLVED schema from the effective lint config,
 * which only inlines files referenced by a `contentRules.frontmatter.schemas`
 * mapping — so Fields is offered only for mapped files. An unmapped schema
 * would render an empty editor over a file that has content; the disabled
 * segment explains instead, and Source stays usable.
 *
 * Only the active segment is mounted: returning to Source remounts
 * `TextViewer`, which refetches the file so a field written through the
 * Fields view is reflected.
 */

// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { EditorModeToggle } from '@/components/EditorModeToggle';
import { NotInSidebarIndicator } from '@/components/NotInSidebarIndicator';
import { FrontmatterSchemaFieldEditor } from '@/components/settings/frontmatter-schema-field-editor';
import { PluginBetaBadge } from '@/components/settings/PluginBetaBadge';
import { TextViewer } from '@/components/TextViewer';
import { useProjectLintConfig } from '@/editor/lint-config-client';
import { type LintConfigViewMode, useLintConfigViewMode } from '@/editor/useLintConfigViewMode';
import {
  consumeSchemaFieldsView,
  subscribeSchemaFieldsView,
} from '@/lib/schema-fields-view-intent';

interface SchemaConfigEditorProps {
  /** Root-relative path of the opened schema asset (no leading slash). */
  assetPath: string;
}

// Same ungated text sibling of `/api/asset` the markdownlint config editor
// uses — serves any path-safe file as UTF-8 text so the dot-directory schema
// renders. Path-safety is enforced server-side.
function assetTextUrl(assetPath: string): string {
  return `/api/asset-text?path=${encodeURIComponent(assetPath)}`;
}

export function SchemaConfigEditor({ assetPath }: SchemaConfigEditorProps) {
  const { t } = useLingui();
  const [persistedMode, setPersistedMode] = useLintConfigViewMode();
  // A Settings-panel open carries a one-shot Fields intent that outranks the
  // persisted preference for THIS mount only; the user's own toggle (which
  // both persists and overrides) wins from then on.
  const [overrideMode, setOverrideMode] = useState<LintConfigViewMode | null>(null);
  const viewMode = overrideMode ?? persistedMode;
  const setViewMode = (next: LintConfigViewMode) => {
    setOverrideMode(next);
    setPersistedMode(next);
  };

  // Claim the Fields intent from an effect, not a render-time read, so render
  // performs no destructive consume and one path serves both cases: an intent
  // banked before this mount, and one recorded live while the editor stays
  // mounted (see the module doc for the Settings-overlay case that keeps the
  // already-active schema mounted and makes the live path necessary).
  useEffect(() => {
    const claim = (path: string) => {
      if (path !== assetPath) return;
      if (!consumeSchemaFieldsView(path)) return;
      setOverrideMode('rules');
    };
    claim(assetPath);
    return subscribeSchemaFieldsView(claim);
  }, [assetPath]);
  const { data } = useProjectLintConfig();

  // Server and client paths are both root-relative with no leading slash, so
  // string equality against the resolved mapping entries identifies a mapped
  // schema file.
  const fieldsEnabled = (data?.effective.plugins.frontmatter.schemas ?? []).some(
    (s) => s.file === assetPath,
  );

  // Fields lives in the wysiwyg slot; force Source when it's unavailable so a
  // persisted 'rules' preference on an unmapped file never renders blank.
  const isSourceMode = !fieldsEnabled || viewMode === 'source';

  const fileName = assetPath.split('/').pop() ?? assetPath;
  const extension = fileName.includes('.') ? (fileName.split('.').pop() ?? '').toLowerCase() : '';

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-schema-config-editor="">
      <NotInSidebarIndicator
        entry={{ kind: 'asset', path: assetPath }}
        className="shrink-0 border-b bg-background px-3 py-1.5"
      />
      <div className="relative flex shrink-0 items-center justify-center border-b bg-background py-2">
        <EditorModeToggle
          isSourceMode={isSourceMode}
          onModeChange={(next) => setViewMode(next === 'source' ? 'source' : 'rules')}
          wysiwygDisabled={!fieldsEnabled}
          wysiwygLabel={t`Fields`}
          sourceLabel={t`Source`}
          wysiwygDisabledReason={t`Field editing is available for schema files mapped in the Frontmatter schemas plugin`}
        />
        {/* Absolute so the mode toggle stays visually centered. */}
        <PluginBetaBadge className="absolute left-3 top-1/2 -translate-y-1/2" />
      </div>
      {isSourceMode ? (
        // Source is a CodeMirror viewer that owns its own scroll — full-bleed,
        // no wrapper padding (a second scroll container would double-scroll).
        <div className="min-h-0 flex-1 overflow-hidden">
          <TextViewer
            key={assetPath}
            src={assetTextUrl(assetPath)}
            assetPath={assetPath}
            fileName={fileName}
            extension={extension}
          />
        </div>
      ) : (
        // The field editor has no scroll or padding of its own — in Settings it
        // inherits both from the dialog body. Standalone it needs its own
        // scroll container and the same content gutter as other panes.
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          <div className="mx-auto w-full max-w-3xl">
            <FrontmatterSchemaFieldEditor file={assetPath} />
          </div>
        </div>
      )}
    </div>
  );
}
