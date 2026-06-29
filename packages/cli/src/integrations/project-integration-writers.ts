import {
  EDITOR_TARGETS,
  type EditorId,
  type EditorMcpTarget,
  type McpInstallOptions,
} from '../commands/editors.ts';
import { writeEditorMcpConfig } from '../commands/init.ts';
import { writeProjectSkill } from './write-project-skill.ts';

type IntegrationId = 'mcp-config' | 'project-skill';

export interface IntegrationWriteOutcome {
  readonly integration: IntegrationId;
  readonly editorId: EditorId;
  readonly action: 'written' | 'overwritten' | 'skipped-unsupported' | 'failed';
  readonly path?: string;
  readonly error?: string;
}

export interface ProjectIntegrationWriter {
  readonly id: IntegrationId;
  write(
    target: EditorMcpTarget,
    projectDir: string,
    options: McpInstallOptions,
  ): IntegrationWriteOutcome;
}

export const mcpConfigWriter: ProjectIntegrationWriter = {
  id: 'mcp-config',
  write(target, projectDir, options) {
    const projectPath = target.projectConfigPath?.(projectDir);
    if (!projectPath) {
      return {
        integration: 'mcp-config',
        editorId: target.id,
        action: 'skipped-unsupported',
      };
    }
    try {
      const result = writeEditorMcpConfig(target, projectDir, options, undefined, projectPath);
      if (result.action === 'written' || result.action === 'overwritten') {
        return {
          integration: 'mcp-config',
          editorId: target.id,
          action: result.action,
          path: result.configPath,
        };
      }
      if (result.action === 'failed') {
        return {
          integration: 'mcp-config',
          editorId: target.id,
          action: 'failed',
          path: result.configPath,
          error: result.error ?? 'unknown failure',
        };
      }
      return {
        integration: 'mcp-config',
        editorId: target.id,
        action: 'failed',
        path: result.configPath,
        error: `unexpected project-scope action: ${result.action}`,
      };
    } catch (err) {
      return {
        integration: 'mcp-config',
        editorId: target.id,
        action: 'failed',
        path: projectPath,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

export const projectSkillWriter: ProjectIntegrationWriter = {
  id: 'project-skill',
  write(target, projectDir, _options) {
    try {
      const result = writeProjectSkill(target, projectDir);
      return {
        integration: 'project-skill',
        editorId: target.id,
        action: result.action,
        ...(result.path ? { path: result.path } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    } catch (err) {
      return {
        integration: 'project-skill',
        editorId: target.id,
        action: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

export const DEFAULT_PROJECT_INTEGRATIONS = [mcpConfigWriter, projectSkillWriter] as const;

export function applyProjectIntegrations(
  projectDir: string,
  editorIds: readonly EditorId[],
  options: McpInstallOptions = {},
  writers: readonly ProjectIntegrationWriter[] = DEFAULT_PROJECT_INTEGRATIONS,
): IntegrationWriteOutcome[] {
  const outcomes: IntegrationWriteOutcome[] = [];
  for (const editorId of editorIds) {
    const target = EDITOR_TARGETS[editorId];
    for (const writer of writers) {
      outcomes.push(writer.write(target, projectDir, options));
    }
  }
  return outcomes;
}
