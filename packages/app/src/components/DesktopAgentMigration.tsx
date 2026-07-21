import { useInstalledAgents } from '@/components/handoff/useInstalledAgents';
import { useMigrateInstalledDesktopAgentsOnce } from '@/lib/acp/desktop-migration';

/**
 * Desktop-only, renders nothing. Runs the one-time "carry over installed desktop
 * apps" upgrade migration once the install probe resolves, so a user who was
 * launching Claude Desktop / Cursor before Desktop went opt-in keeps seeing
 * those rows. Mount inside the `desktopBridge` guard in `App`. Full rationale:
 * `lib/acp/desktop-migration.ts`.
 */
export function DesktopAgentMigration(): null {
  const { states } = useInstalledAgents();
  useMigrateInstalledDesktopAgentsOnce(states);
  return null;
}
