import {
  type SkillScope,
  skillFileLiveDocName,
  skillLiveDocName,
} from '@inkeep/open-knowledge-core';
import { SkillMarkdownViewer } from '@/components/SkillMarkdownViewer';
import { ViewerErrorPane, ViewerLoadingPane } from '@/components/ViewerStatusPane';
import { loadSkillFileText } from '@/lib/skills-api';
import { useViewerText } from './use-viewer-text';

const DATA_ATTR = 'data-skill-markdown';

export function SkillMarkdownLoader({
  scope,
  name,
  path,
  host,
  fileName,
}: {
  scope: SkillScope;
  name: string;
  path: string;
  host?: string;
  fileName: string;
}) {
  const fetchState = useViewerText({
    loadText: (signal) => loadSkillFileText({ scope, name, path, host }, signal),
  });

  if (fetchState.status === 'loading') {
    return <ViewerLoadingPane fileName={fileName} dataAttr={DATA_ATTR} />;
  }
  if (fetchState.status === 'error') {
    return (
      <ViewerErrorPane fileName={fileName} dataAttr={DATA_ATTR} message={fetchState.message} />
    );
  }
  return (
    <SkillMarkdownViewer
      fileName={fileName}
      text={fetchState.content}
      linkBaseDocName={skillFileLiveDocName(scope, name, path)}
      skillPathLinkDocName={skillLiveDocName(scope, name)}
    />
  );
}
