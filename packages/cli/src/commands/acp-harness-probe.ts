/**
 * ACP-thread duplicate-injection guard — the CLI-side probe behind the
 * thread manager's `probeHarnessManagedMcpEntry` seam.
 *
 * ACP agents spawn with the project as cwd, so an agent's harness (Claude
 * Code, Codex, Cursor, OpenCode) ALSO loads its own project/user MCP config
 * — the very files `ok init` / the Desktop consent flow write. Both copies
 * claim the `open-knowledge` server name, and harnesses resolve that
 * collision in their own favor (verified with Codex: its config entry
 * shadows the ACP-injected server). This probe reports whether the harness
 * will already load OK's OWN managed entry, so the thread manager can skip
 * injecting a colliding duplicate.
 *
 * Match discipline is FUNCTIONAL, not exact (`entryRunsOwnManagedServer` /
 * `openCodeEntryRunsOwnManagedServer`): we stand down when the harness entry
 * would launch OK's own server — its `command`+`args` (or OpenCode argv) are
 * OK's canonical chain — regardless of harness policy siblings like Codex's
 * `tools.<name>.approval_mode`, which churns as the user approves tools
 * mid-session. A foreign or tampered `command`/`args` still fails and
 * injection proceeds, and every other miss (absent file, unparseable config,
 * dev-shape entry) falls back to injection, i.e. prior behavior. This is a
 * looser gate than the docked-terminal pre-approval's `isOwnManagedEntry` on
 * purpose — see `entryRunsOwnManagedServer` for why the risk is inverted.
 *
 * Project surfaces are probed at exactly `<cwd>/…` — no upward walk. A
 * harness that discovers a config higher up (Claude Code walks toward the
 * repo root) simply keeps the injected duplicate in that layout:
 * conservative in the safe direction.
 */
import {
  EDITOR_TARGETS,
  type EditorId,
  entryRunsOwnManagedServer,
  openCodeEntryRunsOwnManagedServer,
} from './editors.ts';
import { readExistingMcpEntry } from './init.ts';

export interface OwnManagedMcpEntryHit {
  editorId: EditorId;
  scope: 'project' | 'user';
  configPath: string;
}

/**
 * Whether `editorId`'s project-local (probed first) or user-global MCP
 * config already carries OK's own canonical managed entry. Never throws —
 * unresolvable paths and unreadable configs count as misses.
 */
export function probeOwnManagedEditorMcpEntry(
  editorId: EditorId,
  cwd: string,
  home?: string,
): OwnManagedMcpEntryHit | null {
  const target = EDITOR_TARGETS[editorId];
  const runsOwnServer =
    editorId === 'opencode' ? openCodeEntryRunsOwnManagedServer : entryRunsOwnManagedServer;
  const surfaces: Array<{ scope: 'project' | 'user'; configPath: string }> = [];
  const projectPath = target.projectConfigPath?.(cwd);
  if (projectPath !== undefined) surfaces.push({ scope: 'project', configPath: projectPath });
  try {
    surfaces.push({ scope: 'user', configPath: target.configPath(cwd, home) });
  } catch {
    // Platform-unavailable user config (e.g. Claude Desktop off macOS/Windows)
    // — keep whatever project surface exists.
  }
  for (const surface of surfaces) {
    const entry = readExistingMcpEntry(target, cwd, home, surface.configPath);
    if (entry !== null && runsOwnServer(entry)) {
      return { editorId, scope: surface.scope, configPath: surface.configPath };
    }
  }
  return null;
}
