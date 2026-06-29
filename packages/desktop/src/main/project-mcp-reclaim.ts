import { renameSync as fsRenameSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildMcpConfigMigrateEvent,
  type EditorMcpTarget,
  isEntryUpToDate,
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
      status: 'reclaimed-from-corrupt';
      configPath: string;
      backupPath: string;
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
  }): { action: 'overwritten' | 'failed'; error?: string };
}

interface CorruptBackupFs {
  renameSync(oldPath: string, newPath: string): void;
}

const defaultBackupFs: CorruptBackupFs = {
  renameSync: (oldPath, newPath) => {
    fsRenameSync(oldPath, newPath);
  },
};

function moveCorruptAside(configPath: string, now: Date, fs: CorruptBackupFs): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const backupPath = `${configPath}.broken-${stamp}`;
  fs.renameSync(configPath, backupPath);
  return backupPath;
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
  backupFs?: CorruptBackupFs;
  now?: () => Date;
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
    backupFs = defaultBackupFs,
    now,
  } = opts;
  const nowDate = (): Date => (now ? now() : new Date());
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

    let backupPath: string | null = null;
    if (classification.kind === 'corrupt') {
      try {
        backupPath = moveCorruptAside(projectPath, nowDate(), backupFs);
        logger.event({
          event: 'project-mcp-reclaim-corrupt-backup',
          editor,
          configPath: projectPath,
          backupPath,
          error: classification.error,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        perEditor.push({ editor, status: 'failed', configPath: projectPath, error });
        logger.event({
          event: 'project-mcp-reclaim-backup-failed',
          editor,
          configPath: projectPath,
          error,
        });
        continue;
      }
    }

    if (classification.kind === 'present') {
      logger.event(
        buildMcpConfigMigrateEvent({
          scope: 'project',
          surface: 'desktop-project-open',
          editorId: editor,
          configPath: projectPath,
          priorEntry: classification.entry,
        }),
      );
    }

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

    if (backupPath !== null) {
      perEditor.push({
        editor,
        status: 'reclaimed-from-corrupt',
        configPath: projectPath,
        backupPath,
      });
      logger.event({
        event: 'project-mcp-reclaim-reclaimed-from-corrupt',
        editor,
        configPath: projectPath,
        backupPath,
      });
      continue;
    }
    if (classification.kind !== 'present') continue;
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
