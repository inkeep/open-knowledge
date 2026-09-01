import type { ComponentType, SVGProps } from 'react';
import { AntigravityIcon } from './antigravity';
import { ClaudeIcon } from './claude';
import { CodexIcon } from './codex';
import { CursorIcon } from './cursor';
import { DockerIcon } from './docker';
import { GitHubIcon } from './github';
import { HermesIcon } from './hermes';
import { McpIcon } from './mcp';
import { NpmIcon } from './npm';
import { ObsidianIcon } from './obsidian';
import { OpenClawIcon } from './openclaw';
import { OpenCodeIcon } from './opencode';
import { PiIcon } from './pi';

export const brandIcons = {
  Claude: ClaudeIcon,
  Cursor: CursorIcon,
  Codex: CodexIcon,
  OpenCode: OpenCodeIcon,
  OpenClaw: OpenClawIcon,
  Pi: PiIcon,
  Antigravity: AntigravityIcon,
  Hermes: HermesIcon,
  GitHub: GitHubIcon,
  Obsidian: ObsidianIcon,
  MCP: McpIcon,
  Npm: NpmIcon,
  Docker: DockerIcon,
} as const satisfies Record<string, ComponentType<SVGProps<SVGSVGElement>>>;

export type BrandIconName = keyof typeof brandIcons;
