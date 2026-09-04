import { useLingui } from '@lingui/react/macro';
import { EditorModeToggle } from '@/components/EditorModeToggle';
import { NotInSidebarIndicator } from '@/components/NotInSidebarIndicator';
import { MarkdownlintRuleBrowser } from '@/components/settings/markdownlint-rule-browser';
import { TextViewer } from '@/components/TextViewer';
import { useProjectLintConfig } from '@/editor/lint-config-client';
import { useLintConfigViewMode } from '@/editor/useLintConfigViewMode';

interface LintConfigEditorProps {
  assetPath: string;
}

function assetTextUrl(assetPath: string): string {
  return `/api/asset-text?path=${encodeURIComponent(assetPath)}`;
}

export function LintConfigEditor({ assetPath }: LintConfigEditorProps) {
  const { t } = useLingui();
  const [viewMode, setViewMode] = useLintConfigViewMode();
  const { data } = useProjectLintConfig();

  const governingConfigFile = data?.configFile ?? null;
  const rulesEnabled = governingConfigFile === assetPath;

  const isSourceMode = !rulesEnabled || viewMode === 'source';

  const fileName = assetPath.split('/').pop() ?? assetPath;
  const extension = fileName.includes('.') ? (fileName.split('.').pop() ?? '').toLowerCase() : '';

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-lint-config-editor="">
      {}
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
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          <div className="mx-auto w-full max-w-3xl">
            {}
            <MarkdownlintRuleBrowser hideConfigSourceNote />
          </div>
        </div>
      )}
    </div>
  );
}
