/**
 * Shared yaml@2 + Zod helpers used by both `writeConfigPatch` (headless,
 * fs-direct) and `bindConfigDoc` (UI, Y.Text-backed). Both walk a deep-partial
 * `ConfigPatch` over a yaml@2 `Document`, merge the result, and surface Zod
 * issues as wire-safe `ConfigIssue`s.
 *
 * No Node deps — pure yaml@2 + Zod. Safe to import from browser-bundled code.
 */

import { type Document, isCollection, type ParsedNode } from 'yaml';
import type { ConfigIssue } from './errors.ts';
import type { ConfigPatch } from './schema.ts';

/**
 * Replace any non-collection ancestor on `path` with an empty Map so that
 * `setIn` can descend through it. yaml@2's `setIn` auto-creates *missing*
 * intermediates as Maps but throws "Expected YAML collection at <key>" when
 * an intermediate already exists as a Scalar (e.g., `appearance:` with no
 * body parses as `Scalar(null)`, and `appearance: ~` likewise). This shape
 * is reachable via hand-edits, deletions that leave the parent key, and any
 * config scaffolded with empty section headers.
 */
function ensureCollectionAncestors(
  doc: Document.Parsed<ParsedNode>,
  path: (string | number)[],
): void {
  for (let i = 1; i < path.length; i++) {
    const ancestor = path.slice(0, i);
    if (!doc.hasIn(ancestor)) continue;
    const node = doc.getIn(ancestor, true);
    if (isCollection(node)) continue;
    doc.deleteIn(ancestor);
  }
}

/**
 * Walk a deep-partial patch tree and apply each leaf to the YAML Document.
 *
 * Null values clear the field via `deleteIn`. Undefined keys are skipped
 * (deep-partial semantics — absence means "leave alone"). Arrays replace
 * wholesale per RFC 7396 §1. Returns the dotted paths of every leaf touched.
 */
export function applyPatchToDocument(
  doc: Document.Parsed<ParsedNode>,
  patch: ConfigPatch,
): string[] {
  const applied: string[] = [];

  function walk(value: unknown, path: (string | number)[]): void {
    if (value === undefined) return;
    if (value === null) {
      doc.deleteIn(path);
      applied.push(path.join('.'));
      return;
    }
    if (Array.isArray(value)) {
      ensureCollectionAncestors(doc, path);
      doc.setIn(path, value);
      applied.push(path.join('.'));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, subValue] of Object.entries(value)) {
        walk(subValue, [...path, key]);
      }
      return;
    }
    ensureCollectionAncestors(doc, path);
    doc.setIn(path, value);
    applied.push(path.join('.'));
  }

  for (const [key, value] of Object.entries(patch)) {
    walk(value, [key]);
  }

  return applied;
}

/**
 * Convert a Zod issue to a wire-safe `ConfigIssue`. Symbols in `issue.path`
 * (`PropertyKey[]`) are stringified — they don't survive JSON serialization
 * and break consumer rendering otherwise.
 */
export function toConfigIssue(issue: {
  path: PropertyKey[];
  message: string;
  code: string;
}): ConfigIssue {
  const path = issue.path.map((seg) =>
    typeof seg === 'symbol' ? String(seg) : (seg as string | number),
  );
  return {
    path,
    message: issue.message,
    issueCode: issue.code,
  };
}
