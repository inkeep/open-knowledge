/**
 * Textarea double for the shared `ComposerMentionInput`, for the ThreadView
 * DOM suites' `vi.doMock('@/editor/ComposerMentionInput', ...)`.
 *
 * The real field is a ProseMirror contentEditable, which jsdom cannot type
 * into (`fireEvent.change` is inert and `user.keyboard` needs a real editing
 * host), and whose deferred scroll work is a known source of post-suite
 * crashes under the DOM runner — so ThreadView suites drive this double and
 * the editor's own behavior (chips, `@`-typeahead, IME guard, key handling)
 * is covered against the real TipTap instance in
 * `ComposerMentionInput.dom.test.tsx`.
 *
 * Contract parity, because ThreadView's logic is what these suites test:
 * the full imperative handle (focus / blur / clear / setText / appendText /
 * getContent), `onEmptyChange` on every edit, Enter-submits with the IME
 * guard, Escape → `onEscape` (else blur), and placeholder / disabled /
 * testId as plain DOM attributes. `appendText` reproduces the blank-line
 * join (`existing\n\nappended`) the rescue/staged-draft tests assert.
 */

import type { JSONContent } from '@tiptap/core';
import { type Ref, useImperativeHandle, useRef } from 'react';
import type { ComposerMentionInputHandle } from '@/editor/ComposerMentionInput';

export function MockComposerMentionInput({
  ref,
  ariaLabel,
  onEmptyChange,
  onContentChange,
  onSubmit,
  onEscape,
  className,
  placeholder,
  disabled,
  testId,
}: {
  ref?: Ref<ComposerMentionInputHandle>;
  ariaLabel: string;
  onEmptyChange: (isEmpty: boolean) => void;
  onContentChange?: (doc: JSONContent) => void;
  onSubmit: () => void;
  onEscape?: () => void;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  testId?: string;
}) {
  const localRef = useRef<HTMLTextAreaElement>(null);
  // Both callbacks, on every edit — the real field fires them together, and a
  // double that only carried `onEmptyChange` left every host reading the live
  // draft (`ThreadCard`'s click-away commit) looking at a permanent `null`. A
  // test for "the unmount saves what I typed" then passed with nothing typed.
  //
  // A paragraph of plain text: hosts read this back through `getContent`, not
  // by walking the doc, so the shape only has to be a doc TipTap would accept.
  const notify = () => {
    const value = localRef.current?.value ?? '';
    onEmptyChange(value.trim() === '');
    onContentChange?.({
      type: 'doc',
      content: [
        value === ''
          ? { type: 'paragraph' }
          : { type: 'paragraph', content: [{ type: 'text', text: value }] },
      ],
    });
  };
  useImperativeHandle(ref, () => ({
    focus: () => localRef.current?.focus(),
    focusEnd: () => {
      const el = localRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    },
    blur: () => localRef.current?.blur(),
    clear: () => {
      if (localRef.current) localRef.current.value = '';
      notify();
    },
    setText: (text: string) => {
      if (localRef.current) localRef.current.value = text;
      notify();
    },
    appendText: (text: string) => {
      const el = localRef.current;
      if (!el || text === '') return;
      el.value = el.value.trim() === '' ? text : `${el.value.replace(/\s+$/, '')}\n\n${text}`;
      notify();
    },
    getContent: () => ({
      instruction: localRef.current?.value ?? '',
      mentions: [],
      attachments: [],
    }),
    openMentionPicker: () => {},
  }));
  return (
    <textarea
      ref={localRef}
      aria-label={ariaLabel}
      placeholder={placeholder}
      disabled={disabled}
      data-testid={testId}
      className={className}
      onChange={notify}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onSubmit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          if (onEscape !== undefined) onEscape();
          else localRef.current?.blur();
        }
      }}
    />
  );
}
