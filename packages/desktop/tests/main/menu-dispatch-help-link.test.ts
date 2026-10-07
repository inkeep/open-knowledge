import { describe, expect, test } from 'vitest';
import { menuDispatchHelpLinkUrl } from '../../src/main/menu-dispatch-help-link.ts';

describe('menuDispatchHelpLinkUrl', () => {
  test.each([
    ['open-github', 'https://github.com/inkeep/open-knowledge'],
    ['open-docs', 'https://openknowledge.ai/docs'],
    ['open-discord', 'https://discord.gg/VRKk2EaGHN'],
  ] as const)('%s opens %s', (command, url) => {
    expect(menuDispatchHelpLinkUrl(command)).toBe(url);
  });
});
