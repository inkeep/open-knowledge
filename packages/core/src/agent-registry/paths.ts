import { ALL_EDITOR_IDS, type EditorId } from '../constants/editors.ts';
import { type PathId, pathId } from './ids.ts';

export const EDITOR_PATH_KINDS = [
  'editor-user-config',
  'editor-project-config',
  'editor-project-skill-root',
  'editor-user-skill-root',
] as const;

export type EditorPathKind = (typeof EDITOR_PATH_KINDS)[number];

export const CENTRAL_SKILL_STORE_PATH_ID: PathId = pathId('central-skill-store');

export function editorPathId(kind: EditorPathKind, editor: EditorId): PathId {
  return pathId(`${kind}:${editor}`);
}

export type ResolvedPathId =
  | { readonly kind: EditorPathKind; readonly editor: EditorId }
  | { readonly kind: 'central-skill-store' };

export function parsePathId(value: string): ResolvedPathId | null {
  if (value === CENTRAL_SKILL_STORE_PATH_ID) return { kind: 'central-skill-store' };
  const separator = value.indexOf(':');
  if (separator === -1) return null;
  const kind = value.slice(0, separator);
  const editor = value.slice(separator + 1);
  if (!(EDITOR_PATH_KINDS as readonly string[]).includes(kind)) return null;
  if (!(ALL_EDITOR_IDS as readonly string[]).includes(editor)) return null;
  return { kind: kind as EditorPathKind, editor: editor as EditorId };
}
