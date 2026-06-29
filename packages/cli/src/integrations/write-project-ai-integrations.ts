
import type { EditorId, McpInstallOptions } from '../commands/editors.ts';
import { type LaunchJsonResult, scaffoldLaunchJson } from '../commands/init.ts';
import {
  applyProjectIntegrations,
  type IntegrationWriteOutcome,
} from './project-integration-writers.ts';

export interface ProjectAiIntegrationsResult {
  /** Per-(editor × integration) outcomes — MCP config and the project-local
   *  runtime skill for every selected editor. */
  readonly integrations: IntegrationWriteOutcome[];
  /** Result of `<projectDir>/.claude/launch.json` scaffolding; present iff
   *  `'claude'` was in `selectedEditorIds`. */
  readonly claudeLaunchJson?: LaunchJsonResult;
}

export function writeProjectAiIntegrations(
  projectDir: string,
  selectedEditorIds: readonly EditorId[],
  installOptions: McpInstallOptions = {},
): ProjectAiIntegrationsResult {
  const integrations = applyProjectIntegrations(projectDir, selectedEditorIds, installOptions);
  const claudeLaunchJson = selectedEditorIds.includes('claude')
    ? scaffoldLaunchJson(projectDir, installOptions)
    : undefined;
  return { integrations, claudeLaunchJson };
}
