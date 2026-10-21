// oxlint-disable ok/no-physical-direction-utility -- pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/lint-plugins/ok-rules/README.md#no-physical-direction-utility

import { REDUCED_CHROME_HEADER_HEIGHT } from '@inkeep/open-knowledge-core/constants/chrome';
import { type CSSProperties, lazy, type ReactNode, Suspense } from 'react';
import { shouldShowAppMenubar } from '@/components/app-menubar-gate';
import { useDocumentContext } from '@/editor/DocumentContext';
import { isNoteWindow } from '@/lib/note-window-mode';
import { useSingleFileMode } from '@/lib/single-file-mode';
import { cn } from '@/lib/utils';
import { EditorBreadcrumb } from './EditorBreadcrumb';

const AppMenubar = lazy(() =>
  import('@/components/AppMenubar').then((m) => ({ default: m.AppMenubar })),
);

interface EditorHeaderProps {
  children?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  noteModeToggle?: ReactNode;
}

interface ReducedChromeZonesProps {
  singleFile: boolean;
  isElectronHost: boolean;
  trailing?: ReactNode;
  noteModeToggle?: ReactNode;
}

function ReducedChromeZones({
  singleFile,
  isElectronHost,
  trailing,
  noteModeToggle,
}: ReducedChromeZonesProps) {
  const { activeDocName } = useDocumentContext();
  const appMenubar = shouldShowAppMenubar() ? (
    <Suspense fallback={null}>
      <AppMenubar />
    </Suspense>
  ) : null;

  return (
    <>
      <div
        data-electron-drag={isElectronHost ? '' : undefined}
        data-editor-header-leading-actions=""
        className={cn(
          'absolute inset-y-0 left-0 z-20 flex max-w-[calc(50%-4rem)] items-center gap-1 overflow-hidden px-3',
          isElectronHost && '[-webkit-app-region:drag] left-[var(--ok-titlebar-reserve-left,1rem)]',
        )}
      >
        {singleFile && appMenubar}
        <EditorBreadcrumb docName={activeDocName} includeCurrentPage />
      </div>

      {noteModeToggle ? (
        <div
          data-note-window-mode-toggle=""
          className="absolute inset-y-0 left-1/2 z-30 flex -translate-x-1/2 items-center [-webkit-app-region:no-drag]"
        >
          {noteModeToggle}
        </div>
      ) : null}

      <div
        data-electron-drag={isElectronHost ? '' : undefined}
        data-editor-header-actions=""
        className={cn(
          'absolute inset-y-0 right-0 z-20 flex items-center justify-end gap-2 ps-3 pe-3',
          isElectronHost &&
            '[-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag] [&_a]:[-webkit-app-region:no-drag]',
          isElectronHost && 'mr-[var(--ok-titlebar-reserve-right,0px)]',
        )}
      >
        {trailing}
      </div>
    </>
  );
}

const TRAILING_WIDTH_CLASS = '@[15rem]/editor-header:[--editor-header-trailing-width:2rem]';

export function EditorHeader({ children, leading, trailing, noteModeToggle }: EditorHeaderProps) {
  const singleFile = useSingleFileMode();
  const noteWindow = isNoteWindow();
  const { activeDocName } = useDocumentContext();
  const reducedChrome = noteWindow;
  const isElectronHost = typeof window !== 'undefined' && window.okDesktop != null;

  return (
    <header
      data-editor-header=""
      data-dock-handle=""
      data-electron-drag={isElectronHost ? '' : undefined}
      style={
        reducedChrome
          ? ({ '--ok-reduced-chrome-header-height': REDUCED_CHROME_HEADER_HEIGHT } as CSSProperties)
          : undefined
      }
      className={cn(
        'relative flex shrink-0 items-center @container/editor-header',
        reducedChrome ? 'h-[var(--ok-reduced-chrome-header-height)]' : 'h-11',
        'bg-background',
        isElectronHost && '[-webkit-app-region:drag]',
      )}
    >
      <div
        data-electron-drag={isElectronHost ? '' : undefined}
        data-editor-header-tabs=""
        className={cn(
          'flex h-full min-w-0 w-[var(--editor-header-tabs-width,100%)] overflow-hidden',
          isElectronHost && '[-webkit-app-region:drag]',
          !reducedChrome && trailing != null && TRAILING_WIDTH_CLASS,
        )}
      >
        {reducedChrome || leading == null ? null : (
          <div
            data-editor-header-leading=""
            className="hidden shrink-0 items-center ps-1 @[15rem]/editor-header:flex"
          >
            {leading}
          </div>
        )}
        {singleFile ? (
          <div className="flex min-w-0 items-center px-3">
            <EditorBreadcrumb docName={activeDocName} includeCurrentPage />
          </div>
        ) : (
          children
        )}
      </div>

      {reducedChrome || trailing == null ? null : (
        <div
          data-editor-header-trailing=""
          data-electron-drag={isElectronHost ? '' : undefined}
          className={cn(
            'absolute inset-y-0 end-0 z-10 hidden items-center @[15rem]/editor-header:flex',
            isElectronHost &&
              '[-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag] [&_a]:[-webkit-app-region:no-drag]',
          )}
        >
          {trailing}
        </div>
      )}

      {reducedChrome && (
        <ReducedChromeZones
          singleFile={singleFile}
          isElectronHost={isElectronHost}
          trailing={trailing}
          noteModeToggle={noteModeToggle}
        />
      )}
    </header>
  );
}
