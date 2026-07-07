import { describe as _bunDescribe, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';

// Skip-on-CI gate (oven-sh/bun#11892): simple-git fixture pattern in MCP
// test setup spawns git children that Bun fails to reap on ubuntu-latest
// GHA runners; post-test cgroup never drains, hanging test (test) at the
// 15-min timeout. Tests run normally locally; follow-up PR will migrate
// fixtures to execFileSync.
const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

import { getCurrentMcpLogger, McpLogger } from './logger.ts';
import { createLoggedServer, wrapToolHandlerForLogging } from './tool-logging.ts';
import { textPlusStructured } from './tools/shared.ts';

describe('tool logging wrapper', () => {
  let stderrLines: string[];
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stderrLines = [];
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    }) as never);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  test('wrapToolHandlerForLogging logs start and finish with summarized args/results', async () => {
    const logger = new McpLogger('mcp');
    const handler = wrapToolHandlerForLogging(
      'write_document',
      async () => {
        expect(getCurrentMcpLogger()).toBeDefined();
        return textPlusStructured('Written successfully.', {
          previewUrl: 'http://localhost:4242/#/notes/test',
          previewUrlSource: 'lock',
          warning: {
            message: 'No preview attached.',
            previewUrl: 'http://localhost:4242/#/notes/test',
          },
        });
      },
      {
        logger,
        identityRef: {
          current: {
            connectionId: '12345678-90ab-cdef-1234-567890abcdef',
            displayName: 'Codex',
            colorSeed: 'Codex',
            clientInfo: { name: 'codex', version: '1.0.0' },
          },
        },
      },
    );

    await handler(
      {
        docName: 'notes/test',
        markdown: '# Heading\nBody',
        position: 'replace',
      },
      {
        requestId: 'req-123',
        sessionId: 'transport-456',
        signal: new AbortController().signal,
      },
    );

    expect(stderrLines).toHaveLength(2);

    const start = JSON.parse(stderrLines[0] ?? '');
    const finish = JSON.parse(stderrLines[1] ?? '');

    expect(start.msg).toBe('tool start');
    expect(start.tool).toBe('write_document');
    expect(start.requestId).toBe('req-123');
    expect(start.transportSessionId).toBe('transport-456');
    expect(start.args.docName).toBe('notes/test');
    expect(start.args.markdown).toEqual({
      redacted: true,
      type: 'string',
      length: 14,
      lines: 2,
    });
    expect(start.agent).toEqual({
      connectionId: '12345678',
      displayName: 'Codex',
      clientName: 'codex',
    });

    expect(finish.msg).toBe('tool finish');
    expect(finish.tool).toBe('write_document');
    expect(finish.requestId).toBe('req-123');
    expect(finish.result).toMatchObject({
      isError: false,
      previewUrl: 'http://localhost:4242/#/notes/test',
      previewUrlSource: 'lock',
      warning: true,
      warningPreviewUrl: 'http://localhost:4242/#/notes/test',
    });
    expect(typeof finish.durationMs).toBe('number');
  });

  test('createLoggedServer wraps handlers during tool registration', async () => {
    const logger = new McpLogger('mcp');
    let capturedHandler: ((...args: unknown[]) => unknown) | undefined;
    const fakeServer = {
      tool: (...args: unknown[]) => {
        capturedHandler = args.at(-1) as (...args: unknown[]) => unknown;
        return 'registered';
      },
    };

    const wrapped = createLoggedServer(fakeServer as never, { logger });
    const originalHandler = async () => textPlusStructured('ok', { previewUrl: null });

    expect(
      (wrapped as unknown as { tool: (...args: unknown[]) => unknown }).tool(
        'preview_url',
        'desc',
        { docName: 'string' },
        originalHandler,
      ),
    ).toBe('registered');
    expect(capturedHandler).toBeDefined();
    expect(capturedHandler).not.toBe(originalHandler);

    const wrappedHandler = capturedHandler;
    if (!wrappedHandler) {
      throw new Error('Expected wrapped handler to be captured');
    }

    await wrappedHandler(
      { docName: 'notes/test' },
      { requestId: 'req-456', signal: new AbortController().signal },
    );

    const finish = JSON.parse(stderrLines[1] ?? '');
    expect(finish.tool).toBe('preview_url');
    expect(finish.result.previewUrl).toBeNull();
  });

  test('createLoggedServer wraps handlers during registerTool registration', async () => {
    const logger = new McpLogger('mcp');
    let capturedHandler: ((...args: unknown[]) => unknown) | undefined;
    const fakeServer = {
      tool: () => 'legacy-registered',
      registerTool: (name: string, config: unknown, handler: (...args: unknown[]) => unknown) => {
        expect(name).toBe('read_document');
        expect(config).toEqual({
          description: 'desc',
          inputSchema: { docName: 'string' },
        });
        capturedHandler = handler;
        return 'registered-tool';
      },
    };

    const wrapped = createLoggedServer(fakeServer as never, { logger });
    const originalHandler = async () =>
      textPlusStructured('ok', { previewUrl: null, documents: ['a', 'b'] });

    expect(
      (
        wrapped as unknown as {
          registerTool: (
            name: string,
            config: unknown,
            handler: (...args: unknown[]) => unknown,
          ) => unknown;
        }
      ).registerTool(
        'read_document',
        { description: 'desc', inputSchema: { docName: 'string' } },
        originalHandler,
      ),
    ).toBe('registered-tool');
    expect(capturedHandler).toBeDefined();
    expect(capturedHandler).not.toBe(originalHandler);

    const wrappedHandler = capturedHandler;
    if (!wrappedHandler) {
      throw new Error('Expected wrapped registerTool handler to be captured');
    }

    await wrappedHandler(
      { docName: 'notes/test' },
      { requestId: 'req-789', signal: new AbortController().signal },
    );

    const finish = JSON.parse(stderrLines[1] ?? '');
    expect(finish.tool).toBe('read_document');
    expect(finish.requestId).toBe('req-789');
    expect(finish.result.previewUrl).toBeNull();
    expect(finish.result.documentsCount).toBe(2);
  });
});
