import type { ComponentType, SVGProps } from 'react';
import { ClaudeIcon } from './claude';
import { CodexIcon } from './codex';
import { CursorIcon } from './cursor';
import { GitHubIcon } from './github';
import { McpIcon } from './mcp';
import { ObsidianIcon } from './obsidian';
import { OpenClawIcon } from './openclaw';
import { OpenCodeIcon } from './opencode';

// Brand logos addressable from `meta.json` / page frontmatter via the
// `custom/<Name>` icon string (resolved in `src/lib/source.ts`). Each entry is a
// monochrome `currentColor` mark sized 24×24 to match Lucide, so it inherits the
// sidebar text color and brightens on hover like every other nav icon.
export const brandIcons = {
  Claude: ClaudeIcon,
  Cursor: CursorIcon,
  Codex: CodexIcon,
  OpenCode: OpenCodeIcon,
  OpenClaw: OpenClawIcon,
  GitHub: GitHubIcon,
  Obsidian: ObsidianIcon,
  MCP: McpIcon,
} as const satisfies Record<string, ComponentType<SVGProps<SVGSVGElement>>>;

export type BrandIconName = keyof typeof brandIcons;
