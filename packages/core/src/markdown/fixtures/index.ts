import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

function fixturePath(...segments: string[]): string {
  return resolve(FIXTURES_DIR, ...segments);
}

interface GfmExample {
  section: string;
  markdown: string;
}

export function loadGfmExamples(): GfmExample[] {
  return JSON.parse(readFileSync(fixturePath('gfm', 'examples.json'), 'utf8')) as GfmExample[];
}

interface MdxCrashEntry {
  id: string;
  input: string;
  class: string;
  r23Covers: boolean;
  expectedOutcome: string;
  note: string;
}

export function loadMdxCrashTaxonomy(): MdxCrashEntry[] {
  return JSON.parse(
    readFileSync(fixturePath('mdx', 'crash-taxonomy.json'), 'utf8'),
  ) as MdxCrashEntry[];
}

export interface BuiltInFixture {
  componentName: string;
  blockForm: string;
  inlineForm?: string;
  notes?: string;
}

export function loadBuiltInFixtures(): BuiltInFixture[] {
  return JSON.parse(readFileSync(fixturePath('mdx', 'built-ins.json'), 'utf8')) as BuiltInFixture[];
}

export interface IndentedJsxFixture {
  name: string;
  source: string;
  notes?: string;
}

export function loadIndentedJsxFixtures(): IndentedJsxFixture[] {
  return JSON.parse(
    readFileSync(fixturePath('mdx', 'indented-jsx.json'), 'utf8'),
  ) as IndentedJsxFixture[];
}

export interface LargeEmbedFixture {
  name: string;
  source: string;
  scriptsMustParse?: boolean;
  notes?: string;
}

export function loadLargeEmbedFixtures(): LargeEmbedFixture[] {
  return JSON.parse(
    readFileSync(fixturePath('mdx', 'large-embed.json'), 'utf8'),
  ) as LargeEmbedFixture[];
}

export function loadPrd6955Before(): string {
  return readFileSync(fixturePath('regression', 'prd-6955-before.md'), 'utf8');
}

export function loadPrd6955CorruptedTriplicated(): string {
  return readFileSync(fixturePath('regression', 'prd-6955-corrupted-triplicated.md'), 'utf8');
}

export interface NgPinnedCase {
  id: string;
  name: string;
  input: string;
  expectedOutput: string | null;
  idempotent: boolean;
  highlighted: boolean;
  note: string;
}

export function loadNgPinnedCases(): NgPinnedCase[] {
  return JSON.parse(
    readFileSync(fixturePath('ng-pinned', 'component-blocks-v2.json'), 'utf8'),
  ) as NgPinnedCase[];
}

export function loadLargeRealistic(): string {
  return readFileSync(fixturePath('perf', 'large-realistic.md'), 'utf8');
}

export const PERF_BLOCK_COUNTS = [100, 1000, 5000, 10000, 20000] as const;
export type PerfBlockCount = (typeof PERF_BLOCK_COUNTS)[number];

export function loadPerfFixture(blockCount: PerfBlockCount): string {
  return readFileSync(fixturePath('perf', `${blockCount}.md`), 'utf8');
}
