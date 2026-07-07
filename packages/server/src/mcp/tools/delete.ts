/**
 * `delete` MCP tool — remove one thing, polymorphic over
 * `document` / `folder` / `template` / `asset`.
 *
 * Backends by target:
 *   - document → `POST /api/delete-path` (kind: file) [Requires: Hocuspocus]
 *   - folder   → `POST /api/delete-path` (kind: folder)
 *   - asset    → `POST /api/delete-path` (kind: asset)
 *   - template → `DELETE /api/template` (server, attributed) [Requires: Hocuspocus]
 */
import { z } from 'zod';
import type { AgentIdentity } from '../agent-identity.ts';
import { resolvePreviewUrlForTool } from './preview-url.ts';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  agentIdentityFields,
  HOCUSPOCUS_NOT_RUNNING_ERROR,
  httpDelete,
  httpPost,
  looseObjectArray,
  normalizeDocName,
  outputSchemaWithText,
  previousPreviewUrlField,
  ROUTED_CWD_DESCRIPTION,
  resolveProjectServerContext,
  textPlusStructured,
  textResult,
} from './shared.ts';
import { deleteSkill, deleteSkillFile, type SkillScope } from './skill-target.ts';
import {
  exactlyOneTargetError,
  resolveSkillFilePath,
  resolveTemplatePath,
  SKILL_NAME_DESCRIBE,
  SkillScopeArg,
} from './verb-schemas.ts';

const BASE_DESCRIPTION = [
  'Delete one thing. Pass EXACTLY ONE of `document`, `folder`, `template`, `skill`, or `asset`.',
  '',
  '- `document` — Doc path(s) to delete (a single path or an array). Inbound links become redlinks. Irreversible. [Requires: Hocuspocus server]',
  '- `folder` — Folder path to delete (recursive). [Requires: Hocuspocus server]',
  '- `template` — `{ path: "<folder>/<name>" }` — a template to delete (server-routed, attributed; auto-cleans empty `.ok/`). [Requires: Hocuspocus server]',
  '- `skill` — `{ name }` deletes a whole SKILL; `{ name, files: ["references/x.md"] }` deletes specific bundle files (server-routed, attributed; auto-cleans empty `.ok/`). [Requires: Hocuspocus server]',
  '- `asset` — `{ path: "<folder>/<file.ext>" }` — a binary asset to delete. [Requires: Hocuspocus server]',
  '',
  'Call `links({ kind: "backlinks", document })` BEFORE deleting a doc to see what links here.',
].join('\n');

const DESCRIPTION = BASE_DESCRIPTION;

interface DeleteDeps {
  serverUrl: ServerUrlOrResolver;
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
  identityRef?: { current: AgentIdentity };
}

interface DeleteOneResult {
  docName: string;
  ok: boolean;
  deletedDocNames?: string[];
  previousPreviewUrl?: string;
  error?: string;
}

function parseDeletedDocNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

async function deleteOneDoc(
  rawDocName: string,
  url: string,
  cwd: string,
  deps: DeleteDeps,
): Promise<DeleteOneResult> {
  const normalized = normalizeDocName(rawDocName);
  // Store a bare reason (normalizeDocName pre-prefixes "Error: "; the httpPost
  // path below stores a bare error) so callers add a single prefix — avoids the
  // double "Error: Error:" when the single-doc error branch below wraps it as
  // `Error: ${r.error}`.
  if (!normalized.ok)
    return { docName: rawDocName, ok: false, error: normalized.error.replace(/^Error:\s*/, '') };
  const result = await httpPost(url, '/api/delete-path', {
    kind: 'file',
    path: normalized.docName,
    ...agentIdentityFields(deps.identityRef?.current),
  });
  if (!result.ok) return { docName: normalized.docName, ok: false, error: result.error as string };
  const deletedDocNames = parseDeletedDocNames(result.deletedDocNames);
  const previousPreview = await resolvePreviewUrlForTool(
    normalized.docName,
    { config: deps.config, resolveCwd: deps.resolveCwd },
    cwd,
  );
  return {
    docName: normalized.docName,
    ok: true,
    deletedDocNames: deletedDocNames.length > 0 ? deletedDocNames : [normalized.docName],
    ...(previousPreview ? { previousPreviewUrl: previousPreview.url } : {}),
  };
}

export function register(server: ServerInstance, deps: DeleteDeps): void {
  server.registerTool(
    'delete',
    {
      description: DESCRIPTION,
      inputSchema: {
        document: z
          // A `{ path }` object is accepted as an alias for the bare string so
          // the `write`/`edit` Pattern-B mental model carries over to `delete`.
          .union([
            z.string(),
            z.array(z.string()).min(1),
            z.object({ path: z.union([z.string(), z.array(z.string()).min(1)]) }),
          ])
          .optional()
          .describe(
            'Doc path(s) to delete — a string, an array, or `{ path }`. Inbound links become redlinks. Irreversible.',
          ),
        folder: z
          .union([z.string(), z.object({ path: z.string() })])
          .optional()
          .describe('Folder path to delete (recursive) — a string or `{ path }`.'),
        template: z
          .object({ path: z.string().describe('Template path = `<folder>/<name>`.') })
          .optional()
          .describe('A template to delete.'),
        skill: z
          .object({
            name: z.string().describe(SKILL_NAME_DESCRIBE),
            files: z
              .array(z.string())
              .min(1)
              .optional()
              .describe(
                'Skill-relative bundle file paths to delete (`references/...`/`scripts/...`). Omit to delete the WHOLE skill (`.ok/skills/<name>/`).',
              ),
            scope: SkillScopeArg.optional(),
          })
          .optional()
          .describe(
            'A skill to delete — the whole skill (`.ok/skills/<name>/`), or specific bundle files when `files` is set.',
          ),
        asset: z
          .object({
            path: z
              .string()
              .describe(
                'Asset path incl. extension — the slashes are its folder. Example: "images/diagram.png".',
              ),
          })
          .optional()
          .describe('A binary asset to delete.'),
        cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
      },
      // Output mirrors the Pattern-B input: the result nests under the target
      // key you deleted (`document` / `folder` / `template` / `asset`, or
      // `documents` for a batch). `previousPreviewUrl` is the uniform top-level
      // envelope.
      outputSchema: outputSchemaWithText({
        document: z
          .object({
            ok: z.boolean(),
            deletedDocNames: z
              .array(z.string())
              .optional()
              .describe(
                'The single docName removed (a document delete never cascades to descendants).',
              ),
            error: z.string().optional().describe('Present when `ok` is false.'),
          })
          .optional()
          .describe('Single-document delete result.'),
        folder: z
          .object({ ok: z.boolean(), deletedDocNames: z.array(z.string()) })
          .optional()
          .describe('Folder delete result (docNames removed).'),
        template: z
          .object({ ok: z.boolean(), existed: z.boolean() })
          .optional()
          .describe('Template delete result.'),
        skill: z
          .object({
            ok: z.boolean(),
            existed: z.boolean().optional(),
            files: looseObjectArray
              .optional()
              .describe('Per-bundle-file delete results `{ path, ok, existed?, error? }`.'),
          })
          .optional()
          .describe('Skill delete result (whole skill or specific bundle files).'),
        asset: z
          .object({ ok: z.boolean(), path: z.string() })
          .optional()
          .describe('Asset delete result.'),
        documents: looseObjectArray
          .optional()
          .describe('Batch doc delete: per-doc result records.'),
        previousPreviewUrl: previousPreviewUrlField,
      }),
    },
    async (args: {
      document?: string | string[] | { path: string | string[] };
      folder?: string | { path: string };
      template?: { path: string };
      skill?: { name: string; scope?: SkillScope; files?: string[] };
      asset?: { path: string };
      cwd?: string;
    }) => {
      const context = await resolveProjectServerContext(
        deps.resolveCwd,
        deps.config,
        deps.serverUrl,
        args.cwd,
      );
      if (!context.ok) return textResult(`Error: ${context.error}`, true);
      const { cwd, url } = context;

      // Unwrap the `{ path }` Pattern-B alias to the bare path(s) the rest of
      // the handler expects.
      const folderPath = typeof args.folder === 'object' ? args.folder.path : args.folder;
      const documentArg =
        args.document && typeof args.document === 'object' && !Array.isArray(args.document)
          ? args.document.path
          : args.document;

      const teaching = exactlyOneTargetError(args as Record<string, unknown>, [
        'document',
        'folder',
        'template',
        'skill',
        'asset',
      ]);
      if (teaching) return textResult(`Error: ${teaching}`, true);

      // Skill — server-routed (DELETE /api/skill[-file]) so the delete is
      // attributed in the folder timeline. `files` present → per-file deletes;
      // absent → whole-skill delete (shared `deleteSkill`).
      if (args.skill !== undefined) {
        const skill = args.skill;
        if (skill.files !== undefined && skill.files.length > 0) {
          for (const f of skill.files) {
            const check = resolveSkillFilePath(f);
            if (!check.ok) return textResult(`Error: ${check.error}`, true);
          }
          const results: Array<{ path: string; ok: boolean; existed?: boolean; error?: string }> =
            [];
          for (const f of skill.files) {
            const r = await deleteSkillFile(url, {
              name: skill.name,
              scope: skill.scope,
              path: f,
              identity: deps.identityRef?.current,
            });
            const struct = (
              r as { structuredContent?: { skill?: { file?: { existed?: boolean } } } }
            ).structuredContent;
            if (r.isError) {
              results.push({ path: f, ok: false, error: r.content[0]?.text ?? 'delete failed' });
            } else {
              results.push({ path: f, ok: true, existed: struct?.skill?.file?.existed === true });
            }
          }
          const okCount = results.filter((r) => r.ok).length;
          const allOk = okCount === results.length;
          const lines = results.map((r) =>
            r.ok
              ? `${r.existed ? 'Deleted' : 'No-op (absent)'} ${r.path}.`
              : `Failed ${r.path}: ${r.error}`,
          );
          return textPlusStructured(
            `${okCount}/${results.length} skill file(s) processed.\n${lines.join('\n')}`,
            { skill: { ok: allOk, files: results } },
            !allOk,
          );
        }
        return deleteSkill(url, {
          name: skill.name,
          scope: skill.scope,
          identity: deps.identityRef?.current,
        });
      }

      // Template — server-routed (DELETE /api/template) so the delete is
      // attributed in the folder timeline. Requires the Hocuspocus server,
      // like every other attributed mutation; identity rides the query string.
      if (args.template !== undefined) {
        const resolved = resolveTemplatePath(args.template.path);
        if (!resolved.ok) return textResult(`Error: ${resolved.error}`, true);
        const { folder, name } = resolved;
        if (!url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);
        const params = new URLSearchParams({ folder, name });
        for (const [key, value] of Object.entries(agentIdentityFields(deps.identityRef?.current))) {
          if (typeof value === 'string' && value.length > 0) params.set(key, value);
        }
        const result = await httpDelete(url, `/api/template?${params.toString()}`);
        if (!result.ok) return textResult(`Error: ${result.error}`, true);
        const existed = result.existed === true;
        return textPlusStructured(
          existed
            ? `Deleted template "${name}" from ${folder || '(root)'}.`
            : `Template "${name}" did not exist in ${folder || '(root)'} — nothing to delete.`,
          { template: { ok: true, existed } },
        );
      }

      if (!url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);

      // Folder.
      if (args.folder !== undefined) {
        const result = await httpPost(url, '/api/delete-path', {
          kind: 'folder',
          path: folderPath,
          ...agentIdentityFields(deps.identityRef?.current),
        });
        if (!result.ok) return textResult(`Error: ${result.error}`, true);
        const deleted = parseDeletedDocNames(result.deletedDocNames);
        return textPlusStructured(
          `Deleted folder ${folderPath}${deleted.length ? ` (${deleted.length} doc(s))` : ''}.`,
          { folder: { ok: true, deletedDocNames: deleted } },
        );
      }

      // Asset.
      if (args.asset !== undefined) {
        const path = args.asset.path.replace(/^\/+/, '').replace(/\/+$/, '');
        const result = await httpPost(url, '/api/delete-path', {
          kind: 'asset',
          path,
          ...agentIdentityFields(deps.identityRef?.current),
        });
        if (!result.ok) return textResult(`Error: ${result.error}`, true);
        return textPlusStructured(`Deleted asset ${path}.`, { asset: { ok: true, path } });
      }

      // Document(s).
      const doc = documentArg as string | string[];
      if (Array.isArray(doc)) {
        const results = await Promise.all(doc.map((d) => deleteOneDoc(d, url, cwd, deps)));
        const okCount = results.filter((r) => r.ok).length;
        const allOk = okCount === results.length;
        const lines = results.map((r) =>
          r.ok ? `Deleted ${r.docName}.` : `Failed ${r.docName}: ${r.error}`,
        );
        return textPlusStructured(
          `${okCount}/${results.length} deleted.\n${lines.join('\n')}`,
          { documents: results },
          !allOk,
        );
      }
      const r = await deleteOneDoc(doc, url, cwd, deps);
      if (!r.ok) {
        return textPlusStructured(
          `Error: ${r.error ?? 'unknown error'}`,
          { document: { ok: false, error: r.error } },
          true,
        );
      }
      const deletedDocNames = r.deletedDocNames ?? [r.docName];
      return textPlusStructured(
        deletedDocNames.length === 1
          ? `Deleted ${deletedDocNames[0]}.`
          : `Deleted ${deletedDocNames.length} documents: ${deletedDocNames.join(', ')}.`,
        {
          document: { ok: true, deletedDocNames },
          ...(r.previousPreviewUrl ? { previousPreviewUrl: r.previousPreviewUrl } : {}),
        },
      );
    },
  );
}
