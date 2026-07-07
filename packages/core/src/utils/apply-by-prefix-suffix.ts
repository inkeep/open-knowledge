import type * as Y from 'yjs';

/**
 * Apply `newText` to `ytext` with minimal CRDT mutation: find matching prefix
 * and suffix, delete + insert only the differing middle region. Preserves
 * Y.Text Items in the prefix/suffix (and thus their transaction origins).
 *
 * Shared between client-side Observer A (Path B three-way merge result application)
 * and server-side agent-write path (applyAgentMarkdownWrite).
 * Same semantics, one implementation.
 *
 * @see PRECEDENTS.md precedent #9 (minimize CRDT mutation in sync bridges)
 * @see PRECEDENTS.md precedent #10 (XmlFragment-authoritative, Y.Text mirrors)
 */
export function applyByPrefixSuffix(ytext: Y.Text, currentText: string, newText: string): void {
  if (currentText === newText) return;

  let prefixLen = 0;
  const minLen = Math.min(currentText.length, newText.length);
  while (prefixLen < minLen && currentText[prefixLen] === newText[prefixLen]) prefixLen++;

  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    currentText[currentText.length - 1 - suffixLen] === newText[newText.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const deleteLen = currentText.length - prefixLen - suffixLen;
  const insertStr = newText.slice(prefixLen, newText.length - suffixLen);
  if (deleteLen > 0) ytext.delete(prefixLen, deleteLen);
  if (insertStr.length > 0) ytext.insert(prefixLen, insertStr);
}
