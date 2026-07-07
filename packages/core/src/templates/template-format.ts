/**
 * Template file format: parse / compose / instantiate.
 *
 * A template file carries two things: the template's own picker identity
 * (`title`, `description`, optional `tags`) and the "starter content" a new
 * document receives (its frontmatter + markdown body).
 *
 * **Canonical on-disk format — a SINGLE frontmatter block.** The identity
 * lives under a reserved `template:` key; the new-doc default frontmatter are
 * the remaining top-level keys; the markdown follows:
 *
 * ```
 * ---
 * template:
 *   title: Research Log
 *   description: Provisional analysis...
 * status: provisional
 * created: {{date}}
 * ---
 *
 * ## Question
 * ```
 *
 * One block is load-bearing for rendering: any frontmatter-aware editor
 * surface recognizes only the first `---…---` block (`FRONTMATTER_RE`), so a
 * second stacked block would leak into the rendered body as raw text. With a
 * single block the whole thing lands in the property panel and the body
 * renders clean.
 *
 * **Legacy two-block format** (`---title/description---` then `---docFm---`
 * then body) is still accepted on read and normalized to the same model, so
 * templates already on disk keep working without a destructive migration;
 * they re-serialize single-block on the next save.
 *
 * **Token fidelity.** The doc-frontmatter often carries `{{date}}` / `{{user}}`
 * substitution tokens (`created: {{date}}`). `{{date}}` is a YAML flow-map, so
 * round-tripping doc-frontmatter through a YAML parse+stringify corrupts it
 * (`created: { '{ date }': null }`). Therefore the doc-frontmatter is handled
 * as **raw text** and never re-serialized through YAML — only the token-free
 * `template:` identity is parsed. The "starter content" (doc-frontmatter block
 * + markdown) is exactly what a new doc becomes — so {@link instantiateDoc}
 * and the read-path reconstruction are the same string.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { stripFrontmatter, unwrapFrontmatterFences } from '../extensions/frontmatter.ts';

/**
 * Reserved single-frontmatter-block key holding the template's own identity.
 * Distinct from `RESERVED_FRONTMATTER_KEY` ('frontmatter', the legacy doc
 * slot). A new-doc's frontmatter must never contain `template:` — it is
 * stripped at instantiation — so the write path rejects it in doc-frontmatter.
 */
export const TEMPLATE_IDENTITY_KEY = 'template';

/**
 * The template's own picker identity. `title` is required at write time.
 *
 * The open index signature is intentional and distinguishes this PARSE model
 * from the closed write contract (`TemplateFrontmatter` in templates-write.ts):
 * a `template:` block read off disk may carry extra author-supplied keys, and
 * they must round-trip through parse -> compose unchanged. Do not remove it
 * (drops forward-compat), and do not mirror it onto the closed write types
 * (weakens the write boundary).
 */
export interface TemplateIdentity {
  title?: string;
  description?: string;
  tags?: string[];
  [key: string]: unknown;
}

/**
 * Normalized template model. `starterContent` is the doc-frontmatter block +
 * markdown body — i.e. the literal content a new doc receives (pre-substitution).
 */
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

/**
 * Compose "starter content" from doc-frontmatter TEXT (verbatim, tokens
 * preserved) + markdown. Empty doc-frontmatter → just the markdown.
 */
function composeStarterContent(docFrontmatterText: string, markdown: string): string {
  if (docFrontmatterText.trim() === '') return markdown;
  return `---\n${docFrontmatterText}\n---\n${markdown}`;
}

/**
 * Split starter content into its leading doc-frontmatter TEXT + markdown body.
 * Text-level (no YAML parse) so substitution tokens survive verbatim.
 */
function splitStarterContent(starterContent: string): {
  docFrontmatterText: string;
  markdown: string;
} {
  const { frontmatter, body } = stripFrontmatter(starterContent);
  if (frontmatter === '') return { docFrontmatterText: '', markdown: starterContent };
  return { docFrontmatterText: unwrapFrontmatterFences(frontmatter), markdown: body };
}

/**
 * From a single-block frontmatter's TEXT, peel the leading `template:` key
 * (its line + indented children) as identity, returning the remaining
 * top-level lines as doc-frontmatter TEXT (tokens preserved). Returns `null`
 * when the block does not open with a top-level `template:` key.
 */
function peelTemplateIdentity(
  blockText: string,
): { identity: TemplateIdentity; docFrontmatterText: string } | null {
  const lines = blockText.split('\n');
  if (!(lines[0] ?? '').startsWith(`${TEMPLATE_IDENTITY_KEY}:`)) return null;
  const identityLines = [lines[0] ?? ''];
  let i = 1;
  // The `template:` line owns every following indented child line. A blank line
  // counts as interior to the block only when a later line is still indented; a
  // blank (or non-indented) line before the top-level doc-frontmatter ends it.
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

/**
 * Parse a template file (single-block NEW or legacy two-block) into the
 * normalized model. Never throws — malformed YAML degrades to empty maps so
 * callers (picker, editor, apply) stay total.
 */
export function parseTemplateFile(raw: string): TemplateModel {
  // Strip a leading UTF-8 BOM (added by some Windows editors on re-save) so the
  // frontmatter fence is recognized — `FRONTMATTER_RE` anchors at `^---`, and a
  // BOM-prefixed file would otherwise lose its entire identity silently.
  const cleaned = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const { frontmatter, body } = stripFrontmatter(cleaned);
  if (frontmatter === '') {
    // No frontmatter at all — the whole file is starter markdown.
    return { identity: {}, starterContent: cleaned };
  }
  const block1Text = unwrapFrontmatterFences(frontmatter);

  // NEW single-block: identity under a leading `template:` key.
  const peeled = peelTemplateIdentity(block1Text);
  if (peeled) {
    return {
      identity: peeled.identity,
      starterContent: composeStarterContent(peeled.docFrontmatterText, body),
    };
  }

  // Legacy two-block: block 1 is identity, a second block immediately follows.
  // starterContent stays the verbatim remainder (block 2 + markdown) — tokens
  // preserved, no re-serialization.
  const { frontmatter: block2Fenced } = stripFrontmatter(body);
  if (block2Fenced !== '') {
    return { identity: parseYamlObject(block1Text) as TemplateIdentity, starterContent: body };
  }

  // Single block, no `template:` key, no second block. If it looks like
  // identity (has a title), treat it as identity with empty starter
  // frontmatter; otherwise treat the block as doc-frontmatter text.
  const block1 = parseYamlObject(block1Text);
  if (typeof block1.title === 'string') {
    return { identity: block1 as TemplateIdentity, starterContent: body };
  }
  return { identity: {}, starterContent: composeStarterContent(block1Text, body) };
}

/**
 * Compose a single-block template file from an identity + starter content.
 * Splits the starter content's leading doc-frontmatter TEXT, prepends the
 * `template:` identity, and re-attaches the markdown body. Only the identity
 * is serialized through YAML; doc-frontmatter text passes through verbatim.
 */
export function composeTemplateFile(identity: TemplateIdentity, starterContent: string): string {
  const { docFrontmatterText, markdown } = splitStarterContent(starterContent);
  const cleanIdentity: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(identity)) {
    if (v !== undefined) cleanIdentity[k] = v;
  }
  // `template:` identity is token-free, so YAML stringify is safe here.
  const identityYaml = stringifyYaml({ [TEMPLATE_IDENTITY_KEY]: cleanIdentity });
  const inner =
    docFrontmatterText.trim() === '' ? identityYaml : `${identityYaml}${docFrontmatterText}\n`;
  return `---\n${inner}---\n${markdown}`;
}

/**
 * The literal content a new document receives from a template — its
 * doc-frontmatter block + markdown body, with the template identity stripped.
 * Substitution (`{{date}}`/`{{user}}`) is applied by the caller.
 */
export function instantiateDoc(raw: string): string {
  return parseTemplateFile(raw).starterContent;
}
