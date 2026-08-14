/**
 * The one place that knows how "this pack requires plugin X" becomes config.
 *
 * A pack declares `requiredPlugins: ['okf']` — a dependency it states about
 * itself. Nothing in the pack definition mentions `contentRules`, `enabled`, or
 * YAML. That spelling lives here, so a change to the config shape is a change
 * to this file and not to every pack.
 *
 * Reading and writing are deliberately siblings: `plan` asks whether a plugin is
 * already on to compute `pending`, and `apply` turns it on. If those two
 * disagreed about which key means "enabled", the plan would promise one thing
 * and the apply would do another.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LintPluginId } from '@inkeep/open-knowledge-core';
import { parseDocument } from 'yaml';
import { tracedWriteFileSync } from '../fs-traced.ts';
import { CONFIG_FILENAME } from '../init-project.ts';

/** `.ok/config.yml` under a project root. */
function configPath(projectDir: string): string {
  return join(projectDir, '.ok', CONFIG_FILENAME);
}

/**
 * Whether `id` is currently enabled for this project.
 *
 * Anything unreadable, unparseable, or absent reads as NOT enabled. That is the
 * safe direction for both callers: the plan reports the plugin as pending and
 * the apply turns it on, which is idempotent. Guessing "enabled" from a broken
 * config would instead make the seed silently skip the one thing the pack needs.
 */
export function isPluginEnabled(projectDir: string, id: LintPluginId): boolean {
  let raw: string;
  try {
    raw = readFileSync(configPath(projectDir), 'utf8');
  } catch {
    return false;
  }
  try {
    const parsed = parseDocument(raw).toJSON() as
      | { contentRules?: Record<string, { enabled?: unknown }> }
      | null
      | undefined;
    return parsed?.contentRules?.[id]?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Turn `ids` on in the project config, returning the ids actually written.
 *
 * Sets the one leaf per plugin via the YAML Document rather than rewriting the
 * file: a user's other `contentRules` entries, their markdownlint rules, and
 * their comments and formatting all survive. `setIn` creates the intermediate
 * maps when the config has no `contentRules` block yet, so a freshly-initialized
 * (empty) config works without a special case.
 *
 * Deliberately NOT `applyPatchToDocument`: two functions carry that name in
 * core, and the one the barrel exports is the FRONTMATTER patcher, which
 * flattens a nested patch and drops sibling keys. It type-checks against a
 * Document and fails silently. Setting the leaf directly is both narrower than
 * this needs and immune to that.
 *
 * Already-enabled ids are skipped rather than re-written, which keeps a re-seed
 * from touching the file's mtime for no reason. An unwritable config is not
 * fatal: the caller reports it and the rest of the seed stands.
 */
export function enableRequiredPlugins(
  projectDir: string,
  ids: readonly LintPluginId[],
): LintPluginId[] {
  const pending = ids.filter((id) => !isPluginEnabled(projectDir, id));
  if (pending.length === 0) return [];

  const path = configPath(projectDir);
  const doc = parseDocument(readFileSync(path, 'utf8'));
  for (const id of pending) {
    doc.setIn(['contentRules', id, 'enabled'], true);
  }
  tracedWriteFileSync(path, doc.toString(), 'utf8');
  return pending;
}
