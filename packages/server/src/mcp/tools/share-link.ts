/**
 * `share_link` MCP tool — construct a GitHub-substrate share URL for a doc
 * OR a folder. The target kind is auto-probed from disk by default and can be
 * pinned explicitly via the optional `kind` argument.
 *
 * Wraps `POST /api/share/construct-url` (the same endpoint the editor's
 * Share button calls). Read-only against the working tree: probes HEAD
 * branch, `[remote "origin"] url`, and `refs/remotes/origin/<branch>`. No
 * commits, no pushes, no fetches.
 *
 * Agents do NOT get the Publish-to-GitHub wizard. When the project has no
 * GitHub remote, the no-remote branch returns a clear actionable error
 * rather than walking the agent through `gh repo create` + initial push —
 * publishing is an explicit user act, not an agent-initiated side effect.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ShareConstructUrlErrorCode,
  ShareConstructUrlResponseSchema,
  type ShareFreshness,
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
  '**Preconditions:** project on a named branch (not detached HEAD); origin set to a `github.com` remote; the branch already pushed to origin.',
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

/**
 * The relayable warning an agent prepends to a share link when the target
 * isn't current on origin — the `share_link` mirror of the popover's fact line
 * (kind substitutes doc/folder). `current` and `undefined` (the fail-open and
 * unknown-value cases) get no warning, so an older client that can't interpret
 * a newer freshness value degrades to silence rather than a bad relay.
 */
function freshnessWarning(freshness: ShareFreshness | undefined, kind: ShareKind): string {
  if (freshness === 'absent') {
    return `This ${kind} isn't on GitHub yet. The link won't work until it's pushed.\n\n`;
  }
  if (freshness === 'stale') {
    return `This ${kind} has unpushed changes. Recipients will see the last pushed version.\n\n`;
  }
  return '';
}

/**
 * Tool-local failure codes. The five `ShareConstructUrlErrorCode` server codes
 * flow through verbatim; `target-not-found`, `kind-mismatch`, and `unknown`
 * are produced INLINE by this wrapper (not by `messageForShareError`, whose
 * `never`-guard must keep covering exactly the five server codes).
 *
 * `target-not-found` / `kind-mismatch` are distinct from the system-wide
 * `urn:ok:error:doc-not-found` problem+json envelope — they live only in this
 * tool's structured output, never on the wire.
 */
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

/**
 * Map a `ShareConstructUrlErrorCode` to a one-line agent-facing message.
 * Phrased so an agent can relay it to the user verbatim without re-writing.
 */
function messageForShareError(error: ShareConstructUrlErrorCode, branch?: string): string {
  switch (error) {
    case 'no-remote':
      return 'This project has no GitHub remote. Ask the user to push it to GitHub first (e.g. `gh repo create` then `git push -u origin <branch>`), or use the Share button in the editor to run the Publish wizard. Agents do not publish projects from this tool.';
    case 'detached-head':
      return 'HEAD is detached (no branch checked out). Ask the user to check out a branch (`git checkout <branch>`) before sharing.';
    case 'branch-not-on-origin': {
      // Branch-existence is checked against the local `refs/remotes/origin/<branch>`
      // ref (no `git ls-remote`). A stale local fetch can produce a false negative
      // on a branch that's already on origin — see the schema docstring in
      // `core/src/schemas/api/share.ts`. The fetch hint gives the agent a recovery
      // prompt for that case so it doesn't get stuck if the user replies
      // "I already pushed it."
      const fetchHint =
        ' (If the user says it is already pushed, ask them to `git fetch origin` first to refresh the local mirror, then retry.)';
      return branch
        ? `Branch \`${branch}\` is not on origin yet. Ask the user to push it (\`git push -u origin ${branch}\`), then retry.${fetchHint}`
        : `The current branch is not on origin yet. Ask the user to push it (\`git push -u origin <branch>\`), then retry.${fetchHint}`;
    }
    case 'non-github-remote':
      return 'Origin is not a `github.com` remote. Share links are GitHub-only in v1.';
    case 'invalid-path':
      return 'The resolved share path is not shareable (escapes the project root or names the `.git` subtree). Pass a normal target path under the content directory.';
    default: {
      // Exhaustiveness guard: adding a new variant to `ShareConstructUrlErrorCodeSchema`
      // becomes a compile error here. The runtime fallback is informational only —
      // TypeScript catches the divergence before we ship. Tool-local codes
      // (target-not-found / kind-mismatch / unknown) are handled at their inline
      // call sites, never routed here, so the `never` guard stays over the five
      // server codes.
      const _exhaustive: never = error;
      return `Unknown share-construct-url error: ${String(_exhaustive)}`;
    }
  }
}

/** Probe whether `<contained.abs>` resolves to a directory on disk. */
function isExistingDirectory(abs: string): boolean {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Probe `<absBase>.mdx` then `.md`; return the project-relative path of the
 * first existing file, or `null` when neither exists / the file escapes the
 * project root.
 *
 * Precedence matches `SUPPORTED_DOC_EXTENSIONS` in `doc-extensions.ts`:
 * `.mdx` wins over `.md` when both exist (industry convention — `.mdx` is a
 * strict superset, so a co-located `.mdx` is presumed to intentionally
 * override the `.md`). The wider OK system keys writes/edits/the editor on
 * the same precedence via `getDocExtension`; share URLs must point at the
 * same file the user is editing, not its `.md` shadow.
 *
 * `getDocExtension` itself isn't reachable from here — it lives in the
 * Hocuspocus server process's module state, and the MCP stdio server hits
 * Hocuspocus over HTTP. The existsSync probe is the out-of-process equivalent;
 * it iterates `SUPPORTED_DOC_EXTENSIONS` directly so the precedence can't drift.
 */
function resolveExistingDocPath(projectDir: string, absBase: string): string | null {
  for (const ext of SUPPORTED_DOC_EXTENSIONS) {
    const absWithExt = `${absBase}${ext}`;
    if (existsSync(absWithExt)) {
      const projectContained = resolveWithinRoot(projectDir, absWithExt);
      if (!projectContained.ok) return null;
      // `path.relative` returns `/`-separated paths on POSIX (the OK server's
      // target platform per `path-safety.ts`), so no separator normalization needed.
      return projectContained.rel;
    }
  }
  return null;
}

type ResolveShareTargetResult =
  | { ok: true; kind: ShareKind; sharePath: string }
  | { ok: false; code: 'target-not-found' | 'kind-mismatch' | 'invalid-path' };

/**
 * Resolve a caller-supplied `path` (+ optional `kind`) to the project-relative
 * share path + kind the construct-url endpoint expects. Doc and folder share
 * the SAME containment + relative-to-content-root convention as the prior
 * doc-only resolver (`resolveWithinRoot` against `contentDir`, then re-project
 * the absolute hit against `projectDir`).
 *
 * Decision logic:
 *   - `path === ''` (root sentinel): valid ONLY for `kind === 'folder'` →
 *     `{kind:'folder', sharePath:''}`. `{path:''}` (no kind) or
 *     `{path:'', kind:'doc'}` → `invalid-path` (auto-probe can't disambiguate
 *     the empty root, and a doc always names a file).
 *   - otherwise, probe disk: a doc exists iff `<path>.mdx`/`<path>.md` exists;
 *     a folder exists iff `<path>` is a directory.
 *       - `kind === 'doc'`: doc → doc; else folder → kind-mismatch; else
 *         target-not-found.
 *       - `kind === 'folder'`: folder → folder; else doc → kind-mismatch; else
 *         target-not-found.
 *       - `kind` omitted (auto-probe, first hit wins): `.mdx` → doc;
 *         `.md` → doc; directory → folder; none → target-not-found.
 *
 * Containment escape (path leaves `contentDir`) collapses to
 * `target-not-found`, mirroring the prior doc-only resolver's null-on-escape.
 */
function resolveShareTarget(
  projectDir: string,
  contentDir: string,
  path: string,
  kind?: ShareKind,
): ResolveShareTargetResult {
  if (path === '') {
    // Auto-probe can't disambiguate the empty root, and a doc always names a
    // file — so the root is shareable only when the caller pins `folder`.
    if (kind === 'folder') return { ok: true, kind: 'folder', sharePath: '' };
    return { ok: false, code: 'invalid-path' };
  }

  const contained = resolveWithinRoot(contentDir, path);
  if (!contained.ok) return { ok: false, code: 'target-not-found' };

  // Doc probe strips a trailing `.md`/`.mdx` from the supplied path before
  // appending the probe extension — `path: 'notes.md'` resolves the same file
  // as `path: 'notes'`. Folder probe uses the raw `contained.abs` (a directory
  // named `foo.md` is its own literal path, not `foo`).
  const docBase = contained.abs.replace(/\.(mdx|md)$/i, '');
  const docPath = resolveExistingDocPath(projectDir, docBase);
  const dirExists = isExistingDirectory(contained.abs);

  if (kind === 'doc') {
    if (docPath !== null) return { ok: true, kind: 'doc', sharePath: docPath };
    if (dirExists) return { ok: false, code: 'kind-mismatch' };
    return { ok: false, code: 'target-not-found' };
  }
  if (kind === 'folder') {
    if (dirExists) {
      const folderContained = resolveWithinRoot(projectDir, contained.abs);
      if (!folderContained.ok) return { ok: false, code: 'target-not-found' };
      return { ok: true, kind: 'folder', sharePath: folderContained.rel };
    }
    if (docPath !== null) return { ok: false, code: 'kind-mismatch' };
    return { ok: false, code: 'target-not-found' };
  }

  // Auto-probe: first hit wins in `.mdx` → `.md` → directory order.
  if (docPath !== null) return { ok: true, kind: 'doc', sharePath: docPath };
  if (dirExists) {
    const folderContained = resolveWithinRoot(projectDir, contained.abs);
    if (!folderContained.ok) return { ok: false, code: 'target-not-found' };
    return { ok: true, kind: 'folder', sharePath: folderContained.rel };
  }
  return { ok: false, code: 'target-not-found' };
}

/**
 * Structured output declaration. Mirrors `ShareLinkSuccess | ShareLinkError`
 * (the runtime discriminated union returned via `textPlusStructured`).
 *
 * Strict MCP clients (Claude) validate `structuredContent` against this
 * schema via AJV and reject any undeclared key — declaring `outputSchema`
 * here also routes through the `output-schema-strictness.test.ts` sweep,
 * which guards the `outputSchemaWithText` text-mirror invariant
 * (see `shared.ts` for the helper's docstring).
 *
 * `previewUrl` / `previewUrlSource` are optional success-path additions
 * (route-only preview hint for hosts that watch the user's browser).
 */
const OutputSchema = outputSchemaWithText({
  ok: z.boolean().describe('Success discriminator.'),
  shareUrl: z.string().optional().describe('Marketing share URL (success only).'),
  sharedUrl: z.string().optional().describe('Unencoded GitHub blob/tree URL (success only).'),
  branch: z.string().optional().describe('Branch the share URL pins to (success only).'),
  resolvedKind: z
    .enum(['doc', 'folder'])
    .optional()
    .describe('Kind the target resolved to (success only).'),
  freshness: z
    .enum(['current', 'stale', 'absent'])
    .optional()
    .describe(
      'Whether the shared target matches origin (success only): current, stale (unpushed edits), or absent (not on origin). Omitted when the probe could not run.',
    ),
  error: z
    .enum([
      'no-remote',
      'detached-head',
      'branch-not-on-origin',
      'non-github-remote',
      'invalid-path',
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
      const resolved = resolveShareTarget(cwd, contentDir, args.path, args.kind);
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

      // construct-url returns HTTP 200 for BOTH the happy path AND the five
      // business-logic failures, discriminated on body `ok`. Routing through
      // `httpPost`/`normalizeResponse` would strip the body's `ok` field and
      // force `ok: true` on every 200, so go direct and parse with the
      // shared schema.
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
        // RFC 9457 problem+json: surface `title` + `detail` when present so the
        // agent has both the high-level diagnostic and any actionable specifics
        // the server attached. Fall back to a bare HTTP status when neither
        // field shows up (rare — proxy error pages or non-server intermediaries).
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
        // Omit rather than emit `undefined` so the fail-open / unknown-value
        // case leaves the field absent (the outputSchema declares it optional).
        ...(freshness ? { freshness } : {}),
      };
      // Preview hint is route-only and symmetric across kinds: a doc previews
      // at `/#/<doc>`, a folder at `/#/<folderPath>/` (`/#/` for the
      // content-root sentinel — mirrors the app's `hashFromFolderPath` in
      // `packages/app/src/lib/doc-hash.ts`). Both share the SAME `ui.lock`
      // reachability gate (a UI must be running for the route to be navigable),
      // so `resolvePreviewUrlForTool` resolves the gate + `'lock'` source for
      // both; the folder branch then rewrites the route shape to the
      // trailing-slash folder form.
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
      // Prepend the freshness fact line so an agent relays the same caution a
      // human would see in the popover before handing over a stale/dead link.
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
