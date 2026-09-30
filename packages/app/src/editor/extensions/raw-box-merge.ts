export interface TextChange {
  from: number;
  to: number;
  text: string;
}

export function computeChange(oldVal: string, newVal: string): TextChange | null {
  if (oldVal === newVal) return null;
  let start = 0;
  let oldEnd = oldVal.length;
  let newEnd = newVal.length;

  while (start < oldEnd && oldVal.charCodeAt(start) === newVal.charCodeAt(start)) {
    start++;
  }
  while (
    oldEnd > start &&
    newEnd > start &&
    oldVal.charCodeAt(oldEnd - 1) === newVal.charCodeAt(newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }

  return { from: start, to: oldEnd, text: newVal.slice(start, newEnd) };
}

/* STOP: when both sides changed the same span, the local text is kept after the remote
   replacement rather than dropped. The local side is text a person just typed; losing it
   silently is the failure this merge exists to prevent. */
export function mergeConcurrentEdit(base: string, local: string, remote: string): string {
  const mine = computeChange(base, local);
  if (mine === null) return remote;
  const theirs = computeChange(base, remote);
  if (theirs === null) return local;

  if (mine.to <= theirs.from) {
    return remote.slice(0, mine.from) + mine.text + remote.slice(mine.to);
  }
  const shift = theirs.text.length - (theirs.to - theirs.from);
  if (mine.from >= theirs.to) {
    return remote.slice(0, mine.from + shift) + mine.text + remote.slice(mine.to + shift);
  }
  const after = theirs.from + theirs.text.length;
  return remote.slice(0, after) + mine.text + remote.slice(after);
}
