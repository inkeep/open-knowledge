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
