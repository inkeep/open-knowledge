/**
 * Scope indicator for a settings page or block header — a heading carries one
 * whenever it has a single answer, so "where does this land?" is answered in
 * place rather than inferred from the sidebar group. The exception is a
 * grouping header over blocks of differing scope (Sync & sharing), where each
 * block states its own instead. Inference is unreliable: the "Plugins" group
 * mixes scopes (markdownlint is project-scope, shared via config.yml + the
 * native `.markdownlint.*`; Themes is user-scope), and This project → Preferences
 * stacks committed project blocks next to per-machine ones.
 *
 * Three scopes, by who a setting reaches rather than by which file backs it:
 *   - `user` — personal to this device, spans every project. Usually the user
 *     config, but some user-scope surfaces persist elsewhere (Configure agents
 *     uses localStorage) or store nothing at all (Hotkeys), so the copy speaks
 *     to reach, not to a filename it cannot promise.
 *   - `project` — lives in the project folder and travels with it through git.
 *     Usually `.ok/config.yml`, but the same badge covers `.okignore`, the
 *     per-editor MCP files, `.ok/skills/` and `.ok/templates/`, so the copy
 *     names the folder rather than a file it cannot promise.
 *   - `project-local` — `.ok/local/config.yml`: this project, this machine,
 *     never committed.
 */
import { Trans } from '@lingui/react/macro';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export type SettingsScope = 'user' | 'project' | 'project-local';

export function ScopeBadge({ scope }: { scope: SettingsScope }) {
  return (
    // Own provider so the badge is drop-in anywhere (settings blocks render
    // both inside and outside the app's provider tree); nesting under an
    // outer TooltipProvider is fine.
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* tabIndex makes the badge keyboard-focusable so the tooltip's
            storage/sharing explanation is reachable without a pointer (Radix
            opens tooltips on focus and wires aria-describedby). */}
          <Badge
            variant="gray"
            tabIndex={0}
            className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`settings-scope-badge-${scope}`}
          >
            {scope === 'user' ? (
              <Trans>User</Trans>
            ) : scope === 'project-local' ? (
              <Trans>This machine</Trans>
            ) : (
              <Trans>Project</Trans>
            )}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          {scope === 'user' ? (
            <Trans>
              Personal to this device. Applies to every project you open here and is never shared
              with collaborators.
            </Trans>
          ) : scope === 'project-local' ? (
            <Trans>
              Applies to this project on this computer only. Stored in .ok/local, not shared via
              git.
            </Trans>
          ) : (
            <Trans>
              Shared with everyone on this project. Stored in the project folder and travels with it
              through git.
            </Trans>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
