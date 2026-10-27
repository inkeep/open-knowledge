import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema, type ServerResult } from '@modelcontextprotocol/sdk/types.js';

export const JSON_SCHEMA_DIALECT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

const LIST_TOOLS_METHOD = 'tools/list';

type RequestHandler = (request: unknown, extra: unknown) => ServerResult | Promise<ServerResult>;

const SUBSCHEMA_KEYWORDS = [
  'items',
  'contains',
  'not',
  'propertyNames',
  'if',
  'then',
  'else',
  'additionalProperties',
  'unevaluatedProperties',
  'additionalItems',
  'unevaluatedItems',
  'contentSchema',
] as const;
const SUBSCHEMA_LIST_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items'] as const;
const SUBSCHEMA_MAP_KEYWORDS = [
  'properties',
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
] as const;

type JsonSchemaNode = { [keyword: string]: unknown };

function isSchemaNode(value: unknown): value is JsonSchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function splitTypeArrays(schema: unknown): void {
  if (!isSchemaNode(schema)) return;
  const { type } = schema;
  if (Array.isArray(type) && type.length > 1 && schema.anyOf === undefined) {
    delete schema.type;
    schema.anyOf = type.map((member) => ({ type: member }));
  }
  for (const keyword of SUBSCHEMA_KEYWORDS) splitTypeArrays(schema[keyword]);
  for (const keyword of SUBSCHEMA_LIST_KEYWORDS) {
    const list = schema[keyword];
    if (Array.isArray(list)) for (const entry of list) splitTypeArrays(entry);
  }
  for (const keyword of SUBSCHEMA_MAP_KEYWORDS) {
    const map = schema[keyword];
    if (isSchemaNode(map)) for (const entry of Object.values(map)) splitTypeArrays(entry);
  }
}

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
      if (tool.inputSchema) {
        splitTypeArrays(tool.inputSchema);
        tool.inputSchema.$schema = JSON_SCHEMA_DIALECT_2020_12;
      }
      if (tool.outputSchema) {
        splitTypeArrays(tool.outputSchema);
        tool.outputSchema.$schema = JSON_SCHEMA_DIALECT_2020_12;
      }
    }
    return result;
  });

  target.__jsonSchemaDialectInstalled = true;
}
