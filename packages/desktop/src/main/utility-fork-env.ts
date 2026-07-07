/**
 * Pure env-builder for utilityProcess.fork.
 *
 * Merges `process.env` with desktop-only markers:
 *   - `OK_ELECTRON_PROTOCOL_HOST=1` — the utility's preview-url helper uses
 *     this to emit `openknowledge://` deep-links instead of `http://localhost:<port>`
 *     URLs (Electron host has the protocol handler registered). Set at fork
 *     time (NOT `createServer`) so only forks from this desktop main process
 *     carry the flag; CLI / bunx servers keep the existing http behavior.
 *   - `OK_LOCK_KIND=interactive` — pin the lock kind explicitly so an
 *     accidentally-inherited `mcp-spawned` from a surrounding shell never
 *     causes the desktop's own server to mark itself as MCP-spawned.
 *   - `OK_STARTUP_TRACEPARENT` — set only when `opts.startupTraceparent` is
 *     provided (the Electron main process's `ok.app-startup` root, Plan A). The
 *     server extracts it so its `ok.boot` span joins the desktop launch trace.
 *     Omitted when undefined so a previous value never lingers from a prior
 *     launch's env.
 *   - `OTEL_EXPORTER_OTLP_ENDPOINT` — re-applied from `opts.otlpEndpoint` when
 *     present so the spawned server pushes to the same collector as the
 *     renderer. (It already passes through via the `...parentEnv` spread when
 *     set on `process.env`; the explicit field lets main normalize / supply it.)
 *
 * Extracted so the merge can be unit-tested without standing up an Electron
 * runtime.
 */

export interface UtilityForkEnvOptions {
  /** W3C traceparent of the main-process `ok.app-startup` root, or undefined when OTel is off. */
  startupTraceparent?: string;
  /** OTLP/HTTP collector endpoint to share with the spawned server, or undefined to leave as-is. */
  otlpEndpoint?: string;
}

export function buildUtilityForkEnv(
  parentEnv: NodeJS.ProcessEnv = process.env,
  opts: UtilityForkEnvOptions = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...parentEnv,
    OK_ELECTRON_PROTOCOL_HOST: '1',
    OK_LOCK_KIND: 'interactive',
  };
  if (opts.startupTraceparent !== undefined) {
    env.OK_STARTUP_TRACEPARENT = opts.startupTraceparent;
  }
  if (opts.otlpEndpoint !== undefined) {
    env.OTEL_EXPORTER_OTLP_ENDPOINT = opts.otlpEndpoint;
  }
  return env;
}
