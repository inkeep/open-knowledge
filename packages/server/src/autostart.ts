/**
 * Typed marker for the backend auto-start opt-out.
 *
 * Thrown by backend-ensure paths (the CLI's `resolveMcpHttpUrl`) when no
 * server is running and `OK_MCP_AUTOSTART=0` forbids spawning one. A typed
 * class rather than a message match lets catch sites across the cli/server
 * package boundary distinguish the operator's chosen opt-out from a genuine
 * spawn failure: `preview_url` answers the former with its normal
 * not-running payload and surfaces the latter as a tool error.
 */
export class AutoStartDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutoStartDisabledError';
  }
}
