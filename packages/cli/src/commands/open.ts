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
 * supported-platform desktop executable is installed and `OK_FORCE_BROWSER` is unset — including
 * non-TTY/headless invocations (an agent shelling out). The verb spawns its own
 * platform-native URL handler rather than `launchDesktop`.
 */
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { MANAGED_ARTIFACT_SCOPES, type SkillScope } from '@inkeep/open-knowledge-core';
import {
  encodeDocName,
  encodeFolderRoute,
  encodeSkillRoute,
  findEnclosingProjectRoot,
  resolveLockDir,
  resolveUiInfo,
} from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import type { SpawnDetachedScrubbedOutcome } from '../utils/detached-spawn.ts';
import { openTargetFailureMessage, openTarget as openTargetReal } from '../utils/open-target.ts';
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
  openTarget: (target: string) => Promise<SpawnDetachedScrubbedOutcome>;
  /**
   * Nearest project root STRICTLY above `projectDir`, or null. Drives the
   * nested-project disclosure — a resolved root that sits inside another
   * project is the topology behind silent misrouting, so it is named rather
   * than left for a second command to discover.
   */
  findAncestorProject: (projectDir: string) => string | null;
  /**
   * True when `dir` is itself an OpenKnowledge project root. Only consulted for
   * an EXPLICIT `--project`: an override that names a non-project must fail
   * loudly, because proceeding would open a different project than the caller
   * asked for and report success while doing it.
   */
  isProjectRoot: (dir: string) => boolean;
  /**
   * The project root enclosing `dir`, or `dir` itself when it is one; null when
   * no project encloses it. Used for the cwd default: running from a
   * subdirectory of a project must act on the PROJECT, not on the
   * subdirectory, which is neither a valid deep-link target nor a truthful
   * thing to print.
   */
  enclosingProject: (dir: string) => string | null;
  log: (message: string) => void;
  error: (message: string) => void;
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
    openTarget: openTargetReal,
    findAncestorProject: (projectDir) =>
      findEnclosingProjectRoot(dirname(resolve(projectDir)))?.rootPath ?? null,
    isProjectRoot: (dir) => findEnclosingProjectRoot(dir)?.distance === 0,
    enclosingProject: (dir) => findEnclosingProjectRoot(resolve(dir))?.rootPath ?? null,
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
      'Install it from https://openknowledge.ai/download, or run `ok start` to serve the editor, then retry.',
  );
  return 1;
}

/**
 * The one reporting point for every CLI open entry point (subcommand and the
 * bare-file dispatch, which routes through `runOpen`): the resolved absolute
 * directory is named on success so no caller can drift into opening silently,
 * and a nested resolution names both roots once.
 *
 * `isProject` is threaded rather than re-derived: the caller already knows
 * whether the directory is a project root, and calling it a "project" when it
 * is only a cwd fallback is the same class of confidently-wrong output this
 * surface exists to prevent.
 */
async function openAndReport(
  target: string,
  successMessage: string,
  projectDir: string,
  isProject: boolean,
  deps: OpenDeps,
): Promise<number> {
  const outcome = await deps.openTarget(target);
  if (!outcome.ok) {
    deps.error(`Could not open ${target}: ${openTargetFailureMessage(outcome.reason, target)}.`);
    return 1;
  }
  deps.log(successMessage);
  // Nothing encloses the working directory, so there is no project to name and
  // no nesting to describe — a nested-project note derived from a non-project
  // would assert a topology that does not exist.
  if (!isProject) {
    deps.log(`Working directory: ${projectDir} (not an OpenKnowledge project).`);
    return 0;
  }
  deps.log(`Project: ${projectDir}`);
  const ancestor = deps.findAncestorProject(projectDir);
  if (ancestor !== null) {
    deps.log(
      `Note: this project (${projectDir}) is nested inside another OpenKnowledge project at ${ancestor}. ` +
        'Pass --project to choose explicitly.',
    );
  }
  return 0;
}

/**
 * Core logic, separated from Commander wiring for testability. Returns the
 * process exit code (0 = opened, 1 = nothing to open).
 *
 * Does not check that a doc exists — "open `<doc>`" on a not-yet-created doc
 * lands on the renderer route, which resolves missing targets.
 */
export async function runOpen(name: string, options: OpenOptions, deps: OpenDeps): Promise<number> {
  // An explicit override is taken as given (and validated below). Otherwise
  // resolve the project that ENCLOSES the working directory: `ok open` is
  // routinely run from a subdirectory, and treating that subdirectory as the
  // project both misroutes the deep link and makes the disclosure line — and
  // the nested-project note derived from it — untrue.
  const explicitProject = options.project !== undefined;
  const cwdProject = explicitProject ? null : deps.enclosingProject(process.cwd());
  const projectDir = resolve(options.project ?? cwdProject ?? process.cwd());
  // An explicit override is validated as a project root below; a cwd default is
  // one only when a project actually encloses the working directory. Everything
  // else is a bare directory, and the reporting must not claim otherwise.
  const isProject = explicitProject || cwdProject !== null;
  const cleanName = name.replace(/\/+$/, '');

  // An explicit override that does not name a project is refused rather than
  // silently resolved elsewhere — a wrong project that reports success is the
  // failure this whole surface exists to prevent. An absent override keeps the
  // cwd default, which resolves normally.
  if (explicitProject && !deps.isProjectRoot(projectDir)) {
    deps.error(
      `Cannot open with --project ${projectDir}: no .ok/config.yml there, so it is not an OpenKnowledge project.`,
    );
    return 1;
  }

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
      const deepLink = `openknowledge://open?project=${encodeURIComponent(
        projectDir,
      )}&doc=${encodeURIComponent(`__skill__/${scope}/${cleanName}`)}`;
      return openAndReport(
        deepLink,
        `Opening skill ${cleanName} (${scope}) in the OpenKnowledge desktop app.`,
        projectDir,
        isProject,
        deps,
      );
    }
    const baseUrl = deps.resolveBaseUrl(projectDir);
    if (baseUrl) {
      const url = `${baseUrl}/#/${encodeSkillRoute(scope, cleanName)}`;
      return openAndReport(
        url,
        `Opening skill ${cleanName} (${scope}) in your browser: ${url}`,
        projectDir,
        isProject,
        deps,
      );
    }
    return noTargetError(deps);
  }

  // --- Doc vs folder: trailing slash (forces folder) or disk classification. ---
  const isFolder = /\/+$/.test(name) || deps.classifyName(projectDir, cleanName) === 'folder';

  const bundlePath = deps.detectBundlePath();
  if (isFolder) {
    if (bundlePath) {
      const deepLink = `openknowledge://open?project=${encodeURIComponent(
        projectDir,
      )}&folder=${encodeURIComponent(cleanName)}`;
      return openAndReport(
        deepLink,
        `Opening folder ${cleanName} in the OpenKnowledge desktop app.`,
        projectDir,
        isProject,
        deps,
      );
    }
    const baseUrl = deps.resolveBaseUrl(projectDir);
    if (baseUrl) {
      const url = `${baseUrl}/#/${encodeFolderRoute(cleanName)}`;
      return openAndReport(
        url,
        `Opening folder ${cleanName} in your browser: ${url}`,
        projectDir,
        isProject,
        deps,
      );
    }
    return noTargetError(deps);
  }

  // Doc.
  if (bundlePath) {
    const deepLink = `openknowledge://open?project=${encodeURIComponent(
      projectDir,
    )}&doc=${encodeURIComponent(cleanName)}`;
    return openAndReport(
      deepLink,
      `Opening ${cleanName} in the OpenKnowledge desktop app.`,
      projectDir,
      isProject,
      deps,
    );
  }
  const baseUrl = deps.resolveBaseUrl(projectDir);
  if (baseUrl) {
    const url = `${baseUrl}/#/${encodeDocName(cleanName)}`;
    return openAndReport(
      url,
      `Opening ${cleanName} in your browser: ${url}`,
      projectDir,
      isProject,
      deps,
    );
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
    .option(
      '--project <dir>',
      'Project root (defaults to the project enclosing the current directory)',
    )
    .action(async (name: string, options: OpenOptions) => {
      process.exitCode = await runOpen(name, options, createRealOpenDeps());
    });
}
