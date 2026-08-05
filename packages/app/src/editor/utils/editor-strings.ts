/**
 * Editor user-visible string helpers.
 *
 * Every user-visible label that varies by count / context goes through a
 * helper here, so the count-agreement rules live in one place instead of
 * being re-derived at each call site.
 *
 * Design: prefer LOCALE-NEUTRAL shapes ("with N items") over inflecting
 * the caller's noun, because inflection heuristics (the "+ 's'" pattern)
 * are wrong for irregular plurals and nonsensical in non-English locales.
 * The helpers here intentionally do NOT inflect user-supplied nouns.
 */

import type { PropDef } from '@inkeep/open-knowledge-core';
import { plural, t } from '@lingui/core/macro';

/**
 * Human-readable container summary used as an aria-label on block-
 * container wrappers (Cards / Steps / Tabs / Accordions / Files / …).
 *
 * Examples:
 *   formatContainerAriaLabel('Cards', 'Card', 0)  // "Cards (empty)"
 *   formatContainerAriaLabel('Cards', 'Card', 1)  // "Cards with 1 item"
 *   formatContainerAriaLabel('Cards', 'Card', 3)  // "Cards with 3 items"
 *
 * `childName` is intentionally ignored in the output prose. Inflecting
 * it ("with 3 cards") breaks for irregular plurals (Foot → Foots) and is
 * meaningless in any non-English locale. Accepting `childName` in the
 * signature keeps the contract stable in case a future formatter wants
 * to use it.
 */
export function formatContainerAriaLabel(
  componentLabel: string,
  _childName: string | undefined,
  childCount: number,
): string {
  if (childCount <= 0) return t`${componentLabel} (empty)`;
  // The `plural` macro, not `Intl.PluralRules`: it selects against the ACTIVE
  // catalog's own CLDR categories, so a locale with more than two (Arabic has
  // six) gets the form its translator wrote rather than an English one/other
  // split applied to translated text.
  return t`${componentLabel} with ${plural(childCount, {
    one: '# item',
    other: '# items',
  })}`;
}

/**
 * Pick the prop name whose input should be focused first when the PropPanel
 * mounts. Matches the React DOM `autoFocus` convention. Skips reactnode,
 * hidden, and advanced props — only first-tier string inputs are eligible.
 * First match in declared `props[]` order wins (deterministic, no separate
 * ordering field). Returns `null` when no eligible autoFocus prop exists.
 *
 * Lives here (rather than alongside PropPanel) because `resolve-descriptor-
 * placeholder.ts` also keys off it: the placeholder predicate fires when the
 * autoFocus-flagged required string is empty. Two consumers, one shape-
 * introspection helper — symmetric with `humanizePropName` below.
 */
export function getAutoFocusedPropName(props: PropDef[]): string | null {
  for (const p of props) {
    if (p.type !== 'string') continue;
    if (p.hidden === true) continue;
    if (p.advanced === true) continue;
    if (p.autoFocus === true) return p.name;
  }
  return null;
}

/**
 * Humanize a camelCase / snake_case prop name for the PropPanel UI.
 * Splits on `_` / `-` and on camelCase word boundaries; capitalizes only the
 * first character of the result. `emptyChildName` → `Empty Child Name`
 * (every word begins with a capital because the camelCase regex inserts
 * spaces *before* existing capitals). `default_value` → `Default value`
 * (snake/kebab inputs keep the rest of the words lowercase).
 * Identifiers stay camelCase in the generated markdown attr; only the label
 * is transformed.
 */
export function humanizePropName(name: string): string {
  if (!name) return name;
  const spaced = name
    // snake_case and kebab-case → space
    .replace(/[_-]+/g, ' ')
    // camelCase and consecutive-capitals boundaries (emptyChildName → empty Child Name; ARIALabel → ARIA Label)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
