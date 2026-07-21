
/** True when `needle` is a subsequence of `haystack` (two-pointer, O(n+m)):
 *  insertions in `haystack` are free; any dropped or substituted `needle` byte
 *  fails. */
export function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (needle[i] === haystack[j]) i++;
  }
  return i === needle.length;
}
