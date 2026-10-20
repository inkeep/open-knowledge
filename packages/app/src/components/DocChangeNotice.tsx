import type { DocNoticeWire } from '@inkeep/open-knowledge-core/schemas/api';
import { Trans, useLingui } from '@lingui/react/macro';
import { History, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { requestDocPanelTab } from '@/components/doc-panel-events';
import { SkillModeBanner } from '@/components/SkillModeBanner';
import { Button } from '@/components/ui/button';
import { useDocNotice } from '@/hooks/use-doc-notices';
import { useSingleFileMode } from '@/lib/single-file-mode';

const announcedNoticeIds = new Set<string>();

const EDITOR_FOCUS_TARGETS = ['[contenteditable="true"]', '.cm-content'] as const;

function NoticeMessage({
  notice,
  canOpenTimeline,
}: {
  notice: DocNoticeWire;
  canOpenTimeline: boolean;
}) {
  const fileName = (
    <span translate="no" className="font-medium text-foreground">
      {notice.file.split('/').pop() ?? notice.file}
    </span>
  );
  if (notice.kind === 'both-kept') {
    if (notice.kept.duplicated > 0) {
      return (
        <Trans>
          Both versions were kept in {fileName}. It changed outside OpenKnowledge in the same place
          as here, so the outside version is directly under this one.
        </Trans>
      );
    }
    if (notice.entries.length === 0) {
      return (
        <Trans>
          A deletion in {fileName} was undone because the same text was changed on the other side.
        </Trans>
      );
    }
    return canOpenTimeline ? (
      <Trans>
        A deletion in {fileName} was undone because the same text was changed on the other side. The
        earlier versions are in the timeline.
      </Trans>
    ) : (
      <Trans>
        A deletion in {fileName} was undone because the same text was changed on the other side. The
        earlier versions were saved to the document's history.
      </Trans>
    );
  }
  if (notice.side === 'theirs') {
    return canOpenTimeline ? (
      <Trans>
        An outside change to {fileName} could not be merged, so this version stayed. The outside
        version is in the timeline.
      </Trans>
    ) : (
      <Trans>
        An outside change to {fileName} could not be merged, so this version stayed. The outside
        version was saved to the document's history.
      </Trans>
    );
  }
  return canOpenTimeline ? (
    <Trans>
      Edits to {fileName} kept from the last time this branch was open could not be merged, so the
      file's version stayed. Those edits are in the timeline.
    </Trans>
  ) : (
    <Trans>
      Edits to {fileName} kept from the last time this branch was open could not be merged, so the
      file's version stayed. Those edits were saved to the document's history.
    </Trans>
  );
}

function focusEditorWithin(scope: HTMLElement | null): void {
  if (scope === null) return;
  for (const selector of EDITOR_FOCUS_TARGETS) {
    for (const target of scope.querySelectorAll<HTMLElement>(selector)) {
      target.focus();
      if (document.activeElement === target) return;
    }
  }
  scope.closest<HTMLElement>('[data-editor-region]')?.focus();
}

export function DocChangeNotice({
  docName,
  timelineAvailable,
}: {
  docName: string;
  timelineAvailable: boolean;
}) {
  const { t } = useLingui();
  const { notice, dismiss } = useDocNotice(docName);
  const singleFile = useSingleFileMode();
  const sectionRef = useRef<HTMLElement>(null);
  const messageRef = useRef<HTMLSpanElement>(null);
  const [announcement, setAnnouncement] = useState('');
  const canOpenTimeline = timelineAvailable && !singleFile;

  const noticeId = notice?.id ?? null;
  useEffect(() => {
    if (noticeId === null || announcedNoticeIds.has(noticeId)) return;
    announcedNoticeIds.add(noticeId);
    setAnnouncement(messageRef.current?.textContent ?? '');
  }, [noticeId]);

  function handleDismiss() {
    if (notice === null) return;
    const hadFocus = sectionRef.current?.contains(document.activeElement) ?? false;
    const scope = sectionRef.current?.parentElement ?? null;
    dismiss(notice);
    if (hadFocus) requestAnimationFrame(() => focusEditorWithin(scope));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.stopPropagation();
    handleDismiss();
  }

  return (
    <>
      <span role="status" className="sr-only">
        {announcement}
      </span>
      {notice === null ? null : (
        <section
          ref={sectionRef}
          aria-label={t`File change notice`}
          data-testid="doc-change-notice"
          onKeyDown={handleKeyDown}
          className="shrink-0"
        >
          <SkillModeBanner
            icon={<History className="size-4" aria-hidden />}
            clampLines={false}
            actions={
              <>
                {canOpenTimeline && notice.entries.length > 0 ? (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto px-1"
                    onClick={() => requestDocPanelTab('timeline', { focus: 'panel' })}
                  >
                    {t`Open timeline`}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground"
                  aria-label={t`Dismiss notice`}
                  onClick={handleDismiss}
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              </>
            }
          >
            <span ref={messageRef}>
              <NoticeMessage notice={notice} canOpenTimeline={canOpenTimeline} />
            </span>
          </SkillModeBanner>
        </section>
      )}
    </>
  );
}
