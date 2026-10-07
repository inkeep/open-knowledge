import {
  OPEN_KNOWLEDGE_DISCORD_URL,
  OPEN_KNOWLEDGE_DOCS_URL,
  OPEN_KNOWLEDGE_GITHUB_URL,
} from '@inkeep/open-knowledge-core';
import type { MenuDispatchCommand } from '../shared/ipc-channels.ts';

export type MenuDispatchHelpLinkCommand = Extract<
  MenuDispatchCommand,
  'open-github' | 'open-docs' | 'open-discord'
>;

const HELP_LINK_URLS: Readonly<Record<MenuDispatchHelpLinkCommand, string>> = {
  'open-github': OPEN_KNOWLEDGE_GITHUB_URL,
  'open-docs': OPEN_KNOWLEDGE_DOCS_URL,
  'open-discord': OPEN_KNOWLEDGE_DISCORD_URL,
};

export function menuDispatchHelpLinkUrl(command: MenuDispatchHelpLinkCommand): string {
  return HELP_LINK_URLS[command];
}
