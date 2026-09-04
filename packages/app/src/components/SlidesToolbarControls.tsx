import type { HocuspocusProvider } from '@hocuspocus/provider';
import { Trans, useLingui } from '@lingui/react/macro';
import { Presentation } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { OkSlidesOpenResult } from '@/lib/desktop-bridge-types';
import { recordSlidesOpened } from '@/lib/slides-telemetry';
import { useBooleanFrontmatterField } from '@/lib/use-boolean-frontmatter-field';
import { useWorkspace } from '@/lib/use-workspace';
import { docNameToRelativePath, joinWorkspacePath } from '@/lib/workspace-paths';

type SlidevAvailability = 'pending' | 'available' | 'unavailable';

interface SlidesOpenCopy {
  readonly opening: string;
  readonly timeout: string;
  readonly renderFailed: string;
  readonly openFailed: string;
  readonly unsupported: string;
  readonly startFailed: string;
  readonly retry: string;
}

async function openSlidesDeck(
  slides: { open(docPath: string): Promise<OkSlidesOpenResult> },
  docPath: string,
  copy: SlidesOpenCopy,
  retry: () => void,
): Promise<void> {
  const toastId = toast.loading(copy.opening, { duration: Number.POSITIVE_INFINITY });
  try {
    const result = await slides.open(docPath);
    if (result.ok) {
      toast.dismiss(toastId);
      return;
    }
    if (result.reason === 'cancelled') {
      toast.dismiss(toastId);
      return;
    }
    let message: string;
    let retryable = false;
    switch (result.reason) {
      case 'timeout':
        message = copy.timeout;
        retryable = true;
        break;
      case 'exited-early':
      case 'renderer-failed':
        message = copy.renderFailed;
        retryable = true;
        break;
      case 'load-failed':
        message = copy.openFailed;
        retryable = true;
        break;
      case 'unsupported-server':
        message = copy.unsupported;
        break;
      case 'spawn-error':
        message = copy.startFailed;
        retryable = true;
        break;
      case 'not-available':
      case 'invalid-path':
        message = copy.openFailed;
        break;
      default: {
        const _exhaustive: never = result.reason;
        message = copy.openFailed;
      }
    }
    toast.error(message, {
      id: toastId,
      ...(retryable ? { action: { label: copy.retry, onClick: retry } } : {}),
    });
  } catch (err) {
    console.warn('[slides] open dispatch failed:', err instanceof Error ? err : String(err));
    toast.error(copy.openFailed, {
      id: toastId,
      action: { label: copy.retry, onClick: retry },
    });
  }
}

async function runOpenAttempt(
  slides: { open(docPath: string): Promise<OkSlidesOpenResult> },
  docPath: string,
  copy: SlidesOpenCopy,
  openingPathsRef: { current: Set<string> },
  setOpeningPaths: (paths: ReadonlySet<string>) => void,
  recordActivation: boolean,
): Promise<void> {
  if (openingPathsRef.current.has(docPath)) return;
  openingPathsRef.current.add(docPath);
  try {
    setOpeningPaths(new Set(openingPathsRef.current));
    if (recordActivation) recordSlidesOpened();
    await openSlidesDeck(slides, docPath, copy, () => {
      void runOpenAttempt(slides, docPath, copy, openingPathsRef, setOpeningPaths, false);
    });
  } finally {
    openingPathsRef.current.delete(docPath);
    setOpeningPaths(new Set(openingPathsRef.current));
  }
}

function useSlidevAvailability(isDeck: boolean): SlidevAvailability {
  const [availability, setAvailability] = useState<SlidevAvailability>('pending');
  useEffect(() => {
    if (!isDeck) return;
    let active = true;
    const MIN_REPROBE_INTERVAL_MS = 10_000;
    let lastProbeAt = 0;
    let resolved = false;
    const probe = () => {
      lastProbeAt = Date.now();
      const slides = window.okDesktop?.slides;
      if (slides == null) {
        setAvailability('unavailable');
        return;
      }
      slides
        .status()
        .then((result) => {
          if (!active) return;
          setAvailability(result.available ? 'available' : 'unavailable');
          if (result.available) resolved = true;
        })
        .catch((err: unknown) => {
          console.warn(
            '[slides] availability probe failed:',
            err instanceof Error ? err : String(err),
          );
          if (active) setAvailability('unavailable');
        });
    };
    const probeOnFocus = () => {
      if (resolved) return;
      if (Date.now() - lastProbeAt < MIN_REPROBE_INTERVAL_MS) return;
      probe();
    };
    probe();
    window.addEventListener('focus', probeOnFocus);
    return () => {
      active = false;
      window.removeEventListener('focus', probeOnFocus);
    };
  }, [isDeck]);
  return availability;
}

export function SlidesToolbarControls({
  provider,
  docName,
}: {
  provider: HocuspocusProvider;
  docName: string;
}) {
  const { t } = useLingui();
  const isDeck = useBooleanFrontmatterField(provider, 'slides');
  const availability = useSlidevAvailability(isDeck);
  const workspace = useWorkspace();
  const openingPathsRef = useRef(new Set<string>());
  const [openingPaths, setOpeningPaths] = useState<ReadonlySet<string>>(() => new Set());

  if (!isDeck || availability !== 'available') return null;

  const docPath =
    workspace == null
      ? null
      : joinWorkspacePath(
          workspace.contentDir,
          docNameToRelativePath(docName),
          workspace.pathSeparator,
        );

  async function openAsSlides() {
    const slides = window.okDesktop?.slides;
    if (slides == null || docPath == null) return;
    await runOpenAttempt(
      slides,
      docPath,
      {
        opening: t`Opening...`,
        timeout: t`Slidev timed out while starting. Try again.`,
        renderFailed: t`Slidev couldn't render this document.`,
        openFailed: t`Couldn't open this document in Slidev.`,
        unsupported: t`This isn't a supported version of Slidev.`,
        startFailed: t`Couldn't start Slidev.`,
        retry: t`Try again`,
      },
      openingPathsRef,
      setOpeningPaths,
      true,
    );
  }

  return (
    <Tooltip>
      <Button
        variant="ghost"
        size="icon"
        onClick={openAsSlides}
        aria-label={t`Open in Slidev`}
        aria-busy={docPath != null && openingPaths.has(docPath)}
        data-testid="slides-toolbar-action"
        asChild
      >
        <TooltipTrigger>
          <Presentation aria-hidden />
        </TooltipTrigger>
      </Button>
      <TooltipContent side="bottom">
        <Trans>Open in Slidev</Trans>
      </TooltipContent>
    </Tooltip>
  );
}
