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
import {
  type OpenTargetOptions,
  openTargetFailureMessage,
  openTarget as openTargetReal,
} from '../utils/open-target.ts';
import { createRealDetectDeps, type DetectResult, detectDesktop } from './desktop-dispatch.ts';

export interface OpenOptions {
  skill?: boolean;
  scope?: string;
  project?: string;
}

export interface OpenDeps {
  detectBundlePath: () => string | null;
  resolveBaseUrl: (projectDir: string) => string | null;
  classifyName: (projectDir: string, name: string) => 'doc' | 'folder';
  openTarget: (
    target: string,
    options?: Pick<OpenTargetOptions, 'desktopBundlePath'>,
  ) => Promise<SpawnDetachedScrubbedOutcome>;
  findAncestorProject: (projectDir: string) => string | null;
  isProjectRoot: (dir: string) => boolean;
  enclosingProject: (dir: string) => string | null;
  log: (message: string) => void;
  error: (message: string) => void;
}

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

function isUnsafeName(name: string): boolean {
  return name.startsWith('/') || name.includes('\\') || name.split('/').includes('..');
}

function noTargetError(deps: OpenDeps): number {
  deps.error(
    'No OpenKnowledge desktop app found and no UI is running. ' +
      'Install it from https://openknowledge.ai/download, or run `ok start` to serve the editor, then retry.',
  );
  return 1;
}

async function openAndReport(
  target: string,
  successMessage: string,
  projectDir: string,
  isProject: boolean,
  deps: OpenDeps,
  desktopBundlePath?: string,
): Promise<number> {
  const outcome = await deps.openTarget(target, desktopBundlePath ? { desktopBundlePath } : {});
  if (!outcome.ok) {
    deps.error(`Could not open ${target}: ${openTargetFailureMessage(outcome.reason, target)}.`);
    return 1;
  }
  deps.log(successMessage);
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

export async function runOpen(name: string, options: OpenOptions, deps: OpenDeps): Promise<number> {
  const explicitProject = options.project !== undefined;
  const cwdProject = explicitProject ? null : deps.enclosingProject(process.cwd());
  const projectDir = resolve(options.project ?? cwdProject ?? process.cwd());
  const isProject = explicitProject || cwdProject !== null;
  const cleanName = name.replace(/\/+$/, '');

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

  if (isUnsafeName(cleanName)) {
    deps.error(
      `Invalid name "${cleanName}": must be a relative path with no '..' segments, leading '/', or backslashes.`,
    );
    return 1;
  }

  if (options.skill === true) {
    const scope = (options.scope ?? 'project') as SkillScope;
    if (!(MANAGED_ARTIFACT_SCOPES as readonly string[]).includes(scope)) {
      deps.error(
        `Invalid --scope "${options.scope}": expected one of ${MANAGED_ARTIFACT_SCOPES.join(', ')}.`,
      );
      return 1;
    }
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
        bundlePath,
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
        bundlePath,
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
      bundlePath,
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
