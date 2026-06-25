export type EditorId = 'claude' | 'claude-desktop' | 'cursor' | 'codex' | 'copilot';

export const ALL_EDITOR_IDS = [
  'claude',
  'claude-desktop',
  'cursor',
  'codex',
  'copilot',
] as const satisfies readonly EditorId[];

export const EDITOR_LABELS = {
  claude: 'Claude',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  codex: 'Codex',
  copilot: 'Copilot CLI',
} as const satisfies Record<EditorId, string>;
