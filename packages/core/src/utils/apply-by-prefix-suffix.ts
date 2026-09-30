import type * as Y from 'yjs';

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
