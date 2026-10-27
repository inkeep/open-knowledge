import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { posix, relative, resolve, sep } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  type DualTransportMcpRig,
  startDualTransportMcpRig,
} from './mcp-dual-transport-rig.test-helper.ts';

const ATTACHMENT_FOLDER = 'attachments';
const ATTACHMENT_FOLDER_SETTING = `/${ATTACHMENT_FOLDER}`;

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const TRANSPORTS = [
  { arm: 'in-process localApi', transport: 'local' },
  { arm: 'HTTP fetch', transport: 'http' },
] as const;

type Transport = (typeof TRANSPORTS)[number]['transport'];

type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: { asset?: { path?: string } };
  isError?: boolean;
};

interface AssetWrite {
  readonly reply: string;
  readonly structuredPath: string | undefined;
  readonly written: readonly string[];
}

let rig: DualTransportMcpRig;

function writeAttachmentFolderConfig(contentDir: string, attachmentFolderPath: string): void {
  writeFileSync(
    resolve(contentDir, OK_DIR, 'config.yml'),
    `content:\n  attachmentFolderPath: '${attachmentFolderPath}'\n`,
  );
}

function withAttachmentFolderConfig(attachmentFolderPath: string): void {
  beforeAll(() => writeAttachmentFolderConfig(rig.contentDir, attachmentFolderPath));
  afterAll(() => writeAttachmentFolderConfig(rig.contentDir, ATTACHMENT_FOLDER_SETTING));
}

function replyText(result: ToolResult): string {
  return result.content?.map((c) => c.text ?? '').join('\n') ?? '';
}

beforeAll(async () => {
  rig = await startDualTransportMcpRig({
    tmpPrefix: 'ok-mcp-asset-placement-',
    clientName: 'asset-placement-suite',
    seed: (contentDir) => {
      const okDir = resolve(contentDir, OK_DIR);
      mkdirSync(okDir, { recursive: true });
      writeAttachmentFolderConfig(contentDir, ATTACHMENT_FOLDER_SETTING);
      writeFileSync(resolve(okDir, '.gitignore'), '', 'utf-8');
      mkdirSync(resolve(contentDir, 'docs'), { recursive: true });
      writeFileSync(resolve(contentDir, 'docs', 'readme.md'), '# Docs\n', 'utf-8');
    },
  });
}, 60_000);

afterAll(async () => {
  await rig?.close();
});

const clientFor = (transport: Transport): Client =>
  transport === 'local' ? rig.localClient : rig.httpClient;

function listContentFiles(dir: string = rig.contentDir, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === OK_DIR || entry.name === '.git') continue;
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) listContentFiles(abs, out);
    else out.push(relative(rig.contentDir, abs).split(sep).join('/'));
  }
  return out;
}

async function writeAsset(transport: Transport, path: string, tag: string): Promise<AssetWrite> {
  const stem = posix.basename(path, posix.extname(path));
  const before = new Set(listContentFiles());
  const result = (await clientFor(transport).callTool({
    name: 'write',
    arguments: {
      asset: { path, content: Buffer.concat([PNG_1X1, Buffer.from(tag)]).toString('base64') },
    },
  })) as ToolResult;
  const reply = replyText(result);
  expect(result.isError ?? false, reply).toBe(false);
  return {
    reply,
    structuredPath: result.structuredContent?.asset?.path,
    written: listContentFiles().filter((p) => !before.has(p) && posix.basename(p).startsWith(stem)),
  };
}

const pathToken = (path: string): RegExp =>
  new RegExp(`(?:^|[\\s\`'"])/?${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-])`, 'm');

describe(`MCP write({ asset }) with content.attachmentFolderPath: ${ATTACHMENT_FOLDER_SETTING}`, () => {
  describe('an explicit folder in asset.path decides where the bytes land', () => {
    test.each(TRANSPORTS)('$arm: docs/<name> lands in docs/', async ({ transport }) => {
      const requested = `docs/${transport}-placed.png`;
      const { written } = await writeAsset(transport, requested, `${transport}-placed`);
      expect(written).toEqual([requested]);
    });
  });

  describe('a bare name follows the configured attachment folder', () => {
    test.each(TRANSPORTS)('$arm: <name> lands in the attachment folder', async ({ transport }) => {
      const { written } = await writeAsset(transport, `${transport}-bare.png`, `${transport}-bare`);
      expect(written).toEqual([`${ATTACHMENT_FOLDER}/${transport}-bare.png`]);
    });
  });

  describe('the reply names the path actually written', () => {
    test.each(TRANSPORTS)(
      '$arm: a bare name redirected into the attachment folder',
      async ({ transport }) => {
        const requested = `${transport}-redirected.png`;
        const { reply, structuredPath, written } = await writeAsset(
          transport,
          requested,
          `${transport}-redirected`,
        );
        expect(written).toHaveLength(1);
        const [writtenPath = ''] = written;
        expect(writtenPath).not.toBe(requested);
        expect(structuredPath).toBe(writtenPath);
        expect(reply).toMatch(pathToken(writtenPath));
      },
    );

    test.each(TRANSPORTS)(
      '$arm: a same-name collision the server renamed',
      async ({ transport }) => {
        const requested = `docs/${transport}-dup.png`;
        const first = await writeAsset(transport, requested, `${transport}-dup-first`);
        expect(first.written).toHaveLength(1);
        const { reply, structuredPath, written } = await writeAsset(
          transport,
          requested,
          `${transport}-dup-second`,
        );
        expect(written).toHaveLength(1);
        const [writtenPath = ''] = written;
        expect(posix.basename(writtenPath)).not.toBe(posix.basename(requested));
        expect(structuredPath).toBe(writtenPath);
        expect(reply).toMatch(pathToken(writtenPath));
      },
    );
  });
});

describe('MCP write({ asset }) with content.attachmentFolderPath: ./{{filename}}.assets', () => {
  withAttachmentFolderConfig('./{{filename}}.assets');

  test.each(TRANSPORTS)(
    '$arm: a bare name has no document, so it skips the {{filename}} folder',
    async ({ transport }) => {
      const { written } = await writeAsset(
        transport,
        `${transport}-nodoc.png`,
        `${transport}-nodoc`,
      );
      expect(written).toEqual([`${transport}-nodoc.png`]);
    },
  );

  test.each(TRANSPORTS)('$arm: an explicit folder still wins', async ({ transport }) => {
    const requested = `docs/${transport}-explicit.png`;
    const { written } = await writeAsset(transport, requested, `${transport}-explicit`);
    expect(written).toEqual([requested]);
  });
});

describe('MCP write({ asset }) with content.attachmentFolderPath: /uploads/{{filename}}', () => {
  withAttachmentFolderConfig('/uploads/{{filename}}');

  test.each(TRANSPORTS)(
    '$arm: a bare name has no document, so it is placed as with ./',
    async ({ transport }) => {
      const { written } = await writeAsset(
        transport,
        `${transport}-uploads-nodoc.png`,
        `${transport}-uploads-nodoc`,
      );
      expect(written).toEqual([`${transport}-uploads-nodoc.png`]);
    },
  );
});

describe('MCP write({ asset }) with content.attachmentFolderPath: ./{{FILENAME}}.assets', () => {
  withAttachmentFolderConfig('./{{FILENAME}}.assets');

  test.each(TRANSPORTS)(
    '$arm: the refusal reply names the setting and the unknown variable',
    async ({ transport }) => {
      const result = (await clientFor(transport).callTool({
        name: 'write',
        arguments: {
          asset: { path: `${transport}-refused.png`, content: PNG_1X1.toString('base64') },
        },
      })) as ToolResult;
      const reply = replyText(result);
      expect(result.isError).toBe(true);
      expect(reply).toContain('content.attachmentFolderPath');
      expect(reply).toContain('{{FILENAME}}');
    },
  );
});

describe('MCP write({ asset }) with a bare content.attachmentFolderPath saved by older versions', () => {
  withAttachmentFolderConfig(ATTACHMENT_FOLDER);

  test.each(TRANSPORTS)(
    '$arm: a legacy bare value still loads and places a bare-name asset in attachments/',
    async ({ transport }) => {
      const { written } = await writeAsset(
        transport,
        `${transport}-legacy-bare.png`,
        `${transport}-legacy-bare`,
      );
      expect(written).toEqual([`${ATTACHMENT_FOLDER}/${transport}-legacy-bare.png`]);
    },
  );
});
