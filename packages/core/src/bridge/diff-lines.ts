import DiffMatchPatch from 'diff-match-patch';

const dmp = new DiffMatchPatch();

export interface DiffChange {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export function diffLinesFast(oldStr: string, newStr: string): DiffChange[] {
  if (oldStr === newStr) return [{ value: oldStr }];

  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(oldStr, newStr);
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(diffs, lineArray);

  const result: DiffChange[] = [];
  for (const [op, text] of diffs) {
    if (text.length === 0) continue;
    const prev = result[result.length - 1];
    const removed = op === DiffMatchPatch.DIFF_DELETE;
    const added = op === DiffMatchPatch.DIFF_INSERT;
    if (prev && Boolean(prev.removed) === removed && Boolean(prev.added) === added) {
      prev.value += text;
      continue;
    }
    if (removed) {
      result.push({ value: text, removed: true });
    } else if (added) {
      result.push({ value: text, added: true });
    } else {
      result.push({ value: text });
    }
  }

  return result;
}
