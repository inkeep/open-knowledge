/**
 * Materialize the OKF schemas into `.ok/okf/` so an agent can read the contract it is
 * told governs a document.
 *
 * Runs from the config funnel whenever the `okf` plugin's schema-relevant state changes,
 * and rewrites unconditionally when it does. Rewriting is the point: it means a stray
 * edit is reverted on the next state change or restart, which — with the `$comment`
 * header each file carries — is the clearest available signal that these are generated
 * and that editing them accomplishes nothing.
 *
 * The directory mirrors the rule toggles: a schema file exists exactly while its rule is
 * enabled. Toggling a rule off deletes its file, and disabling the plugin removes them
 * all — advertisement stops naming a disabled rule's schema, so a lingering file would
 * describe a contract nothing points to.
 *
 * Bytes are compared before writing. A boot that changes nothing leaves the files' mtimes
 * alone, so a watcher or an editor holding one open is not disturbed every restart.
 *
 * Failure is never fatal. These files are a convenience for agents; the plugin validates
 * from its compiled copy regardless, so a read-only checkout or a permissions problem
 * degrades to "no schema files" rather than a server that will not boot.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  isOkfRuleEnabled,
  OKF_FRONTMATTER_REGISTRY,
  OKF_SCHEMA_DIR,
  type OkfRuleToggles,
  renderOkfSchemaFiles,
} from '@inkeep/open-knowledge-core';
import {
  tracedMkdirSync,
  tracedRmdirSync,
  tracedRmSync,
  tracedWriteFileSync,
} from '../fs-traced.ts';
import { getLogger } from '../logger.ts';

/** Line added to `.ok/.gitignore` so generated schemas stay out of commits. */
const IGNORE_LINE = 'okf/';

const IGNORE_BLOCK = `
# .ok/okf/ holds the OKF lint plugin's schemas, rendered from the plugin on
# boot so agents can read the contract they are told governs a document. A
# generated artifact — regenerated whenever the plugin's copy changes, and
# never read back — so it is not committed.
${IGNORE_LINE}
`;

/**
 * Append the ignore rule when it is absent.
 *
 * Existing projects were scaffolded before this directory existed, so seeding the rule at
 * `ok init` would only ever cover new ones — and the first boot after an upgrade is
 * exactly when the untracked directory appears. Appending here covers both.
 *
 * The match is deliberately loose (any line equal to `okf/`, ignoring surrounding space)
 * so a user who wrote the rule themselves, or moved it, does not get a duplicate.
 */
function ensureGitignored(projectDir: string): void {
  const ignorePath = join(projectDir, '.ok', '.gitignore');
  let current: string;
  try {
    current = readFileSync(ignorePath, 'utf8');
  } catch (error) {
    // ENOENT is the expected case: this project has no seeded ignore file, so
    // there is nothing to extend and nothing to guess about its conventions.
    // Any OTHER read error (EACCES/EIO) means the file is there but unreadable
    // — surface it rather than silently leaving the generated schemas
    // untracked, which from here looks identical to "no ignore file".
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      getLogger('okf-schemas').warn(
        { err: error, projectDir },
        '[okf] could not read .ok/.gitignore; generated schemas may show as untracked',
      );
    }
    return;
  }
  const alreadyIgnored = current.split('\n').some((line) => line.trim() === IGNORE_LINE);
  if (alreadyIgnored) return;
  tracedWriteFileSync(ignorePath, `${current.replace(/\n*$/, '\n')}${IGNORE_BLOCK}`, 'utf8');
  // Appending to a git-tracked file on boot is deliberate but surprising; a
  // debug line explains an otherwise-unauthored working-tree change.
  getLogger('okf-schemas').debug(
    { projectDir },
    '[okf] added okf/ to .ok/.gitignore so generated schemas stay uncommitted',
  );
}

/** The schema-relevant slice of the persisted `okf` plugin config. */
export interface OkfSchemaState {
  readonly enabled?: boolean;
  readonly rules?: OkfRuleToggles;
}

/**
 * Last-applied state per project dir, encoded as a comparable string. Keyed so a server
 * serving more than one project does not skip the second, and stored as the signature —
 * not a boolean — so a per-rule toggle is a state change the funnel notices, not just
 * plugin on/off.
 */
const appliedSignatures = new Map<string, string>();

/** What of `okf` the directory contents depend on: plugin on/off + which rules are off. */
function schemaSignature(okf: OkfSchemaState | undefined): string {
  if (okf?.enabled !== true) return 'off';
  const disabled = OKF_FRONTMATTER_REGISTRY.filter(
    (entry) => !isOkfRuleEnabled(okf.rules, entry.id),
  ).map((entry) => entry.id);
  return `on:${disabled.sort().join(',')}`;
}

/**
 * Reconcile `.ok/okf/` with the plugin state, once per state change.
 *
 * Called from the config funnel rather than from boot alone. The plugin and its rules
 * can be switched at runtime — the config is read fresh per request — and advertisement
 * names these paths only while a rule is enabled, so the files must track the toggles:
 * appear when a rule turns on, disappear when it turns off. After the first call for a
 * given state this is a Map lookup.
 */
export function ensureOkfSchemaFiles(projectDir: string, okf: OkfSchemaState | undefined): void {
  const signature = schemaSignature(okf);
  if (appliedSignatures.get(projectDir) === signature) return;
  appliedSignatures.set(projectDir, signature);
  if (okf?.enabled === true) {
    writeOkfSchemaFiles(projectDir, okf.rules);
  } else {
    removeOkfSchemaFiles(projectDir);
  }
}

/** Test seam: forget what this process has written. */
export function resetOkfSchemaWriteState(): void {
  appliedSignatures.clear();
}

/**
 * Write the schemas for enabled rules under `projectDir` and delete the files of
 * disabled ones, so the directory always lists exactly the contracts in force. Returns
 * the project-relative paths written or already current, for logging; an empty array
 * means the write was skipped.
 */
export function writeOkfSchemaFiles(projectDir: string, rules?: OkfRuleToggles): string[] {
  const files = renderOkfSchemaFiles();
  const written: string[] = [];
  try {
    tracedMkdirSync(join(projectDir, OKF_SCHEMA_DIR), { recursive: true });
    for (const file of files) {
      const abs = join(projectDir, file.path);
      if (!isOkfRuleEnabled(rules, file.ruleId)) {
        tracedRmSync(abs, { force: true });
        continue;
      }
      let existing: string | null = null;
      try {
        existing = readFileSync(abs, 'utf8');
      } catch {
        existing = null;
      }
      if (existing !== file.contents) {
        tracedMkdirSync(dirname(abs), { recursive: true });
        tracedWriteFileSync(abs, file.contents, 'utf8');
      }
      written.push(file.path);
    }
    ensureGitignored(projectDir);
  } catch (error) {
    getLogger('okf-schemas').warn(
      { err: error, projectDir },
      '[okf] could not write schema files; the plugin still validates from its own copy',
    );
    return [];
  }
  return written;
}

/**
 * Delete every generated schema, and the directory when that leaves it empty.
 *
 * Removes only the files this module renders — a stray file someone parked in `.ok/okf/`
 * survives, and the non-empty directory with it. `rmdirSync` (not recursive `rm`) is what
 * makes that guarantee structural rather than a matter of care.
 */
function removeOkfSchemaFiles(projectDir: string): void {
  try {
    for (const file of renderOkfSchemaFiles()) {
      tracedRmSync(join(projectDir, file.path), { force: true });
    }
    tracedRmdirSync(join(projectDir, OKF_SCHEMA_DIR));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT: never materialized. ENOTEMPTY: a file we did not write is parked
    // there; leaving it is the point of the non-recursive rmdir.
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
      getLogger('okf-schemas').warn(
        { err: error, projectDir },
        '[okf] could not remove generated schema files',
      );
    }
  }
}
