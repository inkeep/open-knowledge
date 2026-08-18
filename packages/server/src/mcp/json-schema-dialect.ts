/**
 * Re-declare tool schemas as JSON Schema 2020-12 in `tools/list` responses.
 *
 * The MCP SDK converts our Zod v4 tool schemas with no `target`, so its
 * internal `mapMiniTarget(undefined)` falls through to `'draft-7'` and every
 * `inputSchema` / `outputSchema` ships stamped
 * `"$schema": "http://json-schema.org/draft-07/schema#"`. Clients that
 * validate structured output against the declared dialect reject the tool
 * outright: an Ajv 2020 instance fails to compile every one of our schemas
 * with `no schema with key or ref "http://json-schema.org/draft-07/schema#"`,
 * so the whole tool surface disappears rather than one tool degrading.
 *
 * Only the label is wrong. Our schemas use no construct where the two
 * dialects diverge (no tuple-form `items`, no `$defs` / `definitions`, no
 * `$ref`, and `exclusiveMinimum` / `exclusiveMaximum` are the numeric form
 * both dialects share), so re-stamping is a relabel, not a conversion.
 *
 * The SDK exposes no way to pass a conversion target: neither `registerTool`
 * nor the server options accept one, and its `tools/list` handler hardcodes
 * the call. Upstream tracking: modelcontextprotocol/typescript-sdk#745.
 *
 * Best-effort, like the sibling `installPrettyZodErrors`: if the SDK's
 * internals move, warn and leave default behavior in place rather than
 * breaking the server.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema, type ServerResult } from '@modelcontextprotocol/sdk/types.js';

export const JSON_SCHEMA_DIALECT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

const LIST_TOOLS_METHOD = 'tools/list';

type RequestHandler = (request: unknown, extra: unknown) => ServerResult | Promise<ServerResult>;

/**
 * The narrow view we mutate. Deliberately NOT the handler's return type:
 * `ServerResult` is a union (it also covers task-shaped results), and
 * narrowing the return to a tools-only shape makes it unassignable.
 */
interface ListToolsShape {
  tools?: Array<{
    inputSchema?: { $schema?: string };
    outputSchema?: { $schema?: string };
  }>;
}

/**
 * Install the dialect re-stamp on the given MCP server. Idempotent.
 *
 * MUST be called AFTER the server's tools are registered: the SDK installs
 * its `tools/list` handler lazily on the first `registerTool`, so calling
 * this at construction time finds nothing to wrap.
 */
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
    // Bracket-prefix matches the OK ops-warning convention. Without this the
    // regression looks identical to "we never installed it", and the symptom
    // (clients silently dropping the entire tool surface) points nowhere near
    // this file.
    console.warn(
      `[json-schema-dialect] No ${LIST_TOOLS_METHOD} handler found. Either the SDK internals changed, or this ran before tools were registered. Tool schemas will keep the SDK's draft-07 dialect.`,
    );
    return;
  }

  server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    // The SDK rebuilds these schema objects on every `tools/list` call, so
    // mutating in place cannot leak across requests.
    const result = await original(request, extra);
    for (const tool of (result as ListToolsShape).tools ?? []) {
      if (tool.inputSchema) tool.inputSchema.$schema = JSON_SCHEMA_DIALECT_2020_12;
      if (tool.outputSchema) tool.outputSchema.$schema = JSON_SCHEMA_DIALECT_2020_12;
    }
    return result;
  });

  target.__jsonSchemaDialectInstalled = true;
}
