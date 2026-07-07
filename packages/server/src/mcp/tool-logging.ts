import type { AgentIdentity } from './agent-identity.ts';
import { type McpLogger, runWithMcpLogger } from './logger.ts';
import type { ServerInstance } from './tools/shared.ts';

interface LoggedToolServerOptions {
  logger?: McpLogger;
  identityRef?: { current: AgentIdentity };
}

interface ToolExtraLike {
  requestId?: unknown;
  sessionId?: string;
}

type AnyToolHandler = (...args: unknown[]) => unknown;

const REDACTED_STRING_KEYS = new Set(['find', 'markdown', 'replace']);
const COMMON_ARRAY_KEYS = [
  'backlinks',
  'deadLinks',
  'documents',
  'enrichedPaths',
  'entries',
  'forwardLinks',
  'hints',
  'hubs',
  'orphans',
  'results',
];
const COMMON_SCALAR_KEYS = [
  'checkpointRef',
  'cwd',
  'fileCount',
  'matchCount',
  'ok',
  'query',
  'stdoutTruncated',
  'truncated',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isToolExtraLike(value: unknown): value is ToolExtraLike {
  return isPlainObject(value) && 'requestId' in value;
}

function summarizeStringForLog(key: string, value: string): string | Record<string, unknown> {
  if (REDACTED_STRING_KEYS.has(key)) {
    return {
      redacted: true,
      type: 'string',
      length: value.length,
      lines: value.length === 0 ? 0 : value.split('\n').length,
    };
  }

  const max = key === 'command' ? 240 : 120;
  if (value.length <= max) return value;
  return {
    type: 'string',
    length: value.length,
    preview: `${value.slice(0, max)}...`,
  };
}

function summarizeArgValue(key: string, value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'string') return summarizeStringForLog(key, value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length };
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return { type: 'object', keyCount: keys.length, keys: keys.slice(0, 12) };
  }
  if (typeof value === 'undefined') return undefined;
  return { type: typeof value };
}

function summarizeArgsForLog(tool: string, args: unknown): unknown {
  if (!isPlainObject(args)) {
    return summarizeArgValue(tool, args);
  }
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, summarizeArgValue(key, value)]),
  );
}

function summarizeStructuredContentForLog(
  structured: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    structuredKeys: Object.keys(structured).sort(),
  };

  for (const key of COMMON_SCALAR_KEYS) {
    if (key in structured) {
      summary[key] = structured[key];
    }
  }

  for (const key of COMMON_ARRAY_KEYS) {
    const value = structured[key];
    if (Array.isArray(value)) {
      summary[`${key}Count`] = value.length;
    }
  }

  if ('previewUrl' in structured) {
    summary.previewUrl = structured.previewUrl ?? null;
  }
  if ('previewUrlSource' in structured) {
    summary.previewUrlSource = structured.previewUrlSource;
  }
  // Body size is captured by `contentTextChars` at the result level; no tool
  // carries a raw `structuredContent.stdout` channel anymore.
  if (Array.isArray(structured.warnings)) {
    summary.warningsCount = structured.warnings.length;
  }
  if (isPlainObject(structured.warning)) {
    summary.warning = true;
    if ('previewUrl' in structured.warning) {
      summary.warningPreviewUrl = structured.warning.previewUrl ?? null;
    }
  }

  return summary;
}

function summarizeToolResultForLog(result: unknown): Record<string, unknown> {
  if (!isPlainObject(result)) {
    return { resultType: typeof result };
  }

  const summary: Record<string, unknown> = {
    isError: result.isError === true,
  };

  if (Array.isArray(result.content)) {
    summary.contentItems = result.content.length;
    const textChars = result.content.reduce((total, item) => {
      if (!isPlainObject(item)) return total;
      return typeof item.text === 'string' ? total + item.text.length : total;
    }, 0);
    summary.contentTextChars = textChars;
  }

  if (isPlainObject(result.structuredContent)) {
    Object.assign(summary, summarizeStructuredContentForLog(result.structuredContent));
  }

  return summary;
}

function summarizeIdentityForLog(identity: AgentIdentity): Record<string, unknown> {
  return {
    connectionId: identity.connectionId.slice(0, 8),
    displayName: identity.displayName,
    ...(identity.clientInfo?.name ? { clientName: identity.clientInfo.name } : {}),
  };
}

function splitInvocationArgs(invocationArgs: unknown[]): {
  toolArgs: unknown;
  extra: ToolExtraLike | undefined;
} {
  const maybeExtra = invocationArgs.at(-1);
  if (isToolExtraLike(maybeExtra)) {
    return {
      toolArgs: invocationArgs.length > 1 ? invocationArgs[0] : undefined,
      extra: maybeExtra,
    };
  }
  return {
    toolArgs: invocationArgs[0],
    extra: undefined,
  };
}

export function wrapToolHandlerForLogging(
  name: string,
  handler: AnyToolHandler,
  opts: LoggedToolServerOptions,
): AnyToolHandler {
  const baseLogger = opts.logger;
  if (!baseLogger) return handler;

  return async (...invocationArgs: unknown[]) => {
    const callLogger = baseLogger.child();
    const startedAt = Date.now();
    const { toolArgs, extra } = splitInvocationArgs(invocationArgs);

    callLogger.info('tool start', {
      tool: name,
      ...(extra?.requestId !== undefined ? { requestId: extra.requestId } : {}),
      ...(extra?.sessionId ? { transportSessionId: extra.sessionId } : {}),
      ...(opts.identityRef?.current
        ? { agent: summarizeIdentityForLog(opts.identityRef.current) }
        : {}),
      ...(toolArgs !== undefined ? { args: summarizeArgsForLog(name, toolArgs) } : {}),
    });

    try {
      const result = await runWithMcpLogger(
        callLogger,
        async () => await handler(...invocationArgs),
      );
      callLogger.info('tool finish', {
        tool: name,
        ...(extra?.requestId !== undefined ? { requestId: extra.requestId } : {}),
        durationMs: Date.now() - startedAt,
        result: summarizeToolResultForLog(result),
      });
      return result;
    } catch (err) {
      callLogger.error('tool error', err, {
        tool: name,
        ...(extra?.requestId !== undefined ? { requestId: extra.requestId } : {}),
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }
  };
}

/**
 * Return a server instance whose `tool(...)` and `registerTool(...)`
 * registration wraps handlers with request-aware structured logging.
 */
export function createLoggedServer(
  server: ServerInstance,
  opts: LoggedToolServerOptions,
): ServerInstance {
  if (!opts.logger) return server;

  const originalTool = (server as unknown as { tool: AnyToolHandler }).tool.bind(server);
  // registerTool is the modern MCP SDK registration API; older mocks/test stubs may not
  // expose it. Wrap only when present so consumers using the legacy `tool()` shape still work.
  const rawRegisterTool = (server as unknown as { registerTool?: (...args: unknown[]) => unknown })
    .registerTool;
  const originalRegisterTool =
    typeof rawRegisterTool === 'function' ? rawRegisterTool.bind(server) : undefined;
  const wrapped = Object.create(server) as ServerInstance;

  (wrapped as unknown as { tool: AnyToolHandler }).tool = ((...toolArgs: unknown[]) => {
    const name = String(toolArgs[0]);
    const handler = toolArgs.at(-1);
    if (typeof handler !== 'function') {
      return originalTool(...toolArgs);
    }
    const nextArgs = [...toolArgs];
    nextArgs[nextArgs.length - 1] = wrapToolHandlerForLogging(
      name,
      handler as AnyToolHandler,
      opts,
    );
    return originalTool(...nextArgs);
  }) as AnyToolHandler;

  if (originalRegisterTool) {
    (wrapped as unknown as { registerTool: typeof server.registerTool }).registerTool = ((
      name: string,
      config: unknown,
      cb: AnyToolHandler,
    ) => {
      if (typeof cb !== 'function') {
        return originalRegisterTool(name, config, cb);
      }
      const wrappedCb = wrapToolHandlerForLogging(name, cb, opts);
      return originalRegisterTool(name, config, wrappedCb);
    }) as unknown as typeof server.registerTool;
  }

  return wrapped;
}
