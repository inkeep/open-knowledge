import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ShareConstructUrlErrorCode,
  ShareConstructUrlErrorCodeSchema,
  ShareConstructUrlResponseSchema,
  type ShareFreshness,
  ShareFreshnessSchema,
} from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import { SUPPORTED_DOC_EXTENSIONS } from '../../doc-extensions.ts';
import { resolveWithinRoot } from './path-safety.ts';
import { encodeDocName, resolvePreviewUrlForTool } from './preview-url.ts';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  HOCUSPOCUS_NOT_RUNNING_ERROR,
  outputSchemaWithText,
  ROUTED_CWD_DESCRIPTION,
  resolveProjectServerContext,
  textPlusStructured,
  textResult,
} from './shared.ts';

type ShareKind = 'doc' | 'folder';

const DESCRIPTION = [
  "[Requires: Hocuspocus server] Build a shareable GitHub-substrate URL (`https://openknowledge.ai/d/...`) pinned to the project's current branch + the focused target (a doc or a folder). Read-only against the working tree — no commits, no pushes, no `git fetch`.",
  '',
  'Use this when the user asks for a share link / shareable link / URL to send to a teammate. Recipients open the link to receive the doc (or folder subtree) into their own OpenKnowledge install.',
  '',
  '**Publishing is a user act.** Agents do NOT publish projects to GitHub from this tool. When the project has no GitHub remote, this tool returns an error pointing the user at the Share wizard (or `gh repo create` + `git push`) — it does not run those steps itself.',
  '',
  '**Parameters:**',
  '- `path` — Content-dir-relative target. For a doc, extension-less (trailing `.md`/`.mdx` is stripped; the on-disk file is probed automatically). For a folder, the directory path. The empty string `""` is the content-root sentinel (folder-only).',
  "- `kind` (optional) — `'doc'` or `'folder'`. Omit to auto-probe disk (`.mdx` → `.md` → directory, first hit wins). REQUIRED when `path` is empty (`\"\"`), since auto-probe cannot disambiguate the root.",
  '- `cwd` (optional) — Project root (see `cwd` description below).',
  '',
  '**Preconditions:** project on a named branch (not detached HEAD); origin set to a GitHub remote (`github.com` or a GitHub Enterprise Server host); the branch already pushed to origin.',
].join('\n');

export interface ShareLinkDeps {
  serverUrl: ServerUrlOrResolver;
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
}

interface ShareLinkSuccess {
  ok: true;
  shareUrl: string;
  sharedUrl: string;
  branch: string;
  resolvedKind: ShareKind;
  freshness?: ShareFreshness;
}

function freshnessWarning(freshness: ShareFreshness | undefined, kind: ShareKind): string {
  if (freshness === 'absent') {
    return `This ${kind} isn't on GitHub yet. The link won't work until it's pushed.\n\n`;
  }
  if (freshness === 'stale') {
    return `This ${kind} has unpushed changes. Recipients will see the last pushed version.\n\n`;
  }
  if (freshness === 'empty') {
    return `Git can't track this folder — it's empty or contains only ignored files. The link won't work until you add a tracked document.\n\n`;
  }
  return '';
}

type ShareLinkErrorCode =
  | ShareConstructUrlErrorCode
  | 'target-not-found'
  | 'kind-mismatch'
  | 'unknown';

interface ShareLinkError {
  ok: false;
  error: ShareLinkErrorCode;
  message: string;
  branch?: string;
}

function messageForShareError(error: ShareConstructUrlErrorCode, branch?: string): string {
  switch (error) {
    case 'no-remote':
      return 'This project has no GitHub remote. Ask the user to push it to GitHub first (e.g. `gh repo create` then `git push -u origin <branch>`), or use the Share button in the editor to run the Publish wizard. Agents do not publish projects from this tool.';
    case 'detached-head':
      return 'HEAD is detached (no branch checked out). Ask the user to check out a branch (`git checkout <branch>`) before sharing.';
    case 'branch-not-on-origin': {
      const fetchHint =
        ' (If the user says it is already pushed, ask them to `git fetch origin` first to refresh the local mirror, then retry.)';
      return branch
        ? `Branch \`${branch}\` is not on origin yet. Ask the user to push it (\`git push -u origin ${branch}\`), then retry.${fetchHint}`
        : `The current branch is not on origin yet. Ask the user to push it (\`git push -u origin <branch>\`), then retry.${fetchHint}`;
    }
    case 'non-github-remote':
      return 'Origin is a non-GitHub remote (GitLab, Bitbucket, etc.). Share links require a GitHub remote (`github.com` or GitHub Enterprise Server).';
    case 'invalid-path':
      return 'The resolved share path is not shareable (escapes the project root or names the `.git` subtree). Pass a normal target path under the content directory.';
    case 'unsupported-share-url':
      return 'The GitHub URL cannot be represented by the share-link format. Use a canonical DNS GitHub host and a shorter repository path.';
    default: {
      const _exhaustive: never = error;
      return `Unknown share-construct-url error: ${String(_exhaustive)}`;
    }
  }
}

function isExistingDirectory(abs: string): boolean {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function resolveExistingDocPath(contentDir: string, absBase: string): string | null {
  for (const ext of SUPPORTED_DOC_EXTENSIONS) {
    const absWithExt = `${absBase}${ext}`;
    if (existsSync(absWithExt)) {
      const contentContained = resolveWithinRoot(contentDir, absWithExt);
      if (!contentContained.ok) return null;
      return contentContained.rel;
    }
  }
  return null;
}

type ResolveShareTargetResult =
  | { ok: true; kind: ShareKind; sharePath: string }
  | { ok: false; code: 'target-not-found' | 'kind-mismatch' | 'invalid-path' };

function resolveShareTarget(
  contentDir: string,
  path: string,
  kind?: ShareKind,
): ResolveShareTargetResult {
  if (path === '') {
    if (kind === 'folder') return { ok: true, kind: 'folder', sharePath: '' };
    return { ok: false, code: 'invalid-path' };
  }

  const contained = resolveWithinRoot(contentDir, path);
  if (!contained.ok) return { ok: false, code: 'target-not-found' };

  const docBase = contained.abs.replace(/\.(mdx|md)$/i, '');
  const docPath = resolveExistingDocPath(contentDir, docBase);
  const dirExists = isExistingDirectory(contained.abs);

  if (kind === 'doc') {
    if (docPath !== null) return { ok: true, kind: 'doc', sharePath: docPath };
    if (dirExists) return { ok: false, code: 'kind-mismatch' };
    return { ok: false, code: 'target-not-found' };
  }
  if (kind === 'folder') {
    if (dirExists) {
      return { ok: true, kind: 'folder', sharePath: contained.rel };
    }
    if (docPath !== null) return { ok: false, code: 'kind-mismatch' };
    return { ok: false, code: 'target-not-found' };
  }

  if (docPath !== null) return { ok: true, kind: 'doc', sharePath: docPath };
  if (dirExists) {
    return { ok: true, kind: 'folder', sharePath: contained.rel };
  }
  return { ok: false, code: 'target-not-found' };
}

const OutputSchema = outputSchemaWithText({
  ok: z.boolean().describe('Success discriminator.'),
  shareUrl: z.string().optional().describe('Marketing share URL (success only).'),
  sharedUrl: z.string().optional().describe('Unencoded GitHub blob/tree URL (success only).'),
  branch: z.string().optional().describe('Branch the share URL pins to (success only).'),
  resolvedKind: z
    .enum(['doc', 'folder'])
    .optional()
    .describe('Kind the target resolved to (success only).'),
  freshness: ShareFreshnessSchema.optional().describe(
    'Whether the shared target matches origin (success only): current, stale (unpushed edits), absent (not on origin, a push fixes it), or empty (a folder holding nothing git can track, which no push fixes). Omitted when the probe could not run.',
  ),
  error: z
    .enum([
      ...ShareConstructUrlErrorCodeSchema.options,
      'target-not-found',
      'kind-mismatch',
      'unknown',
    ])
    .optional()
    .describe('Failure code (error path only).'),
  message: z.string().optional().describe('Agent-actionable error message (error path only).'),
  previewUrl: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Route-only preview URL (no host:port): `/#/<doc>` for a doc, `/#/<folder>/` for a folder, `/#/` for the content root. `null` when no UI is running.',
    ),
  previewUrlSource: z.string().optional().describe('Internal: preview-URL provenance.'),
});

export function register(server: ServerInstance, deps: ShareLinkDeps): void {
  server.registerTool(
    'share_link',
    {
      description: DESCRIPTION,
      inputSchema: {
        path: z
          .string()
          .describe(
            'Content-dir-relative target. Doc paths are extension-less (`.md`/`.mdx` stripped). Folder paths name a directory. `""` is the content-root sentinel (folder-only).',
          ),
        kind: z
          .enum(['doc', 'folder'])
          .optional()
          .describe(
            'Target kind. Omit to auto-probe disk (`.mdx` → `.md` → directory). REQUIRED when `path` is empty.',
          ),
        cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
      },
      outputSchema: OutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args: { path: string; kind?: ShareKind; cwd?: string }) => {
      const context = await resolveProjectServerContext(
        deps.resolveCwd,
        deps.config,
        deps.serverUrl,
        args.cwd,
      );
      if (!context.ok) return textResult(`Error: ${context.error}`, true);
      const { cwd, config, url } = context;
      if (!url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);

      const contentDir = join(cwd, config.content.dir);
      const resolved = resolveShareTarget(contentDir, args.path, args.kind);
      if (!resolved.ok) {
        let message: string;
        if (resolved.code === 'kind-mismatch') {
          const requestedKind: ShareKind = args.kind === 'folder' ? 'folder' : 'doc';
          message = `\`${args.path}\` exists, but not as a ${requestedKind}. Pass \`kind: '${requestedKind === 'doc' ? 'folder' : 'doc'}'\` to share it as the other kind.`;
        } else if (resolved.code === 'invalid-path') {
          message =
            'Cannot share the content root from an empty path without `kind: "folder"`. Pass a non-empty path, or `kind: "folder"` to share the root.';
        } else {
          message = `Target \`${args.path}\` does not exist under the content directory (looked for \`.md\`, \`.mdx\`, and a directory).`;
        }
        const structured: ShareLinkError = { ok: false, error: resolved.code, message };
        return textPlusStructured(`Error: ${message}`, structured, true);
      }

      const requestBody =
        resolved.kind === 'doc'
          ? { kind: 'doc' as const, docPath: resolved.sharePath }
          : { kind: 'folder' as const, folderPath: resolved.sharePath };

      let res: Response;
      try {
        res = await fetch(`${url}/api/share/construct-url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        const errMessage = `Server unreachable: ${err instanceof Error ? err.message : String(err)}`;
        return textPlusStructured(
          `Error: ${errMessage}`,
          { ok: false, error: 'unknown', message: errMessage } satisfies ShareLinkError,
          true,
        );
      }
      let rawBody: unknown;
      try {
        rawBody = await res.json();
      } catch (parseErr) {
        const errMessage = `Server returned non-JSON body: ${
          parseErr instanceof Error ? parseErr.message : String(parseErr)
        }`;
        return textPlusStructured(
          `Error: ${errMessage}`,
          { ok: false, error: 'unknown', message: errMessage } satisfies ShareLinkError,
          true,
        );
      }
      if (!res.ok) {
        let message: string;
        if (rawBody && typeof rawBody === 'object') {
          const record = rawBody as Record<string, unknown>;
          const title = typeof record.title === 'string' ? record.title : undefined;
          const detail = typeof record.detail === 'string' ? record.detail : undefined;
          if (title && detail) {
            message = `${title}: ${detail}`;
          } else if (title) {
            message = title;
          } else if (detail) {
            message = detail;
          } else {
            message = `HTTP ${res.status}`;
          }
        } else {
          message = `HTTP ${res.status}`;
        }
        return textPlusStructured(
          `Error: ${message}`,
          { ok: false, error: 'unknown', message } satisfies ShareLinkError,
          true,
        );
      }
      const parsed = ShareConstructUrlResponseSchema.safeParse(rawBody);
      if (!parsed.success) {
        const errMessage = 'Server returned an unexpected share-construct-url response shape.';
        return textPlusStructured(
          `Error: ${errMessage}`,
          { ok: false, error: 'unknown', message: errMessage } satisfies ShareLinkError,
          true,
        );
      }
      const body = parsed.data;

      if (!body.ok) {
        const message = messageForShareError(body.error, body.branch);
        const structured: ShareLinkError = {
          ok: false,
          error: body.error,
          message,
          ...(body.branch ? { branch: body.branch } : {}),
        };
        return textPlusStructured(`Error: ${message}`, structured, true);
      }

      const { shareUrl, sharedUrl, branch, freshness } = body;
      const structured: ShareLinkSuccess = {
        ok: true,
        shareUrl,
        sharedUrl,
        branch,
        resolvedKind: resolved.kind,
        ...(freshness ? { freshness } : {}),
      };
      const previewDeps = { config: deps.config, resolveCwd: deps.resolveCwd };
      let preview = await resolvePreviewUrlForTool(
        resolved.sharePath.replace(/\.(mdx|md)$/i, ''),
        previewDeps,
        cwd,
      );
      if (preview && resolved.kind === 'folder') {
        const normalized = resolved.sharePath.replace(/^\/+|\/+$/g, '');
        const folderRoute = normalized === '' ? '/#/' : `/#/${encodeDocName(normalized)}/`;
        preview = { ...preview, url: folderRoute };
      }
      const displayPath = args.path === '' ? '(content root)' : args.path;
      const warning = freshnessWarning(freshness, resolved.kind);
      return textPlusStructured(
        `${warning}Share link for ${resolved.kind} \`${displayPath}\` on branch \`${branch}\`:\n${shareUrl}`,
        {
          ...structured,
          previewUrl: preview?.url ?? null,
          ...(preview ? { previewUrlSource: preview.source } : {}),
        },
      );
    },
  );
}
