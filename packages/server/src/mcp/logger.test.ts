import { describe as _bunDescribe, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';

// Skip-on-CI gate (oven-sh/bun#11892): simple-git fixture pattern in MCP
// test setup spawns git children that Bun fails to reap on ubuntu-latest
// GHA runners; post-test cgroup never drains, hanging test (test) at the
// 15-min timeout. Tests run normally locally; follow-up PR will migrate
// fixtures to execFileSync.
const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getCurrentMcpLogger, McpLogger, runWithMcpLogger } from './logger.ts';

describe('McpLogger', () => {
  let stderrLines: string[];
  let stderrSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn> | undefined;
  let tmpLogDir: string | undefined;
  let originalMcpDebug: string | undefined;
  let originalDebug: string | undefined;
  let originalLogFile: string | undefined;

  beforeEach(() => {
    stderrLines = [];
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    }) as never);

    originalMcpDebug = process.env.MCP_DEBUG;
    originalDebug = process.env.DEBUG;
    originalLogFile = process.env.OK_LOG_FILE;
    delete process.env.MCP_DEBUG;
    delete process.env.DEBUG;
    delete process.env.OK_LOG_FILE;
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    warnSpy?.mockRestore();
    warnSpy = undefined;

    if (originalMcpDebug === undefined) delete process.env.MCP_DEBUG;
    else process.env.MCP_DEBUG = originalMcpDebug;

    if (originalDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = originalDebug;

    if (originalLogFile === undefined) delete process.env.OK_LOG_FILE;
    else process.env.OK_LOG_FILE = originalLogFile;

    if (tmpLogDir) {
      rmSync(tmpLogDir, { recursive: true, force: true });
      tmpLogDir = undefined;
    }
  });

  test('gates debug logs behind env flags', () => {
    const logger = new McpLogger();

    logger.debug('hidden');
    expect(stderrLines).toHaveLength(0);

    process.env.MCP_DEBUG = '1';
    logger.debug('shown');

    expect(stderrLines).toHaveLength(1);
    const entry = JSON.parse(stderrLines[0] ?? '');
    expect(entry.level).toBe('debug');
    expect(entry.msg).toBe('shown');
  });

  test('child logger reuses sessionId and rotates corrId', () => {
    const logger = new McpLogger('mcp');
    logger.info('parent');

    const child = logger.child('mcp-tool');
    child.info('child');

    const parentEntry = JSON.parse(stderrLines[0] ?? '');
    const childEntry = JSON.parse(stderrLines[1] ?? '');

    expect(childEntry.sessionId).toBe(parentEntry.sessionId);
    expect(childEntry.corrId).not.toBe(parentEntry.corrId);
    expect(childEntry.component).toBe('mcp-tool');
  });

  test('warns when OK_LOG_FILE cannot be written', () => {
    tmpLogDir = mkdtempSync(resolve(tmpdir(), 'ok-mcp-logger-'));
    process.env.OK_LOG_FILE = tmpLogDir;
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    const logger = new McpLogger();
    logger.info('persist this');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0] as [string];
    expect(message).toContain('[mcp-logger] Failed to write to OK_LOG_FILE');
  });

  test('writes OK_LOG_FILE as single-line JSON while keeping stderr as JSON lines', () => {
    tmpLogDir = mkdtempSync(resolve(tmpdir(), 'ok-mcp-logger-'));
    const logFile = join(tmpLogDir, 'mcp.log');
    process.env.OK_LOG_FILE = logFile;

    const logger = new McpLogger('mcp');
    logger.info('tool finish', {
      tool: 'preview_url',
      requestId: 'req-123',
      result: {
        previewUrl: 'http://localhost:4242/#/notes/test',
        previewUrlSource: 'lock',
      },
    });

    const stderrEntry = JSON.parse(stderrLines[0] ?? '');
    expect(stderrEntry.msg).toBe('tool finish');
    expect(stderrEntry.tool).toBe('preview_url');

    const fileLine = readFileSync(logFile, 'utf-8');
    expect(fileLine).toBe(stderrLines[0]);

    const fileEntry = JSON.parse(fileLine);
    expect(fileEntry.msg).toBe('tool finish');
    expect(fileEntry.tool).toBe('preview_url');
    expect(fileEntry.requestId).toBe('req-123');
    expect(fileEntry.result).toEqual({
      previewUrl: 'http://localhost:4242/#/notes/test',
      previewUrlSource: 'lock',
    });
  });

  test('keeps every OK_LOG_FILE entry on a single JSON line regardless of context size', () => {
    tmpLogDir = mkdtempSync(resolve(tmpdir(), 'ok-mcp-logger-'));
    const logFile = join(tmpLogDir, 'mcp.log');
    process.env.OK_LOG_FILE = logFile;

    const logger = new McpLogger('mcp');

    logger.info('small context', { backoffMs: 8000, attempt: 3 });

    logger.info('large context', {
      tool: 'preview_url',
      result: {
        previewUrl: 'http://localhost:4242/#/notes/very/long/path/test',
        previewUrlSource: 'lock',
        someOtherField: 'with quite a bit of data',
      },
      requestId: 'req-123',
    });

    const lines = readFileSync(logFile, 'utf-8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);

    const [smallEntry, largeEntry] = lines.map((line) => JSON.parse(line));
    expect(smallEntry).toMatchObject({
      msg: 'small context',
      backoffMs: 8000,
      attempt: 3,
    });
    expect(largeEntry).toMatchObject({
      msg: 'large context',
      tool: 'preview_url',
      requestId: 'req-123',
      result: {
        previewUrl: 'http://localhost:4242/#/notes/very/long/path/test',
        previewUrlSource: 'lock',
        someOtherField: 'with quite a bit of data',
      },
    });
  });

  test('runWithMcpLogger binds the current logger across async work', async () => {
    const logger = new McpLogger();

    expect(getCurrentMcpLogger()).toBeUndefined();

    await runWithMcpLogger(logger, async () => {
      expect(getCurrentMcpLogger()).toBe(logger);
      await Promise.resolve();
      expect(getCurrentMcpLogger()).toBe(logger);
    });

    expect(getCurrentMcpLogger()).toBeUndefined();
  });
});
