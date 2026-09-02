import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { stripFrontmatter, unwrapFrontmatterFences } from '../extensions/frontmatter.ts';

export const TEMPLATE_IDENTITY_KEY = 'template';

export interface TemplateIdentity {
  title?: string;
  description?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface TemplateModel {
  identity: TemplateIdentity;
  starterContent: string;
}

function parseYamlObject(yaml: string): Record<string, unknown> {
  if (yaml.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch {
    return {};
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function composeStarterContent(docFrontmatterText: string, markdown: string): string {
  if (docFrontmatterText.trim() === '') return markdown;
  return `---\n${docFrontmatterText}\n---\n${markdown}`;
}

function splitStarterContent(starterContent: string): {
  docFrontmatterText: string;
  markdown: string;
} {
  const { frontmatter, body } = stripFrontmatter(starterContent);
  if (frontmatter === '') return { docFrontmatterText: '', markdown: starterContent };
  return { docFrontmatterText: unwrapFrontmatterFences(frontmatter), markdown: body };
}

function peelTemplateIdentity(
  blockText: string,
): { identity: TemplateIdentity; docFrontmatterText: string } | null {
  const lines = blockText.split('\n');
  if (!(lines[0] ?? '').startsWith(`${TEMPLATE_IDENTITY_KEY}:`)) return null;
  const identityLines = [lines[0] ?? ''];
  let i = 1;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (/^[ \t]/.test(line)) {
      identityLines.push(line);
      i++;
      continue;
    }
    if (line.trim() === '') {
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? '').trim() === '') j++;
      if (j < lines.length && /^[ \t]/.test(lines[j] ?? '')) {
        identityLines.push(line);
        i++;
        continue;
      }
    }
    break;
  }
  const rawIdentity = parseYamlObject(identityLines.join('\n'))[TEMPLATE_IDENTITY_KEY];
  const identity: TemplateIdentity =
    rawIdentity != null && typeof rawIdentity === 'object' && !Array.isArray(rawIdentity)
      ? (rawIdentity as TemplateIdentity)
      : {};
  const docFrontmatterText = lines.slice(i).join('\n').replace(/\n+$/, '');
  return { identity, docFrontmatterText };
}

export function parseTemplateFile(raw: string): TemplateModel {
  const cleaned = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const { frontmatter, body } = stripFrontmatter(cleaned);
  if (frontmatter === '') {
    return { identity: {}, starterContent: cleaned };
  }
  const block1Text = unwrapFrontmatterFences(frontmatter);

  const peeled = peelTemplateIdentity(block1Text);
  if (peeled) {
    return {
      identity: peeled.identity,
      starterContent: composeStarterContent(peeled.docFrontmatterText, body),
    };
  }

  const { frontmatter: block2Fenced } = stripFrontmatter(body);
  if (block2Fenced !== '') {
    return { identity: parseYamlObject(block1Text) as TemplateIdentity, starterContent: body };
  }

  const block1 = parseYamlObject(block1Text);
  if (typeof block1.title === 'string') {
    return { identity: block1 as TemplateIdentity, starterContent: body };
  }
  return { identity: {}, starterContent: composeStarterContent(block1Text, body) };
}

export function composeTemplateFile(identity: TemplateIdentity, starterContent: string): string {
  const { docFrontmatterText, markdown } = splitStarterContent(starterContent);
  const cleanIdentity: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(identity)) {
    if (v !== undefined) cleanIdentity[k] = v;
  }
  const identityYaml = stringifyYaml({ [TEMPLATE_IDENTITY_KEY]: cleanIdentity });
  const inner =
    docFrontmatterText.trim() === '' ? identityYaml : `${identityYaml}${docFrontmatterText}\n`;
  return `---\n${inner}---\n${markdown}`;
}

export function instantiateDoc(raw: string): string {
  return parseTemplateFile(raw).starterContent;
}
