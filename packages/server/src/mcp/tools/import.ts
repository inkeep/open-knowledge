/**
 * `import` MCP tool — acquire a skill from outside this project into
 * `.agents/skills/<name>/` as versioned IN-PLACE content (write-path inversion).
 *
 * Routes to `POST /api/skill/import` (server), which fetches the skill-dir
 * (skills.sh URL, github `owner/repo[/subpath]`, a git URL, or a local path),
 * writes it via the same sanctioned content writers an authored skill uses,
 * records upstream provenance in `.ok/skills-lock.json`, then places it at the
 * locations `add` names. `install` afterwards changes WHERE it lives. Scripts are imported as
 * content, NEVER run.
 */
import {
  SKILL_INSTALL_WARNING_CODES,
  type SkillLocationId,
  SkillLocationIdSchema,
  type SkillScope,
} from '@inkeep/open-knowledge-core';
import { parseSkillsShSource } from '@inkeep/open-knowledge-core/skills-catalog';
import { z } from 'zod';
import type { AgentIdentity } from '../agent-identity.ts';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  agentIdentityFields,
  httpPost,
  outputSchemaWithText,
  ROUTED_CWD_DESCRIPTION,
  requireProjectServer,
  summaryArgSchema,
  textPlusStructured,
  textResult,
} from './shared.ts';
import { SkillScopeArg } from './verb-schemas.ts';

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
            'Non-fatal warnings from BOTH steps: the acquire (skipped unsupported bundle files) and the placement `add` runs.',
          ),
        warningCodes: z
          .array(z.enum(SKILL_INSTALL_WARNING_CODES))
          .optional()
          .describe(
            'Machine-readable codes aligned 1:1 with `warnings` (`warnings[i]` is the display text for `warningCodes[i]`) — switch on these, never on the English. `no-targets`: nothing was projected, no editor is configured for this project. `scripts-present`: the skill ships executable `scripts/` (projected, never auto-run). `no-description`: installed, but its `description` is empty, so agents cannot route to it. `name-conflict`: a DIFFERENT skill already holds that name at a location. `place-path-invalid`: a named location is not a placeable root. `place-fork-refused`: a hand-edited copy was left alone rather than deleted. `skill-fork-name-unpatched`: a fork rename moved the folder but could not rewrite `name` in its SKILL.md.',
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

      const result = await httpPost(context.url, '/api/skill/import', {
        source: args.source,
        ...(args.skill !== undefined ? { skill: args.skill } : {}),
        // Acquire only. The placement below runs through the install path so
        // location math lives in exactly one place, and so an import can never
        // leave a skill sitting somewhere the caller did not name.
        install: false,
        // A pasted skills.sh page URL is marketplace provenance — the user
        // chose the listing — so the install counts toward it. Any other
        // source shape (owner/repo, git URL, local path) is never announced.
        ...(parseSkillsShSource(args.source) !== null ? { marketplace: true } : {}),
        ...(args.scope !== undefined ? { scope: args.scope } : {}),
        ...(args.summary !== undefined ? { summary: args.summary } : {}),
        ...agentIdentityFields(deps.identityRef?.current),
      });
      if (!result.ok) {
        // A multi-skill source names its candidates in `detail`; without it the
        // agent is told to pick one and shown nothing to pick from.
        const detail = typeof result.detail === 'string' ? ` (${result.detail})` : '';
        return textResult(`Error: ${result.error}${detail}`, true);
      }

      const name = typeof result.name === 'string' ? result.name : args.source;
      // Place through the install endpoint rather than reimplementing location
      // math here. A failure leaves the skill acquired at its source folder —
      // reported, not silently swallowed, so the caller knows to retry the
      // placement rather than the fetch.
      const placed = await httpPost(context.url, '/api/skill/install', {
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
      // Both halves warn, and the placement half is the one that reports
      // per-location failures on an otherwise-200 bulk `add`. Dropping its
      // warnings here would let "imported successfully" hide a location that
      // was refused as a fork or rejected as an unplaceable root.
      const warnings = [
        ...(Array.isArray(result.warnings) ? (result.warnings as string[]) : []),
        ...(Array.isArray(placed.warnings) ? (placed.warnings as string[]) : []),
      ];
      const warningCodes = Array.isArray(placed.warningCodes)
        ? (placed.warningCodes as string[])
        : [];
      const line = alreadyImported
        ? // The CONTENT was already present, but `add` still ran — saying "no
          // changes" would misreport a call that just placed the skill somewhere new.
          `Skill "${name}" was already imported (identical content); its placement was applied.`
        : `Imported "${name}"${renamedFrom ? ` (renamed from "${renamedFrom}" — the name was taken)` : ''} into .agents/skills as content. Scripts shown, never run. Use \`install\` to change where it lives.`;
      return textPlusStructured([line, ...warnings].join('\n'), {
        name,
        path: typeof result.path === 'string' ? result.path : undefined,
        alreadyImported,
        ...(renamedFrom ? { collisionRenamedFrom: renamedFrom } : {}),
        warnings,
        ...(warningCodes.length > 0 ? { warningCodes } : {}),
      });
    },
  );
}
