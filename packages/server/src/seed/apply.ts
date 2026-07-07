import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { installPackSkill } from './install-pack-skill.ts';
import { assertEntryPathInProject } from './path-safety.ts';
import { buildStarterFolderFrontmatterYaml, DEFAULT_PACK_ID, resolvePack } from './starter.ts';
import type { ApplyError, ApplyResult, FileEntry, ScaffoldPlan, SeedOptions } from './types.ts';
import { SeedRootDirError } from './types.ts';

/**
 * Resolve the content for a `FileEntry` from the selected pack. Three template
 * id shapes:
 *   - `<rootFileKey>` (e.g. `log.md`, or a folder-prefixed `wiki/OVERVIEW.md`)
 *     — looked up in `pack.rootFiles`
 *   - `<folder>/.ok/frontmatter.yml` — built from `pack.folders`
 *   - `<folder>/.ok/templates/<name>.md` — looked up in `pack.templates`
 *
 * Both the `<folder>` segment and a rootFile key may be nested
 * (`wiki/architecture`, `wiki/OVERVIEW.md`) so a pack can scaffold under a
 * subfolder without `--root`. The rootFiles exact-key lookup runs FIRST: it
 * cannot false-positive, so checking it before the folder-id regexes makes the
 * disambiguation structural rather than convention-dependent — a rootFile key
 * resolves directly and never falls into a regex, even an unusual one that
 * happens to contain `/.ok/`. The folder-id regexes then match a slash-bearing
 * folder segment, with the exact `pack.folders` lookup as the real validator.
 *
 * Returns `undefined` when no content can be resolved — apply() converts that
 * into an `ApplyError` rather than writing an empty file.
 */
function resolveFileContent(
  templateId: string,
  pack: ReturnType<typeof resolvePack>,
): string | undefined {
  // Root files — exact key lookup (e.g. `log.md`, `wiki/OVERVIEW.md`). First so
  // a rootFile key can never be mis-claimed by the folder-id regexes.
  if (pack.rootFiles?.[templateId] !== undefined) {
    return pack.rootFiles[templateId];
  }

  // Frontmatter writes: `<folder>/.ok/frontmatter.yml` (folder may be nested).
  // The exact `pack.folders` match means an over-greedy capture simply fails to
  // resolve rather than mis-resolving to the wrong folder.
  const fmMatch = /^(.+)\/\.ok\/frontmatter\.yml$/.exec(templateId);
  if (fmMatch) {
    const folder = pack.folders.find((f) => f.path === fmMatch[1]);
    if (!folder) return undefined;
    return buildStarterFolderFrontmatterYaml(folder);
  }

  // Template writes: `<folder>/.ok/templates/<name>.md` (folder may be nested;
  // the template name is the final path segment).
  const tplMatch = /^(.+)\/\.ok\/templates\/([^/]+)\.md$/.exec(templateId);
  if (tplMatch) {
    const templateName = tplMatch[2] ?? '';
    return pack.templates[templateName];
  }

  return undefined;
}

/**
 * Apply a ScaffoldPlan to disk. Creates folders + writes files.
 *
 * The pack to apply is selected via `opts.packId` (default `'knowledge-base'`).
 * The plan was already computed against the same pack — apply just resolves
 * template content from the pack's `templates` and `rootFiles` maps.
 *
 * Folder defaults land as nested `<folder>/.ok/frontmatter.yml` files, and
 * starter templates land as nested `<folder>/.ok/templates/<name>.md`. There is
 * no longer a `config.yml folders:` write step.
 *
 * Rollback semantics: not atomic. On partial failure (EACCES mid-write),
 * successfully-written entries remain on disk; `errors` lists what failed.
 * Folder writes are ordered first so files have parents to land in.
 */
export async function applySeed(plan: ScaffoldPlan, opts: SeedOptions = {}): Promise<ApplyResult> {
  const started = Date.now();
  const projectDir = resolve(opts.projectDir ?? process.cwd());
  const pack = resolvePack(opts.packId ?? DEFAULT_PACK_ID);

  let applied = 0;
  const errors: ApplyError[] = [];

  // Containment guard for every plan entry (lexical + realpath). Plan paths
  // come across a trust boundary (HTTP /api/seed/apply, IPC payload); a
  // malicious `..` segment or a symlinked ancestor would otherwise escape
  // projectDir at writeFileSync time. Rejected entries are recorded as errors
  // and skipped — apply is best-effort and continues with the rest.
  const safeEntries: Array<{ entry: FileEntry; absPath: string }> = [];
  for (const entry of plan.created) {
    try {
      const absPath = assertEntryPathInProject(projectDir, entry.path);
      safeEntries.push({ entry, absPath });
    } catch (err) {
      errors.push({
        path: typeof entry.path === 'string' ? entry.path : String(entry.path),
        error:
          err instanceof SeedRootDirError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err),
      });
    }
  }

  // 1. Folders first — files need their parent dirs to exist.
  for (const { entry, absPath } of safeEntries.filter(
    (e): e is { entry: FileEntry & { kind: 'folder' }; absPath: string } =>
      e.entry.kind === 'folder',
  )) {
    try {
      mkdirSync(absPath, { recursive: true });
      applied += 1;
    } catch (err) {
      errors.push({ path: entry.path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // 2. Files — only write if absent (defense-in-depth; plan should already
  //    have excluded existing ones, but a race could slip through).
  for (const { entry, absPath } of safeEntries.filter(
    (e): e is { entry: FileEntry & { kind: 'file' }; absPath: string } => e.entry.kind === 'file',
  )) {
    const templateId = entry.template ?? entry.path;
    const content = resolveFileContent(templateId, pack);
    if (content === undefined) {
      errors.push({
        path: entry.path,
        error: `No content template registered for template id "${templateId}" in pack "${pack.id}"`,
      });
      continue;
    }
    if (existsSync(absPath)) {
      // Already present — plan was stale, skip silently (not an error).
      continue;
    }
    try {
      writeFileSync(absPath, content, 'utf-8');
      applied += 1;
    } catch (err) {
      errors.push({ path: entry.path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Author + install the pack's project-local skill (into `.ok/skills/` so it
  // shows in the Skills list + into each set-up editor's host dir). Single site
  // for every seed entry point (CLI / desktop IPC / HTTP), since they all call
  // applySeed. No-op when no editor is set up or the pack ships no skill.
  const packSkillsInstalled = await installPackSkill(projectDir, pack.id);

  return {
    applied,
    errors,
    durationMs: Date.now() - started,
    packSkillsInstalled,
  };
}
