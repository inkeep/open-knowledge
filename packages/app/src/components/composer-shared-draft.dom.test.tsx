/**
 * Cross-placement integration for the unified "Ask AI" composer's SHARED draft.
 *
 * The user symptom this guards: a brief typed in the bottom docked composer must
 * carry into the create-screen hero composer (and back), surviving the composer
 * unmounting as the user navigates doc → empty → doc. Both placements read/write
 * the same `composer-draft-store`, so the draft lives in the store, not in either
 * component's local state.
 *
 * The shared unit is the editor's ProseMirror document JSON, NOT a flattened
 * string — so an atomic `@`-mention chip survives across placements as a real
 * `composerMention` node, instead of round-tripping through lossy literal `@path`
 * text. The rich `@`-mention input is replaced with a doc-faithful double that
 * honors the real contract additions (`initialDoc` seed + `onContentChange`
 * mirror, both doc JSON) and renders `composerMention` nodes as `.composer-mention`
 * chip spans, so these tests exercise the store wiring + chip survival through the
 * real components rather than the editor internals (covered in
 * `ComposerMentionInput.dom.test.tsx`).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { CreateScenario, InstallState } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { JSONContent } from '@tiptap/core';
import { type ReactNode, type Ref, useImperativeHandle, useRef, useState } from 'react';
import { __resetComposerDraftForTests } from './composer-draft-store';

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

mock.module('@/lib/config-context', () => ({
  useConfigContext: () => ({ merged: { appearance: { preview: { autoOpen: true } } } }),
}));

mock.module('@/components/handoff/OpenInAgentMenuItem', () => ({
  TargetIcon: ({ id }: { id: string }) => <span data-testid={`target-icon-${id}`} />,
}));

type MenuChild = {
  children?: ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
  [key: string]: unknown;
};
mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: MenuChild) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: MenuChild) => <>{children}</>,
  DropdownMenuContent: ({ children, ...props }: MenuChild) => (
    <div role="menu" {...props}>
      {children}
    </div>
  ),
  DropdownMenuGroup: ({ children }: MenuChild) => <>{children}</>,
  DropdownMenuItem: ({ children, disabled, onSelect, ...props }: MenuChild) => (
    <button type="button" role="menuitem" disabled={disabled} onClick={onSelect} {...props}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children, ...props }: MenuChild) => <div {...props}>{children}</div>,
  DropdownMenuSeparator: () => <hr data-testid="menu-separator" />,
}));

const installedAll: Record<string, InstallState> = {
  'claude-cowork': { installed: false },
  'claude-code': { installed: true },
  codex: { installed: true },
  cursor: { installed: true },
};
mock.module('@/components/handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({ states: installedAll, refresh: () => Promise.resolve() }),
}));

mock.module('@/lib/use-workspace', () => ({
  useWorkspace: () => ({ contentDir: '/tmp/project', pathSeparator: '/' }),
}));

mock.module('@/hooks/use-selection-context', () => ({
  useSelectionContext: () => null,
}));

mock.module('@/components/handoff/useHandoffDispatch', () => ({
  useHandoffDispatch: () => ({ dispatch: () => Promise.resolve({ ok: true }) }),
  buildComposerHandoffInput: (args: { instruction: string }) => ({
    compose: { instruction: args.instruction },
  }),
  buildCreateHandoffInput: (args: { description: string }) => ({
    createDescription: args.description,
  }),
  getDisplayNameDefault: (id: string) => id,
  openInstallUrl: () => Promise.resolve(),
}));

mock.module('sonner', () => ({ toast: { error: () => {}, success: () => {} } }));

// ---------------------------------------------------------------------------
// Doc-faithful input double. It honors the SHARED-DRAFT contract additions:
// seeds from `initialDoc` (document JSON) and mirrors edits up via
// `onContentChange` (also document JSON). It models the doc the way the real
// editor does — a paragraph of inline `text` / `composerMention` nodes — and
// renders any mention node as a `.composer-mention` chip span, so a test can
// assert a chip survived across placements. The editor internals are covered
// elsewhere; this exercises the store wiring + chip preservation.
// ---------------------------------------------------------------------------

type Handle = {
  focus: () => void;
  blur: () => void;
  clear: () => void;
  setText: (text: string) => void;
  getContent: () => { instruction: string; mentions: string[] };
};

/** Flatten a composer doc to its plain instruction (chips inline as `@path`). */
function docToInstruction(doc: JSONContent | undefined): string {
  if (!doc?.content) return '';
  return doc.content
    .map((block) =>
      (block.content ?? [])
        .map((node) =>
          node.type === 'composerMention' ? `@${node.attrs?.path ?? ''}` : (node.text ?? ''),
        )
        .join(''),
    )
    .join('\n')
    .trim();
}

/** Build a plain-text paragraph doc (no chips) from a typed string. */
function textToDoc(value: string): JSONContent {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: value ? [{ type: 'text', text: value }] : [] }],
  };
}

mock.module('@/editor/ComposerMentionInput', () => ({
  ComposerMentionInput: ({
    ref,
    ariaLabel,
    onEmptyChange,
    onContentChange,
    onSubmit,
    initialDoc,
  }: {
    ref?: Ref<Handle>;
    ariaLabel: string;
    onEmptyChange: (isEmpty: boolean) => void;
    onContentChange?: (doc: JSONContent) => void;
    onSubmit: () => void;
    initialDoc?: JSONContent;
  }) => {
    // The live doc the field models. Seeded from the shared draft; chips in it
    // render as real chip spans below.
    const [doc, setDoc] = useState<JSONContent>(() => initialDoc ?? textToDoc(''));
    const localRef = useRef<HTMLTextAreaElement>(null);

    const emit = (next: JSONContent) => {
      setDoc(next);
      onEmptyChange(docToInstruction(next) === '');
      onContentChange?.(next);
    };

    useImperativeHandle(ref, () => ({
      focus: () => localRef.current?.focus(),
      blur: () => localRef.current?.blur(),
      clear: () => emit(textToDoc('')),
      setText: (text: string) => emit(textToDoc(text)),
      getContent: () => {
        const mentions: string[] = [];
        for (const block of doc.content ?? []) {
          for (const node of block.content ?? []) {
            if (node.type === 'composerMention' && node.attrs?.path) {
              mentions.push(String(node.attrs.path));
            }
          }
        }
        return { instruction: docToInstruction(doc), mentions };
      },
    }));

    const mentionNodes = (doc.content ?? []).flatMap((block) =>
      (block.content ?? []).filter((node) => node.type === 'composerMention'),
    );

    return (
      <div>
        <textarea
          ref={localRef}
          aria-label={ariaLabel}
          value={docToInstruction(doc)}
          onChange={(event) => emit(textToDoc(event.target.value))}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        {/* Render seeded/inserted mention nodes as real chip spans — the atomic
            unit the assertions look for. */}
        {mentionNodes.map((node, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: stable list of seeded chips in a test double
            key={i}
            className="composer-mention"
            data-composer-mention={String(node.attrs?.path ?? '')}
          >
            @{String(node.attrs?.label ?? node.attrs?.path ?? '')}
          </span>
        ))}
        {/* Test affordance: insert an `@`-mention chip the way the typeahead
            would — appends a `composerMention` node and mirrors the doc up. */}
        <button
          type="button"
          data-testid={`insert-mention-${ariaLabel}`}
          onClick={() => {
            const block = doc.content?.[0] ?? { type: 'paragraph', content: [] };
            const next: JSONContent = {
              type: 'doc',
              content: [
                {
                  ...block,
                  content: [
                    ...(block.content ?? []),
                    { type: 'composerMention', attrs: { path: 'ideas/foo.md', label: 'Foo' } },
                  ],
                },
              ],
            };
            emit(next);
          }}
        >
          insert mention
        </button>
      </div>
    );
  },
}));

const { BottomComposer } = await import('./BottomComposer');
const { CreatePromptComposer } = await import('./empty-state/CreatePromptComposer');

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* guarded */
  }
  __resetComposerDraftForTests();
});

afterEach(() => {
  cleanup();
  __resetComposerDraftForTests();
});

function bottomInput() {
  return screen.getByRole('textbox', { name: 'Ask AI' }) as HTMLTextAreaElement;
}

function heroInput() {
  return screen.getByRole('textbox', {
    name: 'Describe the project you want to create',
  }) as HTMLTextAreaElement;
}

describe('shared draft across composer placements', () => {
  test('a draft typed in the bottom (docked) composer appears in the create (hero) composer', async () => {
    const docked = render(<BottomComposer docName="notes" surface="wysiwyg" />);
    fireEvent.change(bottomInput(), { target: { value: 'condense my AGENTS.md' } });

    // Navigate away from the doc → the bottom composer unmounts.
    docked.unmount();

    // The create/empty hero mounts (a new tab landed on the empty state).
    render(<CreatePromptComposer scenario={'new-project' as CreateScenario} />);
    await waitFor(() => expect(heroInput().value).toBe('condense my AGENTS.md'));
  });

  test('a draft typed in the create (hero) composer appears in the bottom (docked) composer', async () => {
    const hero = render(<CreatePromptComposer scenario={'new-project' as CreateScenario} />);
    fireEvent.change(heroInput(), { target: { value: 'research flightless birds' } });

    hero.unmount();

    render(<BottomComposer docName="notes" surface="wysiwyg" />);
    await waitFor(() => expect(bottomInput().value).toBe('research flightless birds'));
  });

  test('an @-mention chip inserted in the bottom composer survives as a chip node in the create composer', async () => {
    const docked = render(<BottomComposer docName="notes" surface="wysiwyg" />);
    fireEvent.change(bottomInput(), { target: { value: 'see ' } });
    // Insert a mention the way the typeahead would — it becomes an atomic node.
    fireEvent.click(screen.getByTestId('insert-mention-Ask AI'));

    docked.unmount();

    render(<CreatePromptComposer scenario={'new-project' as CreateScenario} />);

    // The seeded hero field restores a real `.composer-mention` chip element —
    // NOT a literal `@ideas/foo.md` text run — proving the doc (not a flattened
    // string) crossed the placement boundary.
    await waitFor(() => {
      const chip = document.querySelector(
        '.composer-mention[data-composer-mention="ideas/foo.md"]',
      );
      expect(chip).not.toBeNull();
    });
  });

  test('the chip also survives the reverse direction (hero → bottom)', async () => {
    const hero = render(<CreatePromptComposer scenario={'new-project' as CreateScenario} />);
    fireEvent.change(heroInput(), { target: { value: 'reference ' } });
    fireEvent.click(screen.getByTestId('insert-mention-Describe the project you want to create'));

    hero.unmount();

    render(<BottomComposer docName="notes" surface="wysiwyg" />);
    await waitFor(() => {
      const chip = document.querySelector(
        '.composer-mention[data-composer-mention="ideas/foo.md"]',
      );
      expect(chip).not.toBeNull();
    });
  });

  test('the draft survives a doc → empty → doc round trip (remount restores it)', async () => {
    const first = render(<BottomComposer docName="notes" surface="wysiwyg" />);
    fireEvent.change(bottomInput(), { target: { value: 'summarize my week' } });
    first.unmount(); // → folder/empty

    const empty = render(<CreatePromptComposer scenario={'new-project' as CreateScenario} />);
    await waitFor(() => expect(heroInput().value).toBe('summarize my week'));
    empty.unmount(); // → back to a doc

    render(<BottomComposer docName="other" surface="wysiwyg" />);
    await waitFor(() => expect(bottomInput().value).toBe('summarize my week'));
  });

  test('the draft persists across a reload (store re-hydrates the doc from storage)', async () => {
    const docked = render(<BottomComposer docName="notes" surface="wysiwyg" />);
    fireEvent.change(bottomInput(), { target: { value: 'draft a spec' } });
    docked.unmount();

    // Simulate reload: drop the in-memory store snapshot. The next mount reads
    // the persisted draft doc back from localStorage.
    __resetComposerDraftForTests();

    render(<BottomComposer docName="notes" surface="wysiwyg" />);
    await waitFor(() => expect(bottomInput().value).toBe('draft a spec'));
  });
});
