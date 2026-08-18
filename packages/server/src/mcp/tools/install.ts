/**
 * `install` MCP tool — project an authored skill's source
 * (`.ok/skills/<name>/`) out into your editor host dirs (`.claude/skills/`,
 * `.cursor/skills/`, `.codex/skills/`) so your agents pick it up.
 *
 * The one new verb beyond the `skill` target on write/edit/delete/move: the
 * per-editor fan-out step. Routes to `POST /api/skill/install`
 * (server) which validates the source first (a conflicted / malformed SKILL.md
 * is refused, never projected verbatim), projects to the project-configured
 * editors (or an explicit `targets` list), and records the marker so
 * reclaim re-materializes it and the sharing-mode exclude stays skill-aware.
 */
import {
  SKILL_INSTALL_WARNING_CODES,
  type SkillFolderActionMcp,
  SkillFolderActionMcpSchema,
  type SkillLocationId,
  SkillLocationIdSchema,
  type SkillScope,
} from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import type { LocalApiDispatch } from '../../http/local-api-dispatch.ts';
import type { AgentIdentity } from '../agent-identity.ts';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  agentIdentityFields,
  apiTarget,
  errorTextWithDetail,
  httpPost,
  httpPut,
  outputSchemaWithText,
  ROUTED_CWD_DESCRIPTION,
  requireProjectServer,
  summaryArgSchema,
  textPlusStructured,
  textResult,
} from './shared.ts';
import { resolveSkillName, SKILL_NAME_DESCRIBE, SkillScopeArg } from './verb-schemas.ts';

const DESCRIPTION = [
  '[Requires: Hocuspocus server] Manage WHERE a skill is available. A skill is ONE real folder (its SOURCE — the skill itself) plus managed copies/symlinks at other locations. `add`/`remove` change the other locations; `mode` flips copies↔symlinks; `source` moves the real folder. There is NO "uninstall everywhere" and no draft state — a skill with no extra locations still lives (and loads) at its source folder; to make a skill stop existing, use `delete`.',
  '',
  'Location ids: editor host ids (`claude` | `cursor` | `codex` | `copilot` | `opencode` | `pi`), `agents` (the vendor-neutral `.agents/skills` hub), or a base-relative custom root path containing `/` (e.g. `.team/skills`; home-relative at global scope). The source is validated FIRST — a SKILL.md with git conflict markers, missing/invalid frontmatter, XML tags in name/description, or a reserved `open-knowledge*` name is refused (never fanned into your agent context).',
  '',
  '**Parameters:**',
  `- \`name\` — ${SKILL_NAME_DESCRIBE}`,
  '- `add` — Locations to ADD the skill to (everything else untouched). Editor ids fan out a copy/symlink; a custom root path places the bundle there. Omitting both `add` and `remove` installs into the project-configured editors.',
  '- `remove` — Locations to REMOVE it from (lossless only: a hand-edited fork is refused, never deleted). Works however the agent gets the skill: removing an editor that reads it through a folder alias (its skills folder symlinked into a shared root) automatically unfollows that folder from the root MINUS this skill — the editor keeps its other skills. The SOURCE cannot be removed — its folder is the skill; move it with `source` or use `delete`.',
  '- `mode` — `"link"`: a live symlink to the source. `"copy"`: an independent folder, auto-refreshed from the source until hand-edited (a hand-edit forks that copy). Applies ONLY to the locations this call names — the ones in `add`, or the ones in `convert` — and sets no skill-wide default. Omit it on `add` and the new location takes the form the skill already uses.',
  '- `convert` — Existing locations to change the FORM of, leaving membership alone. Requires `mode`. Pass every location to make them uniform. Lossless both ways; a hand-edited copy is refused rather than overwritten.',
  "- `source` — Move the skill's REAL folder to this location; the old source becomes a symlink to it. Run alone (not with add/remove).",
  '- `scope` — `project` (default, shared via git) or `global` (user-level, every project on this machine).',
  '',
  '- `skillFolders` — Folder-level topology instead of one skill (the Settings → Folders surface). Run alone; `name` is not used with it. One action per call:',
  '  - `{ action: "link", scope, root, target }` — merge the skills folder `root` into `target` and replace `root` with a symlink, so its agent reads everything placed in `target`. Same-content entries drop; a DIFFERENT skill in both folders aborts with a conflict list; an interrupted merge is resumable by re-running. `target` is required — nothing is ever assumed.',
  '  - `{ action: "unlink", scope, root, exclude? }` — turn a linked folder back into a real directory holding one per-skill symlink per skill it sees (lossless, reversible). `exclude: ["<skill>"]` leaves named skills out — "this agent should not get that skill": the folder keeps everything else but stops following the root.',
  '  - `{ action: "add-root", scope, root }` — declare a NEW custom skills root (base-relative, e.g. ".team/skills"); it becomes a folder row and an install/link target immediately.',
  '',
  'Copies auto-refresh when the source changes — you do NOT need to re-run install after editing a skill. After `delete({skill})` every location is removed with the source.',
].join('\n');

/**
 * Folder-level skill topology (link / unlink / add-root). Lives on `install`
 * rather than `config` because MCP annotations are per-tool and static: one
 * mutating field on `config` forced its `readOnlyHint` off, which made every
 * plain config READ raise an approval prompt for users who never touch skills.
 */
async function runSkillFolderAction(
  deps: InstallDeps,
  action: SkillFolderActionMcp,
  cwd: string | undefined,
): Promise<ReturnType<typeof textResult>> {
  const context = await requireProjectServer(deps.resolveCwd, deps.config, deps.serverUrl, cwd);
  if (!context.ok) return context.result;
  const result = await httpPut(context.url, '/api/skill-targets', { folderAction: action });
  if (!result.ok) return textResult(`Error: ${result.error}`, true);
  const folder = (
    result as { folder?: { moved?: string[]; dropped?: string[]; linked?: string[] } }
  ).folder ?? { moved: [], dropped: [], linked: [] };
  const summary =
    action.action === 'link'
      ? `Linked ${action.root} → ${action.target}: moved ${folder.moved?.length ?? 0} skill(s), dropped ${folder.dropped?.length ?? 0} duplicate(s). Its agent now reads everything placed in ${action.target}.`
      : action.action === 'unlink'
        ? `Unlinked ${action.root} — it is a real directory again with per-skill symlinks (nothing stopped working).`
        : `Declared ${action.root} as a custom skills root — it is now an install and link target.`;
  return textPlusStructured(summary, {
    folder: {
      moved: folder.moved ?? [],
      dropped: folder.dropped ?? [],
      linked: folder.linked ?? [],
    },
  });
}

interface InstallDeps {
  serverUrl: ServerUrlOrResolver;
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
  identityRef?: { current: AgentIdentity };
  localApi?: LocalApiDispatch;
}

export function register(server: ServerInstance, deps: InstallDeps): void {
  server.registerTool(
    'install',
    {
      description: DESCRIPTION,
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe(`${SKILL_NAME_DESCRIBE} Required unless \`skillFolders\` is given.`),
        skillFolders: SkillFolderActionMcpSchema.optional().describe(
          'Folder-level skill-topology verb (link / unlink / add-root). Lives here rather than on `config` so that `config` stays a pure read and hosts can auto-approve it. Run alone, without `name`.',
        ),
        add: z
          .array(SkillLocationIdSchema)
          .optional()
          .describe(
            'Locations to ADD the skill to — everything else untouched. Editor ids (`claude`…`pi`), `agents` (the hub), or a custom root path (".team/skills").',
          ),
        remove: z
          .array(SkillLocationIdSchema)
          .optional()
          .describe(
            'Locations to REMOVE the skill from (lossless only; a hand-edited fork is refused). An editor reading via a folder alias is unfollowed from the shared root minus this skill (it keeps the rest). The SOURCE cannot be removed — its folder IS the skill; use `source` to move it or `delete` to remove the skill.',
          ),
        convert: z
          .array(SkillLocationIdSchema)
          .optional()
          .describe(
            'Existing locations to change the FORM of, leaving their membership alone. Requires `mode`. Pass every location to make them uniform. Lossless both ways; a hand-edited copy is refused rather than overwritten.',
          ),
        mode: z
          .enum(['copy', 'link'])
          .optional()
          .describe(
            'The form for the locations THIS call touches — the ones in `add`, or the ones in `convert`. "link": a pointer to the source, so nothing can drift. "copy": an independent folder, auto-refreshed from the source until hand-edited. Omit on `add` to follow the form the skill already uses. This does not change locations the call does not name, and sets no skill-wide default.',
          ),
        source: SkillLocationIdSchema.optional().describe(
          "Move the skill's REAL folder to this location (the old source becomes a symlink — never a removal). Run alone, not combined with add/remove.",
        ),
        scope: SkillScopeArg.optional(),
        summary: summaryArgSchema,
        cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
      },
      outputSchema: outputSchemaWithText({
        name: z.string().optional().describe('Managed skill name installed or uninstalled.'),
        hosts: z
          .array(z.string())
          .optional()
          .describe(
            'Every location holding the skill after the operation, SOURCE first (editor ids, `agents`, custom root paths). Never empty — the source folder is the skill.',
          ),
        sourceMovedTo: z
          .string()
          .optional()
          .describe('Set when `source` relocated the real folder — its new bundle dir.'),
        converted: z
          .array(z.string())
          .optional()
          .describe('Locations whose form `convert` changed. Membership is unchanged.'),
        warningCodes: z
          .array(z.enum(SKILL_INSTALL_WARNING_CODES))
          .optional()
          .describe(
            'Machine-readable codes aligned 1:1 with `warnings` (`warnings[i]` is the display text for `warningCodes[i]`) — switch on these, never on the English. `no-targets`: nothing was projected, no editor is configured for this project. `scripts-present`: the skill ships executable `scripts/` (projected, never auto-run). `no-description`: installed, but its `description` is empty, so agents cannot route to it. `name-conflict`: a DIFFERENT skill already holds that name at a location. `place-path-invalid`: a named location is not a placeable root. `place-fork-refused`: a hand-edited copy was left alone rather than deleted. `skill-fork-name-unpatched`: a fork rename moved the folder but could not rewrite `name` in its SKILL.md.',
          ),
        scripts: z
          .boolean()
          .optional()
          .describe('true when the skill ships executable `scripts/` (projected, never auto-run).'),
        warnings: z
          .array(z.string())
          .optional()
          .describe('Non-fatal install/uninstall warnings from target projection.'),
        folder: z
          .object({
            moved: z.array(z.string()).describe('Skill bundles moved into the target root.'),
            dropped: z
              .array(z.string())
              .describe('Same-content duplicates dropped during the merge.'),
            linked: z.array(z.string()).describe('Folders now linked (or unlinked/declared).'),
          })
          .optional()
          .describe('Present after a `skillFolders` verb: what the folder operation did.'),
      }),
    },
    async (args: {
      name?: string;
      skillFolders?: SkillFolderActionMcp;
      add?: SkillLocationId[];
      remove?: SkillLocationId[];
      convert?: SkillLocationId[];
      mode?: 'copy' | 'link';
      source?: SkillLocationId;
      scope?: SkillScope;
      summary?: string;
      cwd?: string;
    }) => {
      if (args.skillFolders !== undefined) {
        if (args.name !== undefined) {
          return textResult(
            'Error: `skillFolders` operates on folders, not one skill — do not combine with `name`.',
            true,
          );
        }
        return await runSkillFolderAction(deps, args.skillFolders, args.cwd);
      }
      if (args.name === undefined) {
        return textResult('Error: `name` is required (or pass `skillFolders`).', true);
      }
      const resolved = resolveSkillName(args.name);
      if (!resolved.ok) return textResult(`Error: ${resolved.error}`, true);
      const context = await requireProjectServer(
        deps.resolveCwd,
        deps.config,
        deps.serverUrl,
        args.cwd,
      );
      if (!context.ok) return context.result;

      if (args.convert !== undefined && args.mode === undefined) {
        return textResult(
          'Error: `convert` needs `mode` — the form to convert those locations to.',
          true,
        );
      }

      // Converting is per-location, the same verb the app offers: one request
      // per location, in sequence. It is never a side effect of installing, and
      // it records no skill-wide default — a later `add` still follows the form
      // the skill already uses.
      for (const target of args.convert ?? []) {
        const converted = await httpPost(
          apiTarget(context.url, deps.localApi),
          '/api/skill/install',
          {
            ...(args.scope !== undefined ? { scope: args.scope } : {}),
            name: args.name,
            convert: { target, mode: args.mode },
            ...(args.summary !== undefined ? { summary: args.summary } : {}),
            ...agentIdentityFields(deps.identityRef?.current),
          },
        );
        if (!converted.ok) return textResult(errorTextWithDetail(converted), true);
      }
      // A pure convert changes no membership, so there is no location math to
      // run and nothing further to report.
      if (
        args.convert !== undefined &&
        args.add === undefined &&
        args.remove === undefined &&
        args.source === undefined
      ) {
        const form = args.mode === 'link' ? 'symlinks to the source' : 'independent copies';
        return textPlusStructured(
          `Converted ${args.convert.length} location(s) of skill "${args.name}" to ${form}.`,
          { name: args.name, converted: [...args.convert] },
        );
      }

      // All location math lives server-side (atomic read-modify-write) — the
      // tool passes the additive args through verbatim.
      //
      // `mode` is deliberately NOT forwarded here. The endpoint's `mode` applies
      // to the whole resulting location set, so `add: ['cursor'], mode: 'copy'`
      // would also convert the claude and codex symlinks the caller never named.
      // This tool's `mode` is scoped to `add`, so it is applied below as a
      // per-location convert — the same verb the app uses for one row.
      const result = await httpPost(apiTarget(context.url, deps.localApi), '/api/skill/install', {
        ...(args.scope !== undefined ? { scope: args.scope } : {}),
        name: args.name,
        ...(args.add !== undefined ? { add: args.add } : {}),
        ...(args.remove !== undefined ? { remove: args.remove } : {}),
        ...(args.source !== undefined ? { source: args.source } : {}),
        ...(args.summary !== undefined ? { summary: args.summary } : {}),
        ...agentIdentityFields(deps.identityRef?.current),
      });
      if (!result.ok) return textResult(errorTextWithDetail(result), true);

      // Shape ONLY the locations just added. An already-correct form converges
      // server-side, so re-stating it is a no-op rather than a rewrite.
      for (const target of args.mode !== undefined ? (args.add ?? []) : []) {
        const shaped = await httpPost(apiTarget(context.url, deps.localApi), '/api/skill/install', {
          ...(args.scope !== undefined ? { scope: args.scope } : {}),
          name: args.name,
          convert: { target, mode: args.mode },
          ...agentIdentityFields(deps.identityRef?.current),
        });
        if (!shaped.ok) {
          return textResult(
            `Added ${args.add?.join(', ')} to "${args.name}", but setting ${target} to ${args.mode} failed. ${errorTextWithDetail(shaped)}`,
            true,
          );
        }
      }

      const hosts = Array.isArray(result.hosts) ? (result.hosts as string[]) : [];
      const scripts = result.scripts === true;
      const warnings = Array.isArray(result.warnings) ? (result.warnings as string[]) : [];
      // A bulk add/remove skips the locations it cannot do and succeeds on the
      // rest, so the codes are the only way to tell WHICH kind of failure hit
      // WHICH location — the single-shot verbs return a status instead.
      const warningCodes = Array.isArray(result.warningCodes)
        ? (result.warningCodes as string[])
        : [];
      const sourceMovedTo =
        typeof result.sourceMovedTo === 'string' ? result.sourceMovedTo : undefined;
      const lines = [
        sourceMovedTo !== undefined
          ? `Moved skill "${args.name}"'s source folder to ${sourceMovedTo}; other locations now link to it.`
          : `Skill "${args.name}" now lives at: ${hosts.join(', ') || '(its source folder)'}.`,
        ...warnings,
      ];
      return textPlusStructured(lines.join('\n'), {
        name: args.name,
        hosts,
        scripts,
        warnings,
        ...(warningCodes.length > 0 ? { warningCodes } : {}),
        ...(sourceMovedTo !== undefined ? { sourceMovedTo } : {}),
      });
    },
  );
}
