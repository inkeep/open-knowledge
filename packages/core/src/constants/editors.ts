export type EditorId =
  | 'claude'
  | 'claude-desktop'
  | 'cursor'
  | 'codex'
  | 'copilot'
  | 'opencode'
  | 'openclaw'
  | 'pi'
  | 'antigravity'
  | 'lm-studio'
  | 'hermes';

export const ALL_EDITOR_IDS = [
  'claude',
  'claude-desktop',
  'cursor',
  'codex',
  'copilot',
  'opencode',
  'openclaw',
  'pi',
  'antigravity',
  'lm-studio',
  'hermes',
] as const satisfies readonly EditorId[];

export const EDITOR_LABELS = {
  claude: 'Claude',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  pi: 'Pi',
  antigravity: 'Antigravity',
  'lm-studio': 'LM Studio',
  hermes: 'Hermes',
} as const satisfies Record<EditorId, string>;

export const EDITOR_PROJECT_SKILL_ROOT = {
  claude: '.claude/skills',
  'claude-desktop': null,
  cursor: '.cursor/skills',
  codex: '.codex/skills',
  copilot: '.github/skills',
  opencode: '.opencode/skills',
  openclaw: null,
  pi: '.pi/skills',
  antigravity: null,
  'lm-studio': null,
  hermes: null,
} as const satisfies Record<EditorId, string | null>;

export const EDITOR_USER_SKILL_ROOT = {
  claude: '.claude/skills',
  'claude-desktop': null,
  cursor: '.cursor/skills',
  codex: '.codex/skills',
  copilot: '.copilot/skills',
  opencode: '.opencode/skills',
  openclaw: null,
  pi: '.pi/agent/skills',
  antigravity: '.gemini/skills',
  'lm-studio': '.lmstudio/skills',
  hermes: null,
} as const satisfies Record<EditorId, string | null>;

export const HUB_READER_EDITORS: ReadonlyArray<{
  readonly editorId: EditorId;
  readonly dotDir: string;
  readonly scope: 'project' | 'global';
}> = [
  { editorId: 'lm-studio', dotDir: '.lmstudio', scope: 'project' },
  { editorId: 'openclaw', dotDir: '.openclaw', scope: 'global' },
];

const NON_AGENT_SKILL_ROOT_DIRS: ReadonlySet<string> = new Set(['.github']);

export function skillRootActivationPath(skillsRoot: string): string {
  const dotdir = skillsRoot.split('/')[0] ?? skillsRoot;
  return NON_AGENT_SKILL_ROOT_DIRS.has(dotdir) ? skillsRoot : dotdir;
}

export const PROJECT_SKILL_EDITOR_IDS = ALL_EDITOR_IDS.filter(
  (id) => EDITOR_PROJECT_SKILL_ROOT[id] !== null,
);

export const USER_SKILL_EDITOR_IDS = ALL_EDITOR_IDS.filter(
  (id) => EDITOR_USER_SKILL_ROOT[id] !== null,
);

export const RESERVED_PROJECT_SKILL_NAME = 'open-knowledge';

export const PROJECT_SKILL_PROJECTION_IGNORE_PATHS: readonly string[] = ALL_EDITOR_IDS.flatMap(
  (id) => {
    const root = EDITOR_PROJECT_SKILL_ROOT[id];
    return root === null ? [] : [`${root}/${RESERVED_PROJECT_SKILL_NAME}/`];
  },
);

export const HOSTS_WITH_USER_SKILL_DIR: ReadonlyArray<{
  readonly hostDir: string;
  readonly editorId: EditorId;
}> = PROJECT_SKILL_EDITOR_IDS.filter((editorId) => editorId !== 'pi' && editorId !== 'copilot').map(
  (editorId) => ({
    hostDir: (EDITOR_PROJECT_SKILL_ROOT[editorId] ?? '').split('/')[0],
    editorId,
  }),
);

export const USER_SKILL_HOSTS: ReadonlyArray<{
  readonly hostDir: string;
  readonly skillsRoot: string;
  readonly editorId: EditorId;
}> = ALL_EDITOR_IDS.flatMap((editorId) => {
  const skillsRoot = EDITOR_USER_SKILL_ROOT[editorId];
  if (skillsRoot === null) return [];
  const hostDir = skillsRoot.split('/')[0];
  return hostDir === undefined ? [] : [{ hostDir, skillsRoot, editorId }];
});

export const EDITOR_SETUP_DOC_SLUG = {
  claude: 'claude-code',
  'claude-desktop': 'claude-code',
  cursor: 'cursor',
  codex: 'codex',
  copilot: 'github-copilot-cli',
  opencode: 'opencode',
  openclaw: 'openclaw',
  pi: 'pi',
  antigravity: 'antigravity',
  'lm-studio': 'lm-studio',
  hermes: 'hermes',
} as const satisfies Record<EditorId, string>;

export const EDITOR_PROJECT_CONFIG_PATH = {
  claude: '.mcp.json',
  'claude-desktop': null,
  cursor: '.cursor/mcp.json',
  codex: '.codex/config.toml',
  copilot: null,
  opencode: 'opencode.json',
  openclaw: null,
  pi: '.pi/extensions/open-knowledge.ts',
  antigravity: null,
  'lm-studio': null,
  hermes: null,
} as const satisfies Record<EditorId, string | null>;

export const USER_MCP_GATED_EDITOR_IDS: readonly EditorId[] = ['copilot'];

export function receivesProjectIntegrationWrite(
  id: EditorId,
  opts: { userMcpEntryInstalled: boolean },
): boolean {
  if (EDITOR_PROJECT_CONFIG_PATH[id] !== null) return true;
  if (EDITOR_PROJECT_SKILL_ROOT[id] === null) return false;
  return !USER_MCP_GATED_EDITOR_IDS.includes(id) || opts.userMcpEntryInstalled;
}
