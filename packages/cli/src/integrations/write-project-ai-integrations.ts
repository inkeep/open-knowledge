/**
 * Write project-scope AI tool integrations for a desktop project-setup flow.
 *
 * Thin wrapper over `applyProjectIntegrations` — the shared per-editor
 * project-integration orchestrator. Both Desktop project-setup paths
 * (`runCreateNew` and the onboarding flow) call this wrapper, so the desktop
 * installs the MCP config and the project skill through one code path.
 * `ok init` installs the same integrations via the shared writer primitives
 * but keeps its own scope/detection-aware loop — it does not run this
 * orchestrator.
 *
 * `writeProjectAiIntegrations` adds the one desktop-specific concern the
 * per-editor orchestrator does not own: scaffolding `<projectDir>/.claude/
 * launch.json` when `'claude'` is selected (the CLI's `runInit` does the
 * equivalent). `launch.json` is a single per-project file, not a per-editor
 * integration, so it stays here rather than inside a writer.
 *
 * Never throws — every per-(editor × integration) failure is captured in
 * its `IntegrationWriteOutcome` as `action: 'failed'`.
 */

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
