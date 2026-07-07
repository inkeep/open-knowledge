/**
 * Structural validation for a document name — the extension-less, `/`-segmented
 * key the server stores docs under. A docName that passes here can be turned
 * into a relative content path without producing junk, hidden, or
 * unaddressable files on disk.
 *
 * Rejected: empty / whitespace-only, leading or trailing whitespace, control
 * characters, path traversal (`..`), absolute (`/`-leading) and backslash
 * paths, empty path segments (leading / trailing / doubled `/`), and segments
 * starting with `.` (which also covers bare `.` and `..` — hidden files are
 * excluded from sync and are not addressable).
 *
 * This is intentionally STRICTER than `isSafeDocName` in the server's
 * `api-extension.ts`, which stays a pure path-traversal guard for read and
 * link-graph paths. `validateDocName` is the write-time admission contract;
 * widening the read guard the same way would silently drop more docNames from
 * listings and backlink counts.
 */
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
    // C0 control range (includes tab / newline) and DEL produce junk filenames.
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

/** Boolean form of {@link validateDocName} for `.refine`-style call sites. */
export function isValidDocName(name: string): boolean {
  return validateDocName(name).ok;
}

/**
 * Well-known agent/editor config files that are treated as hidden even though
 * their basename is NOT dot-prefixed. The dotfile agent configs (`.mcp.json`,
 * `.cursor/mcp.json`, `.codex/config.toml`, `.claude/launch.json`) are already
 * caught by the dot-segment branch of {@link isHiddenDocName}. OpenKnowledge
 * also seeds `opencode.json` at the project root so OpenCode's MCP wiring
 * works, and OpenCode's project config filename is fixed (it cannot be a
 * dotfile), so the dot-segment convention misses it. This allowlist closes the
 * gap so every OK-managed agent config hides uniformly.
 *
 * Matched against the basename (the last `/`-segment), case-sensitive — these
 * filenames have a single canonical on-disk casing.
 */
export const HIDDEN_CONFIG_BASENAMES: ReadonlySet<string> = new Set(['opencode.json']);

/**
 * Whether a docName addresses a hidden file — any `/`-segment starts with `.`
 * (`.claude/`, `.cursor/`, `.obsidian/`, a top-level `.foo`), or its basename
 * is a well-known non-dotted agent config in {@link HIDDEN_CONFIG_BASENAMES}
 * (e.g. `opencode.json`). {@link validateDocName} write-rejects dot-segment
 * names, but they can still appear in the read index (they exist on disk,
 * created outside OK). Search ADMITS hidden docs with a rank penalty
 * (`HIDDEN_DOC_LEXICAL_PENALTY` in `workspace-search.ts`) so "search what the
 * tree shows" holds; embedding + egress still EXCLUDE them so agent-facing
 * results and embedding spend stay focused on the canonical content set —
 * mirroring the file tree's `showHiddenFiles` default-off. Deliberately NOT
 * applied to listings / backlinks: the read guard stays lenient, so hidden
 * docs remain editable and addressable directly.
 */
export function isHiddenDocName(name: string): boolean {
  if (name.split('/').some((segment) => segment.startsWith('.'))) return true;
  return HIDDEN_CONFIG_BASENAMES.has(name.slice(name.lastIndexOf('/') + 1));
}
