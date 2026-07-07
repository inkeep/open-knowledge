/**
 * Build + validate the `openknowledge.skill` artifact.
 *
 * ZIPs a bundled SKILL.md source as `<skill-name>/SKILL.md` (wrapper-folder-
 * at-root — Claude Desktop's upload silently rejects flat ZIPs) and runs
 * structural smoke-tests: size ceiling, `name:` match, optional
 * `metadata.version:` match against caller-supplied `expectedSkillVersion`.
 *
 * Two skill bundles ship side by side:
 *   - `discovery` (`name: open-knowledge-discovery`) — slim, install/share
 *     guidance, no behavioral runtime rules. User-global install only.
 *   - `project`   (`name: open-knowledge`)           — the rich agent-runtime
 *     contract. Project-local install + the `.skill` ZIP (Cowork) only.
 *
 * This module is a pure ZIP-builder. Version provenance is the caller's
 * concern: install-flow callers ship whatever SKILL.md is currently bundled;
 * release-build callers compare against an externally-known CLI version
 * (e.g. via `resolvePackageVersion` in `./resolve-package-version.ts`).
 *
 * ZIP library: `yazl` (pure JS, ~20 KB, zero deps) — Windows has no `zip`
 * in PATH and `ok cowork` must work on every CLI user's machine.
 *
 * The output file uses `.skill` extension, not `.zip`. Claude.app registers
 * `.skill` as a `CFBundleDocumentType` on macOS, so double-clicking invokes
 * Claude's native install dialog.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripFrontmatter, unwrapFrontmatterFences } from '@inkeep/open-knowledge-core';
import yazl from 'yazl';
import { BUNDLE_SKILL_NAME, type BundleId } from './skill-bundles.ts';

// Re-export so existing consumers importing `BundleId` from this module keep
// working; the canonical declaration lives in `skill-bundles.ts`.
export type { BundleId };

/** Maximum uncompressed + compressed size. Catches accidental binary bloat.
 *  Current baseline is ~10 KB DEFLATE — 100 KB gives an order of magnitude
 *  of headroom without permitting a runaway regression. */
const MAX_ZIP_BYTES = 102_400;

// `BundleId` + `BUNDLE_SKILL_NAME` are the single source in `skill-bundles.ts`
// (imported above) so the bundle set is declared once across the copier and the
// release version-sync. `BUNDLE_SKILL_NAME` doubles as the ZIP wrapper-folder
// name so the archive root stays stable regardless of source-tree dir naming.

export interface BuildSkillZipOptions {
  /**
   * Which bundle to ZIP. Defaults to `'project'` — Track 2 (`.skill` for
   * Claude Chat / Cowork) ships the rich bundle only.
   */
  bundle?: BundleId;
  /** Override the source directory. Defaults to the resolved bundle dir. */
  sourceDir?: string;
  /** Output file path. Defaults to `./openknowledge.skill` in cwd. */
  outputPath?: string;
  /**
   * When set, validate that SKILL.md's `metadata.version` matches this value.
   * Used by release builds to assert SKILL ↔ CLI version alignment before
   * publish. Omit to skip the check — install-flow callers (desktop IPC,
   * `ok cowork`) don't need it because they ship whatever SKILL.md
   * version is currently bundled with their installed CLI.
   */
  expectedSkillVersion?: string;
  /**
   * Forwarded to `resolveBundledSkillDir`. Defaults to `false` — every
   * `buildSkillZip` caller feeds an install-state gate that compares the
   * built version against `readServerPackageVersion()` (this server's own
   * package), so the build must resolve this server's own bundle, never a
   * co-installed OK Desktop's. `validateSkillZip` hard-codes `false` for
   * the same source-consistency reason.
   *
   * The lone production site that legitimately wants Desktop-priority
   * resolution — `cli/src/integrations/write-project-skill.ts`, the
   * `ok init` path — calls `resolveBundledSkillDir` DIRECTLY (it doesn't
   * go through `buildSkillZip`), so it isn't covered by this default. The
   * `buildSkillZip` opt-in is preserved for symmetry, but no production
   * caller currently passes `true`.
   */
  checkDesktop?: boolean;
}

export interface BuildSkillZipResult {
  outputPath: string;
  /** Compressed size in bytes. */
  size: number;
  /** Hex-encoded SHA256. */
  sha256: string;
  /** SKILL.md `metadata.version:`, or `undefined` if absent. */
  skillVersion?: string;
}

export interface ResolveBundledSkillDirOptions {
  /** Override `$HOME` — probes `~/Applications/OpenKnowledge.app`. Tests pin. */
  home?: string;
  /** Override the platform tag. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /**
   * When false, skip the co-installed OK Desktop probe (candidates 1+2).
   * Defaults to false — every direct caller in this repo passes an explicit
   * value (Desktop reclaim paths pass `false`; `cli/src/integrations/write-
   * project-skill.ts`'s `ok init` path passes `true` to consume a
   * (possibly newer) co-installed Desktop bundle). The safe default
   * matches `buildSkillZip`'s default, so a new direct caller without
   * options gets in-process resolution rather than the unsafe Desktop
   * probe — same source-consistency invariant.
   */
  checkDesktop?: boolean;
}

/** macOS OK Desktop bundles its CLI assets under this path inside the `.app`. */
const DESKTOP_SKILLS_REL = 'OpenKnowledge.app/Contents/Resources/cli/dist/assets/skills';

/**
 * Resolve the source directory for one skill bundle. Probe order:
 *   1. `/Applications/OpenKnowledge.app/.../assets/skills/<which>` (macOS)
 *   2. `~/Applications/OpenKnowledge.app/.../assets/skills/<which>` (macOS)
 *   3. `<server-src>/../dist/assets/skills/<which>` — composed dev output
 *      (`buildSkillBundles()` writes here; preferred so `{{> _shared/… }}`
 *      placeholders are resolved).
 *   4. `<server-src>/../assets/skills/<which>` — source workspace assets
 *      (valid as-is when no placeholders are used — the v1 case).
 *   5. `<published-cli-dist>/assets/skills/<which>` — the CLI build copies the
 *      composed bundles here.
 *
 * Candidates 1+2 give a co-installed OK Desktop priority — its bundle may be
 * newer than an npm-installed CLI. Translocation paths are intentionally
 * skipped (see `cli-install.ts`). On Linux/Windows candidates
 * 1+2 are skipped and resolution falls through to 3-5.
 *
 * First-existing wins. Throws if no candidate resolves — caller surfaces it
 * as a user-facing error.
 */
export function resolveBundledSkillDir(
  // Accepts the known bundle ids and also a nested pack-skill segment like
  // `packs/<id>` (project-level pack skills resolve through the same probe
  // order). `string & {}` keeps the literal hints for the known ids.
  which: BundleId | (string & {}),
  opts: ResolveBundledSkillDirOptions = {},
): string {
  const platform = opts.platform ?? process.platform;
  const checkDesktop = opts.checkDesktop ?? false;
  const home = opts.home ?? homedir();

  const candidates: string[] = [];
  if (checkDesktop && platform === 'darwin') {
    candidates.push(join('/Applications', DESKTOP_SKILLS_REL, which));
    candidates.push(join(home, 'Applications', DESKTOP_SKILLS_REL, which));
  }
  candidates.push(fileURLToPath(new URL(`../dist/assets/skills/${which}`, import.meta.url)));
  candidates.push(fileURLToPath(new URL(`../assets/skills/${which}`, import.meta.url)));
  candidates.push(fileURLToPath(new URL(`./assets/skills/${which}`, import.meta.url)));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Bundled skill asset directory not found for bundle '${which}'. ` +
      `Tried: ${candidates.join(', ')}. ` +
      'This usually means the CLI build did not copy packages/server/assets into dist/assets. ' +
      'Run `cd packages/cli && bun run build` before publishing.',
  );
}

async function* walkFiles(dir: string, base: string = dir): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full, base);
    } else if (entry.isFile()) {
      yield relative(base, full);
    }
  }
}

/**
 * Compute the wrapper folder name for the ZIP root from a source directory.
 * Pure / cross-platform: uses `basename` (handles `\` and `/` correctly via
 * the runtime's path module — on Windows that's `path.win32`). The previous
 * `split('/').pop()` form treated `C:\foo\open-knowledge` as a single segment
 * and leaked the entire absolute path into the ZIP root.
 */
function computeWrapperFolderName(
  sourceDir: string,
  pathBasename: (p: string) => string = basename,
): string {
  return pathBasename(sourceDir) || 'open-knowledge';
}

/**
 * Convert a platform-relative path to a forward-slash-separated ZIP entry
 * name. ZIP entry names are forward-slash-only per APPNOTE.TXT 4.4.17.1;
 * `node:path.relative` returns `\`-separated paths on Windows.
 */
function toPosixZipPath(rel: string, pathSep: string = sep): string {
  return pathSep === '/' ? rel : rel.split(pathSep).join('/');
}

async function zipDirectory(
  sourceDir: string,
  outputPath: string,
  wrapperFolderName: string = computeWrapperFolderName(sourceDir),
): Promise<void> {
  const zipfile = new yazl.ZipFile();

  // Explicit wrapper-folder entry for parity with `system zip -r` output. Most
  // ZIP consumers accept implicit folders, but emitting the entry matches what
  // Claude Desktop's upload UI has been verified against (bash-built skills
  // include the empty entry).
  zipfile.addEmptyDirectory(`${wrapperFolderName}/`);

  // Collect files first so we can close stdin deterministically. Streaming
  // directly from the generator would race `zipfile.end()` against writes.
  const files: string[] = [];
  for await (const rel of walkFiles(sourceDir)) files.push(rel);
  files.sort(); // stable ordering — reproducible ZIPs.

  for (const rel of files) {
    const absolute = join(sourceDir, rel);
    const entryName = `${wrapperFolderName}/${toPosixZipPath(rel)}`;
    zipfile.addFile(absolute, entryName);
  }
  zipfile.end();

  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(outputPath);
    zipfile.outputStream.pipe(out);
    out.on('close', () => resolve());
    out.on('error', reject);
    zipfile.outputStream.on('error', reject);
  });
}

async function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Parse SKILL.md frontmatter `metadata.version:` without pulling in a YAML
 * library. Handles `metadata: { version: "x" }` flow and block forms. Returns
 * `undefined` if the field is absent. Fence recognition is core's contract
 * (`stripFrontmatter`/`unwrapFrontmatterFences`), so fence lines with
 * trailing spaces/tabs are tolerated like every other recognizer.
 */
function extractMetadataVersion(markdown: string): string | undefined {
  const { frontmatter: fenced } = stripFrontmatter(markdown);
  if (fenced === '') return undefined;
  const frontmatter = unwrapFrontmatterFences(fenced);

  // Match `metadata:` block then a subsequent `  version: "..."` line.
  const metaStart = frontmatter.search(/^metadata:/m);
  if (metaStart < 0) return undefined;
  // Scan lines after `metadata:` until an un-indented line breaks the block.
  const rest = frontmatter.slice(metaStart);
  const lines = rest.split('\n').slice(1);
  for (const line of lines) {
    if (/^[^\s]/.test(line)) break; // left-flush line ends the block
    const m = line.match(/^\s+version:\s*["']?([^"'\s]+)["']?$/);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Run the structural smoke-tests on a built `.skill`. Throws on any failure
 * with a user-facing message. Size check is on the input file path, not an
 * in-memory blob, so callers need not load the ZIP twice.
 *
 * `opts.bundle` selects which `name:` value the frontmatter must carry
 * (`open-knowledge-discovery` vs `open-knowledge`); defaults to `'project'`.
 * `opts.sourceDir` short-circuits re-resolution when the caller already has
 * the source dir in hand.
 */
export async function validateSkillZip(
  outputPath: string,
  expectedSkillVersion: string | undefined,
  opts: { bundle?: BundleId; sourceDir?: string } = {},
): Promise<{ size: number; sha256: string; skillVersion?: string }> {
  const bundle: BundleId = opts.bundle ?? 'project';
  const size = statSync(outputPath).size;
  if (size > MAX_ZIP_BYTES) {
    throw new Error(`Built ${outputPath} is ${size} bytes, exceeds ${MAX_ZIP_BYTES}-byte ceiling`);
  }

  const sha256 = await sha256OfFile(outputPath);

  // For the version + name checks, parse the SKILL.md we zipped from — the
  // caller already had it on disk. yazl does not mutate content, and the
  // size + SHA256 checks above would already catch any fs/yazl byte-mangling.
  //
  // `buildSkillZip` always passes `sourceDir`, so the fallback only fires on a
  // direct `validateSkillZip` call. checkDesktop:false there — validation must
  // check the in-tree/build source, never a co-installed OK Desktop's copy.
  const sourceDir = opts.sourceDir ?? resolveBundledSkillDir(bundle, { checkDesktop: false });
  const skillMd = await readFile(join(sourceDir, 'SKILL.md'), 'utf-8');

  // Smoke-test: frontmatter name matches the bundle's required `name:`.
  const expectedName = BUNDLE_SKILL_NAME[bundle];
  if (!new RegExp(`^name:\\s+${expectedName}$`, 'm').test(skillMd.slice(0, 1500))) {
    throw new Error(
      `SKILL.md frontmatter \`name:\` does not match '${expectedName}'. ` +
        `Check packages/server/assets/skills/${bundle}/SKILL.md frontmatter.`,
    );
  }

  // Smoke-test: metadata.version matches the caller-asserted version.
  const skillVersion = extractMetadataVersion(skillMd);
  if (expectedSkillVersion !== undefined) {
    if (!skillVersion) {
      throw new Error(
        `SKILL.md metadata.version missing. Add it to packages/server/assets/skills/${bundle}/SKILL.md.`,
      );
    }
    if (skillVersion !== expectedSkillVersion) {
      throw new Error(
        `SKILL.md metadata.version (${skillVersion}) does not match expected version (${expectedSkillVersion}).`,
      );
    }
  }

  return { size, sha256, skillVersion };
}

/**
 * Build the `.skill` artifact + run validation. Default output is
 * `./openknowledge.skill` in cwd; default bundle is `'project'` (the rich
 * bundle — Track 2 ships rich-only).
 *
 * Pass `expectedSkillVersion` only from release-build paths that need to
 * assert SKILL ↔ CLI version alignment. Install-flow callers (desktop IPC,
 * `ok cowork`) omit it and ship whatever SKILL.md is bundled.
 */
export async function buildSkillZip(opts: BuildSkillZipOptions = {}): Promise<BuildSkillZipResult> {
  const bundle: BundleId = opts.bundle ?? 'project';
  const sourceDir =
    opts.sourceDir ?? resolveBundledSkillDir(bundle, { checkDesktop: opts.checkDesktop ?? false });
  const outputPath = opts.outputPath ?? join(process.cwd(), 'openknowledge.skill');

  // Wrapper folder = the bundle's canonical skill name, NOT the source dir's
  // basename — keeps the archive root stable (`open-knowledge/`) regardless of
  // the `discovery/` | `project/` source-tree directory name.
  await zipDirectory(sourceDir, outputPath, BUNDLE_SKILL_NAME[bundle]);
  const { size, sha256, skillVersion } = await validateSkillZip(
    outputPath,
    opts.expectedSkillVersion,
    { bundle, sourceDir },
  );

  return { outputPath, size, sha256, skillVersion };
}

// Test-only helpers. Not part of the public surface.
/** @internal */
export const __testing = { extractMetadataVersion, computeWrapperFolderName, toPosixZipPath };
