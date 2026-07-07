/**
 * Single-source builder for the `mcp-config-decline` structured event.
 *
 * OpenKnowledge is a guest in another tool's config: when it meets a present,
 * non-empty config it cannot fully parse, it leaves the file untouched and
 * declines to register rather than renaming it aside or overwriting it. This
 * event is the only operator-facing signal of that decision — "OK couldn't
 * register" is otherwise invisible (the user just sees OK's server absent).
 *
 * Sibling of `buildMcpConfigMigrateEvent`; three surfaces emit it today (the
 * Desktop boot sweep, the Desktop first-launch wiring, and the Desktop
 * project-open sweep — see the `surface` enum below), so a single builder keeps
 * their field shapes from diverging the way the migrate event's did before it
 * was centralized.
 *
 * Every field is bounded cardinality — the event carries no config path,
 * parser message, or file contents, so it can be indexed by structured-event
 * sinks without leaking the user's config or exploding label storage:
 *   - `scope`     — `'user' | 'project'`.
 *   - `surface`   — closed set of emitting code paths (`'desktop-startup'`,
 *                   `'desktop-project-open'`, `'desktop-firstlaunch'`).
 *   - `editorId`  — the harness whose config was declined; a member of the
 *                   closed `ALL_EDITOR_IDS` set. Named `editorId` (not
 *                   `harness`) so it joins with the `mcp-config-migrate` event
 *                   and `RepairLogEvent`, which already key the harness that
 *                   way.
 *   - `reason`    — the bounded `McpDeclineReason` enum.
 */

import type { McpDeclineReason } from './init.ts';

export type McpConfigDeclineScope = 'user' | 'project';

// Closed set of emitting code paths. Kept a union (not open `string`) so the
// event stays bounded-cardinality at the type level — a stray free-form surface
// can't reach a structured-event sink and explode label storage. Not exported:
// every call site passes an inline literal, so the union only needs to be
// referenced by the two shapes below.
type McpConfigDeclineSurface = 'desktop-startup' | 'desktop-project-open' | 'desktop-firstlaunch';

// Not exported: callers pass an inline literal (as the Desktop sweeps do) and
// the builder is the only referent. Kept as a named local for signature clarity.
interface McpConfigDeclineInput {
  scope: McpConfigDeclineScope;
  surface: McpConfigDeclineSurface;
  editorId: string;
  reason: McpDeclineReason;
}

export interface McpConfigDeclineEvent {
  event: 'mcp-config-decline';
  scope: McpConfigDeclineScope;
  surface: McpConfigDeclineSurface;
  editorId: string;
  reason: McpDeclineReason;
  /**
   * Index signature so this type is assignable to the loosely-typed
   * `event: { event: string; [k: string]: unknown }` parameter the Desktop
   * structured-event loggers accept — same reason as the migrate event.
   */
  [key: string]: unknown;
}

export function buildMcpConfigDeclineEvent(input: McpConfigDeclineInput): McpConfigDeclineEvent {
  return {
    event: 'mcp-config-decline',
    scope: input.scope,
    surface: input.surface,
    editorId: input.editorId,
    reason: input.reason,
  };
}
