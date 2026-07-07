import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronDown, File, Folder, Hexagon } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { OkScaffoldPlan, OkSeedPackInfo } from '@/lib/desktop-bridge-types';
import { skillDisplayName } from '@/lib/skill-scope';
import { cn } from '@/lib/utils';

interface CreatedItem {
  kind: 'folder' | 'file';
  name: string;
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * A top-level folder to preview as a card. `templateCount` is the number of
 * starter/extra templates the plan installs into `<folder>/.ok/templates/`.
 */
interface FolderCard {
  path: string;
  summary: string;
  templateCount: number;
}

/**
 * One card per pack folder actually being scaffolded. `templateCount` is the
 * number of templates the plan installs into that folder's `.ok/templates/`.
 * Derived from the plan we already fetched — no second round-trip — and honest
 * about re-scaffold: a fully-present folder (all in `skipped`) drops out.
 */
function describeFolderCards(
  plan: OkScaffoldPlan,
  selectedPack: OkSeedPackInfo | undefined,
): FolderCard[] {
  const folders: FolderCard[] = [];
  for (const folder of selectedPack?.folders ?? []) {
    // Match the `<path>/.ok/templates/` segment at a path boundary (start, or
    // after a `/`) so root-mode and subfolder-mode (`brain/external-sources/…`)
    // share one lookup without a bare `includes` false-matching a folder whose
    // name is a suffix of another (`notes` vs `keynotes`).
    const templatesNeedle = `${folder.path}/.ok/templates/`;
    const templateCount = plan.created.filter(
      (e) =>
        e.kind === 'file' &&
        (e.path.startsWith(templatesNeedle) || e.path.includes(`/${templatesNeedle}`)),
    ).length;
    // A folder whose directory is being created OR whose templates are being
    // (re)installed is in-scope; one that's fully present (all in `skipped`)
    // isn't part of "what gets created", so it drops out.
    const folderCreated = plan.created.some(
      (e) => e.kind === 'folder' && (e.path === folder.path || e.path.endsWith(`/${folder.path}`)),
    );
    if (templateCount > 0 || folderCreated) {
      folders.push({ path: folder.path, summary: folder.summary, templateCount });
    }
  }
  return folders;
}

/**
 * Top-level content files the user will actually see in the sidebar — the
 * pack's `rootFiles` (`log.md`, `USER.md`, `HEARTBEAT.md`, …). Excludes every
 * `.ok/` path (templates + frontmatter), which never surface as files.
 */
function describeFileCards(plan: OkScaffoldPlan): Array<{ path: string; name: string }> {
  return plan.created
    .filter((e) => e.kind === 'file' && !e.path.split('/').includes('.ok'))
    .map((e) => ({ path: e.path, name: basename(e.path) }));
}

/**
 * Renders `plan.created` as a card grid — folder / file / skill cards, each led
 * by its type icon (no badge; the icon plus the folder trailing-slash carry the
 * type). The summary line breaks the plan into the counts a user can actually
 * observe in the app — folders, files, skill, templates — keeping templates
 * distinct from files. The full nested layout lives behind a "Files & folders"
 * disclosure; the folder cards above carry the human-readable summaries.
 */
export function CreatedItemsList({
  plan,
  selectedPack,
}: {
  plan: OkScaffoldPlan;
  selectedPack: OkSeedPackInfo | undefined;
}) {
  const { t } = useLingui();
  const [treeOpen, setTreeOpen] = useState(false);
  const folders = describeFolderCards(plan, selectedPack);
  const files = describeFileCards(plan);
  const skill = plan.packSkill?.pending ? plan.packSkill : undefined;
  // Derive the counts straight from the cards so the summary line always
  // matches what's rendered. Counting `plan.created` directly diverged in
  // subfolder mode, where the plan also creates the parent folder (e.g.
  // `brain/`) — a real folder entry with no card, which read as one extra.
  const folderCount = folders.length;
  const fileCount = files.length;
  const templateCount = folders.reduce((sum, f) => sum + f.templateCount, 0);
  const skillCount = skill ? 1 : 0;

  // One-line blurbs for the reserved root files, grounded in each file's
  // frontmatter `description` (authored in `packs`' `rootFiles`, server-side).
  // Kept as a client lookup rather than plumbed through the pack wire (a
  // drift-guarded three-way mirror); unmapped files simply render name-only.
  const fileDescriptions: Record<string, string> = {
    'log.md': t`Append-only log of what changed.`,
    'USER.md': t`Who you are, so the agent has your context.`,
    'SOUL.md': t`The agent's persona, values, and voice.`,
    'ACCESS_POLICY.md': t`What the agent may read, write, and surface.`,
    'HEARTBEAT.md': t`When the agent runs its scheduled work.`,
    'OVERVIEW.md': t`Home page and navigation hub.`,
    'welcome.md': t`Start here: what this is and how it's organized.`,
    'index.md': t`Home page and entry point.`,
  };

  // Only surface non-zero buckets; a skill-only re-install creates 0
  // folders/files/templates (the skill isn't any of those — it lands in the
  // Skills sidebar), so its count carries the summary on its own. Skill trails
  // the sidebar-visible counts.
  // Number + label are separate spans so the count reads darker than its
  // (lighter) noun. Plural picks the noun form without the number (`#`); the
  // number is rendered on its own beside it.
  const counts = [
    folderCount > 0
      ? {
          key: 'folders',
          n: folderCount,
          label: t`${plural(folderCount, { one: 'folder', other: 'folders' })}`,
        }
      : null,
    fileCount > 0
      ? {
          key: 'files',
          n: fileCount,
          label: t`${plural(fileCount, { one: 'file', other: 'files' })}`,
        }
      : null,
    templateCount > 0
      ? {
          key: 'templates',
          n: templateCount,
          label: t`${plural(templateCount, { one: 'template', other: 'templates' })}`,
        }
      : null,
    skillCount > 0
      ? {
          key: 'skills',
          n: skillCount,
          label: t`${plural(skillCount, { one: 'skill', other: 'skills' })}`,
        }
      : null,
  ].filter((c): c is { key: string; n: number; label: string } => c !== null);

  return (
    <section className="@container/created space-y-2.5">
      <div className="flex flex-wrap justify-between items-baseline gap-x-2 gap-y-0.5">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase font-mono tracking-wider text-primary">
          <span aria-hidden="true" className="flex items-center justify-center">
            ◇
          </span>
          <Trans>What gets created</Trans>
        </h3>
        {counts.length > 0 ? (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
            {counts.map((c, i) => (
              <Fragment key={c.key}>
                {i > 0 ? (
                  <span aria-hidden="true" className="text-muted-foreground/50">
                    ·
                  </span>
                ) : null}
                <span>
                  <span className="text-foreground/80">{c.n}</span>{' '}
                  <span className="text-muted-foreground/80">{c.label}</span>
                </span>
              </Fragment>
            ))}
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 @sm/created:grid-cols-2 @2xl/created:grid-cols-3">
        {folders.map((folder) => (
          <div
            key={folder.path}
            className="flex h-full min-w-0 flex-col gap-1.5 rounded-xl border border-border/60 bg-card p-3.5"
          >
            <div className="flex min-w-0 items-center gap-2">
              <Folder aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
              <code className="min-w-0 truncate font-mono text-1sm font-medium text-foreground/90">
                {basename(folder.path)}/
              </code>
              <span className="ml-auto shrink-0 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                {t`${plural(folder.templateCount, { one: '# template', other: '# templates' })}`}
              </span>
            </div>
            {folder.summary ? (
              <p className="text-1sm leading-relaxed text-muted-foreground">{folder.summary}</p>
            ) : null}
          </div>
        ))}

        {files.map((file) => {
          const description = fileDescriptions[file.name];
          return (
            <div
              key={file.path}
              className="flex h-full min-w-0 flex-col gap-1.5 rounded-xl border border-border/60 bg-card p-3.5"
            >
              <div className="flex min-w-0 items-center gap-2">
                <File aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                <code
                  className="min-w-0 truncate font-mono text-1sm font-medium text-foreground/90"
                  title={file.name}
                >
                  {file.name}
                </code>
              </div>
              {description ? (
                <p className="text-1sm leading-relaxed text-muted-foreground">{description}</p>
              ) : null}
            </div>
          );
        })}

        {skill ? (
          <div className="flex h-full min-w-0 flex-col gap-1.5 rounded-xl border border-border/60 bg-card p-3.5">
            <div className="flex min-w-0 items-center gap-2">
              <Hexagon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
              {/* Drop the shared `open-knowledge-pack-` prefix (the identical,
                  non-distinguishing part) so the pack name reads + fits; full
                  name stays on hover. The `Skill` pill mirrors the folder card's
                  template-count pill so the type is unmistakable. */}
              <code
                className="min-w-0 truncate font-mono text-1sm font-medium text-foreground/90"
                title={skill.name}
              >
                {skillDisplayName(skill.name)}
              </code>
              <span className="ml-auto shrink-0 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                <Trans>Skill</Trans>
              </span>
            </div>
            <p className="text-1sm leading-relaxed text-muted-foreground">
              <Trans>Guides your AI agents on how to work here.</Trans>
            </p>
          </div>
        ) : null}
      </div>

      {plan.created.length > 0 ? (
        <Collapsible
          open={treeOpen}
          onOpenChange={setTreeOpen}
          className="overflow-hidden rounded-md border border-border/60 bg-muted/20"
        >
          <CollapsibleTrigger asChild>
            <Button
              variant="link-muted"
              size="sm"
              className="h-auto w-full justify-between rounded-none px-3 py-2 font-mono text-xs uppercase tracking-wide text-muted-foreground hover:bg-muted/40"
            >
              <Trans>Files & folders</Trans>
              <ChevronDown
                aria-hidden="true"
                className={cn('size-3.5 transition-transform', treeOpen && 'rotate-180')}
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t border-border/60">
              <CreatedItemsTree plan={plan} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </section>
  );
}

function describeCreatedItems(plan: OkScaffoldPlan): CreatedItem[] {
  const folders: CreatedItem[] = plan.created
    .filter((e) => e.kind === 'folder')
    .map((e) => ({ kind: 'folder', name: `${e.path}/` }));
  const files: CreatedItem[] = plan.created
    .filter((e) => e.kind === 'file')
    .map((e) => ({ kind: 'file', name: e.path }));
  return [...folders, ...files];
}

/**
 * The full indented file tree (folders + every `.ok/` internal), rendered
 * inside the "Show file tree" disclosure — the enclosing `Collapsible` owns the
 * border + background. Pure structure: folder purpose lives on the cards above.
 */
function CreatedItemsTree({ plan }: { plan: OkScaffoldPlan }) {
  const { t } = useLingui();
  const items = describeCreatedItems(plan);

  // Lex sort gives parent-before-children via string-prefix comparison.
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));

  // Re-scaffold may put the parent in `plan.skipped`; anchoring depth +
  // displayed name to PRESENT ancestors keeps guide bars from descending
  // into rows that never render.
  const presentPaths = new Set(sorted.map((i) => i.name.replace(/\/$/, '')));

  return (
    <ul aria-label={t`Items to be created`} className="py-1.5">
      {sorted.map((item) => {
        const pathKey = item.name.replace(/\/$/, '');
        const segments = pathKey.split('/');
        // Count present ancestors (= visual depth); the leaf name spans
        // any absent intermediate segments so the row stays unambiguous.
        let depth = 0;
        let nearestPresentEnd = 0;
        for (let i = 1; i < segments.length; i++) {
          const ancestor = segments.slice(0, i).join('/');
          if (presentPaths.has(ancestor)) {
            depth++;
            nearestPresentEnd = i;
          }
        }
        const displayName =
          segments.slice(nearestPresentEnd).join('/') + (item.kind === 'folder' ? '/' : '');
        const isFolder = item.kind === 'folder';
        return (
          <li
            key={item.name}
            className="relative flex min-w-0 items-center gap-1.5 py-1 pr-3"
            style={{ paddingLeft: `${12 + depth * 16}px` }}
          >
            {/* Vertical guides at each present-ancestor depth (`+8`
                  centers the 1px line within the 16px icon column). */}
            {Array.from({ length: depth }, (_, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: depth-slot index is the stable identity (ancestor paths may include skipped segments)
                key={`guide:${i}`}
                aria-hidden="true"
                className="absolute top-0 bottom-0 w-px bg-border/50"
                style={{ left: `${12 + i * 16 + 8}px` }}
              />
            ))}
            {isFolder ? (
              <Folder
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
                strokeWidth={1.5}
              />
            ) : (
              // Spacer keeps file names aligned with sibling folder names.
              <span aria-hidden="true" className="size-3.5 shrink-0" />
            )}
            <code className="font-mono text-1sm shrink-0 text-foreground/80">{displayName}</code>
          </li>
        );
      })}
    </ul>
  );
}
