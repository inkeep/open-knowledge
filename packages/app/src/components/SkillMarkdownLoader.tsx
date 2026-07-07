/**
 * Load-and-render wrapper for a skill bundle `.md` / `.mdx` file: drives the
 * shared `useViewerText` fetch lifecycle (loading / error / loaded), then hands
 * the loaded text to `SkillMarkdownViewer` for the read-only rendered prose.
 *
 * Reuses the same load state machine + status panes as the source `TextViewer`,
 * so loading spinners and error messages are identical — only the loaded branch
 * differs (rendered markdown instead of CodeMirror source).
 */
import type { SkillScope } from '@inkeep/open-knowledge-core';
import { SkillMarkdownViewer } from '@/components/SkillMarkdownViewer';
import { ViewerErrorPane, ViewerLoadingPane } from '@/components/ViewerStatusPane';
import { loadSkillFileText } from '@/lib/skills-api';
import { useViewerText } from './use-viewer-text';

const DATA_ATTR = 'data-skill-markdown';

export function SkillMarkdownLoader({
  scope,
  name,
  path,
  fileName,
}: {
  scope: SkillScope;
  name: string;
  path: string;
  fileName: string;
}) {
  const fetchState = useViewerText({
    loadText: (signal) => loadSkillFileText({ scope, name, path }, signal),
  });

  if (fetchState.status === 'loading') {
    return <ViewerLoadingPane fileName={fileName} dataAttr={DATA_ATTR} />;
  }
  if (fetchState.status === 'error') {
    // No "Open file" handoff — a skill bundle file has no asset-server URL.
    return (
      <ViewerErrorPane fileName={fileName} dataAttr={DATA_ATTR} message={fetchState.message} />
    );
  }
  return <SkillMarkdownViewer fileName={fileName} text={fetchState.content} />;
}
