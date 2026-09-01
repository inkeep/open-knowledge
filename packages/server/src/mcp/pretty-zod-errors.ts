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

export function installPrettyZodErrors(server: McpServer): void {
  const target = server as unknown as ValidateToolInputContext & {
    __prettyZodErrorsInstalled?: true;
  };
  if (target.__prettyZodErrorsInstalled === true) {
    return;
  }
  const original = target.validateToolInput;
  if (typeof original !== 'function') {
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
