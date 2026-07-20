/**
 * Editor pane for an opened markdownlint JSON config file. Offers a segmented
 * toggle between the raw read-only Source view (`TextViewer`) and the WYSIWYG
 * Rules view (`MarkdownlintRuleBrowser`, the same rule editor the Settings
 * dialog uses), so a config owner can edit rules without hand-writing JSON while
 * still inspecting the file's comments / `extends`.
 *
 * The rule browser writes only the project's ROOT config (its write endpoint
 * targets whatever file the server reports as governing), so Rules is offered
 * only when the opened file IS that governing file — otherwise a nested or
 * not-yet-created config would edit the wrong bytes. When Rules is unavailable
 * the segment is disabled with an explanation and Source stays usable.
 *
 * Only the active segment is mounted: returning to Source remounts `TextViewer`,
 * which refetches the file so a rule written through the Rules view is reflected.
 */

import { useLingui } from '@lingui/react/macro';
import { EditorModeToggle } from '@/components/EditorModeToggle';
import { NotInSidebarIndicator } from '@/components/NotInSidebarIndicator';
import { MarkdownlintRuleBrowser } from '@/components/settings/markdownlint-rule-browser';
import { TextViewer } from '@/components/TextViewer';
import { useProjectLintConfig } from '@/editor/lint-config-client';
import { useLintConfigViewMode } from '@/editor/useLintConfigViewMode';

interface LintConfigEditorProps {
  /** Root-relative path of the opened config asset (no leading slash). */
  assetPath: string;
}

// `/api/asset-text` is the ungated sibling of `/api/asset`: it serves any
// path-safe file as UTF-8 text regardless of the asset allowlist, which is how
// a hidden dotfile config renders. Path-safety is enforced server-side.
function assetTextUrl(assetPath: string): string {
  return `/api/asset-text?path=${encodeURIComponent(assetPath)}`;
}

export function LintConfigEditor({ assetPath }: LintConfigEditorProps) {
  const { t } = useLingui();
  const [viewMode, setViewMode] = useLintConfigViewMode();
  const { data } = useProjectLintConfig();

  // Server and client paths are both root-relative with no leading slash, so a
  // direct string equality identifies the governing root config. `assetPath` is
  // always a non-null string, so the equality alone already rejects a null
  // (or absent) configFile.
  const governingConfigFile = data?.configFile ?? null;
  const rulesEnabled = governingConfigFile === assetPath;

  // Rules lives in the wysiwyg slot; force Source when it's unavailable so a
  // persisted 'rules' preference on a non-governing file never renders blank.
  const isSourceMode = !rulesEnabled || viewMode === 'source';

  const fileName = assetPath.split('/').pop() ?? assetPath;
  const extension = fileName.includes('.') ? (fileName.split('.').pop() ?? '').toLowerCase() : '';

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-lint-config-editor="">
      {/* Same not-in-sidebar chrome AssetPreview carries, so a config opened as a
          hidden dotfile advertises the same reveal affordance. Self-gates to null
          when the file is visible in the tree. */}
      <NotInSidebarIndicator
        entry={{ kind: 'asset', path: assetPath }}
        className="shrink-0 border-b bg-background px-3 py-1.5"
      />
      <div className="flex shrink-0 items-center justify-center border-b bg-background py-2">
        <EditorModeToggle
          isSourceMode={isSourceMode}
          onModeChange={(next) => setViewMode(next === 'source' ? 'source' : 'rules')}
          wysiwygDisabled={!rulesEnabled}
          wysiwygLabel={t`Rules`}
          sourceLabel={t`Source`}
          wysiwygDisabledReason={t`Rule editing is available for the project's root markdownlint config`}
        />
      </div>
      {isSourceMode ? (
        // Source is a CodeMirror viewer that owns its own scroll — full-bleed,
        // no wrapper padding (a second scroll container would double-scroll).
        <div className="min-h-0 flex-1 overflow-hidden">
          <TextViewer
            key={assetPath}
            src={assetTextUrl(assetPath)}
            fileName={fileName}
            extension={extension}
          />
        </div>
      ) : (
        // The rule browser has no scroll or padding of its own — in Settings it
        // inherits both from the dialog body. Standalone it needs its own
        // scroll container and the same content gutter as other panes.
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          <div className="mx-auto w-full max-w-3xl">
            {/* The user is looking at the config file — the "these rules come from
                <file>" note the Settings dialog shows would be redundant here. */}
            <MarkdownlintRuleBrowser hideConfigSourceNote />
          </div>
        </div>
      )}
    </div>
  );
}
