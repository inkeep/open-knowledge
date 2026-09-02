import type { HocuspocusProvider } from '@hocuspocus/provider';
import { Trans, useLingui } from '@lingui/react/macro';
import { Presentation } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { recordSlidesOpened } from '@/lib/slides-telemetry';
import { useBooleanFrontmatterField } from '@/lib/use-boolean-frontmatter-field';
import { useWorkspace } from '@/lib/use-workspace';
import { docNameToRelativePath, joinWorkspacePath } from '@/lib/workspace-paths';

type SlidevAvailability = 'pending' | 'available' | 'unavailable';

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

  if (!isDeck || availability !== 'available') return null;

  async function openAsSlides() {
    const slides = window.okDesktop?.slides;
    if (slides == null || workspace == null) return;
    recordSlidesOpened();
    const docPath = joinWorkspacePath(
      workspace.contentDir,
      docNameToRelativePath(docName),
      workspace.pathSeparator,
    );
    try {
      const result = await slides.open(docPath);
      if (!result.ok) {
        let message: string;
        switch (result.reason) {
          case 'timeout':
            message = t`Slidev timed out while starting. Try again.`;
            break;
          case 'exited-early':
            message = t`Slidev couldn't render this document.`;
            break;
          case 'unsupported-server':
            message = t`This isn't a supported version of Slidev.`;
            break;
          case 'spawn-error':
            message = t`Couldn't start Slidev.`;
            break;
          case 'not-available':
          case 'invalid-path':
            message = t`Couldn't open this document in Slidev.`;
            break;
          default: {
            const _exhaustive: never = result.reason;
            message = t`Couldn't open this document in Slidev.`;
          }
        }
        toast.error(message);
      }
    } catch (err) {
      console.warn('[slides] open dispatch failed:', err instanceof Error ? err : String(err));
      toast.error(t`Couldn't open this document in Slidev.`);
    }
  }

  return (
    <Tooltip>
      <Button
        variant="ghost"
        size="icon"
        onClick={openAsSlides}
        aria-label={t`Open in Slidev`}
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
