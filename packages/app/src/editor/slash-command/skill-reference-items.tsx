import type { Editor } from '@tiptap/core';
import { Sparkles } from 'lucide-react';
import { getSkillNamesForScope } from '@/lib/skill-name-set';
import { skillDocTarget } from '../extensions/skill-path-links';
import type { SlashCommandItem } from './items';

const BLURB_MAX = 80;
const BLURB_OVERFLOW = 24;

const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|approx|cf|al|Dr|Mr|Ms|Mrs|St|No|Fig)\.$/;

function firstSentence(text: string): string {
  const terminator = /[.!?](?=\s)/g;
  for (let hit = terminator.exec(text); hit !== null; hit = terminator.exec(text)) {
    const candidate = text.slice(0, hit.index + 1);
    if (!ABBREVIATION.test(candidate)) return candidate;
  }
  return text;
}

function capAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const nextSpace = text.indexOf(' ', max);
  const tokenEnd = nextSpace === -1 ? text.length : nextSpace;
  if (tokenEnd <= max + BLURB_OVERFLOW) return text.slice(0, tokenEnd).trimEnd();
  return text.slice(0, max).trimEnd();
}

function blurb(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  const collapsed = description.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return undefined;
  const shortened = capAtWord(firstSentence(collapsed), BLURB_MAX);
  if (shortened.length >= collapsed.length) return shortened;
  return `${shortened.replace(/[.!?,;:]+$/, '')}…`;
}

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
    const text = blurb(info.description);
    items.push({
      name: `skill-ref-${name}`,
      label: name,
      icon: Sparkles,
      category: 'skills',
      ...(text === undefined ? {} : { description: text }),
      command: (editor) => {
        editor.chain().focus().insertContent(`/${name} `).run();
      },
    });
  }
  items.sort((a, b) => a.label.localeCompare(b.label));
  return items;
}
