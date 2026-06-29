
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONFIG_SCHEMA_MAJOR_PATH, LOCAL_DIR, OK_DIR } from '@inkeep/open-knowledge-core';
import { tracedMkdirSync, tracedWriteFileSync } from './fs-traced.ts';

export const CONFIG_FILENAME = 'config.yml';

function assertNotSymlink(filePath: string, label: string): void {
  let lst: ReturnType<typeof lstatSync>;
  try {
    lst = lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (lst.isSymbolicLink()) {
    throw new Error(
      `Refusing to follow symlink at ${label} (${filePath}). ` +
        `An untrusted upstream may have committed this symlink to redirect writes outside the project. ` +
        `Remove the symlink and re-run.`,
    );
  }
}

export function packageVersionMajorMinor(version: string): string {
  const [rawMajor = '0', rawMinor = '0'] = version.split('.');
  const major = rawMajor.length > 0 ? rawMajor : '0';
  const minor = rawMinor.length > 0 ? rawMinor : '0';
  return `${major}.${minor}`;
}

function quoteYamlScalar(value: string): string {
  return /^[A-Za-z0-9._\-/]+$/.test(value) ? value : JSON.stringify(value);
}

export interface BuildConfigYmlOptions {
  /** When set and not `'.'`, the scaffold's commented `content.dir`
   * placeholder is replaced with the uncommented form so a freshly written
   * config.yml carries the resolved scope (e.g., git-root promotion's picked
   * sub-path). `'.'` and `undefined` both render the default commented
   * placeholder. */
  contentDir?: string;
}

export function buildConfigYmlContent(_version: string, options?: BuildConfigYmlOptions): string {
  const template = `# yaml-language-server: $schema=https://unpkg.com/@inkeep/open-knowledge@latest/dist/schemas/${CONFIG_SCHEMA_MAJOR_PATH}/config.project.schema.json
# OpenKnowledge — project configuration
#
# This file overrides built-in defaults for this project. Every key below
# is commented out and shows its current default value. Uncomment any key
# to override it.
#
# Precedence (lowest -> highest):
#   Built-in defaults
#     -> ~/${OK_DIR}/global.yml         (user defaults)
#     -> ./${OK_DIR}/config.yml         (this file)
#
# Schema reference: packages/core/src/config/schema.ts


# --- Content ---------------------------------------------------------------
# dir: where the CRDT editor reads/writes documents. Relative to the project
# root (the directory containing ${OK_DIR}/), NOT to this file.
#
# Path exclusions live in .okignore (gitignore syntax) at the project root,
# with nested .okignore files honored at any folder depth.
#
# content:
#   dir: .


# --- Suggested lifecycle (optional pattern) --------------------------------
# Projects that want an explicit knowledge-maturation flow can organize as
# three tiers *relative to the content directory* — create the subfolders
# only when you need them:
#
#   1. external-sources/  — raw content fetched from URLs, PDFs. No analysis,
#                           just preservation. Use the \`ingest\` MCP tool.
#   2. research/          — analysis and synthesis. Provisional findings,
#                           trade-offs, open questions. Use the \`research\`
#                           MCP tool.
#   3. articles/          — canonical knowledge. Use the \`consolidate\` MCP
#                           tool to promote research -> articles once
#                           decisions are made.
#
# This is a pattern, not a requirement. Projects with existing layouts
# (\`specs/\`, \`reports/\`, \`docs/\`, etc.) should use those; the lifecycle
# exists as mental scaffolding, not as enforced filesystem structure.


# --- Server ----------------------------------------------------------------
# Host: set via \`--host\` flag or \`HOST\` env var (default: localhost; use
# \`0.0.0.0\` to bind LAN-visible). Port: set via \`--port\` flag or \`PORT\`
# env var (auto-allocated if unset). Both are per-process runtime knobs —
# no \`server:\` schema field exists.


# --- Appearance ------------------------------------------------------------
# Theme for the chrome. Defaults UNSET so the existing localStorage cache
# (\`ok-theme-v1\`) keeps powering FOUC-free first paint until you
# explicitly write here.
#
# appearance:
#   theme: system            # 'light' | 'dark' | 'system'
`;
  const contentDir = options?.contentDir;
  if (contentDir === undefined || contentDir === '.') return template;
  return template.replace(
    '# content:\n#   dir: .',
    `content:\n  dir: ${quoteYamlScalar(contentDir)}`,
  );
}

function writeIfMissing(filePath: string, content: string, label: string): boolean {
  assertNotSymlink(filePath, label);
  if (existsSync(filePath)) return false;
  tracedWriteFileSync(filePath, content, 'utf-8');
  return true;
}

function ensureGitignoreEntries(
  filePath: string,
  scaffoldContent: string,
): 'created' | 'updated' | 'unchanged' {
  assertNotSymlink(filePath, '.ok/.gitignore');
  if (!existsSync(filePath)) {
    tracedWriteFileSync(filePath, scaffoldContent, 'utf-8');
    return 'created';
  }
  const required = scaffoldContent
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  const existing = readFileSync(filePath, 'utf-8');
  const present = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = required.filter((l) => !present.has(l));
  if (missing.length === 0) return 'unchanged';
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  tracedWriteFileSync(filePath, `${existing}${sep}${missing.join('\n')}\n`, 'utf-8');
  return 'updated';
}

const OK_GITIGNORE_CONTENT = `# .ok/local/ holds per-machine runtime state. Anything inside is
# machine-local and never committed. New runtime files (caches, locks,
# manifests, telemetry, error logs) are auto-ignored — no edit needed here.
${LOCAL_DIR}/

# Per-machine runtime state at the .ok/ root. Contains PII (principal email,
# UUID), hostnames, and absolute filesystem paths — never commit. The only
# file at .ok/ root that SHOULD be committed is \`config.yml\` (project
# configuration), which is explicitly NOT in this ignore list.
principal.json
state.json
server.lock
ui.lock
sync-state.json
last-spawn-error.log
`;

export const OK_OKIGNORE_TEMPLATE = `# .okignore — paths to exclude from the OpenKnowledge document index.
# Uses gitignore syntax (parsed by the \`ignore\` npm library), evaluated
# alongside .gitignore in a single ignore-lib instance.
#
# Patterns combine with .gitignore: an entry here adds to exclusions, and
# a leading \`!\` re-includes a file that .gitignore excluded.
# Nested .okignore files at any folder depth are honored (mirrors .gitignore).
#
# Examples:
#   drafts/        # exclude a directory
#   *.draft.md     # exclude files matching a pattern
#   !keep.md       # re-include a file .gitignore excluded
`;

export const ROOT_GITIGNORE_TEMPLATE = `# Seeded by OpenKnowledge when this project was created. Edit freely.
.DS_Store
`;

export interface InitContentOptions {
  /** When set and not `'.'`, scaffolded `.ok/config.yml` carries an
   * uncommented `content.dir: <value>` block. Used by the CLI's git-root
   * promotion path to scope the project to a sub-folder of the git
   * working tree without requiring the user to hand-edit the file. */
  contentDir?: string;
  /** Optional package version threaded through to `buildConfigYmlContent`.
   * The version is currently unused inside the rendered template (the
   * `$schema` URL pins to `CONFIG_SCHEMA_MAJOR_PATH` + `@latest`), but
   * callers continue to pass it so the upgrade path stays open. */
  packageVersion?: string;
}

export interface InitContentResult {
  created: string[];
  updated: string[];
  skipped: string[];
}

export function initContent(projectDir: string, options?: InitContentOptions): InitContentResult {
  const okDir = resolve(projectDir, OK_DIR);
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  assertNotSymlink(okDir, '.ok/');
  tracedMkdirSync(okDir, { recursive: true });

  const gitignoreAction = ensureGitignoreEntries(join(okDir, '.gitignore'), OK_GITIGNORE_CONTENT);
  if (gitignoreAction === 'created') {
    created.push('.gitignore');
  } else if (gitignoreAction === 'updated') {
    updated.push('.gitignore');
  } else {
    skipped.push('.gitignore');
  }

  if (
    writeIfMissing(
      join(okDir, CONFIG_FILENAME),
      buildConfigYmlContent(options?.packageVersion ?? '0.0.0', {
        contentDir: options?.contentDir,
      }),
      `.ok/${CONFIG_FILENAME}`,
    )
  ) {
    created.push(CONFIG_FILENAME);
  } else {
    skipped.push(CONFIG_FILENAME);
  }

  if (writeIfMissing(join(projectDir, '.okignore'), OK_OKIGNORE_TEMPLATE, '.okignore')) {
    created.push('.okignore');
  } else {
    skipped.push('.okignore');
  }

  return { created, updated, skipped };
}

export function writeRootGitignoreForNewRepo(projectDir: string): 'created' | 'skipped' {
  return writeIfMissing(join(projectDir, '.gitignore'), ROOT_GITIGNORE_TEMPLATE, '.gitignore')
    ? 'created'
    : 'skipped';
}
