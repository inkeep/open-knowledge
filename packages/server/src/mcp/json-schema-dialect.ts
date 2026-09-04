import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema, type ServerResult } from '@modelcontextprotocol/sdk/types.js';

export const JSON_SCHEMA_DIALECT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

const LIST_TOOLS_METHOD = 'tools/list';

type RequestHandler = (request: unknown, extra: unknown) => ServerResult | Promise<ServerResult>;

interface ListToolsShape {
  tools?: Array<{
    inputSchema?: { $schema?: string };
    outputSchema?: { $schema?: string };
  }>;
}

export function installJsonSchemaDialect(server: McpServer): void {
  const target = server as unknown as { __jsonSchemaDialectInstalled?: true };
  if (target.__jsonSchemaDialectInstalled === true) {
    return;
  }

  const inner = server.server as unknown as {
    _requestHandlers?: Map<string, RequestHandler>;
  };
  const original = inner._requestHandlers?.get(LIST_TOOLS_METHOD);
  if (typeof original !== 'function') {
    console.warn(
      `[json-schema-dialect] No ${LIST_TOOLS_METHOD} handler found. Either the SDK internals changed, or this ran before tools were registered. Tool schemas will keep the SDK's draft-07 dialect.`,
    );
    return;
  }

  server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await original(request, extra);
    for (const tool of (result as ListToolsShape).tools ?? []) {
      if (tool.inputSchema) tool.inputSchema.$schema = JSON_SCHEMA_DIALECT_2020_12;
      if (tool.outputSchema) tool.outputSchema.$schema = JSON_SCHEMA_DIALECT_2020_12;
    }
    return result;
  });

  target.__jsonSchemaDialectInstalled = true;
}
