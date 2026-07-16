/**
 * Canonical editor-ID and label registry shared across the CLI's
 * MCP-wiring code, the desktop bridge contract, and the renderer dialogs.
 *
 * Browser-compatible (no node:* imports). Node-specific config-path
 * resolution lives in `packages/cli/src/commands/editors.ts:EDITOR_TARGETS`,
 * which now reads labels from this module to avoid drift.
 */
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
  copilot: 'GitHub Copilot',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  pi: 'Pi',
  antigravity: 'Antigravity',
  'lm-studio': 'LM Studio',
  hermes: 'Hermes',
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
 * MCP path); Copilot's is `.github/skills`, its documented project location.
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
  copilot: '.github/skills',
  // OpenCode scans `.opencode/skills` natively (alongside `.agents/skills` and
  // `.claude/skills`); OK writes its own primary dir so install-on-OpenCode is
  // honest and never shares Codex's write.
  opencode: '.opencode/skills',
  // OpenClaw is a global agent gateway (config + skills live under the user's
  // home, e.g. `~/.agents/skills`); it has no project-scoped skill dir OK writes.
  openclaw: null,
  // Pi implements the Agent Skills standard and scans `.pi/skills` natively
  // (alongside `.agents/skills`); OK writes its own primary dir so
  // install-on-Pi is honest and never shares another host's write. Project
  // skill dirs are trust-gated in Pi: they load only after the user trusts
  // the folder.
  pi: '.pi/skills',
  // Antigravity (IDE + `agy` CLI) reads skills only from the user-global
  // `~/.gemini/skills` hub — there is no project-scoped skill dir OK writes.
  // Like OpenClaw, its integration is the user-global MCP config; OK ships no
  // per-project skill for it.
  antigravity: null,
  // LM Studio is an MCP host (its chat connects to MCP servers) with no Agent
  // Skills surface at all — OK's only integration is the user-global MCP config.
  'lm-studio': null,
  // Hermes Agent (Nous Research) is a user-global terminal agent: its whole
  // config lives at `~/.hermes/config.yaml` with no project-scoped skill dir OK
  // writes — same null-project-skill posture as OpenClaw / Claude Desktop.
  hermes: null,
} as const satisfies Record<EditorId, string | null>;

/** Editor ids that have a project skill surface (valid install-projection targets). */
export const PROJECT_SKILL_EDITOR_IDS = ALL_EDITOR_IDS.filter(
  (id) => EDITOR_PROJECT_SKILL_ROOT[id] !== null,
);

/**
 * Reserved name of OpenKnowledge's built-in project-skill bundle — the ONE skill
 * OK ships and re-projects into every wired editor's host dir on every project
 * open (`.{host}/skills/open-knowledge/`). Mirrors `BUNDLE_SKILL_NAME.project`
 * (and `SHIPPED_SKILL_NAME`) in `@inkeep/open-knowledge-server`; duplicated here
 * because core cannot depend on server, and pinned in lock-step by a server-side
 * test. Authored / pack skills take other names — the reserved `open-knowledge*`
 * prefix keeps them from shadowing this bundle.
 */
export const RESERVED_PROJECT_SKILL_NAME = 'open-knowledge';

/**
 * Per-editor host-dir paths OK re-projects its built-in `open-knowledge` bundle
 * into (`.{host}/skills/open-knowledge/`) — POSIX, trailing slash, derived from
 * `EDITOR_PROJECT_SKILL_ROOT` so a new project-skill editor flows here
 * automatically.
 *
 * This projection is a LOCAL, per-machine artifact: the app regenerates it on
 * every open, and different builds version-stamp its frontmatter differently, so
 * committing it to git makes teammates collide under auto-sync (recurring merge
 * conflicts / "external-changes-pending"). These paths are therefore ALWAYS
 * git-excluded via a committed `.gitignore` block (`ensureProjectSkillGitignore`),
 * independent of the OK shared/local-only sharing toggle. Authored skills at
 * `.{host}/skills/<other-name>/` are NOT here — they still follow the toggle.
 */
export const PROJECT_SKILL_PROJECTION_IGNORE_PATHS: readonly string[] = ALL_EDITOR_IDS.flatMap(
  (id) => {
    const root = EDITOR_PROJECT_SKILL_ROOT[id];
    return root === null ? [] : [`${root}/${RESERVED_PROJECT_SKILL_NAME}/`];
  },
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
 *
 * Pi and Copilot are carve-outs: Pi's user-global skills dir is
 * `~/.pi/agent/skills` (the agent home is nested one level below the `.pi`
 * dotdir), while Copilot's is `~/.copilot/skills`, not `~/.github/skills`.
 * Both natively read the central `~/.agents/skills` hub that the user-bundle
 * installer already writes, so including either here would create a dead path.
 */
export const HOSTS_WITH_USER_SKILL_DIR: ReadonlyArray<{
  readonly hostDir: string;
  readonly editorId: EditorId;
}> = PROJECT_SKILL_EDITOR_IDS.filter((editorId) => editorId !== 'pi' && editorId !== 'copilot').map(
  (editorId) => ({
    // `editorId` came from the non-null filter, so the root is a string.
    hostDir: (EDITOR_PROJECT_SKILL_ROOT[editorId] ?? '').split('/')[0],
    editorId,
  }),
);

/**
 * OpenKnowledge integration-doc slug per editor — the setup guide at
 * `https://openknowledge.ai/docs/integrations/<slug>`. Consumed by the
 * first-launch consent dialog to link an undetected tool to its setup guide.
 * Claude Code and Claude Desktop share one page (`claude-code` covers both).
 */
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
  // Copilot's `~/.copilot/mcp-config.json` is user-global. It can also read
  // standard workspace `.mcp.json` files, but OK does not duplicate its own
  // server into the shared Claude workspace config: one user-global entry
  // avoids same-named-source precedence ambiguity while project skills still
  // install to `.github/skills`.
  copilot: null,
  opencode: 'opencode.json',
  // OpenClaw's MCP config is user-global (`~/.openclaw/openclaw.json`); no
  // project-local variant, so it is never detected as "project-configured".
  openclaw: null,
  // Pi has no MCP config at all — OK's integration is a managed bridge
  // EXTENSION file dropped at `.pi/extensions/open-knowledge.ts` (Pi loads
  // project extensions after the user trusts the folder). That file is the
  // project-configured signal AND the artifact every generic consumer
  // (sharing-mode exclude, deinit, reclaim) must target, so it is the
  // project-config path. OK never reads or writes `.pi/settings.json`.
  pi: '.pi/extensions/open-knowledge.ts',
  // Antigravity has NO project-scoped MCP config — the IDE, app, and `agy` CLI
  // all share one user-global file at `~/.gemini/config/mcp_config.json`
  // (per-project you can only filter which global servers are allowed). So it
  // is never detected as "project-configured"; like Claude Desktop / OpenClaw,
  // OK writes only the user-global config.
  antigravity: null,
  // LM Studio's MCP config is a single user-global `mcp.json` (it follows
  // Cursor's notation but has no project-local variant), so it is never
  // detected as "project-configured".
  'lm-studio': null,
  // Hermes' MCP config is user-global (`~/.hermes/config.yaml`, servers under
  // `mcp_servers`); no project-local variant, so it is never detected as
  // "project-configured" — same as OpenClaw.
  hermes: null,
} as const satisfies Record<EditorId, string | null>;
