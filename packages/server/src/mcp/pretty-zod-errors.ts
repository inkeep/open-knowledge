/**
 * Replace the MCP SDK's default Zod-error formatter with `z.prettifyError`.
 *
 * The SDK's `validateToolInput` formats validation failures by returning
 * `ZodError.message`, which in Zod v4 is `JSON.stringify(issues, null, 2)` —
 * a multi-line JSON dump that an agent has to parse to see which field is
 * missing and what values are allowed. For required-enum fields (e.g.
 * `position: "append" | "prepend" | "replace"`) the bug report
 * describes the bare-bones surface as "Required" with no actionable context.
 *
 * `z.prettifyError` (Zod v4) returns a clean two-line summary per issue —
 * `✖ Invalid option: expected one of "append"|"prepend"|"replace"
 *    → at position`
 * — which names the field AND lists the allowed values, exactly the form
 * the ticket asks for.
 *
 * The override is best-effort: if the SDK's internal shape changes, the
 * installer leaves default behavior in place rather than breaking the
 * server.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

interface ValidateToolInputContext {
  validateToolInput?: (
    tool: { inputSchema?: unknown },
    args: unknown,
    toolName: string,
  ) => Promise<unknown>;
}

/**
 * Install a prettier Zod-error formatter on the given MCP server. Safe to
 * call once per `new McpServer(...)`. Idempotent — calling twice on the
 * same instance is a no-op after the first install.
 */
export function installPrettyZodErrors(server: McpServer): void {
  const target = server as unknown as ValidateToolInputContext & {
    __prettyZodErrorsInstalled?: true;
  };
  if (target.__prettyZodErrorsInstalled === true) {
    return;
  }
  const original = target.validateToolInput;
  if (typeof original !== 'function') {
    // Best-effort fallback: SDK shape changed (`validateToolInput` renamed
    // or removed). Without this warning the regression looks identical to
    // "we never patched it" and only surfaces once the bug ticket is
    // reopened. Bracket-prefix matches the OK ops-warning convention.
    console.warn(
      '[pretty-zod-errors] McpServer.validateToolInput not found — SDK internals may have changed. Falling back to default error formatting.',
    );
    return;
  }
  const replacement = async function (
    this: McpServer,
    tool: { inputSchema?: unknown },
    args: unknown,
    toolName: string,
  ): Promise<unknown> {
    if (!tool.inputSchema) {
      return original.call(this, tool, args, toolName);
    }
    if (!isZodSchema(tool.inputSchema)) {
      return original.call(this, tool, args, toolName);
    }
    const result = await tool.inputSchema.safeParseAsync(args);
    if (result.success) {
      // SDK's `validateToolInput` returns `parseResult.data` on success
      // (mcp.js → `safeParseAsync` → `parseResult.data`). If a future SDK
      // version adds success-path side effects (normalization, metrics,
      // logging) we'd want to wrap `original` instead of bypassing it.
      return result.data;
    }
    const prettyMessage = z.prettifyError(result.error);
    throw new McpError(
      ErrorCode.InvalidParams,
      `Input validation error: Invalid arguments for tool ${toolName}:\n${prettyMessage}`,
    );
  };
  target.validateToolInput = replacement;
  target.__prettyZodErrorsInstalled = true;
}

function isZodSchema(value: unknown): value is z.ZodType {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { safeParseAsync?: unknown };
  return typeof candidate.safeParseAsync === 'function';
}
