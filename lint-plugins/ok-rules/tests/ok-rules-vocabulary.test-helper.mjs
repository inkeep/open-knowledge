import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const VOCABULARY_SOURCES = 'lint-plugins/ok-rules/tests/ok-rules-vocabulary.';

const RETIRED = /gritql|\.grit\b|biome-plugins|bun run/i;

const HISTORICAL = /\b(?:retired|replaced|superseded|no longer|used to|formerly|migrat)/i;

const ENGINE_NAMES = ['GritQL', 'biome', 'eslint', 'remark', 'rehype', 'vite', 'babel', 'oxlint'];

const DEMOTED_UNAMBIGUOUS = new RegExp(
  [
    String.raw`\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+ (?:(?:${ENGINE_NAMES.join('|')}) )?plugins?\b`,
    String.raw`\bok/[a-z0-9-]+\b.{0,60}\bplugins?\b`,
    String.raw`\bplugins?\b\s*(?:test|fixture)\b`,
  ].join('|'),
  'i',
);

const ENGINE_PLUGINS = new RegExp(`\\b(?:${ENGINE_NAMES.join('|')})[- ]plugins?\\b`, 'gi');

export function pluginDirNames() {
  const dir = join(REPO_ROOT, 'lint-plugins');
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  if (names.length === 0) {
    throw new Error(
      `ok-rules-vocabulary: ${relative(REPO_ROOT, dir)} lists no plugin directories. An empty ` +
        'alternation would strip every `plugin` token and green the gate.',
    );
  }
  return names;
}

const REAL_PLUGIN_NAMES = new RegExp(
  `\\b(?:${pluginDirNames()
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\b[^.]{0,3}(?:(?:${ENGINE_NAMES.join('|')}) )?plugins?\\b`,
  'gi',
);

const PLUGIN_AS_MODULE = new RegExp(
  [
    'lint-plugins',
    'jsPlugins',
    'plugin\\.mjs',
    'plugins\\.html',
    'JS[- ]plugins?',
    'packages/\\{[^}]*plugin[^}]*\\}',
    'packages/plugin',
    'index\\.(?:private\\.)?mjs',
    'lint/plugin/',
    'import plugin',
    'plugin\\.rules',
    '(?:`ok`|`\\.private\\.`) plugins?',
    'PLUGIN_NAME',
  ].join('|'),
  'gi',
);

const NEAR_RULE_VOCABULARY = new RegExp(
  [
    String.raw`\bplugins?\b\s*(?:test|fixture)`,
    String.raw`\b(?:rule|test|fixture)\b.{0,60}\bplugins?\b`,
    String.raw`\bplugins?\b.{0,60}\b(?:fires|must fire|fixture|test)\b`,
  ].join('|'),
  'i',
);

function blank(line, pattern) {
  return line.replace(pattern, (m) => ' '.repeat(m.length));
}

export function judgeDemotion(line, { demotedFirst = true } = {}) {
  const named = blank(line, REAL_PLUGIN_NAMES);
  if (demotedFirst && DEMOTED_UNAMBIGUOUS.test(named)) return true;
  const residue = blank(blank(named, ENGINE_PLUGINS), PLUGIN_AS_MODULE);
  if (!demotedFirst && DEMOTED_UNAMBIGUOUS.test(residue)) return true;
  return /\bplugins?\b/i.test(residue) && NEAR_RULE_VOCABULARY.test(residue);
}

export function namesRetiredMechanism(line) {
  return RETIRED.test(line) && !HISTORICAL.test(line);
}

export function readmeLine(startsWith) {
  const lines = readFileSync(join(REPO_ROOT, 'lint-plugins/ok-rules/README.md'), 'utf-8').split(
    '\n',
  );
  const found = lines.filter((l) => l.startsWith(startsWith));
  if (found.length !== 1) {
    throw new Error(
      `ok-rules-vocabulary: expected exactly one README line starting "${startsWith}", found ` +
        `${found.length}. The pinned legitimate case must track a real line, not an index.`,
    );
  }
  return found[0];
}

function posixRel(file) {
  return relative(REPO_ROOT, file).split(sep).join('/');
}

function corpusFiles(dirs) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(mjs|ts|tsx|json|md)$/.test(entry)) found.push(full);
    }
  };
  for (const dir of dirs) {
    const abs = join(REPO_ROOT, dir);
    if (existsSync(abs)) walk(abs);
  }
  return found.filter((file) => !posixRel(file).startsWith(VOCABULARY_SOURCES));
}

export function filesPerDir(dirs) {
  const counts = new Map(dirs.map((dir) => [dir, 0]));
  for (const file of corpusFiles(dirs)) {
    const rel = posixRel(file);
    for (const dir of dirs) {
      if (rel.startsWith(`${dir}/`)) counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
  }
  return counts;
}

export function scan(dirs, judge) {
  const out = [];
  for (const file of corpusFiles(dirs)) {
    const rel = posixRel(file);
    readFileSync(file, 'utf-8')
      .split('\n')
      .forEach((line, i) => {
        if (judge(line)) out.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
  }
  return out;
}
