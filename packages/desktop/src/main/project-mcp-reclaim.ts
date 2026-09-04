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
import { classifyMcpLauncherEntry } from '@inkeep/open-knowledge-core';
import type { McpWiringEditorId } from '../shared/ipc-channels.ts';
import { classifyInstallShape } from './install-shape.ts';

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
  editorTargets: Record<McpWiringEditorId, EditorMcpTarget>;
  allEditorIds: readonly McpWiringEditorId[];
  classifyExistingProjectMcpConfig(
    editorId: McpWiringEditorId,
    projectDir: string,
    projectPath: string,
  ): McpEntryClassification;
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
  env?: Record<string, string | undefined>;
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
  if (!isPackaged && forceEnv !== '1') return { status: 'skipped', reason: 'dev-mode' };
  const installShape = classifyInstallShape(platform, executablePath, opts.env ?? process.env);
  if (installShape.kind === 'appimage') {
    return { status: 'skipped', reason: 'appimage-ephemeral' };
  }
  if (installShape.kind === 'unsupported') {
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
      perEditor.push({ editor, status: 'no-token', configPath: projectPath });
      logger.event({ event: 'project-mcp-reclaim-no-token', editor, configPath: projectPath });
      continue;
    }

    if (classification.kind === 'decline') {
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

    if (classification.kind === 'present') {
      if (editor === 'pi') {
        if (isEntryUpToDate(classification.entry)) {
          perEditor.push({ editor, status: 'healthy-current', configPath: projectPath });
          logger.event({
            event: 'project-mcp-reclaim-healthy-current',
            editor,
            configPath: projectPath,
          });
          continue;
        }
      } else {
        const launcher = classifyMcpLauncherEntry(classification.entry);
        if (launcher.kind === 'recognized' && launcher.disposition === 'keep') {
          perEditor.push({ editor, status: 'healthy-current', configPath: projectPath });
          logger.event({
            event: 'project-mcp-reclaim-healthy-current',
            editor,
            configPath: projectPath,
          });
          continue;
        }
        if (launcher.kind === 'declined') {
          perEditor.push({
            editor,
            status: 'declined',
            configPath: projectPath,
            reason: launcher.reason,
          });
          logger.event(
            buildMcpConfigDeclineEvent({
              scope: 'project',
              surface: 'desktop-project-open',
              editorId: editor,
              reason: launcher.reason,
            }),
          );
          continue;
        }
      }
    }

    if (classification.kind !== 'present') {
      const _exhaustive: never = classification;
      return _exhaustive;
    }

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
