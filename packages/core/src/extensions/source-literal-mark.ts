import { Mark } from '@tiptap/core';
import { decodeInlineWhitespaceNumericCharRefRun } from '../markdown/whitespace-char-ref.ts';

export const SourceLiteralMark = Mark.create({
  name: 'sourceLiteral',
  priority: 10,
  excludes: '',
  inclusive: false,

  addAttributes() {
    return {
      sourceRaw: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-source-literal]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', { 'data-source-literal': '', ...HTMLAttributes }, 0];
  },
});

export function isValidSourceLiteralRaw(sourceRaw: unknown, visibleText: unknown): boolean {
  if (typeof sourceRaw !== 'string' || typeof visibleText !== 'string') return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: this is exactly the set we are rejecting.
  if (/[\x00-\x1F\x7F]/.test(sourceRaw)) return false;
  const normalizedRaw = sourceRaw.replaceAll(' ', ' ');
  const normalizedVisible = visibleText.replaceAll(' ', ' ');
  if (normalizedRaw === normalizedVisible) return true;
  if (stripMarkdownBackslashEscapes(normalizedRaw) === normalizedVisible) return true;
  return decodeInlineWhitespaceNumericCharRefRun(normalizedRaw) === normalizedVisible;
}

function stripMarkdownBackslashEscapes(s: string): string {
  return s.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}
