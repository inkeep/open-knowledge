/**
 * `install` MCP tool — project an authored skill's source
 * (`.ok/skills/<name>/`) out into your editor host dirs (`.claude/skills/`,
 * `.cursor/skills/`, `.codex/skills/`) so your agents pick it up.
 *
 * The one new verb beyond the `skill` target on write/edit/delete/move: the
 * deliberate Draft → Installed step. Routes to `POST /api/skill/install`
 * (server) which validates the source first (a conflicted / malformed SKILL.md
 * is refused, never projected verbatim), projects to the project-configured
 * editors (or an explicit `targets` list), and records the marker so
 * reclaim re-materializes it and the sharing-mode exclude stays skill-aware.
 */
import {
  type SkillScope,
  type SkillTargetEditor,
  SkillTargetEditorSchema,
} from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import type { AgentIdentity } from '../agent-identity.ts';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  agentIdentityFields,
  HOCUSPOCUS_NOT_RUNNING_ERROR,
  httpPost,
  outputSchemaWithText,
  ROUTED_CWD_DESCRIPTION,
  resolveProjectServerContext,
  summaryArgSchema,
  textPlusStructured,
  textResult,
} from './shared.ts';
import { resolveSkillName, SKILL_NAME_DESCRIBE, SkillScopeArg } from './verb-schemas.ts';

const DESCRIPTION = [
  '[Requires: Hocuspocus server] Install an authored SKILL into your editors — the deliberate Draft → Installed step.',
  '',
  'Projects the skill source at `.ok/skills/<name>/` verbatim into the editor host dirs your project is configured for (`.claude/skills/<name>/`, `.cursor/skills/<name>/`, `.codex/skills/<name>/`, `.opencode/skills/<name>/`). The source is validated FIRST — a SKILL.md with git conflict markers, missing/invalid frontmatter, XML tags in name/description, or a reserved `open-knowledge*` name is refused (never projected into your agent context). Records the install so it survives a relaunch.',
  '',
  '**Parameters:**',
  `- \`name\` — ${SKILL_NAME_DESCRIBE}`,
  '- `targets` — Optional explicit editor ids (`claude` | `cursor` | `codex` | `opencode`). Omit to install into the editors this project is already configured for.',
  '- `scope` — `project` (default, shared via git) or `global` (user-global, installed into every editor on this machine).',
  '',
  'After editing a skill, run `install` again to push the new version. After `delete({skill})`, the projection is removed automatically (uninstall).',
].join('\n');

interface InstallDeps {
  serverUrl: ServerUrlOrResolver;
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
  identityRef?: { current: AgentIdentity };
}

export function register(server: ServerInstance, deps: InstallDeps): void {
  server.registerTool(
    'install',
    {
      description: DESCRIPTION,
      inputSchema: {
        name: z.string().describe(SKILL_NAME_DESCRIBE),
        targets: z
          .array(SkillTargetEditorSchema)
          .optional()
          .describe(
            'Explicit editor ids to install into. Omit to use the editors this project is configured for.',
          ),
        scope: SkillScopeArg.optional(),
        summary: summaryArgSchema,
        cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
      },
      outputSchema: outputSchemaWithText({
        name: z.string().optional(),
        hosts: z.array(z.string()).optional().describe('Editor ids the skill was projected into.'),
        scripts: z
          .boolean()
          .optional()
          .describe('true when the skill ships executable `scripts/` (projected, never auto-run).'),
        warnings: z.array(z.string()).optional(),
      }),
    },
    async (args: {
      name: string;
      targets?: SkillTargetEditor[];
      scope?: SkillScope;
      summary?: string;
      cwd?: string;
    }) => {
      const resolved = resolveSkillName(args.name);
      if (!resolved.ok) return textResult(`Error: ${resolved.error}`, true);
      const context = await resolveProjectServerContext(
        deps.resolveCwd,
        deps.config,
        deps.serverUrl,
        args.cwd,
      );
      if (!context.ok) return textResult(`Error: ${context.error}`, true);
      if (!context.url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);

      // Target resolution lives server-side: explicit tool arg → the project's
      // committed `.ok/skill-targets.json` → detected project-configured editors.
      const result = await httpPost(context.url, '/api/skill/install', {
        ...(args.scope !== undefined ? { scope: args.scope } : {}),
        name: args.name,
        ...(args.targets !== undefined ? { targets: args.targets } : {}),
        ...(args.summary !== undefined ? { summary: args.summary } : {}),
        ...agentIdentityFields(deps.identityRef?.current),
      });
      if (!result.ok) return textResult(`Error: ${result.error}`, true);

      const hosts = Array.isArray(result.hosts) ? (result.hosts as string[]) : [];
      const scripts = result.scripts === true;
      const warnings = Array.isArray(result.warnings) ? (result.warnings as string[]) : [];
      const lines = [
        hosts.length > 0
          ? `Installed skill "${args.name}" into: ${hosts.join(', ')}.`
          : `Skill "${args.name}" was not projected — no target editors.`,
        ...warnings,
      ];
      return textPlusStructured(lines.join('\n'), {
        name: args.name,
        hosts,
        scripts,
        warnings,
      });
    },
  );
}
