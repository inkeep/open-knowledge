/**
 * MCP tool registry.
 *
 * Reads:     exec, search, history, links, skills, config, palette, preview_url, share_link
 * Writes:    write, edit, delete, move, checkpoint, restore_version
 * Conflicts: conflicts, resolve_conflict
 * Workflow:  workflow (kind: ingest | research | consolidate | discover)
 *
 * `write` / `edit` / `delete` / `move` are native CRUD verbs, polymorphic
 * over document / folder / template / asset via a nested target object
 * (Pattern B). They absorb the former write_document / edit_document /
 * edit_frontmatter / delete_document / rename / folder_config tools. The one
 * soft constraint ("exactly one target") is enforced by a teaching error.
 * `links` covers six link-graph reads; `checkpoint`/`restore_version` split the former `version` tool.
 *
 * Read-tool routing:
 *   - `exec` — primary read surface: shell-style `cat`/`ls`/`grep`/`find`,
 *     enriched with frontmatter / backlinks / shadow-repo history / folder
 *     defaults / template menus on every wiki file or directory referenced.
 *   - `search` — ranked workspace retrieval (Orama; mirrors cmd-K).
 *
 * - `workflow` returns instructional text (kind: ingest | research |
 *   consolidate | discover) and needs no server connection; its discover
 *   body's Phase 5 (link-graph activation) checks for Hocuspocus itself.
 * - Document tools make HTTP calls to Hocuspocus and require `serverUrl`.
 * - `search` calls `POST /api/search` and requires Hocuspocus.
 *
 * Project-level scaffolding has two paths: `ok seed` CLI for empty repos
 * (Karpathy three-layer + `log.md` + per-layer folder defaults) and the
 * `workflow({ kind: "discover" })` primer for existing-content repos (extracts conventions
 * from siblings; sets folder frontmatter + templates + `.okignore`).
 *
 * To add a new tool: create `packages/server/src/mcp/tools/<name>.ts` with a
 * `register(...)` export, then import and call it from here.
 */

import { createEnsureSingleFileSession } from '../../ensure-single-file-session.ts';
import type { AgentIdentity } from '../agent-identity.ts';
import { getCurrentMcpLogger, type McpLogger } from '../logger.ts';
import { createLoggedServer } from '../tool-logging.ts';
import { register as registerCheckpoint } from './checkpoint.ts';
import { register as registerConfig } from './config.ts';
import { register as registerConflicts } from './conflicts.ts';
import { register as registerDelete } from './delete.ts';
import { register as registerEdit } from './edit.ts';
import { register as registerExec } from './exec.ts';
import { register as registerPreviewUrl } from './get-preview-url.ts';
import { register as registerHistory } from './history.ts';
import { register as registerInstall } from './install.ts';
import { register as registerLinks } from './links.ts';
import { register as registerMove } from './move.ts';
import { register as registerPalette } from './palette.ts';
import { register as registerResolveConflict } from './resolve-conflict.ts';
import { register as registerRestoreVersion } from './restore-version.ts';
import { register as registerSearch } from './search.ts';
import { register as registerShareLink } from './share-link.ts';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import { register as registerSkills } from './skills.ts';
import { register as registerWorkflow } from './workflow.ts';
import { register as registerWrite } from './write.ts';

/**
 * Per-call cwd resolver. Returns the absolute host directory that the
 * current tool call should operate against. Priority:
 *   1. explicit `cwd` arg from the tool call
 *   2. the client's only advertised MCP root
 *   3. otherwise error
 */
type ResolveCwd = (explicit?: string) => Promise<string>;

interface RegisterAllToolsOptions {
  /**
   * Hocuspocus URL. Accept a string (explicit override, e.g. `--port`), or a
   * lazy resolver that re-discovers per-call from the effective project cwd.
   * The resolver variant is what lets one MCP stdio process route different
   * tool calls to different OpenKnowledge projects.
   */
  serverUrl?: ServerUrlOrResolver;
  /** Resolves the cwd for a given tool call (see `ResolveCwd` docs). */
  resolveCwd: ResolveCwd;
  config: ConfigOrResolver;
  identityRef?: { current: AgentIdentity };
  logger?: McpLogger;
  /**
   * True when this MCP server process is running inside OK Desktop's own
   * built-in terminal (`OK_DESKTOP_TERMINAL=1` inherited from the pty). The
   * global `ok mcp` server sets it from its env; the shared collab server
   * (`ok start`) never has the marker, so it stays false there. `preview_url`
   * uses it to steer the agent to `ok open` (which focuses the OK Desktop
   * window) instead of returning a URL the agent shouldn't navigate.
   */
  isDesktopTerminal?: boolean;
}

export function registerAllTools(server: ServerInstance, opts: RegisterAllToolsOptions): void {
  const log = opts.logger;
  const registrationServer = createLoggedServer(server, {
    logger: opts.logger,
    identityRef: opts.identityRef,
  });
  const named =
    (tool: string): ResolveCwd =>
    async (explicit?: string) => {
      try {
        const cwd = await opts.resolveCwd(explicit);
        const activeLog = getCurrentMcpLogger() ?? log;
        activeLog?.debug('tool cwd resolved', { tool, cwd, ...(explicit ? { explicit } : {}) });
        return cwd;
      } catch (err) {
        const activeLog = getCurrentMcpLogger() ?? log;
        activeLog?.warn('tool call failed', {
          tool,
          error: err instanceof Error ? err.message : String(err),
          ...(explicit ? { explicit } : {}),
        });
        throw err;
      }
    };

  // exec — the primary surface.
  registerExec(registrationServer, {
    resolveCwd: named('exec'),
    serverUrl: opts.serverUrl,
    config: opts.config,
  });

  // Workflow primers — return instructional text (kind: ingest | research |
  // consolidate | discover), no server connection needed. discover's Phase 5
  // (link-graph activation) checks for Hocuspocus in its own body.
  registerWorkflow(registrationServer, { config: opts.config, resolveCwd: named('workflow') });

  // Search — exec covers cat / ls / grep / find via fs-direct shell. `search`
  // is the ranked-retrieval read (Orama; mirrors cmd-K).
  registerSearch(registrationServer, {
    resolveCwd: named('search'),
    config: opts.config,
    serverUrl: opts.serverUrl,
  });
  // Unified link-graph reader — replaces the six dedicated getters
  // (get_backlinks, get_forward_links, get_dead_links, get_orphans, get_hubs,
  // suggest_links) behind a `kind` discriminator.
  registerLinks(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('links'),
  });

  // CRUD verbs — polymorphic over document / folder / template / asset
  // (Pattern B: per-target fields nested inside the address key). `write`,
  // `edit`, `delete` span CRDT (document) + HTTP (folder-create, asset) +
  // fs-direct (folder frontmatter, template) backends by target; the address
  // key signals which.
  registerWrite(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('write'),
    identityRef: opts.identityRef,
  });
  registerEdit(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('edit'),
    identityRef: opts.identityRef,
  });
  registerDelete(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('delete'),
    identityRef: opts.identityRef,
  });
  // `move` — move/rename a document, folder, or asset; probes the content
  // directory to set `kind` and rewrites the link graph.
  registerMove(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('move'),
    identityRef: opts.identityRef,
  });
  // `install` — project an authored skill into the editor host dirs
  // (Draft → Installed). The one new verb beyond the `skill` CRUD target.
  registerInstall(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('install'),
    identityRef: opts.identityRef,
  });
  registerHistory(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('history'),
  });
  // Read half of the skill vocabulary (list + read across both scopes) — the
  // mutate verbs (write/edit/delete/move/install) already cover `skill`.
  registerSkills(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('skills'),
  });
  // Version management, split by risk-shape: `checkpoint` is a project-wide
  // snapshot; `restore_version` is a per-doc restore. `history` is the read.
  registerCheckpoint(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('checkpoint'),
    identityRef: opts.identityRef,
  });
  registerRestoreVersion(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('restore_version'),
    identityRef: opts.identityRef,
  });
  // `palette` — markdown-native authoring forms + themed embed starters +
  // theme tokens; pass `components: [ids]` for full JSX-form detail (merged
  // from the former get_components). Pure module-export data; no server needed.
  registerPalette(registrationServer, {
    resolveCwd: named('palette'),
    config: opts.config,
  });

  // Config tools — fs-direct (no Hocuspocus required).
  //
  // All tools use `server.registerTool`. These config/search tools also pass
  // structured-output and annotation channels (`outputSchema`, `readOnlyHint`,
  // `idempotentHint`, `destructiveHint`) where clients need a strict schema or
  // richer metadata. Registration is wrapped by `createLoggedServer` (see
  // tool-logging.ts).
  registerConfig(registrationServer, {
    config: opts.config,
    resolveCwd: named('config'),
  });
  // Resolves the browser-reachable preview URL on demand — the one place the
  // preview base/port reaches an agent. Per-response `previewUrl` fields are
  // route-only; hosts that open the URL themselves call this tool. Takes
  // `serverUrl` for its backend-ensure (a preview request is demand for a
  // backend), though it never makes HTTP calls itself — `ui.lock` stays the
  // URL source.
  registerPreviewUrl(registrationServer, {
    config: opts.config,
    resolveCwd: named('preview_url'),
    serverUrl: opts.serverUrl,
    isDesktopTerminal: opts.isDesktopTerminal,
    // Boot-on-demand for the `file` branch is wired only when this registration
    // has backend/spawn authority (the same gate as `serverUrl`): it spawns a
    // detached `ok <file>` via this process's own CLI entry.
    ...(opts.serverUrl ? { ensureSingleFileSession: createEnsureSingleFileSession() } : {}),
  });
  // Conflict tools — wrap `/api/sync/conflict*` endpoints. `conflicts` is a
  // read (kind: list | content); `resolve_conflict` is a separate write
  // (annotated `destructiveHint: true`).
  registerConflicts(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('conflicts'),
  });
  registerResolveConflict(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('resolve_conflict'),
  });

  // Share-link construction — wraps `POST /api/share/construct-url`. Read-only
  // against the working tree; no commits/pushes/fetches. The no-remote branch
  // returns a clear actionable error rather than running the Publish wizard;
  // publishing is an explicit user act, not agent-initiated.
  registerShareLink(registrationServer, {
    serverUrl: opts.serverUrl,
    config: opts.config,
    resolveCwd: named('share_link'),
  });
}
