import { AntigravityIcon } from '@/components/icons/antigravity';
import { ClaudeIcon } from '@/components/icons/claude';
import { CodexIcon } from '@/components/icons/codex';
import { CursorIcon } from '@/components/icons/cursor';
import { OpenClawIcon } from '@/components/icons/openclaw';
import { OpenCodeIcon } from '@/components/icons/opencode';
import { PiIcon } from '@/components/icons/pi';

export const AGENTS = [
  { name: 'Claude', Icon: ClaudeIcon },
  { name: 'Codex', Icon: CodexIcon },
  { name: 'Cursor', Icon: CursorIcon },
  { name: 'OpenCode', Icon: OpenCodeIcon },
  { name: 'Pi', Icon: PiIcon },
  { name: 'OpenClaw', Icon: OpenClawIcon },
  { name: 'Antigravity', Icon: AntigravityIcon },
] as const;

export function AgentIcons() {
  return (
    <div className="not-prose my-6 flex flex-wrap items-center gap-6">
      {AGENTS.map(({ name, Icon }) => (
        <div key={name} className="flex items-center gap-2 text-fd-muted-foreground">
          <Icon className="size-6" aria-hidden="true" />
          <span className="text-sm font-medium">{name}</span>
        </div>
      ))}
    </div>
  );
}
