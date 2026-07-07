/**
 * Project-local MCP config reclaim on project open. Both Desktop and CLI
 * sweeps apply the same namespace-ownership rule: if an `open-knowledge`
 * entry exists and does not pass the chain-sentinel check, rewrite it.
 */

import { join } from 'node:path';
import {
  buildMcpConfigDeclineEvent,
  buildMcpConfigMigrateEvent,
  type EditorMcpTarget,
  isEntryUpToDate,
  type McpDeclineReason,
  type McpEntryClassification,
  truncatePriorEntry,
} from '@inkeep/open-knowledge';
import type { McpWiringEditorId } from '../shared/ipc-channels.ts';

interface ProjectMcpReclaimLogger {
  event(payload: { event: string; [key: string]: unknown }): void;
}

const DEFAULT_LOGGER: ProjectMcpReclaimLogger = {
  event: (payload) => console.warn(JSON.stringify(payload)),
};

type ProjectMcpReclaimPerEditor =
  | { editor: McpWiringEditorId; status: 'no-file'; configPath: string }
  | { editor: McpWiringEditorId; status: 'no-token'; configPath: string }
  | { editor: McpWiringEditorId; status: 'healthy-current'; configPath: string }
  | { editor: McpWiringEditorId; status: 'reclaimed'; configPath: string }
  | {
      editor: McpWiringEditorId;
      status: 'declined';
      configPath: string;
      reason: McpDeclineReason;
    }
  | { editor: McpWiringEditorId; status: 'failed'; configPath: string; error: string }
  | { editor: McpWiringEditorId; status: 'unsupported'; reason: string };

type ProjectMcpReclaimResult =
  | { status: 'skipped'; reason: string }
  | { status: 'done'; perEditor: ProjectMcpReclaimPerEditor[] };

export interface ProjectMcpReclaimCliSurface {
  /** `EDITOR_TARGETS[id]` keyed by editor — same surface as `McpWiringCliSurface`. */
  editorTargets: Record<McpWiringEditorId, EditorMcpTarget>;
  /** Full `ALL_EDITOR_IDS`. */
  allEditorIds: readonly McpWiringEditorId[];
  /** Project-scope variant: discriminated classification at `projectPath`. */
  classifyExistingProjectMcpConfig(
    editorId: McpWiringEditorId,
    projectDir: string,
    projectPath: string,
  ): McpEntryClassification;
  /** Project-scope variant: rewrites the entry at `projectPath` with the canonical
   *  shape. `declined` is the guest-ownership outcome when a read-then-write race
   *  surfaces a present config the write path won't edit (the classify pre-pass
   *  saw it as reclaimable, but the lock-time read no longer parses / is oversized
   *  / has a duplicate container). */
  writeProjectMcpConfig(opts: {
    editorId: McpWiringEditorId;
    projectDir: string;
    projectPath: string;
  }): { action: 'overwritten' | 'declined' | 'failed'; reason?: McpDeclineReason; error?: string };
}

interface CheckAndRepairProjectMcpOpts {
  projectDir: string;
  executablePath: string;
  isPackaged: boolean;
  platform: 'darwin' | 'win32' | 'linux' | string;
  cli: ProjectMcpReclaimCliSurface;
  forceEnv?: string | null | undefined;
  reclaimDisableEnv?: string | null | undefined;
  logger?: ProjectMcpReclaimLogger;
}

export async function checkAndRepairProjectMcpOnProjectOpen(
  opts: CheckAndRepairProjectMcpOpts,
): Promise<ProjectMcpReclaimResult> {
  const {
    projectDir,
    executablePath,
    isPackaged,
    platform,
    cli,
    forceEnv,
    reclaimDisableEnv,
    logger = DEFAULT_LOGGER,
  } = opts;
  if (reclaimDisableEnv === '1') return { status: 'skipped', reason: 'reclaim-disabled' };
  if (platform !== 'darwin') return { status: 'skipped', reason: 'platform' };
  if (!isPackaged && forceEnv !== '1') return { status: 'skipped', reason: 'dev-mode' };
  if (!/\.app\/Contents\/MacOS\/[^/]+$/.test(executablePath)) {
    return { status: 'skipped', reason: 'bad-executable-path' };
  }

  logger.event({ event: 'project-mcp-reclaim-started', projectDir });

  const perEditor: ProjectMcpReclaimPerEditor[] = [];
  for (const editor of cli.allEditorIds) {
    const target = cli.editorTargets[editor];
    if (!target?.projectConfigPath) {
      perEditor.push({ editor, status: 'unsupported', reason: 'no-project-config-path' });
      continue;
    }
    let projectPath: string;
    try {
      projectPath = target.projectConfigPath(projectDir);
    } catch (err) {
      perEditor.push({
        editor,
        status: 'failed',
        configPath: join(projectDir, '<unresolved>'),
        error: err instanceof Error ? err.message : String(err),
      });
      logger.event({
        event: 'project-mcp-reclaim-resolve-failed',
        editor,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    let classification: McpEntryClassification;
    try {
      classification = cli.classifyExistingProjectMcpConfig(editor, projectDir, projectPath);
    } catch (err) {
      perEditor.push({
        editor,
        status: 'failed',
        configPath: projectPath,
        error: err instanceof Error ? err.message : String(err),
      });
      logger.event({
        event: 'project-mcp-reclaim-read-failed',
        editor,
        configPath: projectPath,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (classification.kind === 'absent' || classification.kind === 'no-entry') {
      // 'absent' = file doesn't exist. 'no-entry' = file parses but has no
      // entry under our server name (could be a valid config for other
      // tools — never author into it). Both are no-ops under namespace
      // ownership. Operators reading the log can disambiguate via the
      // configPath + existsSync upstream if they need to.
      perEditor.push({ editor, status: 'no-token', configPath: projectPath });
      logger.event({ event: 'project-mcp-reclaim-no-token', editor, configPath: projectPath });
      continue;
    }

    if (classification.kind === 'present' && isEntryUpToDate(classification.entry)) {
      perEditor.push({ editor, status: 'healthy-current', configPath: projectPath });
      logger.event({
        event: 'project-mcp-reclaim-healthy-current',
        editor,
        configPath: projectPath,
      });
      continue;
    }

    if (classification.kind === 'decline') {
      // OpenKnowledge is a guest in another tool's config: a present, non-empty
      // file it cannot fully parse is left byte-untouched — never renamed aside
      // or overwritten — and registration is skipped. The bounded decline
      // signal is the only operator-facing trace; the user sees OK's server
      // simply absent rather than their config reset.
      perEditor.push({
        editor,
        status: 'declined',
        configPath: projectPath,
        reason: classification.reason,
      });
      logger.event(
        buildMcpConfigDeclineEvent({
          scope: 'project',
          surface: 'desktop-project-open',
          editorId: editor,
          reason: classification.reason,
        }),
      );
      continue;
    }

    if (classification.kind !== 'present') {
      // Exhaustiveness guard: absent / no-entry / healthy-current / decline all
      // `continue` above, so only an incompatible `present` reaches here. A new
      // McpEntryClassification variant becomes a compile error rather than
      // silently falling into the repair write below.
      const _exhaustive: never = classification;
      return _exhaustive;
    }

    // Only a present-but-incompatible entry remains. Emit the structured
    // `mcp-config-migrate` event BEFORE the write so field observability
    // captures every attempted migration — including writes that fail. The
    // sibling `project-mcp-reclaim-reclaimed` event below fires only on a
    // successful write; together they distinguish "intent to migrate" from
    // "did migrate."
    logger.event(
      buildMcpConfigMigrateEvent({
        scope: 'project',
        surface: 'desktop-project-open',
        editorId: editor,
        configPath: projectPath,
        priorEntry: classification.entry,
      }),
    );

    const writeResult = cli.writeProjectMcpConfig({
      editorId: editor,
      projectDir,
      projectPath,
    });
    if (writeResult.action === 'failed') {
      perEditor.push({
        editor,
        status: 'failed',
        configPath: projectPath,
        error: writeResult.error ?? 'unknown',
      });
      logger.event({
        event: 'project-mcp-reclaim-write-failed',
        editor,
        configPath: projectPath,
        error: writeResult.error ?? 'unknown',
      });
      continue;
    }

    if (writeResult.action === 'declined') {
      // The classify pre-pass saw a reclaimable entry, but the lock-time read no
      // longer parses (a concurrent harness truncated it, or it grew past the
      // size bound). The write left the file byte-untouched — record a decline,
      // NOT a reclaim, so the `reclaimed` event never fires for an unwritten file.
      const reason: McpDeclineReason = writeResult.reason ?? 'unparseable';
      perEditor.push({ editor, status: 'declined', configPath: projectPath, reason });
      logger.event(
        buildMcpConfigDeclineEvent({
          scope: 'project',
          surface: 'desktop-project-open',
          editorId: editor,
          reason,
        }),
      );
      continue;
    }

    // Reuses the shared `truncatePriorEntry` helper so the truncation contract
    // stays in lockstep with `mcp-config-migrate`.
    const { priorCommand, priorArgs } = truncatePriorEntry(classification.entry);
    perEditor.push({ editor, status: 'reclaimed', configPath: projectPath });
    logger.event({
      event: 'project-mcp-reclaim-reclaimed',
      editor,
      configPath: projectPath,
      priorCommand,
      priorArgs,
    });
  }

  return { status: 'done', perEditor };
}
