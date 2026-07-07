/**
 * `KNOWN_TARGETS` — pure data describing each Open-in-Agent target. No
 * function fields; dispatch is a hand-rolled switch in `dispatch.ts` with
 * `never` exhaustiveness (not a registry with callbacks).
 *
 * Adding a 5th target is a 5-file change:
 *   (1) `HandoffTarget` union in `packages/core/src/handoff/types.ts`
 *   (2) append an entry here
 *   (3) switch case in `dispatch.ts`
 *   (4) URL builder in `packages/core/src/handoff/<name>-url.ts`
 *   (5) `ALLOWED_SCHEMES` in `packages/desktop/src/main/shell-allowlist.ts`
 * The exhaustiveness check in `dispatch.ts` + the drift-detector test in
 * `shell-allowlist.test.ts` enforce completeness.
 *
 * UI visibility is governed separately by `VISIBLE_TARGETS` below — adding a
 * target here exposes it to dispatch-by-ID but not to render surfaces unless
 * it also clears that allow-list filter.
 */

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
    displayName: 'Codex',
    appBrandName: 'Codex Desktop',
    schemes: ['codex:'],
    installUrl: 'https://openai.com/codex',
    tagline: "OpenAI's coding agent, terminal-native.",
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    schemes: ['cursor:'],
    installUrl: 'https://cursor.com/',
    tagline: 'AI-first VS Code fork with multi-file edits.',
  },
  {
    // Terminal-only target: no URL scheme (empty `schemes`), so it is never
    // deep-link-dispatched (no `dispatch.ts` URL case, no `RECIPES` recipe) nor
    // install-probed via scheme. It surfaces ONLY as a terminal-CLI launch row
    // (see `TERMINAL_CLIS`/`TERMINAL_CLI_IDS`) and is excluded from
    // `VISIBLE_TARGETS` below. It lives here so the terminal row reuses the
    // shared brand-icon + display-name metadata.
    id: 'opencode',
    displayName: 'OpenCode',
    schemes: [],
    installUrl: 'https://opencode.ai',
    tagline: 'Open-source terminal coding agent; bring any local model.',
  },
] as const satisfies ReadonlyArray<TargetData>;

// UI-visibility allow-list. `claude-cowork` is intentionally absent: dispatch
// by ID (deep links, programmatic callers) still works via KNOWN_TARGETS, but
// no surface renders it. Drop a target here to hide its row from the
// Open-in-Agent dropdown, FileTree context submenu, command palette agent
// group, and the empty-state "Create with <agent>" composer.
export const VISIBLE_TARGETS: ReadonlyArray<TargetData> = KNOWN_TARGETS.filter(
  // `claude-cowork`: dispatch-by-ID only, no render surface.
  // `opencode`: terminal-only — surfaced via the terminal-CLI rows, not the
  // GUI deep-link target list, so it must not appear as a dispatchable row.
  (target) => target.id !== 'claude-cowork' && target.id !== 'opencode',
);
