/**
 * `ok open <name>` — open a doc, folder, or skill in the OK Desktop app.
 *
 * The Claude Code CLI (and any pure-stdio agent host — Codex CLI, Cursor CLI,
 * OpenCode) has no preview pane and no in-app browser, so it is on rung 3 of the
 * skill's preview capability ladder. This verb is that rung's action: it
 * focus-or-launches the desktop app via an `openknowledge://open` deep link,
 * falling back to the browser UI (`ok ui`) when no desktop bundle is installed.
 *
 * `<name>` is auto-classified against the project on disk — a directory opens as
 * a FOLDER, anything else as a DOC — so there is no `--folder` flag; a trailing
 * slash (`ok open foo/`) forces folder intent for a folder that doesn't exist on
 * disk yet. `--skill <name>` opens a skill in the skill editor instead (skills are
 * addressed by name + scope, not a content path, so they can't be auto-detected
 * from a bare name).
 *
 * Deep-link shapes (all `openknowledge://open?project=<abs>&...`):
 *   - doc    → `&doc=<name>`                        → `#/<name>`
 *   - folder → `&folder=<path>`                     → `#/<path>/`
 *   - skill  → `&doc=__skill__/<scope>/<name>`      → `#/__skill__/<scope>/<name>`
 *     (a skill rides the `doc=` param: the skill editor is an ordinary editor
 *     tab keyed on the synthetic `__skill__/…` docName, so no new scheme param
 *     is needed — the renderer resolves it via `docNameFromHash`.)
 *
 * Desktop presence comes from `detectDesktop().bundlePath`, populated whenever a
 * bundle is installed on macOS and `OK_FORCE_BROWSER` is unset — including
 * non-TTY/headless invocations (an agent shelling out). The verb spawns its own
 * `open "<url>"` (LaunchServices) rather than `launchDesktop`.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MANAGED_ARTIFACT_SCOPES, type SkillScope } from '@inkeep/open-knowledge-core';
import {
  encodeDocName,
  encodeFolderRoute,
  encodeSkillRoute,
  resolveLockDir,
  resolveUiInfo,
} from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { createRealDetectDeps, type DetectResult, detectDesktop } from './desktop-dispatch.ts';

export interface OpenOptions {
  /** Treat `<name>` as a skill name (opens the skill editor). */
  skill?: boolean;
  /** Skill scope when `--skill` is set; defaults to `project`. */
  scope?: string;
  project?: string;
}

/**
 * Side-effect surface for `runOpen`. Injected so unit tests drive the full
 * matrix (desktop present/absent, doc/folder/skill, UI running/not) without a
 * real macOS, desktop install, running server, or filesystem.
 */
export interface OpenDeps {
  /** Absolute desktop bundle path when one is installed, else null. */
  detectBundlePath: () => string | null;
  /** Browser origin (`http://localhost:<port>`) of a running UI, else null. */
  resolveBaseUrl: (projectDir: string) => string | null;
  /**
   * Classify a content-tree name against disk: a directory → `'folder'`,
   * anything else (a `.md`/`.mdx` file, or a not-yet-created name) → `'doc'`.
   * This is what lets `ok open <name>` route correctly without `--folder`.
   */
  classifyName: (projectDir: string, name: string) => 'doc' | 'folder';
  /** Hand a URL or `openknowledge://` deep link to the OS to open. */
  openTarget: (target: string) => void;
  log: (message: string) => void;
  error: (message: string) => void;
}

/**
 * Copy `process.env` minus `ELECTRON_RUN_AS_NODE`. The CLI wrapper sets that
 * var so the bundled Electron binary runs as a Node host; if the
 * LaunchServices-spawned target (the desktop app for `openknowledge://`, or the
 * browser for http) inherited it, it would start as a headless Node host with
 * no script and exit immediately. Mirrors `launchDesktop`.
 */
export function scrubElectronRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.ELECTRON_RUN_AS_NODE;
  return next;
}

/**
 * Build the real side-effect surface. `detect` is injectable so the
 * `bundlePath ?? null` collapse can be unit-tested without a real macOS /
 * desktop install.
 */
export function createRealOpenDeps(
  detect: () => DetectResult = () => detectDesktop(createRealDetectDeps()),
): OpenDeps {
  return {
    detectBundlePath: () => detect().bundlePath ?? null,
    resolveBaseUrl: (projectDir) => resolveUiInfo({ lockDir: resolveLockDir(projectDir) }).baseUrl,
    classifyName: (projectDir, name) => {
      const abs = join(projectDir, name);
      try {
        return statSync(abs).isDirectory() ? 'folder' : 'doc';
      } catch (err) {
        // ENOENT/ENOTDIR = the name doesn't resolve to anything (a not-yet-
        // created doc, or a path through a file) → treat as a doc, silently.
        // Any other code (EACCES, ELOOP, …) means the path may really be a
        // directory we just couldn't stat — log it so a misclassification is
        // diagnosable rather than silent (mirrors `isServerLive`).
        const code = (err as { code?: string } | null)?.code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          process.stderr.write(
            `[ok open] statSync failed for ${abs} (${code ?? 'unknown'}); treating as a doc\n`,
          );
        }
        return 'doc';
      }
    },
    openTarget: (target) => {
      const child = nodeSpawn('open', [target], {
        detached: true,
        stdio: 'ignore',
        env: scrubElectronRunAsNode(process.env),
      });
      child.unref();
    },
    log: (message) => process.stdout.write(`${message}\n`),
    error: (message) => process.stderr.write(`${message}\n`),
  };
}

/** Reject names the desktop deep-link parser silently drops. */
function isUnsafeName(name: string): boolean {
  return name.startsWith('/') || name.includes('\\') || name.split('/').includes('..');
}

/** Shared exit when neither the desktop app nor a running UI can be reached. */
function noTargetError(deps: OpenDeps): number {
  deps.error(
    'No OpenKnowledge desktop app found and no UI is running. ' +
      'Install OK Desktop, or start a UI with `ok ui`, then retry.',
  );
  return 1;
}

/** Build + open an `openknowledge://open` deep link to the desktop app. */
function openDesktopDeepLink(
  projectDir: string,
  param: 'doc' | 'folder',
  target: string,
  deps: OpenDeps,
): void {
  const deepLink = `openknowledge://open?project=${encodeURIComponent(
    projectDir,
  )}&${param}=${encodeURIComponent(target)}`;
  deps.openTarget(deepLink);
}

/**
 * Core logic, separated from Commander wiring for testability. Returns the
 * process exit code (0 = opened, 1 = nothing to open).
 *
 * Does not check that a doc exists — "open `<doc>`" on a not-yet-created doc
 * lands on the renderer route, which resolves missing targets.
 */
export function runOpen(name: string, options: OpenOptions, deps: OpenDeps): number {
  const projectDir = resolve(options.project ?? process.cwd());
  const cleanName = name.replace(/\/+$/, '');

  if (!cleanName) {
    deps.error(
      'Nothing to open: pass a doc, folder, or skill name (e.g. `ok open specs/foo/SPEC`).',
    );
    return 1;
  }

  // Reject names the desktop deep-link parser silently drops — applied to ALL
  // targets (doc, folder, AND skill) before branching, so a `..` / leading-slash
  // / backslash name can't slip into the synthetic `__skill__/<scope>/<name>`
  // target (or report a false success while the app drops the URL).
  if (isUnsafeName(cleanName)) {
    deps.error(
      `Invalid name "${cleanName}": must be a relative path with no '..' segments, leading '/', or backslashes.`,
    );
    return 1;
  }

  // --- Skill: addressed by name + scope, not a content path. ---
  if (options.skill === true) {
    const scope = (options.scope ?? 'project') as SkillScope;
    if (!(MANAGED_ARTIFACT_SCOPES as readonly string[]).includes(scope)) {
      deps.error(
        `Invalid --scope "${options.scope}": expected one of ${MANAGED_ARTIFACT_SCOPES.join(', ')}.`,
      );
      return 1;
    }
    // The skill editor is an ordinary editor tab keyed on the synthetic
    // `__skill__/<scope>/<name>` docName, so a skill rides the `doc=` deep-link
    // param — no new scheme param needed. Skill names are lowercase-hyphen, so
    // the synthetic name needs no pre-encoding here.
    const bundlePath = deps.detectBundlePath();
    if (bundlePath) {
      openDesktopDeepLink(projectDir, 'doc', `__skill__/${scope}/${cleanName}`, deps);
      deps.log(`Opening skill ${cleanName} (${scope}) in the OpenKnowledge desktop app.`);
      return 0;
    }
    const baseUrl = deps.resolveBaseUrl(projectDir);
    if (baseUrl) {
      const url = `${baseUrl}/#/${encodeSkillRoute(scope, cleanName)}`;
      deps.openTarget(url);
      deps.log(`Opening skill ${cleanName} (${scope}) in your browser: ${url}`);
      return 0;
    }
    return noTargetError(deps);
  }

  // --- Doc vs folder: trailing slash (forces folder) or disk classification. ---
  const isFolder = /\/+$/.test(name) || deps.classifyName(projectDir, cleanName) === 'folder';

  const bundlePath = deps.detectBundlePath();
  if (isFolder) {
    if (bundlePath) {
      openDesktopDeepLink(projectDir, 'folder', cleanName, deps);
      deps.log(`Opening folder ${cleanName} in the OpenKnowledge desktop app.`);
      return 0;
    }
    const baseUrl = deps.resolveBaseUrl(projectDir);
    if (baseUrl) {
      const url = `${baseUrl}/#/${encodeFolderRoute(cleanName)}`;
      deps.openTarget(url);
      deps.log(`Opening folder ${cleanName} in your browser: ${url}`);
      return 0;
    }
    return noTargetError(deps);
  }

  // Doc.
  if (bundlePath) {
    openDesktopDeepLink(projectDir, 'doc', cleanName, deps);
    deps.log(`Opening ${cleanName} in the OpenKnowledge desktop app.`);
    return 0;
  }
  const baseUrl = deps.resolveBaseUrl(projectDir);
  if (baseUrl) {
    const url = `${baseUrl}/#/${encodeDocName(cleanName)}`;
    deps.openTarget(url);
    deps.log(`Opening ${cleanName} in your browser: ${url}`);
    return 0;
  }
  return noTargetError(deps);
}

export function openCommand(): Command {
  return new Command('open')
    .description(
      'Open a doc, folder, or skill in the OK Desktop app (falls back to the browser UI). ' +
        'Docs and folders are auto-detected — no flag needed.',
    )
    .argument(
      '<name>',
      'Doc path (specs/foo/SPEC), folder path (specs/foo or specs/foo/), or a skill name with --skill',
    )
    .option('--skill', 'Open <name> as a skill in the skill editor')
    .option(
      '--scope <scope>',
      `Skill scope when --skill is set: ${MANAGED_ARTIFACT_SCOPES.join(' | ')}`,
      'project',
    )
    .option('--project <dir>', 'Project root (defaults to the current directory)')
    .action((name: string, options: OpenOptions) => {
      process.exitCode = runOpen(name, options, createRealOpenDeps());
    });
}
