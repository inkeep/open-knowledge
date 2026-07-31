/**
 * Dynamic "reference a skill" slash items — skill docs only (typing `/` in a skill doc surfaces the skills you already have;
 * the slash menu IS the picker, so `/gri` filters straight to `grilling`).
 * Selecting one inserts the plain `/name ` convention bytes; the reference
 * decoration then renders it as a live skill link. No items outside skill
 * docs, no items before the name snapshot loads.
 */
import type { Editor } from '@tiptap/core';
import { Sparkles } from 'lucide-react';
import { getSkillNamesForScope } from '@/lib/skill-name-set';
import { skillDocTarget } from '../extensions/skill-path-links';
import type { SlashCommandItem } from './items';

/** The active doc name, read off the always-registered skillPathLinks
 *  extension's options — the one place the editor instance carries it. */
function editorDocName(editor: Editor | undefined): string | null {
  if (!editor) return null;
  const ext = editor.extensionManager.extensions.find((e) => e.name === 'skillPathLinks');
  const docName = (ext?.options as { docName?: string } | undefined)?.docName;
  return typeof docName === 'string' && docName !== '' ? docName : null;
}

export function getSkillReferenceItems(ctx?: { editor?: Editor }): SlashCommandItem[] {
  const docName = editorDocName(ctx?.editor);
  const target = docName === null ? null : skillDocTarget(docName);
  if (target === null) return [];
  // Same-scope only: a global skill referencing a project skill breaks in
  // every other project; a project doc references its own project set.
  const known = getSkillNamesForScope(target.scope);
  if (known === null) return [];
  const items: SlashCommandItem[] = [];
  for (const [name, info] of known) {
    items.push({
      name: `skill-ref-${name}`,
      label: name,
      icon: Sparkles,
      category: 'skills',
      description: info.scope,
      command: (editor) => {
        editor.chain().focus().insertContent(`/${name} `).run();
      },
    });
  }
  items.sort((a, b) => a.label.localeCompare(b.label));
  return items;
}
