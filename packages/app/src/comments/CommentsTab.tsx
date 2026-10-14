import { useEffect, useState } from 'react';
import { type PanelScope, PanelScopeHeader } from '@/components/PanelScopeHeader';
import { useSingleFileMode } from '@/lib/single-file-mode';
import { CommentProjectPanel } from './CommentProjectPanel';
import { CommentsPanel } from './CommentsPanel';
import { consumePendingCommentScope, subscribeCommentScopeRequests } from './reveal-queue';
import { setVisibleCommentScope } from './visible-scope';

export function CommentsTab({
  docName,
  onDestinationComplete,
}: {
  docName: string;
  onDestinationComplete?: (target: HTMLElement) => void;
}) {
  const [requestedScope, setRequestedScope] = useState<PanelScope>('doc');
  const singleFile = useSingleFileMode();
  const scope: PanelScope = singleFile ? 'doc' : requestedScope;
  useEffect(() => {
    const pending = consumePendingCommentScope();
    if (pending !== null) setRequestedScope(pending);
    return subscribeCommentScopeRequests(setRequestedScope);
  }, []);
  useEffect(() => {
    setVisibleCommentScope({ scope, docName });
    return () => setVisibleCommentScope(null);
  }, [scope, docName]);
  const scopeSwitch = singleFile ? undefined : (
    <PanelScopeHeader scope={scope} onScopeChange={setRequestedScope} />
  );
  return scope === 'doc' ? (
    <CommentsPanel
      docName={docName}
      scopeSwitch={scopeSwitch}
      onDestinationComplete={onDestinationComplete}
    />
  ) : (
    <CommentProjectPanel scopeSwitch={scopeSwitch} onDestinationComplete={onDestinationComplete} />
  );
}
