import { createContext, type ReactNode, use, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { moveHostPreservingScroll, observeHostScrollRestore } from '@/lib/preserve-subtree-scroll';

const FileListHostContext = createContext<HTMLElement | null>(null);

function createFileListHostElement(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const host = document.createElement('div');
  host.className = 'contents';
  host.setAttribute('data-file-list-host', '');
  return host;
}

export function FileListHostProvider({
  enabled,
  fileList,
  children,
}: {
  readonly enabled: boolean;
  readonly fileList: ReactNode;
  readonly children: ReactNode;
}) {
  const [host] = useState(createFileListHostElement);
  const activeHost = enabled ? host : null;
  return (
    <FileListHostContext value={activeHost}>
      {activeHost != null ? createPortal(fileList, activeHost) : null}
      {children}
    </FileListHostContext>
  );
}

export function useFileListHost(): HTMLElement | null {
  return use(FileListHostContext);
}

export function useAttachFileListHost(host: HTMLElement | null, slot: HTMLElement | null): void {
  useLayoutEffect(() => {
    if (host == null || slot == null) return;
    if (host.parentElement !== slot) moveHostPreservingScroll(host, slot);
    return observeHostScrollRestore(host, slot);
  }, [host, slot]);
}
