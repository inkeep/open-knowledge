/** Root directory name for open-knowledge inside a project. */
export const OK_DIR = '.ok';

/**
 * Project-root marker — `<projectDir>/.ok/config.yml`. Distinguishes a real
 * OK project from a folder that merely carries `.ok/` sidecars (nested
 * folder-rule `frontmatter.yml`, `templates/`). Gates that walk up looking
 * for "the project" must check this file, not just the `.ok/` directory:
 * `write`/`edit` (folder/template) creates nested `<folder>/.ok/` dirs
 * with no `config.yml`, and a looser gate would mistake them for project
 * roots. Use `isProjectRoot(dir)` from `@inkeep/open-knowledge-server`'s
 * `find-project-root.ts` (Node-only) for the canonical "is this a project
 * root?" check that pairs with this marker.
 */
export const OK_PROJECT_MARKER = '.ok/config.yml';

/**
 * Subdirectory of `.ok/` that holds per-machine runtime state (locks, caches,
 * state manifests, telemetry, error logs). Anything inside is gitignored via
 * the single `local/` rule in `.ok/.gitignore`. Adding a new runtime file
 * never requires a `.gitignore` edit — write it under `<contentDir>/.ok/local/`
 * and it's covered.
 *
 * Exported as a bare string so frontend bundles can pretty-print paths in
 * error messages without importing `node:path`. Use `getLocalDir(contentDir)`
 * from `./ok-paths.ts` for the resolved absolute path on Node.
 */
export const LOCAL_DIR = 'local';
