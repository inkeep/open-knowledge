/**
 * Client-side validity check for a bundle-relative file path — the ONE shape
 * shared by the create + rename dialogs so they can never disagree. Mirrors,
 * but does not replace, the server's authoritative gate
 * (`classifySkillFilePath` + `resolveBundleFileAbs` containment): any
 * in-bundle path is writable except the skill's own `SKILL.md`; `..` and
 * empty segments never pass. The client check exists only for inline feedback.
 */
export function isValidBundleFilePath(path: string): boolean {
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;
  if (segments.length === 0) return false;
  if (segments.length === 1 && (segments[0] as string).toLowerCase() === 'skill.md') return false;
  return !/\s/.test(path);
}
