import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

const CLI_ENTRY = resolve(import.meta.dirname, '../../dist/cli.mjs');
const ANCHOR_LINE = /\[mcp\] bundle identity anchor=(.+?) dev=\d+ inode=\d+/;
const ANCHOR_WAIT_MS = 20_000;
const RUN_AS_DARWIN = "Object.defineProperty(process, 'platform', { value: 'darwin' });\n";

let home: string | undefined;

function anchorReportedByBuiltMcp(): Promise<string> {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ok-mcp-anchor-')));
  const runAsDarwin = join(home, 'run-as-darwin.mjs');
  writeFileSync(runAsDarwin, RUN_AS_DARWIN);
  const mcp = spawn(
    process.execPath,
    ['--import', pathToFileURL(runAsDarwin).href, CLI_ENTRY, 'mcp', '--no-bundle-proxy'],
    {
      cwd: home,
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH ?? '', HOME: home },
    },
  );
  let stderr = '';
  let settled = false;
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const fail = (reason: string): void => {
    settled = true;
    clearTimeout(timer);
    mcp.kill('SIGKILL');
    reject(new Error(`${reason}:\n${stderr}`));
  };
  const timer = setTimeout(
    () => fail(`no bundle identity anchor line within ${ANCHOR_WAIT_MS} ms`),
    ANCHOR_WAIT_MS,
  );
  mcp.stderr.setEncoding('utf-8');
  mcp.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    if (settled) return;
    if (stderr.includes('bundle identity watcher off')) {
      fail('ok mcp started no bundle identity watcher');
      return;
    }
    const anchor = ANCHOR_LINE.exec(stderr)?.[1];
    if (anchor === undefined) return;
    settled = true;
    clearTimeout(timer);
    mcp.once('close', () => resolve(anchor));
    mcp.stdin.end();
  });
  mcp.once('error', (err) => {
    settled = true;
    clearTimeout(timer);
    reject(err);
  });
  return promise;
}

describe('the built CLI anchors the macOS MCP upgrade watcher on its entry file', () => {
  beforeAll(() => {
    expect(
      existsSync(CLI_ENTRY),
      `${CLI_ENTRY} is missing. The cli \`test\` turbo task builds it first; a bare vitest run needs \`pnpm --dir packages/cli run build:cli\`.`,
    ).toBe(true);
  });

  afterEach(() => {
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  test(
    'ok mcp watches dist/cli.mjs, the file an upgrade replaces under the same name',
    async () => {
      expect(await anchorReportedByBuiltMcp()).toBe(realpathSync(CLI_ENTRY));
    },
    ANCHOR_WAIT_MS + 5_000,
  );
});
