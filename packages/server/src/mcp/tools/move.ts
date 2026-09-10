import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  MANAGED_ARTIFACT_SCOPES,
  SKILL_MOVE_STATE_CODES,
  SKILL_RETENTION_LEDGER_CODES,
  SKILL_SOURCE_STATE_CODES,
} from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import { SUPPORTED_DOC_EXTENSIONS } from '../../doc-extensions.ts';
import type { AgentIdentity } from '../agent-identity.ts';
import { resolveWithinRoot } from './path-safety.ts';
import { type PreviewUrlSource, resolvePreviewUrlForTool } from './preview-url.ts';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  agentIdentityFields,
  HOCUSPOCUS_NOT_RUNNING_ERROR,
  httpPost,
  looseObjectArray,
  normalizeDocName,
  outputSchemaWithText,
  parseRenameCollidingPairs,
  previewUrlSourceField,
  previousPreviewUrlField,
  type RenameCollisionPair,
  ROUTED_CWD_DESCRIPTION,
  resolveProjectServerContext,
  summaryArgSchema,
  summaryOutputSchema,
  textPlusStructured,
  textResult,
} from './shared.ts';
import { moveSkill, moveSkillCrossScope, type SkillScope } from './skill-target.ts';
import { resolveTemplatePath } from './verb-schemas.ts';

export const CROSS_LEVEL_TRANSFER_CLAUSE =
  'history does not transfer; the editor locations the destination level can host are re-projected there, while everything else — the `agents` hub, custom roots, and any editor with no skills root at that level — is removed at the source and not re-created at the destination. Re-add the ones the destination level can place with `install` (every removed location comes back as `droppedLocations`) — but only on a success: on a reported failure `droppedLocations` instead lists what this call had already removed at the source, so installing those at the destination spreads a retained copy rather than restoring anything (see `droppedLocations` for the per-`moveState` split).';

export const DROPPED_LOCATIONS_DESCRIPTION =
  'Skill cross-level move only: locations the skill occupied at the source that the move did not automatically re-project at the destination — the `agents` hub, custom roots, and any editor with no skills root at that level — as `install` location ids. On a SUCCESS they were removed at the source and not re-created at the destination, and the ones the destination level can place (the `agents` hub and custom roots) go back with `install` as `add`, together with `scope` set to the DESTINATION level; an editor with no skills root there cannot be placed at all — `install` accepts its id and projects nothing, so the move\'s own success text names the equivalent (an editor that reads the `agents` hub at that level takes `add: ["agents"]` instead) or states that no destination-level placement exists. Custom roots resolve against that level\'s base — your home directory at the Global level, the project directory at the Project level — not wherever the root lived before the move. On a FAILURE this is instead the set of source-side placements this call had already removed, and whether the skill moved is what `moveState` says: on `nothing-written`, `destination-removed`, `destination-stray` and the two retained states the source is still there, so do not pass these to `install` at the DESTINATION level — re-add them at the SOURCE level, and retry the move only once that state is resolved. On `destination-unreadable` and `partially-applied` the source removal may already have run, so inspect both locations before re-adding anywhere.';

const DESCRIPTION = [
  '[Requires: Hocuspocus server] Move or rename a document, folder, or asset through the managed flow at `POST /api/rename-path`. Works for all three — the tool probes the content directory to decide. Inbound wiki-links plus supported inline Markdown links are rewritten across affected docs; renamed assets are reported.',
  '',
  '**Parameters:**',
  '- `from` — Current path. Doc: docName (trailing `.md`/`.mdx` stripped). Folder: relative path, no leading/trailing slash. Asset: the file path incl. extension.',
  '- `to` — New path. Same shape as `from`.',
  '- `template` — Move/rename a TEMPLATE instead of a doc/folder/asset: `{ from: "<folder>/<name>", to: "<folder>/<name>" }` (nested — a flat path cannot disambiguate a template under `.ok/templates/` from a same-named doc). Mutually exclusive with flat `from`/`to`. Inherited templates are not moved (move the local copy / the owning folder); templates carry no inbound links, so nothing is rewritten.',
  `- \`skill\` — Move/rename a SKILL: \`{ from: "<name>", to: "<name>", scope?, toScope? }\` (nested). Within one level (omit \`toScope\`, or \`toScope\` === \`scope\`): renames the skill folder and keeps the SKILL.md \`name\` in sync. ACROSS levels (\`toScope\` differs from \`scope\`): moves the skill between the Project level (this KB) and the Global level (your user home); ${CROSS_LEVEL_TRANSFER_CLAUSE} Mutually exclusive with flat \`from\`/\`to\`.`,
  '- `summary` — Optional one-line user-outcome (≤80 chars). If omitted, defaults to "Renamed X → Y". Avoid secrets or PII — persisted to git history.',
  '',
  `**Errors:** 400 — invalid path / excluded by \`.gitignore\`/\`.okignore\`; 404 — source does not exist; 409 — destination already exists (\`colliding[]\` returned); 500 — a cross-level skill move can leave partial state (source, destination, or both), so it is not a safe blind retry. Every cross-level skill-move failure this handler reports carries a \`moveState\` code whatever its status, and the two refusals that turn on a retained destination copy arrive as 409, not 500 — \`destination-retained-blocking\`, and the \`nothing-written\` collision that carries a \`retentionLedger\` — so read \`moveState\` before retrying regardless of status. The one exception is a response whose \`moveState\`/\`sourceState\`/\`retentionLedger\` triple this build cannot recognise as consistent: all three are withheld and the text says so instead — "The server returned an unrecognized or inconsistent move outcome. Do not remove either copy before comparing the source and destination."`,
].join('\n');

interface RenameMapping {
  fromDocName: string;
  toDocName: string;
}
interface RenameRewrittenDoc {
  docName: string;
  rewrites: number;
}
interface RenamedAsset {
  fromPath: string;
  toPath: string;
}

export interface MoveDeps {
  serverUrl: ServerUrlOrResolver;
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
  identityRef?: { current: AgentIdentity };
}

interface MoveArgs {
  from?: string;
  to?: string;
  template?: { from: string; to: string };
  skill?: { from: string; to: string; scope?: SkillScope; toScope?: SkillScope };
  summary?: string;
  cwd?: string;
}

function parseRenameMappings(value: unknown): RenameMapping[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { fromDocName, toDocName } = entry as Record<string, unknown>;
    return typeof fromDocName === 'string' && typeof toDocName === 'string'
      ? [{ fromDocName, toDocName }]
      : [];
  });
}

function parseRewrittenDocs(value: unknown): RenameRewrittenDoc[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { docName, rewrites } = entry as Record<string, unknown>;
    return typeof docName === 'string' && typeof rewrites === 'number'
      ? [{ docName, rewrites }]
      : [];
  });
}

function parseRenamedAssets(value: unknown): RenamedAsset[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { fromPath, toPath } = entry as Record<string, unknown>;
    return typeof fromPath === 'string' && typeof toPath === 'string' ? [{ fromPath, toPath }] : [];
  });
}

function isValidFolderPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path.startsWith('/') || path.endsWith('/')) return false;
  if (path.includes('..')) return false;
  return true;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function resolveMoveKind(contentDir: string, from: string): 'file' | 'folder' | 'asset' | null {
  const contained = resolveWithinRoot(contentDir, from);
  if (!contained.ok) return null;
  const absBase = contained.abs;
  if (existsSync(absBase)) {
    try {
      const stat = statSync(absBase);
      if (stat.isDirectory()) return 'folder';
      if (stat.isFile()) {
        return absBase.endsWith('.md') || absBase.endsWith('.mdx') ? 'file' : 'asset';
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') return 'file';
    }
  }
  for (const ext of SUPPORTED_DOC_EXTENSIONS) {
    if (existsSync(`${absBase}${ext}`)) return 'file';
  }
  return null;
}

export function register(server: ServerInstance, deps: MoveDeps): void {
  server.registerTool(
    'move',
    {
      description: DESCRIPTION,
      inputSchema: {
        from: z
          .string()
          .optional()
          .describe('Current path of a document, folder, or asset (auto-detected).'),
        to: z
          .string()
          .optional()
          .describe('New path. All inbound wiki-links + inline links are rewritten automatically.'),
        template: z
          .object({ from: z.string(), to: z.string() })
          .optional()
          .describe(
            'Move/rename a TEMPLATE instead: `{ from: "<folder>/<name>", to: "<folder>/<name>" }`. Nested because a flat path cannot disambiguate a template under `.ok/templates/` from a same-named doc. Mutually exclusive with flat `from`/`to`.',
          ),
        skill: z
          .object({
            from: z.string(),
            to: z.string(),
            scope: z
              .enum(MANAGED_ARTIFACT_SCOPES)
              .optional()
              .describe(
                'Source level (default "project"). "project" = this KB; "global" = your user home.',
              ),
            toScope: z
              .enum(MANAGED_ARTIFACT_SCOPES)
              .optional()
              .describe(
                `Destination level. Omit (or set equal to \`scope\`) for a within-level rename. Set to the OTHER level to move the skill across levels (project↔global): ${CROSS_LEVEL_TRANSFER_CLAUSE}`,
              ),
          })
          .optional()
          .describe(
            `Move/rename a SKILL: \`{ from: "<name>", to: "<name>", scope?, toScope? }\`. Within one level: renames the skill folder and keeps SKILL.md \`name\` in sync. Across levels (\`toScope\` differs from \`scope\`): moves between Project and Global; ${CROSS_LEVEL_TRANSFER_CLAUSE} Mutually exclusive with flat \`from\`/\`to\`.`,
          ),
        summary: summaryArgSchema.describe(
          'Optional one-line user-outcome (≤80 chars). Defaults to "Renamed X → Y". Persisted to git history.',
        ),
        cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
      },
      outputSchema: outputSchemaWithText({
        ok: z.boolean().describe('Whether the move succeeded.'),
        kind: z
          .enum(['file', 'folder', 'asset', 'template', 'skill'])
          .optional()
          .describe(
            'What was moved (`file`/`folder`/`asset` auto-detected from `from`; `template`/`skill` when that nested target was used).',
          ),
        committed: z
          .boolean()
          .optional()
          .describe(
            'Template move, or a skill move WITHIN one level: `true` = tracked `git mv` (history preserved), `false` = plain disk rename. Always `false` on a cross-level skill move — history does not transfer.',
          ),
        renamed: z
          .array(
            z.object({
              fromDocName: z.string(),
              toDocName: z.string(),
            }),
          )
          .optional()
          .describe('docName remappings performed.'),
        rewrittenDocs: looseObjectArray
          .optional()
          .describe('Docs whose inbound links were rewritten.'),
        renamedAssets: looseObjectArray
          .optional()
          .describe('Referenced assets that were moved alongside.'),
        previewUrls: z
          .record(z.string(), z.string())
          .optional()
          .describe('Route-only preview URL per new docName.'),
        previewUrlSource: previewUrlSourceField,
        previousPreviewUrl: previousPreviewUrlField,
        summary: summaryOutputSchema.optional(),
        error: z.string().optional().describe('Present when `ok` is false.'),
        colliding: looseObjectArray
          .optional()
          .describe('On a 409 collision: the conflicting from→to pairs.'),
        crossScope: z
          .boolean()
          .optional()
          .describe(
            `Skill cross-level move only: \`true\` when the skill was moved between the Project and Global levels. ${CROSS_LEVEL_TRANSFER_CLAUSE}`,
          ),
        droppedLocations: z.array(z.string()).optional().describe(DROPPED_LOCATIONS_DESCRIPTION),
        moveState: z
          .enum(SKILL_MOVE_STATE_CODES)
          .optional()
          .describe(
            'Skill cross-level move failures only: what is on disk, so you can decide whether to retry. Present on every cross-level skill-move failure this handler reports whose triple this build recognises as consistent, at whatever status it reports it. Do not read it as a 500-only concern: `destination-retained-blocking`, and the `nothing-written` collision that carries a `retentionLedger`, both arrive as 409, while `destination-retained` is the 500. Withheld here, together with `sourceState` and `retentionLedger`, when the three do not form a triple this build recognises as consistent; that case reports "The server returned an unrecognized or inconsistent move outcome. Do not remove either copy before comparing the source and destination." in the text instead, and is to be treated as unknown state, not as an ordinary collision. A request rejected before it runs — wrong method, an oversized or unreadable body, a timeout, or a body that fails schema validation against a differently-versioned server — carries none, as does a transport failure that never reached the server. Treat an absent `moveState` on a failure as unknown state, not as a state that cannot occur. `nothing-written` = THIS call wrote nothing, so it changed neither location; it says nothing about damage an earlier call left behind. Safe to retry once the refusal is addressed. `destination-removed` = the destination copy failed and was cleaned up; the source is intact; safe to retry. `destination-stray` = the destination copy failed and cleanup also failed; the source is intact but a stray copy remains; remove it before retrying. `destination-retained` = source removal failed and the complete destination copy was deliberately kept; a retry will collide with it, so read `sourceState` first. `destination-retained-blocking` = this call refused because the destination is a copy an EARLIER failed move retained; read `sourceState` before touching it — on `intact` it is a redundant duplicate and removing it unblocks the retry, otherwise do not delete it before reconciling it against the source, since it may hold the only copy of files that failed removal already deleted. `destination-unreadable` = the source was removed and the destination is not readable; do not retry, recover from history or a backup. `partially-applied` = an unexpected failure after the copy began left an indeterminate state; inspect both locations before doing anything.',
          ),
        sourceState: z
          .enum(SKILL_SOURCE_STATE_CODES)
          .optional()
          .describe(
            'Skill cross-level move failures only: accompanies both states that report a retained destination — `moveState: destination-retained` (this call kept it) and `moveState: destination-retained-blocking` (an earlier call did, and this retry was refused) — and reports what the SOURCE looked like when its removal failed. Every value is an as-of-then observation: on `destination-retained` this call took it, and on `destination-retained-blocking` it is replayed out of the record the earlier call wrote, so nothing has re-read the source since. `intact` = the source matched the content hash recorded before the move, so the retained destination copy is a redundant duplicate; it is safe to remove before retrying, and removing it is what unblocks the retry. `lossy` = the source no longer matched that hash, so it is partially removed; do not remove either location before recovering the missing source files from the retained copy. `unknown` = the source could not be verified against a known content hash, so whether files were lost is undetermined; do not remove either location before comparing them.',
          ),
        retentionLedger: z
          .enum(SKILL_RETENTION_LEDGER_CODES)
          .optional()
          .describe(
            'Skill cross-level move failures only: present when this call could not determine whether the occupant at the destination is a copy an earlier failed move retained. `unreadable` = the retained-destination ledger itself could not be read. `occupant-unverifiable` = the directory at the destination could not be verified against the copy this server recorded — either it could not be read at all, or it carries no SKILL.md to compare — so this server could not confirm whether it is the copy an earlier failed move retained. It accompanies `moveState: nothing-written` — that code is still true of this call, which wrote nothing — but do NOT read it as an ordinary collision: treat the occupant the way you would a `sourceState` other than `intact` and compare it against the source before deleting it. A triple this MCP process cannot recognise as consistent is withheld whole — `moveState`, `sourceState` and `retentionLedger` together — so once any server on this connection can emit this field, treat an absent `retentionLedger` on a `nothing-written` refusal that reports a destination collision (`urn:ok:error:doc-already-exists`) as unverified rather than as an unconditionally safe retry. The other `nothing-written` refusals — invalid arguments, no project root, no usable skill home — never reached a destination occupant to verify, so they stay safe to retry once the refusal is addressed.',
          ),
      }),
    },
    async (args: MoveArgs) => {
      const context = await resolveProjectServerContext(
        deps.resolveCwd,
        deps.config,
        deps.serverUrl,
        args.cwd,
      );
      if (!context.ok) return textResult(`Error: ${context.error}`, true);
      const { cwd, config, url } = context;
      if (!url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);

      if (args.template !== undefined) {
        if (args.from !== undefined || args.to !== undefined) {
          return textResult(
            'Error: pass EITHER flat `from`/`to` (document/folder/asset) OR `template: { from, to }` — not both.',
            true,
          );
        }
        const rf = resolveTemplatePath(args.template.from);
        if (!rf.ok) return textResult(`Error: ${rf.error}`, true);
        const rt = resolveTemplatePath(args.template.to);
        if (!rt.ok) return textResult(`Error: ${rt.error}`, true);
        const result = await httpPost(url, '/api/template', {
          fromFolder: rf.folder,
          fromName: rf.name,
          toFolder: rt.folder,
          toName: rt.name,
          ...(args.summary !== undefined ? { summary: args.summary } : {}),
          ...agentIdentityFields(deps.identityRef?.current),
        });
        if (!result.ok) {
          const error = typeof result.error === 'string' ? result.error : 'Template move failed';
          return textPlusStructured(
            `Error: ${error}`,
            { ok: false, kind: 'template', error },
            true,
          );
        }
        const committed = result.committed === true;
        const fromLabel = typeof result.from === 'string' ? result.from : args.template.from;
        const toLabel = typeof result.to === 'string' ? result.to : args.template.to;
        return textPlusStructured(
          `${committed ? 'Renamed' : 'Moved'} template ${fromLabel} → ${toLabel}.${committed ? '' : ' (Untracked `.ok/` — moved on disk without git history.)'}`,
          { ok: true, kind: 'template', committed },
        );
      }

      if (args.skill !== undefined) {
        if (args.from !== undefined || args.to !== undefined) {
          return textResult(
            'Error: pass EITHER flat `from`/`to` (document/folder/asset) OR `skill: { from, to }` — not both.',
            true,
          );
        }
        const fromScope = args.skill.scope ?? 'project';
        if (args.skill.toScope !== undefined && args.skill.toScope !== fromScope) {
          return moveSkillCrossScope(url, {
            fromScope,
            toScope: args.skill.toScope,
            fromName: args.skill.from,
            toName: args.skill.to,
            summary: args.summary,
            identity: deps.identityRef?.current,
          });
        }
        return moveSkill(url, {
          fromName: args.skill.from,
          toName: args.skill.to,
          scope: args.skill.scope,
          summary: args.summary,
          identity: deps.identityRef?.current,
        });
      }

      if (args.from === undefined || args.to === undefined) {
        return textResult(
          'Error: provide both `from` and `to` (or use `template: { from, to }` to move a template, or `skill: { from, to }` to move/rename a skill).',
          true,
        );
      }

      const contentDir = join(cwd, config.content.dir);
      const kind = resolveMoveKind(contentDir, args.from);
      if (kind === null) {
        const split = resolveTemplatePath(args.from);
        if (
          split.ok &&
          existsSync(join(contentDir, split.folder, '.ok', 'templates', `${split.name}.md`))
        ) {
          return textResult(
            `Error: \`${args.from}\` is a template, not a doc/folder/asset. Move it with \`move({ template: { from: "${args.from}", to: "<folder>/<newName>" } })\`.`,
            true,
          );
        }
        return textResult(
          `Error: \`${args.from}\` does not exist as a doc, folder, or asset under the content directory.`,
          true,
        );
      }

      let fromPath = args.from;
      let toPath = args.to;
      if (kind === 'file') {
        const nf = normalizeDocName(args.from);
        if (!nf.ok) return textResult(nf.error, true);
        const nt = normalizeDocName(args.to);
        if (!nt.ok) return textResult(nt.error, true);
        fromPath = nf.docName;
        toPath = nt.docName;
      } else if (kind === 'folder') {
        if (!isValidFolderPath(args.from) || !isValidFolderPath(args.to)) {
          return textResult(
            'Error: folder `from`/`to` must be relative paths with no leading/trailing slash.',
            true,
          );
        }
      }

      const result = await httpPost(url, '/api/rename-path', {
        kind,
        fromPath,
        toPath,
        ...(args.summary !== undefined ? { summary: args.summary } : {}),
        ...agentIdentityFields(deps.identityRef?.current),
      });
      if (!result.ok) {
        const error = result.error as string;
        const colliding = parseRenameCollidingPairs(result.colliding);
        const structured: { ok: false; error: string; colliding?: RenameCollisionPair[] } = {
          ok: false,
          error,
          ...(colliding.length > 0 ? { colliding } : {}),
        };
        return textPlusStructured(`Error: ${error}`, structured, true);
      }

      const renamed = parseRenameMappings(result.renamed);
      const rewrittenDocs = parseRewrittenDocs(result.rewrittenDocs);
      const renamedAssets = parseRenamedAssets(result.renamedAssets);

      const previewDeps = { config: deps.config, resolveCwd: deps.resolveCwd };
      const previewUrls: Record<string, string> = {};
      let previewUrlSource: PreviewUrlSource | undefined;
      let previousPreviewUrl: string | undefined;
      if (kind === 'file') {
        const newPreview = await resolvePreviewUrlForTool(toPath, previewDeps, cwd);
        const oldPreview = await resolvePreviewUrlForTool(fromPath, previewDeps, cwd);
        if (newPreview) {
          previewUrls[toPath] = newPreview.url;
          previewUrlSource = newPreview.source;
        }
        if (oldPreview) previousPreviewUrl = oldPreview.url;
      } else if (kind === 'folder') {
        for (const { toDocName } of renamed) {
          const preview = await resolvePreviewUrlForTool(toDocName, previewDeps, cwd);
          if (preview) {
            previewUrls[toDocName] = preview.url;
            previewUrlSource ??= preview.source;
          }
        }
      }

      const summaryResult =
        result.summary && typeof result.summary === 'object'
          ? (result.summary as { value: string; truncatedFrom?: number; hint?: string })
          : undefined;
      const summaryHint = typeof summaryResult?.hint === 'string' ? summaryResult.hint : undefined;

      const textLines: string[] = [];
      if (kind === 'asset') {
        textLines.push(`Moved asset ${fromPath} → ${toPath}.`);
      } else if (kind === 'folder') {
        textLines.push(
          renamed.length === 0
            ? `No managed docs under ${args.from}/ — nothing to rename. Empty folders are not tracked.`
            : `Renamed folder ${args.from}/ → ${args.to}/ (${renamed.length} doc${renamed.length === 1 ? '' : 's'}, ${rewrittenDocs.length} rewrite${rewrittenDocs.length === 1 ? '' : 's'}).`,
        );
      } else {
        const renamedSummary =
          renamed
            .map(({ fromDocName, toDocName }) => `${fromDocName} -> ${toDocName}`)
            .join(', ') || `${fromPath} -> ${toPath}`;
        const rewrittenSummary =
          rewrittenDocs.length === 0
            ? 'No inbound links required updates.'
            : `Rewrote ${rewrittenDocs.length} ${pluralize(rewrittenDocs.length, 'document')}.`;
        textLines.push(`Renamed ${renamedSummary}. ${rewrittenSummary}`);
      }
      if (renamedAssets.length > 0) {
        textLines.push(
          `Moved ${renamedAssets.length} referenced ${pluralize(renamedAssets.length, 'asset')}.`,
        );
      }
      if (summaryHint) textLines.push(summaryHint);

      return textPlusStructured(textLines.join('\n'), {
        ok: true,
        kind,
        renamed,
        rewrittenDocs,
        ...(renamedAssets.length > 0 ? { renamedAssets } : {}),
        ...(Object.keys(previewUrls).length > 0 ? { previewUrls } : {}),
        ...(previewUrlSource ? { previewUrlSource } : {}),
        ...(previousPreviewUrl ? { previousPreviewUrl } : {}),
        ...(summaryResult ? { summary: summaryResult } : {}),
      });
    },
  );
}
