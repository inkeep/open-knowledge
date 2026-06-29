
import { type Document, isCollection, type ParsedNode } from 'yaml';
import type { ConfigIssue } from './errors.ts';
import type { ConfigPatch } from './schema.ts';

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
