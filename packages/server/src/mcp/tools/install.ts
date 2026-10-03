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
  alignWarningCodes,
  apiTarget,
  errorTextWithDetail,
  httpPost,
  httpPut,
  INSTALL_WARNING_CODE_GLOSS,
  outputSchemaWithText,
  ROUTED_CWD_DESCRIPTION,
  requireProjectServer,
  summaryArgSchema,
  textPlusStructured,
  textResult,
  WARNING_CODES_CONTRACT,
  WARNINGS_FIELD_CONTRACT,
} from './shared.ts';
import { resolveSkillName, SKILL_NAME_DESCRIBE, SkillScopeArg } from './verb-schemas.ts';

const KNOWN_INSTALL_CODES: ReadonlySet<string> = new Set(SKILL_INSTALL_WARNING_CODES);

const DESCRIPTION = [
  'Manage where a SKILL is available: `{name, add?, remove?, convert?, mode?, source?, scope?}` or `{skillFolders: {...}}` alone. Requires the Hocuspocus server. One real source folder plus managed copies/symlinks; the source still loads with no extra locations. Use delete to remove the skill everywhere.',
  "name is the bundle identity: lowercase letters/digits/hyphens, ≤64 chars. Locations: claude/cursor/codex/copilot/opencode/pi, agents (.agents/skills), or custom root containing '/' such as .team/skills. Custom roots are project-relative, home-relative at global scope. scope: project (default, shared via git) or global (user-wide).",
  'add/remove change membership; omitting both installs to configured editors. remove cannot remove the source; folder aliases unfollow minus this skill and keep others. Differing copies are preserved; editor removal may succeed and leave them in place.',
  'mode: link = live symlink for source updates (copy where the OS refuses symlinks); copy = separate folder, refreshed on watcher/startup sync while unedited. Hand-edited copies fork; differing copies are preserved and cannot be converted. Requires add or convert; affects named locations only, no skill-wide default. Omit mode on add to inherit form. convert requires mode and changes form without membership; name all locations for uniformity.',
  'source moves the real folder; its old location becomes a symlink. Run alone, not with add/remove. Source SKILL.md with conflict markers, invalid/missing frontmatter, XML in name/description or reserved open-knowledge* names is refused before projection.',
  "skillFolders runs alone without name. link: {action:'link', scope, root, target}; target required, merge then symlink root; equal entries deduplicate, differing skills abort, interrupted merges can rerun. unlink: {action:'unlink', scope, root, exclude?}; makes a real directory of per-skill symlinks, excluding named skills and retaining others. add-root: {action:'add-root', scope, root}; declares a custom root for install/link.",
].join('\n');

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
            'Locations to REMOVE the skill from; differing copies are preserved and may remain after success. An editor reading via a folder alias is unfollowed from the shared root minus this skill (it keeps the rest). The SOURCE cannot be removed — its folder IS the skill; use `source` to move it or `delete` to remove the skill.',
          ),
        convert: z
          .array(SkillLocationIdSchema)
          .optional()
          .describe(
            'Existing locations to change the FORM of, leaving their membership alone. Requires `mode`. Pass every location to make them uniform. Lossless both ways; a differing copy is refused rather than overwritten.',
          ),
        mode: z
          .enum(['copy', 'link'])
          .optional()
          .describe(
            'Form for locations in `add` or `convert`. "link": live pointer to the source. "copy": independent folder, refreshed on watcher/startup sync while unedited; a hand edit forks it. Omit on `add` to inherit the existing form. Other locations stay unchanged; no skill-wide default. Requires `add` or `convert`; `mode` alone is refused.',
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
          .describe(`${WARNING_CODES_CONTRACT} ${INSTALL_WARNING_CODE_GLOSS}`),
        scripts: z
          .boolean()
          .optional()
          .describe('true when the skill ships executable `scripts/` (projected, never auto-run).'),
        warnings: z
          .array(z.string())
          .optional()
          .describe(
            `Non-fatal install/uninstall warnings from target projection. ${WARNINGS_FIELD_CONTRACT}`,
          ),
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
      if (args.convert !== undefined && args.mode === undefined) {
        return textResult(
          'Error: `convert` needs `mode` — the form to convert those locations to.',
          true,
        );
      }
      if (
        args.mode !== undefined &&
        (args.add?.length ?? 0) === 0 &&
        (args.convert?.length ?? 0) === 0
      ) {
        return textResult(
          'Error: `mode` needs `add` or `convert` — name the locations whose form should change.',
          true,
        );
      }
      const context = await requireProjectServer(
        deps.resolveCwd,
        deps.config,
        deps.serverUrl,
        args.cwd,
      );
      if (!context.ok) return context.result;

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
      const aligned = alignWarningCodes(result.warnings, result.warningCodes, KNOWN_INSTALL_CODES);
      const sourceMovedTo =
        typeof result.sourceMovedTo === 'string' ? result.sourceMovedTo : undefined;
      const lines = [
        sourceMovedTo !== undefined
          ? `Moved skill "${args.name}"'s source folder to ${sourceMovedTo}; other locations now link to it.`
          : `Skill "${args.name}" now lives at: ${hosts.join(', ') || '(its source folder)'}.`,
        ...aligned.warnings,
      ];
      return textPlusStructured(lines.join('\n'), {
        name: args.name,
        hosts,
        scripts,
        warnings: aligned.warnings,
        ...(aligned.warningCodes ? { warningCodes: aligned.warningCodes } : {}),
        ...(sourceMovedTo !== undefined ? { sourceMovedTo } : {}),
      });
    },
  );
}
