import { createContext, type ReactNode, use, useEffect, useState } from 'react';
import { fetchApiConfig } from '@/lib/api-config';
import '@/lib/desktop-bridge-types';

const SingleFileModeContext = createContext<boolean>(false);

export function SingleFileModeProvider({ children }: { children: ReactNode }) {
  const [singleFile, setSingleFile] = useState<boolean>(() =>
    typeof window !== 'undefined' ? (window.okDesktop?.config.singleFile ?? false) : false,
  );

  useEffect(() => {
    if (window.okDesktop) return;

    const controller = new AbortController();
    void fetchApiConfig(controller.signal)
      .then((result) => {
        if (controller.signal.aborted || result.status !== 'ok') return;
        setSingleFile(result.config.singleFile);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  return <SingleFileModeContext value={singleFile}>{children}</SingleFileModeContext>;
}

export function useSingleFileMode(): boolean {
  return use(SingleFileModeContext);
}
