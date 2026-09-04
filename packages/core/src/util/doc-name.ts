export function validateDocName(name: string): { ok: true } | { ok: false; reason: string } {
  if (name.length === 0) {
    return { ok: false, reason: 'docName must not be empty' };
  }
  if (name.trim().length === 0) {
    return { ok: false, reason: 'docName must not be blank (whitespace only)' };
  }
  if (name !== name.trim()) {
    return { ok: false, reason: 'docName must not have leading or trailing whitespace' };
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return { ok: false, reason: 'docName must not contain control characters' };
    }
  }
  if (name.includes('..') || name.startsWith('/') || name.includes('\\')) {
    return { ok: false, reason: 'docName must not contain "..", a leading "/", or a backslash' };
  }
  for (const segment of name.split('/')) {
    if (segment.length === 0) {
      return {
        ok: false,
        reason:
          'docName must not contain empty path segments (no leading, trailing, or doubled "/")',
      };
    }
    if (segment.startsWith('.')) {
      return {
        ok: false,
        reason: 'docName path segments must not start with "." (hidden files are not addressable)',
      };
    }
  }
  return { ok: true };
}

export function isValidDocName(name: string): boolean {
  return validateDocName(name).ok;
}

export const HIDDEN_CONFIG_BASENAMES: ReadonlySet<string> = new Set(['opencode.json']);

const PROJECT_SKILL_BUNDLE_PATH_RE = /^\.[A-Za-z0-9_-]+\/skills\/[^/]+\/.+$/;

export function isProjectSkillBundlePath(name: string): boolean {
  return PROJECT_SKILL_BUNDLE_PATH_RE.test(name);
}

export function isHiddenDocName(name: string): boolean {
  if (isProjectSkillBundlePath(name)) return false;
  if (name.split('/').some((segment) => segment.startsWith('.'))) return true;
  return HIDDEN_CONFIG_BASENAMES.has(name.slice(name.lastIndexOf('/') + 1));
}
