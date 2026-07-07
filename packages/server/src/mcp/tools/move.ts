/**
 * `move` MCP tool — move or rename a document, folder, or asset via
 * `POST /api/rename-path`. The tool probes the content directory to decide
 * whether `from` is a doc (`.md`/`.mdx`), a folder, or an asset (any other
 * file), then sets `kind` accordingly. Inbound wiki-links + inline links are
 * rewritten so nothing breaks.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MANAGED_ARTIFACT_SCOPES } from '@inkeep/open-knowledge-core';
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

const DESCRIPTION = [
  '[Requires: Hocuspocus server] Move or rename a document, folder, or asset through the managed flow at `POST /api/rename-path`. Works for all three — the tool probes the content directory to decide. Inbound wiki-links plus supported inline Markdown links are rewritten across affected docs; renamed assets are reported.',
  '',
  '**Parameters:**',
  '- `from` — Current path. Doc: docName (trailing `.md`/`.mdx` stripped). Folder: relative path, no leading/trailing slash. Asset: the file path incl. extension.',
  '- `to` — New path. Same shape as `from`.',
  '- `template` — Move/rename a TEMPLATE instead of a doc/folder/asset: `{ from: "<folder>/<name>", to: "<folder>/<name>" }` (nested — a flat path cannot disambiguate a template under `.ok/templates/` from a same-named doc). Mutually exclusive with flat `from`/`to`. Inherited templates are not moved (move the local copy / the owning folder); templates carry no inbound links, so nothing is rewritten.',
  '- `skill` — Move/rename a SKILL: `{ from: "<name>", to: "<name>", scope?, toScope? }` (nested). Within one level (omit `toScope`, or `toScope` === `scope`): renames `.ok/skills/<from>/` → `.ok/skills/<to>/` and keeps the SKILL.md `name` in sync. ACROSS levels (`toScope` differs from `scope`, e.g. `scope: "project"` + `toScope: "global"`): moves the skill between the Project level (this KB) and the Global level (`~/.ok/skills`); history does NOT transfer (it re-creates fresh in the new level) and the moved skill lands as an un-projected Draft. Run `install` afterward to (re)project it. Mutually exclusive with flat `from`/`to`.',
  '- `summary` — Optional one-line user-outcome (≤80 chars). If omitted, defaults to "Renamed X → Y". Avoid secrets or PII — persisted to git history.',
  '',
  '**Errors:** 400 — invalid path / excluded by `.gitignore`/`.okignore`; 404 — source does not exist; 409 — destination already exists (`colliding[]` returned).',
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

/**
 * Probe whether `from` is a doc, folder, or asset under the content dir:
 * - 'folder' — `<contentDir>/<from>` is a directory
 * - 'file'   — `<from>(.md|.mdx)` exists (a managed doc)
 * - 'asset'  — `<from>` exists as a file with any other extension
 * - null     — neither resolves (or `from` escapes the root)
 */
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
                'Source level (default "project"). "project" = this KB\'s `.ok/skills/`; "global" = the Global `~/.ok/skills/`.',
              ),
            toScope: z
              .enum(MANAGED_ARTIFACT_SCOPES)
              .optional()
              .describe(
                'Destination level. Omit (or set equal to `scope`) for a within-level rename. Set to the OTHER level to move the skill across levels (project↔global) — history does not transfer and it lands as a Draft.',
              ),
          })
          .optional()
          .describe(
            'Move/rename a SKILL: `{ from: "<name>", to: "<name>", scope?, toScope? }`. Within one level: renames `.ok/skills/<name>/` and keeps SKILL.md `name` in sync. Across levels (`toScope` differs from `scope`): moves between Project and Global, resetting history. Mutually exclusive with flat `from`/`to`.',
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
            'Template move only: `true` = tracked `git mv` (history preserved), `false` = plain disk rename (untracked / local-only `.ok/`).',
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
            'Skill cross-level move only: `true` when the skill was moved between the Project and Global levels (history reset; lands as a Draft — re-run `install`).',
          ),
        bothScopes: z
          .boolean()
          .optional()
          .describe(
            'Skill cross-level move only: `true` when the destination write succeeded but deleting the source failed, so the skill now exists in BOTH levels and the source copy must be removed manually.',
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

      // Template move/rename — nested target. A flat path can't disambiguate a
      // template under `.ok/templates/` from a same-named doc, so the
      // `template` key is the disambiguator. Routes to the managed
      // `/api/template` move endpoint (git mv + auto-clean), not rename-path.
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

      // Skill move/rename — nested target (a flat path can't disambiguate a
      // skill under `.ok/skills/` from a same-named doc). Within one level,
      // `moveSkill` routes to POST /api/skill (git mv + frontmatter sync); across
      // levels, `moveSkillCrossScope` composes write-dest + delete-source.
      if (args.skill !== undefined) {
        if (args.from !== undefined || args.to !== undefined) {
          return textResult(
            'Error: pass EITHER flat `from`/`to` (document/folder/asset) OR `skill: { from, to }` — not both.',
            true,
          );
        }
        const fromScope = args.skill.scope ?? 'project';
        // A `toScope` that differs from the source level is the cross-level
        // signal; otherwise (omitted or equal) it's a within-level rename.
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
        // A flat path that resolves to a template is the "reached for `move` by
        // analogy" footgun — point at the nested template target.
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

      // Resolve from/to path shapes by kind.
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
