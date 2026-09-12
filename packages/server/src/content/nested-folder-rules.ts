import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { assertNoSymlinkEscape, checkSymlinkLeaf, isContainmentRejection } from '../fs-safety.ts';
import { getLogger } from '../logger.ts';

export type FolderFrontmatter = {
  title?: string;
  description?: string;
  tags?: string[];
} & Record<string, unknown>;

export function readFolderFrontmatter(
  projectDir: string,
  folderRelPath: string,
): FolderFrontmatter {
  const yamlPath = nestedOkPath(projectDir, folderRelPath, 'frontmatter.yml');
  /* STOP: the leaf lstat below cannot see a symlinked `.ok` ANCESTOR — the
     kernel dereferences it before reaching the final component — so the
     containing `.ok` dir gets its own identity check, matching
     `collectFromFolder` and the fetch-by-name walk. */
  if (checkSymlinkLeaf(dirname(yamlPath)).kind === 'symlink') {
    warnOnce(
      'symlink',
      yamlPath,
      `${dirname(yamlPath)} is a symlink — folder metadata skipped. Replace the symlink with a real directory.`,
    );
    return {};
  }
  const leafCheck = checkSymlinkLeaf(yamlPath);
  if (leafCheck.kind === 'symlink') {
    warnOnce(
      'symlink',
      yamlPath,
      `symlink at ${yamlPath} — folder metadata skipped. Replace it with a regular file.`,
    );
    return {};
  }
  if (leafCheck.kind === 'unverifiable') {
    warnOnce(
      'unverifiable',
      yamlPath,
      `cannot lstat ${yamlPath} (${leafCheck.code ?? 'unknown errno'}) — folder metadata skipped.`,
    );
    return {};
  }
  if (!existsSync(yamlPath)) return {};
  /* STOP: unlike the folder-config route arms, this reader's other caller
     (`enrichDirectory` via MCP `exec`) has only lexical containment in front
     of it, so a symlinked ancestor (`<folder>/.ok -> /outside`) must be
     refused HERE — the leaf check above cannot see it. */
  try {
    assertNoSymlinkEscape(yamlPath, resolve(projectDir));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnOnce(
      isContainmentRejection(err) ? 'escape' : 'canonicalize',
      yamlPath,
      `cannot safely read ${yamlPath} — folder metadata skipped. Reason: ${reason}`,
    );
    return {};
  }
  const parsed = readFrontmatterYaml(yamlPath);
  return parsed != null ? coerceWellKnown(parsed) : {};
}

function coerceWellKnown(raw: Record<string, unknown>): FolderFrontmatter {
  const out: FolderFrontmatter = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = value;
  }
  if (typeof raw.title === 'string') out.title = raw.title;
  else delete out.title;
  if (typeof raw.description === 'string') out.description = raw.description;
  else delete out.description;
  if (Array.isArray(raw.tags)) {
    out.tags = (raw.tags as unknown[]).filter((t): t is string => typeof t === 'string');
  } else {
    delete out.tags;
  }
  return out;
}

const WARN_CLASSES = [
  'symlink',
  'unverifiable',
  'escape',
  'canonicalize',
  'malformed-yaml',
] as const;
type WarnClass = (typeof WARN_CLASSES)[number];

const warnedPaths = new Set<string>();

function warnOnce(kind: WarnClass, absPath: string, message: string): void {
  const key = `${kind}:${absPath}`;
  if (warnedPaths.has(key)) return;
  warnedPaths.add(key);
  getLogger('folder-frontmatter').warn({ path: absPath, kind }, message);
}

function clearWarns(absPath: string): void {
  for (const kind of WARN_CLASSES) warnedPaths.delete(`${kind}:${absPath}`);
}

function readFrontmatterYaml(absYamlPath: string): Record<string, unknown> | null {
  let content: string;
  try {
    content = readFileSync(absYamlPath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnOnce(
      'malformed-yaml',
      absYamlPath,
      `malformed YAML at ${absYamlPath} — folder metadata skipped. Fix the file or delete it. Reason: ${reason}`,
    );
    return null;
  }

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  clearWarns(absYamlPath);
  return parsed as Record<string, unknown>;
}

export function nestedOkPath(projectDir: string, folderRelPath: string, member: string): string {
  const normalized = folderRelPath.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  return normalized === '' || normalized === '.'
    ? join(projectDir, '.ok', member)
    : join(projectDir, normalized, '.ok', member);
}

export function parentFolderOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}
