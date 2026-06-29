
import type { Editor } from '@tiptap/core';
import { createContext, type ReactNode, use } from 'react';

interface JsxComponentHost {
  editor: Editor;
  getPos: () => number | undefined;
  addChild: (() => void) | null;
}

const JsxComponentHostContext = createContext<JsxComponentHost | null>(null);

export function JsxComponentHostProvider({
  value,
  children,
}: {
  value: JsxComponentHost | null;
  children: ReactNode;
}) {
  return (
    <JsxComponentHostContext.Provider value={value}>{children}</JsxComponentHostContext.Provider>
  );
}

export function useJsxComponentHost(): JsxComponentHost | null {
  return use(JsxComponentHostContext);
}
