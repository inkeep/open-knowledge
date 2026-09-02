import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ContentBlock, PromptCapabilities } from '@agentclientprotocol/sdk';
import type { AttachmentPart } from '@inkeep/open-knowledge-core/acp/thread-protocol';

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

function fileUri(absPath: string): string {
  return pathToFileURL(absPath).href;
}

const EMBED_MAX_BYTES = 512 * 1024;

export type AttachmentPathResolver = (
  requestedPath: string,
) => Promise<{ abs: string; rel: string }>;

export interface ConversionDeps {
  readonly readFile?: typeof readFile;
  readonly stat?: typeof stat;
}

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
