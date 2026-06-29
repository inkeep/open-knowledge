
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseGitUrl } from '@inkeep/open-knowledge';

export function readCanonicalGitHubRemoteUrl(projectPath: string): string | null {
  const gitDir = resolveGitDir(projectPath);
  if (gitDir === null) return null;
  let raw: string;
  try {
    raw = readFileSync(join(resolveCommonDir(gitDir), 'config'), 'utf-8');
  } catch {
    return null;
  }
  const originUrl = extractOriginUrl(raw);
  if (originUrl === null) return null;
  const parsed = parseGitUrl(originUrl);
  if (parsed === null) return null;
  if (parsed.hostname !== 'github.com') return null;
  return `https://github.com/${parsed.owner}/${parsed.name}.git`;
}

function resolveGitDir(projectPath: string): string | null {
  const dotGit = join(projectPath, '.git');
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return null;
  let pointer: string;
  try {
    pointer = readFileSync(dotGit, 'utf-8');
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(pointer.trim());
  if (!match) return null;
  const target = match[1].trim();
  return isAbsolute(target) ? target : resolve(projectPath, target);
}

function resolveCommonDir(gitDir: string): string {
  const pointer = join(gitDir, 'commondir');
  let contents: string;
  try {
    contents = readFileSync(pointer, 'utf-8').trim();
  } catch {
    return gitDir;
  }
  if (contents.length === 0) return gitDir;
  return isAbsolute(contents) ? contents : resolve(gitDir, contents);
}

export function extractOriginUrl(configBlob: string): string | null {
  let inOriginSection = false;
  for (const rawLine of configBlob.split(/\r?\n/)) {
    const line = stripCommentAndTrim(rawLine);
    if (line.length === 0) continue;
    if (line.startsWith('[')) {
      inOriginSection = /^\[\s*remote\s+["']origin["']\s*\]$/.test(line);
      continue;
    }
    if (!inOriginSection) continue;
    const m = /^url\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    return unquote(m[1]);
  }
  return null;
}

function stripCommentAndTrim(line: string): string {
  const indexes = [line.indexOf('#'), line.indexOf(';')].filter((i) => i >= 0);
  if (indexes.length === 0) return line.trim();
  const idx = Math.min(...indexes);
  return line.slice(0, idx).trim();
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
