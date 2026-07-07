/**
 * Composable per-editor project-integration layer.
 *
 * Gives the desktop project-setup path one shared abstraction: a uniform
 * `ProjectIntegrationWriter` interface, the default writer set
 * `[mcp-config, project-skill]`, and an `applyProjectIntegrations`
 * orchestrator. OK Desktop's `writeProjectAiIntegrations` runs this
 * orchestrator. `ok init` installs the same integrations via the shared
 * primitives the writers wrap (`writeProjectSkill`, `writeEditorMcpConfig`)
 * but keeps its own `--scope` / `--no-mcp` / detection-aware loop — it does
 * NOT run this orchestrator.
 *
 * Abstraction boundary: per-editor project-local integrations ONLY. The
 * `.ok/` scaffold, the user-global skill (`installUserSkill`), `launch.json`,
 * and git remain `ok init`'s own composition AROUND this orchestrator.
 *
 * Adding a new project-local concern = appending one writer to the default
 * set; no caller changes.
 */
import {
  EDITOR_TARGETS,
  type EditorId,
  type EditorMcpTarget,
  type McpInstallOptions,
} from '../commands/editors.ts';
import { type McpDeclineReason, writeEditorMcpConfig } from '../commands/init.ts';
import { writeProjectSkill } from './write-project-skill.ts';

type IntegrationId = 'mcp-config' | 'project-skill';

/**
 * Per-(editor × integration) outcome.
 *
 * `action` discriminates five states:
 *   - `'written'`     — wrote a fresh artifact
 *   - `'overwritten'` — replaced an existing artifact
 *   - `'skipped-unsupported'` — editor has no surface for this integration
 *     (e.g. Claude Desktop has no `projectConfigPath` / no `projectSkillPath`)
 *   - `'declined'`    — a present config OK can't safely edit was left
 *     byte-unchanged (guest-ownership); `reason` is the bounded cause. NOT a
 *     failure — registration was skipped non-destructively.
 *   - `'failed'`      — error occurred; `error` is set
 *
 * `path` is the absolute target path when one is meaningful; absent for
 * `skipped-unsupported`. `error` is set iff `action === 'failed'`; `reason` is
 * set iff `action === 'declined'`.
 */
export interface IntegrationWriteOutcome {
  readonly integration: IntegrationId;
  readonly editorId: EditorId;
  readonly action: 'written' | 'overwritten' | 'skipped-unsupported' | 'declined' | 'failed';
  readonly path?: string;
  readonly error?: string;
  readonly reason?: McpDeclineReason;
}

/**
 * One project-local integration concern applied to one editor.
 *
 * **MUST NOT throw.** A writer guarantees its failures surface as
 * `action: 'failed'` so a single editor never aborts the batch.
 * `applyProjectIntegrations` relies on this contract — if a future change
 * adds a throwing path inside a writer, the orchestrator's
 * non-fatal-failure guarantee silently breaks.
 */
export interface ProjectIntegrationWriter {
  readonly id: IntegrationId;
  write(
    target: EditorMcpTarget,
    projectDir: string,
    options: McpInstallOptions,
  ): IntegrationWriteOutcome;
}

// ---------------------------------------------------------------------------
// mcpConfigWriter — wraps writeEditorMcpConfig (project-scope path)
// ---------------------------------------------------------------------------

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
    // `writeEditorMcpConfig` itself catches every failure path and never
    // throws by design, but this outer try/catch is the trust seam between
    // the orchestrator and the underlying primitive: the writer interface
    // promises "MUST NOT throw" regardless of future evolution of the
    // wrapped function.
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
      if (result.action === 'declined') {
        // A present project config OK can't safely edit was left byte-unchanged
        // (guest-ownership). This is a non-destructive skip, NOT a failure —
        // surface it as `declined` with the bounded reason so the desktop
        // create-new flow neither counts it against the failure metric nor
        // overstates it as a successful write.
        return {
          integration: 'mcp-config',
          editorId: target.id,
          action: 'declined',
          path: result.configPath,
          ...(result.declineReason !== undefined ? { reason: result.declineReason } : {}),
        };
      }
      // `skipped-missing` and `skipped-flag` are unreachable for project-scope
      // writes — `configPathOverride` bypasses `isEditorTargetAvailable`, and
      // `skipped-flag` is set only on the `--no-mcp` branch which never
      // reaches this writer. Surface as `failed` if a future change re-routes
      // them here so the orchestrator never returns a silent skip.
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

// ---------------------------------------------------------------------------
// projectSkillWriter — wraps writeProjectSkill
// ---------------------------------------------------------------------------

export const projectSkillWriter: ProjectIntegrationWriter = {
  id: 'project-skill',
  // `_options` is intentionally unused — `writeProjectSkill` copies a bundled
  // asset directory; none of the McpInstallOptions fields apply. Accepted so
  // every writer has the same call signature.
  write(target, projectDir, _options) {
    try {
      const result = writeProjectSkill(target, projectDir);
      return {
        integration: 'project-skill',
        editorId: target.id,
        action: result.action,
        // `result.path` is `''` for `skipped-unsupported`; omit when falsy so
        // the outcome shape is "path present when meaningful."
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

// ---------------------------------------------------------------------------
// Default writer set + orchestrator
// ---------------------------------------------------------------------------

/**
 * Canonical project-integration set, in apply order.
 *
 * OK Desktop's `writeProjectAiIntegrations` runs `applyProjectIntegrations`
 * with this default set. `as const` fixes the tuple shape so the writer at
 * each index stays statically known.
 */
export const DEFAULT_PROJECT_INTEGRATIONS = [mcpConfigWriter, projectSkillWriter] as const;

/**
 * Apply every writer to every editor and collect per-(editor × integration)
 * outcomes. One writer failure never aborts the rest of the batch — the
 * writer contract (`MUST NOT throw`) is what makes that guarantee hold.
 *
 * `writers` is the extension point; callers that want only MCP config (or
 * only the skill) can pass a narrower set.
 */
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
