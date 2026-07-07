/**
 * Canonical editor-ID and label registry shared across the CLI's
 * MCP-wiring code, the desktop bridge contract, and the renderer dialogs.
 *
 * Browser-compatible (no node:* imports). Node-specific config-path
 * resolution lives in `packages/cli/src/commands/editors.ts:EDITOR_TARGETS`,
 * which now reads labels from this module to avoid drift.
 */
export type EditorId = 'claude' | 'claude-desktop' | 'cursor' | 'codex' | 'opencode' | 'openclaw';

export const ALL_EDITOR_IDS = [
  'claude',
  'claude-desktop',
  'cursor',
  'codex',
  'opencode',
  'openclaw',
] as const satisfies readonly EditorId[];

/**
 * Human-readable display label per editor. Consumed by:
 *   - cli `EDITOR_TARGETS[id].label` (the canonical metadata registry)
 *   - app's `ConsentDialogBody` (via `payload.editorOptions` from main)
 *   - app's `CreateProjectDialog` (directly imported)
 */
export const EDITOR_LABELS = {
  claude: 'Claude',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  codex: 'Codex',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
} as const satisfies Record<EditorId, string>;

/**
 * Project-relative skills root per editor (POSIX, `cwd`-relative), or `null`
 * for an editor with no project skill surface (Claude Desktop reads
 * user-global skills only). Authored skills project to `<root>/<name>/`; OK's
 * shipped bundle lives at `<root>/open-knowledge/`. Single source for the
 * install-projection fan-out (`skill-projection.ts`) AND the sharing-mode
 * exclude (`getOkArtifactPaths`), so both stay in lock-step.
 *
 * Each editor installs into its OWN primary skills dir so "install on Codex
 * only" is honest. Codex's is `.codex/skills` (alongside its `.codex/config.toml`
 * MCP path).
 *
 * Why per-editor and NOT a shared `.agents/skills` broadcast at project scope:
 * `.agents/skills` was Codex's old shared path and conflated Cursor+Codex. At
 * project scope there is no shared convergence point — each harness reads its
 * OWN dir (Claude → `.claude/skills`, Cursor → `.cursor/skills`, …) — so
 * projecting a project skill into `.agents/skills` would
 *   (a) HIDE it from harnesses that don't read `.agents` (Claude, Cursor),
 *   (b) DOUBLE-LOAD it for ones that read both their dir AND `.agents` (OpenCode
 *       reads `.opencode/skills` natively AND `.agents/skills`) → duplicate /
 *       name-collision (the `<name>-<editor>` churn class), and
 *   (c) CLOBBER the symlink where `.codex`/`.cursor` symlink to `.agents`.
 * The per-editor fan-out already reaches every harness OK supports, so `.agents`
 * adds NO reach at project scope — only conflation. A genuinely new harness that
 * adopts the vendor-neutral `.agents/` convention is onboarded by adding it to
 * this map (one line; flows to every dependent + lock-step test), NOT by
 * broadcasting into a shared dir.
 *
 * The asymmetry with USER/global scope is deliberate: `~/.agents/skills` IS the
 * right hub there, because the `skills` CLI fans the bundled discovery skill out
 * from it via `--agent '*'` (see `skill-install.ts`) — a shared convergence
 * point that exists globally but has no per-project equivalent.
 *
 * The CLI's `EDITOR_TARGETS.projectSkillPath` is a second source for the same
 * map and must move in lock-step.
 */
export const EDITOR_PROJECT_SKILL_ROOT = {
  claude: '.claude/skills',
  'claude-desktop': null,
  cursor: '.cursor/skills',
  codex: '.codex/skills',
  // OpenCode scans `.opencode/skills` natively (alongside `.agents/skills` and
  // `.claude/skills`); OK writes its own primary dir so install-on-OpenCode is
  // honest and never shares Codex's write.
  opencode: '.opencode/skills',
  // OpenClaw is a global agent gateway (config + skills live under the user's
  // home, e.g. `~/.agents/skills`); it has no project-scoped skill dir OK writes.
  openclaw: null,
} as const satisfies Record<EditorId, string | null>;

/** Editor ids that have a project skill surface (valid install-projection targets). */
export const PROJECT_SKILL_EDITOR_IDS = ALL_EDITOR_IDS.filter(
  (id) => EDITOR_PROJECT_SKILL_ROOT[id] !== null,
);

/**
 * Editors that keep a `~/.<host>/skills/<name>/` (and `<projectDir>/.<host>/skills/`)
 * layout — the single source for the CLI `repair-skills` + desktop `skill-reclaim`
 * sweeps (previously a hand-maintained literal duplicated in BOTH, with only the
 * CLI copy lockstep-tested). Derived from `PROJECT_SKILL_EDITOR_IDS` +
 * `EDITOR_PROJECT_SKILL_ROOT`, so `hostDir` (the root's top-level dotdir, e.g.
 * `.claude` from `.claude/skills`) and the id set can never drift from the
 * canonical editor constants. Adding a project-skill editor to
 * `EDITOR_PROJECT_SKILL_ROOT` flows here automatically.
 */
export const HOSTS_WITH_USER_SKILL_DIR: ReadonlyArray<{
  readonly hostDir: string;
  readonly editorId: EditorId;
}> = PROJECT_SKILL_EDITOR_IDS.map((editorId) => ({
  // `editorId` came from the non-null filter, so the root is a string.
  hostDir: (EDITOR_PROJECT_SKILL_ROOT[editorId] ?? '').split('/')[0],
  editorId,
}));

/**
 * Project-relative MCP-config path per editor (POSIX, `cwd`-relative), or
 * `null` for an editor with no project-scope config (Claude Desktop is
 * user-global). Presence of this file is how an editor is detected as
 * "project-configured" — the default install-projection target set,
 * absent an explicit `skill_targets` in config. Mirrors `projectConfigPath`
 * in the CLI's `EDITOR_TARGETS`.
 */
export const EDITOR_PROJECT_CONFIG_PATH = {
  claude: '.mcp.json',
  'claude-desktop': null,
  cursor: '.cursor/mcp.json',
  codex: '.codex/config.toml',
  opencode: 'opencode.json',
  // OpenClaw's MCP config is user-global (`~/.openclaw/openclaw.json`); no
  // project-local variant, so it is never detected as "project-configured".
  openclaw: null,
} as const satisfies Record<EditorId, string | null>;
