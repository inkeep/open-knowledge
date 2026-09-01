import type { EditorId, McpInstallOptions } from '../commands/editors.ts';
import {
  applyProjectIntegrations,
  type IntegrationWriteOutcome,
} from './project-integration-writers.ts';

export interface ProjectAiIntegrationsResult {
  readonly integrations: IntegrationWriteOutcome[];
}

export function writeProjectAiIntegrations(
  projectDir: string,
  selectedEditorIds: readonly EditorId[],
  installOptions: McpInstallOptions = {},
): ProjectAiIntegrationsResult {
  const integrations = applyProjectIntegrations(projectDir, selectedEditorIds, installOptions);
  return { integrations };
}
