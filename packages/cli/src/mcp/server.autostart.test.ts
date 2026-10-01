import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from 'vitest';

test.each(['disabled', 'failed-start'])(
  'ok mcp teaches manual startup on a real tool call when autostart is %s',
  async (mode) => {
    const project = mkdtempSync(join(tmpdir(), 'ok-mcp-autostart-'));
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    mkdirSync(join(project, '.ok'));
    writeFileSync(join(project, '.ok/config.yml'), '{}\n');
    const launcher = join(project, 'launcher.mjs');
    writeFileSync(
      launcher,
      `if (process.argv[2] === 'start') { process.stderr.write('fixture startup failed\\n'); process.exitCode = 1; } else { await import(${JSON.stringify(pathToFileURL(join(packageRoot, 'src/cli.ts')).href)}); }\n`,
    );
    const client = new Client({ name: 'autostart-recovery-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        '--import',
        'tsx',
        '--conditions=development',
        launcher,
        '--cwd',
        project,
        '--log-level',
        'silent',
        'mcp',
        '--no-bundle-proxy',
      ],
      cwd: packageRoot,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        OK_MCP_AUTOSTART: mode === 'disabled' ? '0' : '1',
        OK_MCP_SPAWN_TIMEOUT_MS: '5000',
        OK_BUNDLE_PROXY: '0',
      },
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'write',
        arguments: { cwd: project, document: { path: 'draft', content: '# Draft\n' } },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('Run `ok start` in the target project'),
        }),
      ]);
      expect(result.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining('retry this tool') }),
      ]);
      expect(result.content).toEqual([
        expect.objectContaining({
          text: expect.stringContaining(
            'Do not fall back to native file edits for OpenKnowledge content',
          ),
        }),
      ]);
      if (mode === 'failed-start') {
        expect(result.content).toEqual([
          expect.objectContaining({
            text: expect.stringContaining(
              'server did not start within 5000ms stderr:\nfixture startup failed',
            ),
          }),
        ]);
      }
      expect(existsSync(join(project, 'draft.md'))).toBe(false);
      expect(existsSync(join(project, '.ok/local/server.lock'))).toBe(false);
    } finally {
      await client.close();
      await transport.close();
      rmSync(project, { recursive: true, force: true });
    }
  },
  30_000,
);
