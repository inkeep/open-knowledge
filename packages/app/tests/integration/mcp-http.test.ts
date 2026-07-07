import { expect, test } from 'bun:test';
import { createTestServer } from './test-harness';

const MCP_PROTOCOL_VERSION = '2025-06-18';

test('POST /mcp serves MCP JSON-RPC over Streamable HTTP', async () => {
  const server = await createTestServer();

  try {
    const init = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'ok-integration-test', version: '0.0.0' },
        },
      }),
    });

    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    const initBody = (await init.json()) as {
      jsonrpc: '2.0';
      id: number;
      result?: { serverInfo?: { name?: string }; protocolVersion?: string };
    };
    expect(initBody.result?.serverInfo?.name).toBe('open-knowledge');
    expect(initBody.result?.protocolVersion).toBeTruthy();

    const initialized = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': sessionId as string,
        'mcp-protocol-version': initBody.result?.protocolVersion ?? MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(initialized.status).toBe(202);

    const tools = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': sessionId as string,
        'mcp-protocol-version': initBody.result?.protocolVersion ?? MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });

    expect(tools.status).toBe(200);
    const toolsBody = (await tools.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    const toolNames = toolsBody.result?.tools?.map((tool) => tool.name) ?? [];
    // Sample the verb surface + the merges/splits: the four CRUD verbs;
    // version -> checkpoint + restore_version; conflict reads -> conflicts;
    // components/palette -> palette.
    expect(toolNames).toContain('exec');
    expect(toolNames).toContain('search');
    expect(toolNames).toContain('write');
    expect(toolNames).toContain('edit');
    expect(toolNames).toContain('delete');
    expect(toolNames).toContain('move');
    expect(toolNames).toContain('links');
    expect(toolNames).toContain('checkpoint');
    expect(toolNames).toContain('restore_version');
    expect(toolNames).toContain('conflicts');
    expect(toolNames).toContain('palette');
    expect(toolNames).not.toContain('read_document');
    expect(toolNames).not.toContain('write_document');
    expect(toolNames).not.toContain('folder_config');
    expect(toolNames).not.toContain('version');
    expect(toolNames).not.toContain('list_conflicts');
  } finally {
    await server.cleanup();
  }
});
