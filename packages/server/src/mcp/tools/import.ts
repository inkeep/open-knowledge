import {
  SKILL_AUTHORING_WARNING_CODES,
  SKILL_INSTALL_WARNING_CODES,
  type SkillLocationId,
  SkillLocationIdSchema,
  type SkillScope,
} from '@inkeep/open-knowledge-core';
import { parseSkillsShSource } from '@inkeep/open-knowledge-core/skills-catalog';
import { z } from 'zod';
import type { LocalApiDispatch } from '../../http/local-api-dispatch.ts';
import type { AgentIdentity } from '../agent-identity.ts';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  AUTHORING_WARNING_CODE_GLOSS,
  agentIdentityFields,
  alignWarningCodes,
  apiTarget,
  httpPost,
  INSTALL_WARNING_CODE_GLOSS,
  outputSchemaWithText,
  ROUTED_CWD_DESCRIPTION,
  requireProjectServer,
  summaryArgSchema,
  textPlusStructured,
  textResult,
  warningCodesContract,
  warningsFieldContract,
} from './shared.ts';
import { SkillScopeArg } from './verb-schemas.ts';

const KNOWN_CODES: ReadonlySet<string> = new Set<string>([
  ...SKILL_AUTHORING_WARNING_CODES,
  ...SKILL_INSTALL_WARNING_CODES,
]);

const DESCRIPTION = [
  '[Requires: Hocuspocus server] Import a skill into this project as versioned content.',
  '',
  'Fetches an agentskills.io / skills.sh skill-dir from a `source` and writes it into the vendor-neutral `.agents/skills/<name>/` hub — where it gains history, search, attribution, and cross-harness projection (via `install`) for free. Provenance (source, commit, content hash, publisher) is recorded in `.ok/skills-lock.json`. Scripts are imported as content and are NEVER executed. `add` says where it goes — an import always places the skill somewhere, so `install` afterwards is only for changing WHERE it lives (add/remove/convert/source).',
  '',
  '**Parameters:**',
  '- `source` — paste the full skills.sh skill-page URL (`https://www.skills.sh/<owner>/<repo>/<skill>`, or `https://www.skills.sh/site/<hostname>/<skill>` for a website catalog), or pass `owner/repo[/subpath]` (GitHub), a git URL, or a local / `file://` path.',
  '- `skill` — Pick ONE skill when the source bundles several.',
  '- `scope` — `project` (default, versioned + shared) or `global` (user-global, unversioned).',
  '',
  'On a name collision with an existing skill the import lands under `<name>-imported` (never overwrites). An identical re-import (same content hash) is a no-op.',
].join('\n');

interface ImportDeps {
  serverUrl: ServerUrlOrResolver;
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
  identityRef?: { current: AgentIdentity };
  localApi?: LocalApiDispatch;
}

export function register(server: ServerInstance, deps: ImportDeps): void {
  server.registerTool(
    'import',
    {
      description: DESCRIPTION,
      inputSchema: {
        source: z
          .string()
          .min(1)
          .describe(
            'Full skills.sh skill-page URL (`https://www.skills.sh/<owner>/<repo>/<skill>`, or `https://www.skills.sh/site/<hostname>/<skill>` for a website catalog), `owner/repo[/subpath]`, a git URL, or a local / `file://` path.',
          ),
        skill: z.string().min(1).optional().describe('Pick one skill from a multi-skill source.'),
        add: z
          .array(SkillLocationIdSchema)
          .min(1)
          .describe(
            'REQUIRED — where the imported skill goes. Editor ids (`claude` … `pi`), `agents` (the vendor-neutral hub), or a custom root path (".team/skills"). Same vocabulary as `install`. A skill acquired and placed nowhere is not a state worth having, so this is not optional.',
          ),
        mode: z
          .enum(['copy', 'link'])
          .optional()
          .describe(
            'The form for the locations in `add`. "link": a symlink to the source. "copy": an independent folder, auto-refreshed until hand-edited. Omit to follow the form the skill already uses.',
          ),
        scope: SkillScopeArg.optional(),
        summary: summaryArgSchema,
        cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
      },
      outputSchema: outputSchemaWithText({
        name: z
          .string()
          .optional()
          .describe('Managed skill name created or matched by the import.'),
        path: z
          .string()
          .optional()
          .describe('Project-relative path of the imported skill bundle (under `.agents/skills`).'),
        alreadyImported: z
          .boolean()
          .optional()
          .describe('True when an identical content hash already existed and no files changed.'),
        collisionRenamedFrom: z
          .string()
          .optional()
          .describe(
            'Original upstream skill name when a local collision forced an `-imported` rename.',
          ),
        warnings: z
          .array(z.string())
          .optional()
          .describe(
            `Non-fatal warnings from BOTH steps: the acquire (skipped unsupported bundle files) first, then the placement \`add\` runs. ${warningsFieldContract('each step')} One step sending an unreadable shape replaces only its own slice of this list; the other step's text still comes through.`,
          ),
        warningCodes: z
          .array(z.enum([...SKILL_AUTHORING_WARNING_CODES, ...SKILL_INSTALL_WARNING_CODES]))
          .optional()
          .describe(
            `${warningCodesContract('either step')} Authoring codes (from the imported SKILL.md): ${AUTHORING_WARNING_CODE_GLOSS} Placement codes: ${INSTALL_WARNING_CODE_GLOSS}`,
          ),
      }),
    },
    async (args: {
      source: string;
      skill?: string;
      add: SkillLocationId[];
      mode?: 'copy' | 'link';
      scope?: SkillScope;
      summary?: string;
      cwd?: string;
    }) => {
      const context = await requireProjectServer(
        deps.resolveCwd,
        deps.config,
        deps.serverUrl,
        args.cwd,
      );
      if (!context.ok) return context.result;

      const result = await httpPost(apiTarget(context.url, deps.localApi), '/api/skill/import', {
        source: args.source,
        ...(args.skill !== undefined ? { skill: args.skill } : {}),
        install: false,
        ...(parseSkillsShSource(args.source) !== null ? { marketplace: true } : {}),
        ...(args.scope !== undefined ? { scope: args.scope } : {}),
        ...(args.summary !== undefined ? { summary: args.summary } : {}),
        ...agentIdentityFields(deps.identityRef?.current),
      });
      if (!result.ok) {
        const detail = typeof result.detail === 'string' ? ` (${result.detail})` : '';
        return textResult(`Error: ${result.error}${detail}`, true);
      }

      const name = typeof result.name === 'string' ? result.name : args.source;
      const placed = await httpPost(apiTarget(context.url, deps.localApi), '/api/skill/install', {
        ...(args.scope !== undefined ? { scope: args.scope } : {}),
        name,
        add: args.add,
        ...(args.mode !== undefined ? { mode: args.mode } : {}),
        ...(args.summary !== undefined ? { summary: args.summary } : {}),
        ...agentIdentityFields(deps.identityRef?.current),
      });
      if (!placed.ok) {
        return textResult(
          `Imported "${name}", but placing it failed: ${placed.error}. Run \`install\` to retry the placement.`,
          true,
        );
      }
      const alreadyImported = result.alreadyImported === true;
      const renamedFrom =
        typeof result.collisionRenamedFrom === 'string' ? result.collisionRenamedFrom : undefined;
      const acquired = alignWarningCodes(result.warnings, result.warningCodes, KNOWN_CODES);
      const projected = alignWarningCodes(placed.warnings, placed.warningCodes, KNOWN_CODES);
      const warnings = [...acquired.warnings, ...projected.warnings];
      const line = alreadyImported
        ? `Skill "${name}" was already imported (identical content); its placement was applied.`
        : `Imported "${name}"${renamedFrom ? ` (renamed from "${renamedFrom}" — the name was taken)` : ''} into .agents/skills as content. Scripts shown, never run. Use \`install\` to change where it lives.`;
      return textPlusStructured([line, ...warnings].join('\n'), {
        name,
        path: typeof result.path === 'string' ? result.path : undefined,
        alreadyImported,
        ...(renamedFrom ? { collisionRenamedFrom: renamedFrom } : {}),
        warnings,
        ...(acquired.warningCodes && projected.warningCodes
          ? { warningCodes: [...acquired.warningCodes, ...projected.warningCodes] }
          : {}),
      });
    },
  );
}
