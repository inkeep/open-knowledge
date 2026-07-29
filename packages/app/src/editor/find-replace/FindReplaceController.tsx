import type { Editor } from '@tiptap/core';
import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { getEditorForDoc, subscribeEditorRegistry } from '@/editor/active-editor';
import { matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import { isOverlayLayerOpen } from '@/lib/overlay-layers';
import { getEditorView } from '../utils/get-editor-view';
import { FindReplaceBar } from './FindReplaceBar';
import { getFindReplaceState } from './tiptap-find-replace-extension';

interface FindReplaceControllerProps {
  activeDocName: string | null;
  isSourceMode: boolean;
}

interface FindReplaceUiState {
  open: boolean;
  replaceOpen: boolean;
  query: string;
  replacement: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  activeIndex: number;
}

interface MatchSummary {
  current: number;
  total: number;
}

const EMPTY_MATCH_SUMMARY: MatchSummary = { current: 0, total: 0 };
const MAX_SELECTION_PREFILL_LENGTH = 120;
const FIND_QUERY_DISPATCH_DELAY_MS = 100;

function useActiveEditor(activeDocName: string | null): Editor | null {
  return useSyncExternalStore(
    subscribeEditorRegistry,
    () => (activeDocName ? getEditorForDoc(activeDocName) : null),
    () => null,
  );
}

function selectedTextForFind(editor: Editor | null): string | null {
  if (!editor || editor.isDestroyed) return null;
  const { from, to, empty } = editor.state.selection;
  if (empty) return null;
  const text = editor.state.doc.textBetween(from, to, '\n', '\n').trim();
  if (text.length === 0 || text.length > MAX_SELECTION_PREFILL_LENGTH) return null;
  if (text.includes('\n')) return null;
  return text;
}

function matchSummaryFromEditor(editor: Editor): MatchSummary {
  const pluginState = getFindReplaceState(editor.state);
  return {
    current: pluginState.matches.length === 0 ? 0 : pluginState.activeIndex + 1,
    total: pluginState.matches.length,
  };
}

function isSameMatchSummary(a: MatchSummary, b: MatchSummary): boolean {
  return a.current === b.current && a.total === b.total;
}

function closeFindForEditor(
  editor: Editor | null,
  setFindState: Dispatch<SetStateAction<FindReplaceUiState>>,
  setMatchSummary: Dispatch<SetStateAction<MatchSummary>>,
): void {
  if (editor && !editor.isDestroyed) {
    editor.commands.clearFindMatches();
    editor.commands.focus();
  }
  setFindState((prev) => ({ ...prev, open: false, activeIndex: 0 }));
  setMatchSummary(EMPTY_MATCH_SUMMARY);
}

function scrollActiveFindMatchIntoView(editor: Editor | null): void {
  if (!editor || editor.isDestroyed || typeof window === 'undefined') return;

  window.requestAnimationFrame(() => {
    if (editor.isDestroyed) return;

    const view = getEditorView(editor);
    if (!view) return;

    const activeMatch = view.dom.querySelector('.ok-find-match-active');
    if (activeMatch instanceof HTMLElement) {
      activeMatch.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    }
  });
}

export function FindReplaceController({ activeDocName, isSourceMode }: FindReplaceControllerProps) {
  const editor = useActiveEditor(activeDocName);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const previousEditorRef = useRef<Editor | null>(null);
  const previousDocNameRef = useRef<string | null>(activeDocName);
  const activeIndexRef = useRef(0);
  const [findState, setFindState] = useState<FindReplaceUiState>({
    open: false,
    replaceOpen: false,
    query: '',
    replacement: '',
    caseSensitive: false,
    wholeWord: false,
    activeIndex: 0,
  });
  const [matchSummary, setMatchSummary] = useState<MatchSummary>(EMPTY_MATCH_SUMMARY);

  useEffect(() => {
    if (previousDocNameRef.current === activeDocName) return;
    previousDocNameRef.current = activeDocName;
    setFindState((prev) => ({ ...prev, activeIndex: 0 }));
  }, [activeDocName]);

  useEffect(() => {
    activeIndexRef.current = findState.activeIndex;
  }, [findState.activeIndex]);

  useEffect(() => {
    const previousEditor = previousEditorRef.current;
    if (previousEditor && previousEditor !== editor && !previousEditor.isDestroyed) {
      previousEditor.commands.clearFindMatches();
    }
    previousEditorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (!findState.open || !findInputRef.current) return;
    const handle = requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
    return () => cancelAnimationFrame(handle);
  }, [findState.open]);

  useEffect(() => {
    if (!findState.open || !isSourceMode) return;
    setFindState((prev) => ({ ...prev, open: false, activeIndex: 0 }));
  }, [findState.open, isSourceMode]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      setMatchSummary(EMPTY_MATCH_SUMMARY);
      return;
    }

    if (!findState.open || isSourceMode) {
      editor.commands.clearFindMatches();
      setMatchSummary(EMPTY_MATCH_SUMMARY);
      return;
    }

    const handle = window.setTimeout(() => {
      if (editor.isDestroyed) return;
      editor.commands.setFindQuery(findState.query, {
        options: {
          caseSensitive: findState.caseSensitive,
          wholeWord: findState.wholeWord,
        },
        activeIndex: activeIndexRef.current,
      });

      const nextSummary = matchSummaryFromEditor(editor);
      setMatchSummary((prev) => (isSameMatchSummary(prev, nextSummary) ? prev : nextSummary));
    }, FIND_QUERY_DISPATCH_DELAY_MS);

    return () => window.clearTimeout(handle);
  }, [
    editor,
    findState.open,
    findState.query,
    findState.caseSensitive,
    findState.wholeWord,
    isSourceMode,
  ]);

  useEffect(() => {
    if (!editor || editor.isDestroyed || !findState.open || isSourceMode) return;
    const onTransaction = () => {
      const pluginState = getFindReplaceState(editor.state);
      const nextSummary = matchSummaryFromEditor(editor);
      setMatchSummary((prev) => (isSameMatchSummary(prev, nextSummary) ? prev : nextSummary));
      setFindState((prev) =>
        prev.activeIndex === pluginState.activeIndex
          ? prev
          : { ...prev, activeIndex: pluginState.activeIndex },
      );
    };
    editor.on('transaction', onTransaction);
    return () => {
      editor.off('transaction', onTransaction);
    };
  }, [editor, findState.open, isSourceMode]);

  useEffect(() => {
    function openFind(replaceOpen: boolean) {
      const selectedText = selectedTextForFind(editor);
      setFindState((prev) => ({
        ...prev,
        open: true,
        replaceOpen,
        query: selectedText ?? prev.query,
        activeIndex: 0,
      }));
    }

    function onKeyDown(event: KeyboardEvent) {
      if (!activeDocName || isSourceMode || event.defaultPrevented) return;
      // A layer above the editor owns the keyboard. Escape already falls out
      // via `defaultPrevented` above (a dismissable layer cancels it), but the
      // find chords are not cancelled by anything and need this arm.
      if (isOverlayLayerOpen()) return;

      if (matchesKeyboardShortcut(event, 'find')) {
        event.preventDefault();
        if (findState.open) {
          closeFindForEditor(editor, setFindState, setMatchSummary);
        } else {
          openFind(false);
        }
        return;
      }

      if (matchesKeyboardShortcut(event, 'replace')) {
        event.preventDefault();
        openFind(true);
        return;
      }

      if (findState.open) {
        const isFindNext = matchesKeyboardShortcut(event, 'find-next');
        const isFindPrevious = matchesKeyboardShortcut(event, 'find-previous');
        if (isFindNext || isFindPrevious) {
          event.preventDefault();
          const didSelect = isFindPrevious
            ? editor?.commands.selectPreviousFindMatch()
            : editor?.commands.selectNextFindMatch();
          if (didSelect) scrollActiveFindMatchIntoView(editor);
          return;
        }
      }

      if (event.key === 'Escape' && findState.open) {
        event.preventDefault();
        closeFindForEditor(editor, setFindState, setMatchSummary);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeDocName, editor, findState.open, isSourceMode]);

  function applyFindQueryToEditor(): boolean {
    if (!editor || editor.isDestroyed) return false;
    editor.commands.setFindQuery(findState.query, {
      options: {
        caseSensitive: findState.caseSensitive,
        wholeWord: findState.wholeWord,
      },
      activeIndex: activeIndexRef.current,
    });
    return true;
  }

  function syncSummaryFromEditor() {
    if (!editor || editor.isDestroyed) return;
    const pluginState = getFindReplaceState(editor.state);
    const nextSummary = matchSummaryFromEditor(editor);
    setMatchSummary((prev) => (isSameMatchSummary(prev, nextSummary) ? prev : nextSummary));
    setFindState((prev) =>
      prev.activeIndex === pluginState.activeIndex
        ? prev
        : { ...prev, activeIndex: pluginState.activeIndex },
    );
  }

  function closeFind() {
    closeFindForEditor(editor, setFindState, setMatchSummary);
  }

  function selectNext() {
    if (!editor || editor.isDestroyed) return;
    applyFindQueryToEditor();
    const didSelect = editor.commands.selectNextFindMatch();
    if (didSelect) scrollActiveFindMatchIntoView(editor);
    syncSummaryFromEditor();
  }

  function selectPrevious() {
    if (!editor || editor.isDestroyed) return;
    applyFindQueryToEditor();
    const didSelect = editor.commands.selectPreviousFindMatch();
    if (didSelect) scrollActiveFindMatchIntoView(editor);
    syncSummaryFromEditor();
  }

  function replaceCurrent() {
    if (!editor || editor.isDestroyed) return;
    applyFindQueryToEditor();
    const didReplace = editor.commands.replaceCurrentFindMatch(findState.replacement);
    if (didReplace) scrollActiveFindMatchIntoView(editor);
    syncSummaryFromEditor();
  }

  function replaceAll() {
    if (!editor || editor.isDestroyed) return;
    applyFindQueryToEditor();
    const didReplace = editor.commands.replaceAllFindMatches(findState.replacement);
    if (didReplace) scrollActiveFindMatchIntoView(editor);
    syncSummaryFromEditor();
  }

  if (!findState.open || !activeDocName || isSourceMode) return null;

  return (
    <div className="editor-content-aligned pointer-events-none absolute inset-x-0 top-2 z-30 px-2">
      <div className="flex justify-end">
        <FindReplaceBar
          findInputRef={findInputRef}
          query={findState.query}
          replacement={findState.replacement}
          replaceOpen={findState.replaceOpen}
          caseSensitive={findState.caseSensitive}
          wholeWord={findState.wholeWord}
          current={matchSummary.current}
          total={matchSummary.total}
          onQueryChange={(query) => setFindState((prev) => ({ ...prev, query, activeIndex: 0 }))}
          onReplacementChange={(replacement) => setFindState((prev) => ({ ...prev, replacement }))}
          onReplaceOpenChange={(replaceOpen) => setFindState((prev) => ({ ...prev, replaceOpen }))}
          onCaseSensitiveChange={(caseSensitive) =>
            setFindState((prev) => ({ ...prev, caseSensitive }))
          }
          onWholeWordChange={(wholeWord) => setFindState((prev) => ({ ...prev, wholeWord }))}
          onNext={selectNext}
          onPrevious={selectPrevious}
          onReplaceCurrent={replaceCurrent}
          onReplaceAll={replaceAll}
          onClose={closeFind}
        />
      </div>
    </div>
  );
}
