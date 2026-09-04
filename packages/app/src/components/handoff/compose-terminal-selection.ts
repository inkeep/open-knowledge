import { composeSelectionPrompt } from '@inkeep/open-knowledge-core';
import { docNameToRelativePath } from '@/lib/workspace-paths';

export function composeTerminalSelectionPaste(docName: string, selectionMarkdown: string): string {
  return composeSelectionPrompt({
    relativePath: docNameToRelativePath(docName),
    instruction: '',
    selectionMarkdown,
    target: 'claude-code',
  });
}
