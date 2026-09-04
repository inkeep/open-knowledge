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

const ImportSkillDialog = lazy(() =>
  import('@/components/ImportSkillDialog').then((m) => ({ default: m.ImportSkillDialog })),
);

const RESIZE_STEP = 32;
const COLLAPSE_DRAG_SLACK = 40;

export function SkillsSidebarDock({ filesOpen = true }: { filesOpen?: boolean } = {}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(readSkillsDockExpanded);
  const [height, setHeight] = useState(readSkillsDockHeight);
  const [measured, setMeasured] = useState<number | null>(null);
  const [addTab, setAddTab] = useState<AddSkillTab | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const { createBlank } = useCreateBlankSkill();
  const openSkill = useOpenSkill();

  useEffect(() => subscribeSkillsDockExpanded(setExpanded), []);

  const heightRef = useRef(height);
  useEffect(() => {
    heightRef.current = height;
  });
  useEffect(() => {
    const el = contentRef.current;
    if (!expanded || el === null) return;
    const observer = new ResizeObserver(() => {
      if (heightRef.current !== null) return;
      const next = el.getBoundingClientRect().height;
      if (next > 0) setMeasured(Math.round(next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded]);

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
    setHeight(heightBeforeDrag);
    setExpanded(false);
    writeSkillsDockExpanded(false);
    if (opts.restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight =
      contentRef.current?.getBoundingClientRect().height ?? SKILLS_DOCK_MIN_HEIGHT;
    const heightBeforeDrag = height;
    let latest = startHeight;
    let raw = startHeight;
    const onMove = (e: PointerEvent) => {
      raw = startHeight + (startY - e.clientY);
      latest = resizeBy(startY - e.clientY, startHeight);
    };
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
      className={cn(
        'group/skills-dock flex min-h-0 flex-col',
        expanded && !filesOpen ? 'flex-1' : 'shrink-0',
      )}
      data-testid="skills-dock"
    >
      {expanded && filesOpen ? (
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
      {}
      <CollapsibleContent
        ref={contentRef}
        className={cn(
          'overflow-auto subtle-scrollbar',
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
  return <SidebarToolbarButton icon={icon} label={label} onClick={onClick} data-testid={testId} />;
}
