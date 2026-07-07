/**
 * Pure path helpers for project-relative paths in the renderer.
 *
 * Shared between `ConsentDialogBody.tsx` and `install-onboarding-toast` —
 * the established pattern (see `workspace-paths.ts` header) is to lift
 * shared helpers out of component files so `lib/ → components/` imports
 * never appear.
 *
 * No React, no Node `path` module — both helpers normalize `/` and `\`
 * segment separators inline so the renderer bundle stays free of a node-
 * path shim.
 */

/**
 * Compute a project-relative path from an absolute picked path. Returns
 * `'.'` when picked === projectDir (forward-slash-normalized for cross-
 * platform comparison), the relative segment join when picked is inside
 * projectDir, or `null` when picked escapes (caller surfaces the inline
 * error). Trailing slashes are tolerated.
 */
export function relativeToProject(projectDir: string, picked: string): string | null {
  const normalize = (p: string): string =>
    p.replace(/\\/g, '/').replace(/\/+$/, '') || (p.startsWith('/') ? '/' : '');
  const root = normalize(projectDir);
  const target = normalize(picked);
  if (root === target) return '.';
  const prefix = root.endsWith('/') ? root : `${root}/`;
  if (!target.startsWith(prefix)) return null;
  return target.slice(prefix.length);
}

/**
 * `..`-escape detector for the content.dir field. Walks segments and tracks
 * depth — any segment that pops the cursor below depth 0 is an escape.
 */
export function isContentDirSafe(value: string): boolean {
  if (value === '' || value === '.') return true;
  // content.dir is project-relative; absolute paths are rejected outright.
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.replace(/\\/g, '/').split('/');
  let depth = 0;
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      depth -= 1;
      if (depth < 0) return false;
    } else {
      depth += 1;
    }
  }
  return true;
}
