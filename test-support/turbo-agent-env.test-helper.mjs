// UPSTREAM(turbo@2.11.5): any of these makes turbo detect a coding agent and maintain its AGENTS.md block; detect() also checks /opt/.devin.
const TURBO_AGENT_DETECTION_VARS = [
  'AI_AGENT',
  'CURSOR_TRACE_ID',
  'CURSOR_AGENT',
  'GEMINI_CLI',
  'CODEX_SANDBOX',
  'AUGMENT_AGENT',
  'OPENCODE_CLIENT',
  'OPENCODE',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'REPL_ID',
];

export function withoutTurboAgentDetection(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !TURBO_AGENT_DETECTION_VARS.includes(key)),
  );
}
