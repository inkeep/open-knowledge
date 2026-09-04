import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';
import { BUNDLE_SKILL_NAME, type BundleId } from './skill-bundles.ts';

export type { BundleId };

const MAX_ZIP_BYTES = 102_400;

export interface BuildSkillZipOptions {
  bundle?: BundleId;
  sourceDir?: string;
  outputPath?: string;
  checkDesktop?: boolean;
}

export interface BuildSkillZipResult {
  outputPath: string;
  size: number;
  sha256: string;
}

export interface ResolveBundledSkillDirOptions {
  home?: string;
  platform?: NodeJS.Platform;
  checkDesktop?: boolean;
}

const DESKTOP_SKILLS_REL = 'OpenKnowledge.app/Contents/Resources/cli/dist/assets/skills';

export function resolveBundledSkillDir(
  which: BundleId | (string & {}),
  opts: ResolveBundledSkillDirOptions = {},
): string {
  const platform = opts.platform ?? process.platform;
  const checkDesktop = opts.checkDesktop ?? false;
  const home = opts.home ?? homedir();

  const candidates: string[] = [];
  const underTest = process.env.NODE_ENV === 'test';
  if (checkDesktop && platform === 'darwin') {
    if (!underTest) candidates.push(join('/Applications', DESKTOP_SKILLS_REL, which));
    if (!underTest || opts.home !== undefined) {
      candidates.push(join(home, 'Applications', DESKTOP_SKILLS_REL, which));
    }
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

function computeWrapperFolderName(
  sourceDir: string,
  pathBasename: (p: string) => string = basename,
): string {
  return pathBasename(sourceDir) || 'open-knowledge';
}

function toPosixZipPath(rel: string, pathSep: string = sep): string {
  return pathSep === '/' ? rel : rel.split(pathSep).join('/');
}

async function zipDirectory(
  sourceDir: string,
  outputPath: string,
  wrapperFolderName: string = computeWrapperFolderName(sourceDir),
): Promise<void> {
  const zipfile = new yazl.ZipFile();

  zipfile.addEmptyDirectory(`${wrapperFolderName}/`);

  const files: string[] = [];
  for await (const rel of walkFiles(sourceDir)) files.push(rel);
  files.sort();

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

export async function validateSkillZip(
  outputPath: string,
  opts: { bundle?: BundleId; sourceDir?: string } = {},
): Promise<{ size: number; sha256: string }> {
  const bundle: BundleId = opts.bundle ?? 'project';
  const size = statSync(outputPath).size;
  if (size > MAX_ZIP_BYTES) {
    throw new Error(`Built ${outputPath} is ${size} bytes, exceeds ${MAX_ZIP_BYTES}-byte ceiling`);
  }

  const sha256 = await sha256OfFile(outputPath);

  const sourceDir = opts.sourceDir ?? resolveBundledSkillDir(bundle, { checkDesktop: false });
  const skillMd = await readFile(join(sourceDir, 'SKILL.md'), 'utf-8');

  const expectedName = BUNDLE_SKILL_NAME[bundle];
  if (!new RegExp(`^name:\\s+${expectedName}$`, 'm').test(skillMd.slice(0, 1500))) {
    throw new Error(
      `SKILL.md frontmatter \`name:\` does not match '${expectedName}'. ` +
        `Check packages/server/assets/skills/${bundle}/SKILL.md frontmatter.`,
    );
  }

  return { size, sha256 };
}

export async function buildSkillZip(opts: BuildSkillZipOptions = {}): Promise<BuildSkillZipResult> {
  const bundle: BundleId = opts.bundle ?? 'project';
  const sourceDir =
    opts.sourceDir ?? resolveBundledSkillDir(bundle, { checkDesktop: opts.checkDesktop ?? false });
  const outputPath = opts.outputPath ?? join(process.cwd(), 'openknowledge.skill');

  await zipDirectory(sourceDir, outputPath, BUNDLE_SKILL_NAME[bundle]);
  const { size, sha256 } = await validateSkillZip(outputPath, { bundle, sourceDir });

  return { outputPath, size, sha256 };
}

export const __testing = { computeWrapperFolderName, toPosixZipPath };
