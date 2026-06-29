
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export type OriginResult =
  | { kind: 'ok'; owner: string; repo: string }
  | { kind: 'no-remote' }
  | { kind: 'non-github' };

function resolveGitDir(projectDir: string): string | null {
  const gitPath = resolve(projectDir, '.git');
  if (!existsSync(gitPath)) return null;

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(gitPath);
  } catch {
    return null;
  }

  if (stat.isDirectory()) return gitPath;

  if (stat.isFile()) {
    let contents: string;
    try {
      contents = readFileSync(gitPath, 'utf-8');
    } catch {
      return null;
    }
    const match = /^gitdir:\s*(.+)$/m.exec(contents.trim());
    if (!match) return null;
    const rawTarget = match[1].trim();
    const target = isAbsolute(rawTarget) ? rawTarget : resolve(projectDir, rawTarget);
    return existsSync(target) ? target : null;
  }

  return null;
}

function resolveCommonDir(gitDir: string): string {
  const pointer = join(gitDir, 'commondir');
  if (!existsSync(pointer)) return gitDir;
  let contents: string;
  try {
    contents = readFileSync(pointer, 'utf-8').trim();
  } catch {
    return gitDir;
  }
  if (contents.length === 0) return gitDir;
  return isAbsolute(contents) ? contents : resolve(gitDir, contents);
}

export function readGitHeadBranch(projectDir: string): string | null {
  const gitDir = resolveGitDir(projectDir);
  if (!gitDir) return null;
  const headPath = join(gitDir, 'HEAD');
  if (!existsSync(headPath)) return null;
  let head: string;
  try {
    head = readFileSync(headPath, 'utf-8');
  } catch {
    return null;
  }
  const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head.trim());
  return match ? match[1] : null;
}

function stripCommentAndTrim(line: string): string {
  const hashIdx = line.indexOf('#');
  const semiIdx = line.indexOf(';');
  let cutAt = -1;
  if (hashIdx >= 0 && semiIdx >= 0) cutAt = Math.min(hashIdx, semiIdx);
  else if (hashIdx >= 0) cutAt = hashIdx;
  else if (semiIdx >= 0) cutAt = semiIdx;
  return (cutAt === -1 ? line : line.slice(0, cutAt)).trim();
}

export function extractOriginUrl(configContents: string): string | null {
  let inOriginRemote = false;
  for (const rawLine of configContents.split(/\r?\n/)) {
    const line = stripCommentAndTrim(rawLine);
    if (line.length === 0) continue;
    if (line.startsWith('[')) {
      inOriginRemote = /^\[\s*remote\s+["']origin["']\s*\]$/.test(line);
      continue;
    }
    if (!inOriginRemote) continue;
    const match = /^url\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length > 0) return value;
  }
  return null;
}

function parseGitHubOriginUrl(originUrl: string): { owner: string; repo: string } | null {
  const raw = originUrl.trim();
  if (!raw) return null;

  let m = /^https?:\/\/(?:www\.)?github\.com\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(raw);
  if (m) return { owner: m[1], repo: m[2] };

  m = /^ssh:\/\/(?:[\w.-]+@)?github\.com(?::\d+)?\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(
    raw,
  );
  if (m) return { owner: m[1], repo: m[2] };

  m = /^[\w.-]+@github\.com:([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?$/.exec(raw);
  if (m) return { owner: m[1], repo: m[2] };

  m = /^git:\/\/github\.com\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(raw);
  if (m) return { owner: m[1], repo: m[2] };

  return null;
}

function readParsedOrigin(
  projectDir: string,
): { originUrl: string; github: { owner: string; repo: string } | null } | null {
  const gitDir = resolveGitDir(projectDir);
  if (!gitDir) return null;
  const configPath = join(resolveCommonDir(gitDir), 'config');
  if (!existsSync(configPath)) return null;
  let configContents: string;
  try {
    configContents = readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }
  const originUrl = extractOriginUrl(configContents);
  if (!originUrl) return null;
  return { originUrl, github: parseGitHubOriginUrl(originUrl) };
}

export function readOriginGitHubRepo(projectDir: string): OriginResult {
  const parsed = readParsedOrigin(projectDir);
  if (!parsed) return { kind: 'no-remote' };
  if (parsed.github) return { kind: 'ok', owner: parsed.github.owner, repo: parsed.github.repo };
  return { kind: 'non-github' };
}

export interface SyncRemoteInfo {
  label: string;
  webUrl: string | null;
}

export function readSyncRemoteInfo(projectDir: string): SyncRemoteInfo | null {
  const parsed = readParsedOrigin(projectDir);
  if (!parsed) return null;
  if (parsed.github) {
    return {
      label: `${parsed.github.owner}/${parsed.github.repo}`,
      webUrl: `https://github.com/${parsed.github.owner}/${parsed.github.repo}`,
    };
  }
  return { label: labelFromNonGitHubUrl(parsed.originUrl), webUrl: null };
}

function labelFromNonGitHubUrl(url: string): string {
  const trimmed = url.trim().replace(/\.git$/, '');
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(trimmed);
  if (scp) return `${scp[1]}/${scp[2]}`;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)*(.+)$/i.exec(trimmed);
  if (scheme) return scheme[1];
  return trimmed;
}

export function branchExistsOnOrigin(projectDir: string, branch: string): boolean {
  const gitDir = resolveGitDir(projectDir);
  if (!gitDir) return false;
  const commonDir = resolveCommonDir(gitDir);

  const loosePath = join(commonDir, 'refs', 'remotes', 'origin', branch);
  if (existsSync(loosePath)) return true;

  const packedPath = join(commonDir, 'packed-refs');
  if (!existsSync(packedPath)) return false;
  let packed: string;
  try {
    packed = readFileSync(packedPath, 'utf-8');
  } catch {
    return false;
  }
  const target = `refs/remotes/origin/${branch}`;
  for (const rawLine of packed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith('^')) continue;
    const parts = line.split(/\s+/);
    if (parts.length === 2 && parts[1] === target) return true;
  }
  return false;
}
