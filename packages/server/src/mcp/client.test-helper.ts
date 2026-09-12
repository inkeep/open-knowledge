import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function connectMcpTestClient(
  url: string,
  identity?: { name?: string; version?: string },
): Promise<Client> {
  const client = new Client({
    name: identity?.name ?? 'integration-test',
    version: identity?.version ?? '0.0.0',
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}
