import { composeSelectionPrompt } from '@inkeep/open-knowledge-core';
import { docNameToRelativePath } from '@/lib/workspace-paths';

/**
 * Grounded selection paste for a terminal CLI: the doc named as an `@`-mention
 * plus the passage, via the same `composeSelectionPrompt` the bottom composer
 * uses — never raw text a running agent can't place. Shared by every
 * selection→terminal entry point (Ask-AI bubble button, ⌘J/⇧⌘J selection-send)
 * so they stay byte-identical.
 *
 * NOTE: there's no URL to budget in a terminal paste, so `target` only tunes
 * composeSelectionPrompt's inline-vs-locus threshold — and only Cursor
 * double-encodes, so every non-Cursor target (claude-code among them) shares
 * the same widest threshold: inline unless huge. Any target is correct here; it
 * does NOT assume the running CLI. Derive it from the live terminal CLI only if
 * that threshold ever matters (e.g. composeSelectionPrompt gains per-target
 * content).
 */
export function composeTerminalSelectionPaste(docName: string, selectionMarkdown: string): string {
  return composeSelectionPrompt({
    relativePath: docNameToRelativePath(docName),
    instruction: '',
    selectionMarkdown,
    target: 'claude-code',
  });
}
