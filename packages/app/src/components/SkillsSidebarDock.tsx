import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronRight, Compass, SquarePen } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { AddSkillTab } from '@/components/ImportSkillDialog';
import { SidebarToolbarButton } from '@/components/SidebarToolbarButton';
import { SkillsSidebarSection } from '@/components/SkillsSidebarSection';
import {
  clampSkillsDockHeight,
  readSkillsDockExpanded,
  readSkillsDockHeight,
  SKILLS_DOCK_MIN_HEIGHT,
  skillsDockMaxHeight,
  subscribeSkillsDockExpanded,
  writeSkillsDockExpanded,
  writeSkillsDockHeight,
} from '@/components/skills-dock-expanded-store';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useCreateBlankSkill } from '@/hooks/use-create-blank-skill';
import { useOpenSkill } from '@/hooks/use-open-skill';
import { cn } from '@/lib/utils';

// Same lazy add-skill modal the section and the empty state use, so opening it
// from here reuses the already-loaded chunk instead of shipping a second copy.
const ImportSkillDialog = lazy(() =>
  import('@/components/ImportSkillDialog').then((m) => ({ default: m.ImportSkillDialog })),
);

/** Keyboard resize step. One arrow press moves about a row and a half — coarse
 *  enough to cross the panel without holding the key, fine enough to land. */
const RESIZE_STEP = 32;
/** Fallback when the content box cannot be measured (never mounted / hidden). */
// Dragging this far below the minimum reads as "close it", not "make it small":
// the clamp pins the dock at MIN while the pointer keeps going, so without a
// slack band there is no way to collapse by dragging at all — the gesture every
// bottom panel teaches. Release inside the band collapses; the chevron reopens.
const COLLAPSE_DRAG_SLACK = 40;

/**
 * The Skills dock: a collapsible section pinned flush to the bottom of the
 * sidebar, below the file tree rather than instead of it. Collapsed it is one
 * header row; expanded it takes a capped slice with its own scroll, so the file
 * tree above never loses its whole body to it.
 *
 * The toolbar is hover-revealed, matching how a collapsed section behaves in
 * Cursor / VS Code: at rest the row reads as a rail, which is what keeps it
 * cheap to leave open. It stays in the DOM (opacity, not conditional render) so
 * keyboard users reach it in tab order and `focus-within` pins it visible.
 */
export function SkillsSidebarDock({ filesOpen = true }: { filesOpen?: boolean } = {}) {
  const { t } = useLingui();
  // Read once for the initial value; the store is the cross-reload memory.
  const [expanded, setExpanded] = useState(readSkillsDockExpanded);
  // The DRAGGED height, or null for "never dragged" — the only thing that may
  // drive `style`. `measured` is what the panel currently happens to be, which
  // is a different question and answers only the resize handle's `aria-valuenow`.
  const [height, setHeight] = useState(readSkillsDockHeight);
  const [measured, setMeasured] = useState<number | null>(null);
  const [addTab, setAddTab] = useState<AddSkillTab | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const { createBlank } = useCreateBlankSkill();
  const openSkill = useOpenSkill();

  // The command palette and an unresolved `/skill-name` link reveal the dock
  // through the store, so mirror external writes back into local state.
  useEffect(() => subscribeSkillsDockExpanded(setExpanded), []);

  // A dock that has never been dragged renders at a viewport fraction, which is
  // a height nobody has in a number — and the handle has to report one. Observe
  // it instead of adopting it.
  //
  // Adopting was the bug behind "Skills Studio shows nothing". The measurement
  // ran on the commit that flipped the dock open, which is always BEFORE
  // `/api/skills` resolves — so it measured an empty box: 16px of group
  // padding. The only guard was `measured > 0`, so 16 was adopted, below the
  // panel's own 96px floor (the clamp applied to drags, never to this). A
  // non-null height then switched the content off `maxHeight: 45vh` onto a
  // fixed `height: 16px`, and nothing ever re-measured — so when the skills
  // landed, all of them scrolled inside a 16px strip for the rest of the
  // session. Reported as missing skills, because that is what it looks like.
  //
  // This value therefore feeds `aria-valuenow` and nothing else — never
  // `style`. A dock nobody has dragged keeps tracking the cap, which is what
  // the style comment below already promised, and the observer keeps the
  // reported number true across a window resize too — which the one-shot
  // measurement never did.
  const heightRef = useRef(height);
  useEffect(() => {
    heightRef.current = height;
  });
  useEffect(() => {
    const el = contentRef.current;
    if (!expanded || el === null) return;
    const observer = new ResizeObserver(() => {
      // A dragged height IS the reported value, so observing is pure waste then
      // — during a drag this fires per frame, each write re-rendering for a
      // byte-identical output. Read through a ref: `height` in the deps would
      // rebuild the observer on every one of those frames instead.
      if (heightRef.current !== null) return;
      const next = el.getBoundingClientRect().height;
      if (next > 0) setMeasured(Math.round(next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded]);

  /**
   * Resize by pointer, tracked on `window` rather than the handle: the pointer
   * leaves a 4px strip immediately on any real drag, and a handle-local listener
   * would drop the gesture the moment it did.
   */
  const resizeBy = (delta: number, from: number) => {
    const next = clampSkillsDockHeight(from + delta, window.innerHeight);
    setHeight(next);
    return next;
  };
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const collapseFromResize = (
    heightBeforeDrag: number | null,
    opts: { restoreFocus?: boolean } = {},
  ) => {
    // The clamp already dragged the live height to MIN — put it back so the
    // next expand restores the size the user actually chose, not the artifact
    // of the collapsing gesture. Nothing is persisted for the same reason.
    setHeight(heightBeforeDrag);
    setExpanded(false);
    writeSkillsDockExpanded(false);
    // The resize handle only exists while the dock is open, so a KEYBOARD
    // collapse unmounts the element that held focus — without a handoff the
    // focus falls to <body> and the keyboard user is stranded. The header
    // trigger stays mounted and is the natural next stop (it reopens).
    if (opts.restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    // Only the primary button drags; a right-click here should reach the row's
    // own context menu rather than starting a gesture that never ends.
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight =
      contentRef.current?.getBoundingClientRect().height ?? SKILLS_DOCK_MIN_HEIGHT;
    const heightBeforeDrag = height;
    let latest = startHeight;
    // The UNCLAMPED request — the clamp pins `latest` at MIN, so only this can
    // tell "resting at the minimum" apart from "trying to drag it closed".
    let raw = startHeight;
    // Dragging UP grows the dock, so the delta is inverted.
    const onMove = (e: PointerEvent) => {
      raw = startHeight + (startY - e.clientY);
      latest = resizeBy(startY - e.clientY, startHeight);
    };
    // `pointercancel` as well as `pointerup`: the OS takes the pointer away on a
    // touch turning into a scroll, a window losing focus mid-drag, or a device
    // disconnect, and only the cancel event fires then. Ending on `pointerup`
    // alone leaves the move listener attached for the life of the page — every
    // later mouse move keeps resizing a panel nobody is dragging.
    const end = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (raw < SKILLS_DOCK_MIN_HEIGHT - COLLAPSE_DRAG_SLACK) {
        collapseFromResize(heightBeforeDrag);
        return;
      }
      writeSkillsDockHeight(latest);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  return (
    <Collapsible
      open={expanded}
      onOpenChange={(open) => {
        setExpanded(open);
        writeSkillsDockExpanded(open);
      }}
      // Takes the slack when it is the only section left open. The stack was
      // built so Files holds the slack and Skills sits under it, on the premise
      // that a collapsed Files leaves the gap below both — but a section stack
      // gives the space to whoever is still open, and leaving it empty renders
      // as a dock clipped mid-row with a blank half-sidebar underneath it.
      className={cn(
        'group/skills-dock flex min-h-0 flex-col',
        // Same predicate as the content below — a dragged height pins the
        // content, and a root that still grew would extend the dock's box past
        // its own rows.
        expanded && !filesOpen ? 'flex-1' : 'shrink-0',
      )}
      data-testid="skills-dock"
    >
      {expanded && filesOpen ? (
        // Separator, not a button: it has a value along one axis, which is what
        // lets arrow keys drive it for anyone who cannot drag. Straddles the
        // seam so the whole seam is the target, and only exists while the dock
        // is open AND Files is open — with Files collapsed the dock fills, so
        // there is no size to negotiate: a live handle there persisted heights
        // that could not bind and its ARIA reported a value nothing used. The
        // header trigger still collapses the dock in that state.
        // biome-ignore lint/a11y/useSemanticElements: the suggested <hr> is a thematic break — a non-interactive, unfocusable element with no value. This separator is a focusable window splitter that reports and changes a size.
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t`Resize skills panel`}
          aria-valuenow={Math.max(SKILLS_DOCK_MIN_HEIGHT, height ?? measured ?? 0)}
          aria-valuemin={SKILLS_DOCK_MIN_HEIGHT}
          aria-valuemax={
            typeof window === 'undefined' ? undefined : skillsDockMaxHeight(window.innerHeight)
          }
          tabIndex={0}
          data-testid="skills-dock-resize"
          className="-mt-1 h-2 shrink-0 cursor-row-resize focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring [-webkit-app-region:no-drag]"
          onPointerDown={startResize}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            const from =
              contentRef.current?.getBoundingClientRect().height ?? SKILLS_DOCK_MIN_HEIGHT;
            // Keyboard parity with drag-to-collapse: shrinking a dock already
            // at its minimum collapses it instead of doing nothing.
            if (e.key === 'ArrowDown' && from <= SKILLS_DOCK_MIN_HEIGHT) {
              collapseFromResize(height, { restoreFocus: true });
              return;
            }
            writeSkillsDockHeight(resizeBy(e.key === 'ArrowUp' ? RESIZE_STEP : -RESIZE_STEP, from));
          }}
        />
      ) : null}
      <div className="flex items-center gap-1 px-2 py-1.5">
        <CollapsibleTrigger
          ref={triggerRef}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className="size-4 shrink-0 text-tree-muted transition-transform group-data-[state=open]/skills-dock:rotate-90 motion-reduce:transition-none" />
          <span className="truncate text-sm font-normal">
            <Trans>Skills Studio</Trans>
          </span>
        </CollapsibleTrigger>
        {/* biome-ignore lint/a11y/useSemanticElements: same call as the Files toolbar above — a toolbar cluster is not a form-control set. */}
        <div
          role="group"
          aria-label={t`Skills toolbar`}
          data-testid="skills-dock-toolbar"
          className="flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/skills-dock:opacity-100 group-hover/skills-dock:opacity-100 motion-reduce:transition-none [&>*]:[-webkit-app-region:no-drag]"
        >
          <DockAction
            icon={SquarePen}
            label={t`New skill`}
            onClick={() => {
              setExpanded(true);
              writeSkillsDockExpanded(true);
              void createBlank('project');
            }}
            testId="skills-dock-new"
          />
          <DockAction
            icon={Compass}
            label={t`Explore skills`}
            onClick={() => setAddTab('skills-sh')}
            testId="skills-dock-explore"
          />
        </div>
      </div>
      {/* Capped so the file tree above always keeps a usable body, and scrolled
          internally so a long skill list never pushes the dock off-screen. Until
          the handle is dragged the cap IS the size, so the dock tracks the
          viewport; a dragged height replaces it and the cap becomes the ceiling
          the drag was already clamped to. */}
      <CollapsibleContent
        ref={contentRef}
        className={cn(
          'overflow-auto subtle-scrollbar',
          // The cap protects the file tree's body. With Files collapsed there
          // is no body to protect, so the dock fills — INCLUDING over a dragged
          // height. A size dragged while Files was open binds only while Files
          // is open: honoring it against an otherwise-empty sidebar renders a
          // clipped tree above a dead black band, which reads as broken, not
          // as a chosen size. Reopen Files and the chosen height is back.
          !filesOpen ? 'min-h-0 flex-1' : 'data-[state=open]:max-h-[70vh]',
        )}
        style={!filesOpen ? undefined : height !== null ? { height } : { maxHeight: '45vh' }}
      >
        <SkillsSidebarSection dockExpanded={expanded} />
      </CollapsibleContent>
      {addTab !== null ? (
        <Suspense fallback={null}>
          <ImportSkillDialog
            defaultScope="project"
            defaultTab={addTab}
            open
            onOpenChange={(open) => {
              if (!open) setAddTab(null);
            }}
            onImported={({ scope, name }) => {
              setAddTab(null);
              openSkill(scope, name);
            }}
          />
        </Suspense>
      ) : null}
    </Collapsible>
  );
}

function DockAction({
  icon,
  label,
  onClick,
  testId,
}: {
  icon: typeof SquarePen;
  label: string;
  onClick: () => void;
  testId: string;
}) {
  // The Files toolbar's control, verbatim — the dock growing its own size-6
  // variant is exactly what SidebarToolbarButton exists to prevent.
  return <SidebarToolbarButton icon={icon} label={label} onClick={onClick} data-testid={testId} />;
}
