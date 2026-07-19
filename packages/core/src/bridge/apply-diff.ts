import type * as Y from 'yjs';
import { diffLinesFast } from './diff-lines.ts';

const APPLY_FAST_DIFF_MAX_BYTES = 256 * 1024;

export function applyIncrementalDiff(ytext: Y.Text, currentText: string, newText: string): void {
  if (currentText === newText) return;

  const changes = diffLinesFast(currentText, newText);
  let offset = 0;
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    const next = changes[i + 1];
    if (change.removed && next?.added) {
      const targetSlice = currentText.substring(offset, offset + next.value.length);
      if (targetSlice === next.value) {
        offset += next.value.length;
        i++; // consume the paired ADDED
        continue;
      }
      ytext.delete(offset, change.value.length);
      ytext.insert(offset, next.value);
      offset += next.value.length;
      i++; // consume the paired ADDED
    } else if (change.removed) {
      ytext.delete(offset, change.value.length);
    } else if (change.added) {
      ytext.insert(offset, change.value);
      offset += change.value.length;
    } else {
      offset += change.value.length;
    }
  }
}

export function applyFastDiff(ytext: Y.Text, currentText: string, newText: string): void {
  if (currentText === newText) return;
  if (
    currentText.length > APPLY_FAST_DIFF_MAX_BYTES ||
    newText.length > APPLY_FAST_DIFF_MAX_BYTES
  ) {
    applyByPrefixSuffixMiddleReplace(ytext, currentText, newText);
    return;
  }
  const changes = diffLinesFast(currentText, newText);
  let offset = 0;
  for (const change of changes) {
    if (change.removed) {
      ytext.delete(offset, change.value.length);
    } else if (change.added) {
      ytext.insert(offset, change.value);
      offset += change.value.length;
    } else {
      offset += change.value.length;
    }
  }
}

function applyByPrefixSuffixMiddleReplace(
  ytext: Y.Text,
  currentText: string,
  newText: string,
): void {
  let prefixLen = 0;
  const minLen = Math.min(currentText.length, newText.length);
  while (
    prefixLen < minLen &&
    currentText.charCodeAt(prefixLen) === newText.charCodeAt(prefixLen)
  ) {
    prefixLen++;
  }
  if (prefixLen > 0) {
    prefixLen = currentText.lastIndexOf('\n', prefixLen - 1) + 1;
  }

  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    currentText.charCodeAt(currentText.length - 1 - suffixLen) ===
      newText.charCodeAt(newText.length - 1 - suffixLen)
  ) {
    suffixLen++;
  }
  if (suffixLen > 0) {
    const curStart = currentText.length - suffixLen;
    const newStart = newText.length - suffixLen;
    const curAligned = curStart === 0 || currentText.charCodeAt(curStart - 1) === 10;
    const newAligned = newStart === 0 || newText.charCodeAt(newStart - 1) === 10;
    if (!(curAligned && newAligned)) {
      const firstNewline = currentText.indexOf('\n', curStart);
      suffixLen = firstNewline === -1 ? 0 : currentText.length - (firstNewline + 1);
    }
  }

  const deleteLen = currentText.length - prefixLen - suffixLen;
  const insertStr = newText.slice(prefixLen, newText.length - suffixLen);
  if (deleteLen > 0) ytext.delete(prefixLen, deleteLen);
  if (insertStr.length > 0) ytext.insert(prefixLen, insertStr);
}
