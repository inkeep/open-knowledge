// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { EditorModeToggle } from '@/components/EditorModeToggle';
import { NotInSidebarIndicator } from '@/components/NotInSidebarIndicator';
import { FrontmatterSchemaFieldEditor } from '@/components/settings/frontmatter-schema-field-editor';
import { TextViewer } from '@/components/TextViewer';
import { useProjectLintConfig } from '@/editor/lint-config-client';
import { type LintConfigViewMode, useLintConfigViewMode } from '@/editor/useLintConfigViewMode';
import {
  consumeSchemaFieldsView,
  subscribeSchemaFieldsView,
} from '@/lib/schema-fields-view-intent';

interface SchemaConfigEditorProps {
  assetPath: string;
}

function assetTextUrl(assetPath: string): string {
  return `/api/asset-text?path=${encodeURIComponent(assetPath)}`;
}

export function SchemaConfigEditor({ assetPath }: SchemaConfigEditorProps) {
  const { t } = useLingui();
  const [persistedMode, setPersistedMode] = useLintConfigViewMode();
  const [overrideMode, setOverrideMode] = useState<LintConfigViewMode | null>(null);
  const viewMode = overrideMode ?? persistedMode;
  const setViewMode = (next: LintConfigViewMode) => {
    setOverrideMode(next);
    setPersistedMode(next);
  };

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

  const fieldsEnabled = (data?.effective.plugins.frontmatter.schemas ?? []).some(
    (s) => s.file === assetPath,
  );

  const isSourceMode = !fieldsEnabled || viewMode === 'source';

  const fileName = assetPath.split('/').pop() ?? assetPath;
  const extension = fileName.includes('.') ? (fileName.split('.').pop() ?? '').toLowerCase() : '';

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-schema-config-editor="">
      <NotInSidebarIndicator
        entry={{ kind: 'asset', path: assetPath }}
        className="shrink-0 border-b bg-background px-3 py-1.5"
      />
      <div className="flex shrink-0 items-center justify-center border-b bg-background py-2">
        <EditorModeToggle
          isSourceMode={isSourceMode}
          onModeChange={(next) => setViewMode(next === 'source' ? 'source' : 'rules')}
          wysiwygDisabled={!fieldsEnabled}
          wysiwygLabel={t`Fields`}
          sourceLabel={t`Source`}
          wysiwygDisabledReason={t`Field editing is available for schema files mapped in the Frontmatter schemas plugin`}
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
            <FrontmatterSchemaFieldEditor file={assetPath} />
          </div>
        </div>
      )}
    </div>
  );
}
