import { join } from 'node:path';
import {
  canonicalRuleId,
  DEFAULT_MARKDOWNLINT_CONFIG,
  findRuleConfigEntry,
  type MarkdownlintRuleSetting,
} from '@inkeep/open-knowledge-core';
import { applyEdits, modify, parse as parseJsonc, stripComments } from 'jsonc-parser';
import { stringify as stringifyYaml } from 'yaml';
import { tracedUnlinkSync } from '../fs-traced.ts';
import { writeFileAtomic } from './fs-safety.ts';
import {
  DEFAULT_MARKDOWNLINT_FILENAME,
  findNativeMarkdownlintFile,
  readOwnNativeRules,
} from './markdownlint-discovery.ts';

export interface WriteMarkdownlintResult {
  action: 'written' | 'deleted' | 'noop' | 'declined-executable';
  file: string;
}

function serialize(name: string, rules: Record<string, unknown>): string {
  if (name.endsWith('.yaml') || name.endsWith('.yml')) return stringifyYaml(rules);
  return `${JSON.stringify(rules, null, 2)}\n`;
}

function governingKey(rules: Readonly<Record<string, unknown>>, ruleId: string): string {
  return findRuleConfigEntry(rules, ruleId)?.key ?? canonicalRuleId(ruleId) ?? ruleId;
}

function keysAddressing(rules: Readonly<Record<string, unknown>>, ruleId: string): string[] {
  const canonical = canonicalRuleId(ruleId);
  if (canonical === null) return ruleId in rules ? [ruleId] : [];
  return Object.keys(rules).filter((key) => canonicalRuleId(key) === canonical);
}

const JSONC_FORMATTING = { insertSpaces: true, tabSize: 2, eol: '\n' } as const;

function applyJsoncRuleChange(
  raw: string,
  rules: Readonly<Record<string, unknown>>,
  ruleId: string,
  value: MarkdownlintRuleSetting | null,
): string {
  let text = raw;
  if (value === null) {
    for (const key of keysAddressing(rules, ruleId)) {
      text = applyEdits(
        text,
        modify(text, [key], undefined, { formattingOptions: JSONC_FORMATTING }),
      );
    }
    return text;
  }
  const key = governingKey(rules, ruleId);
  return applyEdits(text, modify(text, [key], value, { formattingOptions: JSONC_FORMATTING }));
}

export function writeMarkdownlintRule(
  contentDir: string,
  ruleId: string,
  value: MarkdownlintRuleSetting | null,
): WriteMarkdownlintResult {
  const existing = findNativeMarkdownlintFile(contentDir);
  const name = existing?.name ?? DEFAULT_MARKDOWNLINT_FILENAME;
  const file = existing?.path ?? join(contentDir, name);

  if (existing && /\.(cjs|mjs|js)$/.test(existing.path)) {
    return { action: 'declined-executable', file: existing.name };
  }

  if (!existing && value === null) return { action: 'noop', file: name };

  const own = existing ? readOwnNativeRules(contentDir) : null;
  const isYaml = name.endsWith('.yaml') || name.endsWith('.yml');

  if (existing && own && !isYaml) {
    const text = applyJsoncRuleChange(own.raw, own.rules, ruleId, value);
    const remaining = parseJsonc(text.replace(/^\uFEFF/, ''), [], { allowTrailingComma: true });
    const isEmpty =
      !remaining ||
      typeof remaining !== 'object' ||
      Object.keys(remaining as Record<string, unknown>).length === 0;
    if (isEmpty) {
      const hasComments = stripComments(text) !== text;
      if (!hasComments) {
        tracedUnlinkSync(file);
        return { action: 'deleted', file: name };
      }
    }
    writeFileAtomic(file, text);
    return { action: 'written', file: name };
  }

  const rules: Record<string, unknown> = own
    ? { ...own.rules }
    : existing
      ? {}
      : { ...DEFAULT_MARKDOWNLINT_CONFIG };

  if (value === null) {
    for (const key of keysAddressing(rules, ruleId)) delete rules[key];
  } else {
    rules[governingKey(rules, ruleId)] = value;
  }

  if (Object.keys(rules).length === 0) {
    if (existing) {
      tracedUnlinkSync(file);
      return { action: 'deleted', file: name };
    }
    return { action: 'noop', file: name };
  }

  writeFileAtomic(file, serialize(name, rules));
  return { action: 'written', file: name };
}
