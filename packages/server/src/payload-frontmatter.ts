/**
 * The append/prepend payload partition rule, shared by the two server-side
 * consumers that must agree on it byte-for-byte.
 *
 * Server-local on purpose. `@inkeep/open-knowledge-core` is a mirrored public
 * package, so an export there is a permanent surface commitment; both callers
 * live in this package, and the rule is an internal write-path policy rather
 * than a markdown primitive. Kept out of `agent-sessions.ts` (the composer
 * that owns the rule) because the MCP `write` tool would then drag Yjs,
 * Hocuspocus and the parse pool in for one predicate.
 */

import {
  parseFrontmatterYaml,
  stripFrontmatter,
  unwrapFrontmatterFences,
} from '@inkeep/open-knowledge-core';

/**
 * Partition an append/prepend payload into (frontmatter, body) under the rule
 * that only a YAML MAPPING counts as frontmatter.
 *
 * `FRONTMATTER_RE` claims any text that opens with a `---` fence and closes
 * with another one, which an ordinary body hits routinely — a thematic break,
 * a section separated by rules, a pasted `---`-delimited quote. Append and
 * prepend DISCARD whatever the partition claims, so a mis-claim silently eats
 * body content the caller asked to write. A claimed span that does not parse
 * as a mapping was never frontmatter, so it is un-split and the whole payload
 * is body.
 *
 * The two consumers must not diverge: `composeAgentWrite` writes by this rule,
 * and the MCP `write` tool's advisory notes describe the result to the agent.
 * When they disagree the note reports a drop that did not happen.
 * `replace`/`patch` do NOT use this — they supersede the frontmatter region
 * rather than discarding it, so they keep the raw `stripFrontmatter` partition.
 */
export function splitPayloadFrontmatter(markdown: string): {
  frontmatter: string;
  body: string;
} {
  const split = stripFrontmatter(markdown);
  if (split.frontmatter === '') return split;
  if (parseFrontmatterYaml(unwrapFrontmatterFences(split.frontmatter)).map === null) {
    return { frontmatter: '', body: markdown };
  }
  return split;
}
