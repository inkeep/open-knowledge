import type { Editor } from '@tiptap/core';
import { Sparkles } from 'lucide-react';
import { getSkillNamesForScope } from '@/lib/skill-name-set';
import { skillDocTarget } from '../extensions/skill-path-links';
import type { SlashCommandItem } from './items';

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
