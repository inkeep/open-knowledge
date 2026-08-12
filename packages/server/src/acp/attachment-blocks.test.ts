import type { PromptCapabilities } from '@agentclientprotocol/sdk';
import type { AttachmentPart } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { describe, expect, test, vi } from 'vitest';
import {
  type AttachmentPathResolver,
  buildPromptBlocks,
  partToBlock,
} from './attachment-blocks.ts';

/** A resolver that pretends every path is already inside the content root. */
const acceptingResolver: AttachmentPathResolver = async (requested) => ({
  abs: `/root/${requested}`,
  rel: requested,
});

/** A resolver that always throws — simulates `confineToContentDir` refusing
 *  an escape. `partToBlock` catches it and returns a dropped outcome. */
const rejectingResolver: AttachmentPathResolver = async (requested) => {
  throw new Error(`path escapes: ${requested}`);
};

/** Stat/readFile stubs — sized so the file falls under the embed cap. Size
 *  comes from the buffer OR the text, whichever the assertion cares about. */
function makeDeps(text = 'hello world', bytes = Buffer.from(text)) {
  return {
    stat: vi.fn(async () => ({ size: bytes.length }) as never),
    readFile: vi.fn(async (_p: unknown, encoding?: unknown) => {
      return encoding === 'utf8' ? text : bytes;
    }) as never,
  };
}

describe('partToBlock — images', () => {
  test('image + capabilities.image === true → image block', async () => {
    const part: AttachmentPart = {
      kind: 'image',
      data: 'AAAA',
      mimeType: 'image/png',
      name: 'shot.png',
    };
    const caps: PromptCapabilities = { image: true };
    const out = await partToBlock(part, caps, acceptingResolver);
    expect(out).toEqual({ block: { type: 'image', data: 'AAAA', mimeType: 'image/png' } });
  });

  test('image without capabilities.image → dropped with reason', async () => {
    const part: AttachmentPart = {
      kind: 'image',
      data: 'AAAA',
      mimeType: 'image/png',
      name: 'shot.png',
    };
    const out = await partToBlock(part, {}, acceptingResolver);
    expect(out).toEqual({
      dropped: true,
      reason: expect.stringContaining('does not accept images'),
    });
  });
});

describe('partToBlock — folders', () => {
  test('folder → resource_link with inode/directory mimetype', async () => {
    const part: AttachmentPart = { kind: 'folder', path: 'specs/foo', name: 'foo' };
    const out = await partToBlock(part, {}, acceptingResolver);
    expect(out).toEqual({
      block: {
        type: 'resource_link',
        uri: 'file:///root/specs/foo',
        name: 'foo',
        mimeType: 'inode/directory',
      },
    });
  });

  test('folder that escapes the content root → dropped', async () => {
    const part: AttachmentPart = { kind: 'folder', path: '../secrets', name: 'secrets' };
    const out = await partToBlock(part, {}, rejectingResolver);
    expect(out).toEqual({
      dropped: true,
      reason: expect.stringContaining('attachment path refused'),
    });
  });
});

describe('partToBlock — files', () => {
  test('file WITHOUT embeddedContext → resource_link with mimeType + size', async () => {
    const part: AttachmentPart = { kind: 'file', path: 'notes.md', name: 'notes.md' };
    const deps = makeDeps('# hi');
    const out = await partToBlock(part, {}, acceptingResolver, deps);
    expect(out).toEqual({
      block: {
        type: 'resource_link',
        uri: 'file:///root/notes.md',
        name: 'notes.md',
        mimeType: 'text/markdown',
        size: 4,
      },
    });
    // Never reads bytes when embedding isn't allowed — a resource_link is a
    // reference, not a payload.
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  test('text file WITH embeddedContext → resource + TextResourceContents', async () => {
    const part: AttachmentPart = { kind: 'file', path: 'notes.md', name: 'notes.md' };
    const caps: PromptCapabilities = { embeddedContext: true };
    const deps = makeDeps('# hi');
    const out = await partToBlock(part, caps, acceptingResolver, deps);
    expect(out).toEqual({
      block: {
        type: 'resource',
        resource: {
          uri: 'file:///root/notes.md',
          text: '# hi',
          mimeType: 'text/markdown',
        },
      },
    });
  });

  test('binary file WITH embeddedContext → resource_link (Zed-aligned; never inline bytes)', async () => {
    // Zed's rule: binary files ride as `ResourceLink`, not `EmbeddedResource`.
    // Sending base64 payload for a PDF/image-as-file just inflates the wire —
    // agents like Claude Code don't translate blob resources into their
    // native document/vision paths, they fall back to their Read tool, which
    // works fine off a `file://` URI alone.
    const part: AttachmentPart = { kind: 'file', path: 'assets/logo.png', name: 'logo.png' };
    const caps: PromptCapabilities = { embeddedContext: true };
    const bytes = Buffer.from([1, 2, 3, 4]);
    const deps = makeDeps('', bytes);
    const out = await partToBlock(part, caps, acceptingResolver, deps);
    expect(out).toEqual({
      block: {
        type: 'resource_link',
        uri: 'file:///root/assets/logo.png',
        name: 'logo.png',
        mimeType: 'image/png',
        size: bytes.length,
      },
    });
    // And crucially: no readFile call happened, because binaries are pure
    // references — the agent reads bytes off disk via its own tool.
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  test('oversized file falls back to resource_link even under embeddedContext', async () => {
    const part: AttachmentPart = { kind: 'file', path: 'big.txt', name: 'big.txt' };
    const caps: PromptCapabilities = { embeddedContext: true };
    const deps = {
      stat: vi.fn(async () => ({ size: 10 * 1024 * 1024 }) as never),
      readFile: vi.fn(),
    };
    const out = await partToBlock(part, caps, acceptingResolver, deps as never);
    expect(out).toHaveProperty('block.type', 'resource_link');
    // Never reads bytes for a file above the cap — the resource_link is a
    // reference, so shipping the bytes would defeat the point of the cap.
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  test('missing file → dropped with the fs error message', async () => {
    const part: AttachmentPart = { kind: 'file', path: 'gone.md', name: 'gone.md' };
    const deps = {
      stat: vi.fn(async () => {
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      }) as never,
      readFile: vi.fn(),
    };
    const out = await partToBlock(part, {}, acceptingResolver, deps);
    expect(out).toEqual({
      dropped: true,
      reason: expect.stringContaining('file unavailable'),
    });
  });
});

describe('buildPromptBlocks', () => {
  test('leads with the text block (with file/folder markers prepended), then appends parts', async () => {
    const parts: AttachmentPart[] = [
      { kind: 'folder', path: 'specs', name: 'specs' },
      { kind: 'image', data: 'AAAA', mimeType: 'image/png', name: 'shot.png' },
    ];
    const caps: PromptCapabilities = { image: true };
    const { blocks, dropped } = await buildPromptBlocks(
      'look at this',
      parts,
      caps,
      acceptingResolver,
    );
    expect(dropped).toEqual([]);
    expect(blocks).toEqual([
      // File/folder attachments get a `[name](path)` marker inline in the
      // text so Claude Code's ACP adapter correlates the ResourceLink block
      // against the message. Images are self-describing (they ride inline
      // as a native ImageContent block) and get no marker.
      { type: 'text', text: '[specs](specs)\n\nlook at this' },
      {
        type: 'resource_link',
        uri: 'file:///root/specs',
        name: 'specs',
        mimeType: 'inode/directory',
      },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ]);
  });

  test('file-only attachment on empty text → marker becomes the whole text', async () => {
    const parts: AttachmentPart[] = [{ kind: 'file', path: 'notes.md', name: 'notes.md' }];
    const { blocks } = await buildPromptBlocks('', parts, {}, acceptingResolver, makeDeps('# hi'));
    expect(blocks[0]).toEqual({ type: 'text', text: '[notes.md](notes.md)' });
  });

  test('a dropped part does not stop later parts from converting', async () => {
    const parts: AttachmentPart[] = [
      { kind: 'image', data: 'AAAA', mimeType: 'image/png', name: 'shot.png' },
      { kind: 'folder', path: 'specs', name: 'specs' },
    ];
    // capabilities.image is false → the image drops, the folder still lands
    const { blocks, dropped } = await buildPromptBlocks('here', parts, {}, acceptingResolver);
    expect(blocks.map((b) => b.type)).toEqual(['text', 'resource_link']);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.part.kind).toBe('image');
  });

  test('undefined attachments → text-only block, no drops', async () => {
    const { blocks, dropped } = await buildPromptBlocks(
      'plain',
      undefined,
      undefined,
      acceptingResolver,
    );
    expect(blocks).toEqual([{ type: 'text', text: 'plain' }]);
    expect(dropped).toEqual([]);
  });
});
