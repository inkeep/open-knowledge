/**
 * Convert `AttachmentPart` wire values (files, folders, images picked or
 * dropped in the composer) into the ACP `ContentBlock[]` the server hands
 * to the agent alongside the user's text.
 *
 * Gated on `PromptCapabilities`: an agent that didn't advertise
 * `embeddedContext` gets a `resource_link` reference instead of the file's
 * contents; one that didn't advertise `image` gets the image dropped with
 * a warning rather than a malformed prompt. Client-side gating disables
 * unsupported attachment surfaces up front, so this side is defense-in-
 * depth — a version-skewed client can still send parts an agent won't take.
 *
 * Path safety: files/folders address workspace-relative paths that the
 * caller MUST resolve through `confineToContentDir` before this helper
 * reads bytes — a path that escapes the content root has already returned
 * `path-escape` at the caller level.
 */

import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ContentBlock, PromptCapabilities } from '@agentclientprotocol/sdk';
import type { AttachmentPart } from '@inkeep/open-knowledge-core/acp/thread-protocol';

/**
 * Sniff whether a mime type reads well as UTF-8 text — controls whether an
 * embedded file part becomes `TextResourceContents` (readable inline by the
 * agent) or `BlobResourceContents` (base64 binary payload).
 *
 * Kept intentionally coarse: any `text/*` mime and a handful of application
 * types the app language corpus routinely produces. Anything else is safer
 * to encode as a blob and let the agent decide.
 */
function isTextishMime(mimeType: string | null): boolean {
  if (mimeType === null) return false;
  if (mimeType.startsWith('text/')) return true;
  return (
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType === 'application/x-yaml' ||
    mimeType === 'application/yaml' ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/typescript' ||
    mimeType === 'application/toml' ||
    mimeType === 'application/x-sh' ||
    mimeType === 'application/sql'
  );
}

/**
 * Best-effort mime lookup for the file-extension → text/binary split.
 * The list stays workspace-realistic (source, config, docs) rather than
 * exhaustive: a miss falls through to `application/octet-stream` which
 * routes to the blob branch — safe under-approximation, never wrong output.
 */
function mimeFromExtension(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = path.slice(dot + 1).toLowerCase();
  const map: Readonly<Record<string, string>> = {
    md: 'text/markdown',
    mdx: 'text/markdown',
    txt: 'text/plain',
    log: 'text/plain',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    html: 'text/html',
    htm: 'text/html',
    xml: 'application/xml',
    json: 'application/json',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    toml: 'application/toml',
    js: 'application/javascript',
    mjs: 'application/javascript',
    cjs: 'application/javascript',
    ts: 'application/typescript',
    tsx: 'application/typescript',
    py: 'text/x-python',
    rs: 'text/x-rust',
    go: 'text/x-go',
    java: 'text/x-java',
    rb: 'text/x-ruby',
    php: 'text/x-php',
    sh: 'application/x-sh',
    css: 'text/css',
    scss: 'text/x-scss',
    sql: 'application/sql',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    zip: 'application/zip',
  };
  return map[ext] ?? null;
}

/**
 * Encode a file:// URI from a canonical absolute path. Delegates to
 * `pathToFileURL` so Windows `C:\Users\...` paths yield a well-formed
 * `file:///C:/Users/...` URI rather than a percent-encoded backslash mess.
 */
function fileUri(absPath: string): string {
  return pathToFileURL(absPath).href;
}

/** Cap on inline-embedded file size — 512 KiB is generous enough for source
 *  and config files, small enough that a rogue attachment can't inflate one
 *  prompt into a multi-megabyte payload. Files above this fall back to
 *  `resource_link` so the reference survives without shipping the bytes. */
const EMBED_MAX_BYTES = 512 * 1024;

/**
 * Resolver contract the caller provides — a `confineToContentDir`-style
 * check that yields `{abs, rel}` on success and throws on escape. Injected
 * so the helper stays pure and testable without wiring the full server.
 */
export type AttachmentPathResolver = (
  requestedPath: string,
) => Promise<{ abs: string; rel: string }>;

/** Optional overrides — the tests inject fakes so no real fs is touched. */
export interface ConversionDeps {
  readonly readFile?: typeof readFile;
  readonly stat?: typeof stat;
}

/**
 * Convert one `AttachmentPart` into zero-or-one ACP `ContentBlock`. Zero
 * covers the drop paths (unsupported by the agent, path escape, missing
 * file) — the caller keeps the reason and emits a warning on the thread's
 * `agent_stderr` channel so the user can see why an attachment went
 * missing. Never throws for a client-side data problem.
 */
export async function partToBlock(
  part: AttachmentPart,
  capabilities: PromptCapabilities | null | undefined,
  resolve: AttachmentPathResolver,
  deps: ConversionDeps = {},
): Promise<{ readonly block: ContentBlock } | { readonly dropped: true; readonly reason: string }> {
  const readFileImpl = deps.readFile ?? readFile;
  const statImpl = deps.stat ?? stat;

  if (part.kind === 'image') {
    if (capabilities?.image !== true) {
      return { dropped: true, reason: `agent does not accept images (${part.name})` };
    }
    return {
      block: { type: 'image', data: part.data, mimeType: part.mimeType },
    };
  }

  if (part.kind === 'blob') {
    // An OS-picked / dropped non-image file. `EmbeddedResource` is the only
    // block type that carries arbitrary contents inline — `resource_link`
    // would require a URI the agent can read, which an external path is
    // not. Route by encoding: utf-8 payload as `TextResourceContents`,
    // base64 payload as `BlobResourceContents`.
    //
    // Gated on `embeddedContext`: an agent that didn't advertise it can
    // (and does) reject an unexpected `resource` block and close its own
    // session mid-turn — that surfaces to the user as "reconnecting to
    // agent service" and the whole message disappears. Fall back to text
    // by inlining the file's contents into the user prompt so the ask
    // still lands.
    if (capabilities?.embeddedContext !== true) {
      const inlined = part.textPayload
        ? part.data
        : `[binary attachment ${part.name} (${part.mimeType || 'application/octet-stream'}) — this agent doesn't accept embedded resources]`;
      return {
        block: {
          type: 'text',
          text: `\n\n--- Attachment: ${part.name} ---\n${inlined}\n--- End attachment ---`,
        },
      };
    }
    // `attachment:` synthetic URI — never resolves as a real path, so an
    // agent that echoes it back can't accidentally follow it out of the
    // workspace. Name rides as a URL param for observability.
    const uri = `attachment:///${encodeURIComponent(part.name || 'attachment')}`;
    if (part.textPayload) {
      return {
        block: {
          type: 'resource',
          resource: {
            uri,
            text: part.data,
            ...(part.mimeType !== '' ? { mimeType: part.mimeType } : {}),
          },
        },
      };
    }
    return {
      block: {
        type: 'resource',
        resource: {
          uri,
          blob: part.data,
          ...(part.mimeType !== '' ? { mimeType: part.mimeType } : {}),
        },
      },
    };
  }

  if (part.kind === 'folder') {
    let abs: string;
    try {
      ({ abs } = await resolve(part.path));
    } catch (err) {
      return { dropped: true, reason: pathEscapeReason(part.path, err) };
    }
    return {
      block: {
        type: 'resource_link',
        uri: fileUri(abs),
        name: part.name || basename(part.path) || part.path,
        mimeType: 'inode/directory',
      },
    };
  }

  // part.kind === 'file'
  let abs: string;
  try {
    ({ abs } = await resolve(part.path));
  } catch (err) {
    return { dropped: true, reason: pathEscapeReason(part.path, err) };
  }
  let sizeBytes: number | null = null;
  try {
    const info = await statImpl(abs);
    sizeBytes = info.size;
  } catch (err) {
    return { dropped: true, reason: `file unavailable: ${errMessage(err)}` };
  }

  const mimeType = mimeFromExtension(part.path);
  const name = part.name || basename(part.path) || part.path;
  const uri = fileUri(abs);

  // Zed-aligned: only embed CONTENT for text files under the cap when the
  // agent advertised `embeddedContext`. Everything else — binaries (PDF,
  // .zip, screenshots-as-file), large text, no-cap agents — rides as a
  // `ResourceLink` and the agent reads from disk via its own tool. Sending
  // base64 bytes for binaries just inflates the wire without unlocking
  // anything — Claude Code's ACP adapter doesn't translate them into an
  // Anthropic `document` block, so it still routes through its Read tool.
  const canEmbedText =
    capabilities?.embeddedContext === true &&
    sizeBytes <= EMBED_MAX_BYTES &&
    isTextishMime(mimeType);
  if (!canEmbedText) {
    return {
      block: {
        type: 'resource_link',
        uri,
        name,
        ...(mimeType !== null ? { mimeType } : {}),
        ...(sizeBytes !== null ? { size: sizeBytes } : {}),
      },
    };
  }
  let text: string;
  try {
    text = await readFileImpl(abs, 'utf8');
  } catch (err) {
    return { dropped: true, reason: `file read failed: ${errMessage(err)}` };
  }
  return {
    block: {
      type: 'resource',
      resource: {
        uri,
        text,
        ...(mimeType !== null ? { mimeType } : {}),
      },
    },
  };
}

/**
 * Full prompt-payload build: text block first, then each attachment. Drops
 * are reported alongside the blocks so the caller can log them.
 */
export async function buildPromptBlocks(
  text: string,
  attachments: readonly AttachmentPart[] | undefined,
  capabilities: PromptCapabilities | null | undefined,
  resolve: AttachmentPathResolver,
  deps: ConversionDeps = {},
): Promise<{
  readonly blocks: readonly ContentBlock[];
  readonly dropped: ReadonlyArray<{ readonly part: AttachmentPart; readonly reason: string }>;
}> {
  // Prepend `[name](path)` markers so the agent sees the file references
  // inline with the message text — Claude Code's ACP adapter treats
  // trailing ResourceLink blocks as unlabeled context and ignores them
  // without a hint in the prompt. Only file/folder parts get a marker;
  // image parts are self-describing via their inline block.
  const markers: string[] = [];
  for (const part of attachments ?? []) {
    if (part.kind === 'file' || part.kind === 'folder') {
      markers.push(`[${part.name || part.path}](${part.path})`);
    }
  }
  const agentText =
    markers.length > 0
      ? text === ''
        ? markers.join(' ')
        : `${markers.join(' ')}\n\n${text}`
      : text;
  const blocks: ContentBlock[] = [{ type: 'text', text: agentText }];
  const dropped: Array<{ part: AttachmentPart; reason: string }> = [];
  for (const part of attachments ?? []) {
    const outcome = await partToBlock(part, capabilities, resolve, deps);
    if ('block' in outcome) blocks.push(outcome.block);
    else dropped.push({ part, reason: outcome.reason });
  }
  return { blocks, dropped };
}

function pathEscapeReason(requested: string, err: unknown): string {
  const msg = errMessage(err);
  return `attachment path refused: ${requested} (${msg})`;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
