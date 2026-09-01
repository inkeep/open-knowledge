import type { TargetData } from '@inkeep/open-knowledge-core';

export const KNOWN_TARGETS = [
  {
    id: 'claude-cowork',
    displayName: 'Claude Cowork',
    appBrandName: 'Claude Desktop',
    schemes: ['claude:'],
    installUrl: 'https://claude.com/download',
    tagline: "Conversational pairing in Claude Desktop's Cowork tab.",
  },
  {
    id: 'claude-code',
    displayName: 'Claude',
    appBrandName: 'Claude Desktop',
    schemes: ['claude:'],
    installUrl: 'https://claude.com/download',
    tagline: "Agentic coding in Claude Desktop's Code tab.",
  },
  {
    id: 'codex',
    displayName: 'ChatGPT',
    appBrandName: 'ChatGPT Desktop',
    schemes: ['codex:'],
    installUrl: 'https://developers.openai.com/codex/app',
    tagline: "OpenAI's ChatGPT desktop app, home of the Codex agent.",
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    schemes: ['cursor:'],
    installUrl: 'https://cursor.com/',
    tagline: 'AI-first VS Code fork with multi-file edits.',
  },
  {
    id: 'copilot',
    displayName: 'GitHub Copilot',
    schemes: [],
    installUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started',
    tagline: "GitHub's terminal-native coding agent.",
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    schemes: [],
    installUrl: 'https://opencode.ai',
    tagline: 'Open-source terminal coding agent; bring any local model.',
  },
  {
    id: 'pi',
    displayName: 'Pi',
    schemes: [],
    installUrl: 'https://pi.dev',
    tagline: 'Minimal open-source terminal coding agent, extensible in TypeScript.',
  },
  {
    id: 'antigravity',
    displayName: 'Antigravity',
    schemes: [],
    installUrl: 'https://antigravity.google',
    tagline: "Google's agentic IDE + `agy` terminal agent.",
  },
  {
    id: 'openclaw',
    displayName: 'OpenClaw',
    schemes: [],
    installUrl: 'https://openclaw.ai',
    tagline: 'Open-source agent gateway; runs agents against your MCP servers.',
  },
  {
    id: 'hermes',
    displayName: 'Hermes',
    schemes: [],
    installUrl: 'https://hermes-agent.nousresearch.com',
    tagline: "Nous Research's terminal coding agent.",
  },
] as const satisfies ReadonlyArray<TargetData>;

export const VISIBLE_TARGETS: ReadonlyArray<TargetData> = KNOWN_TARGETS.filter(
  (target) =>
    target.id !== 'claude-cowork' &&
    target.id !== 'copilot' &&
    target.id !== 'opencode' &&
    target.id !== 'pi' &&
    target.id !== 'antigravity' &&
    target.id !== 'openclaw' &&
    target.id !== 'hermes',
);
