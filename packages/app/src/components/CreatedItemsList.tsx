import type { LintPluginId } from '@inkeep/open-knowledge-core';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { File, Folder, Hexagon, type LucideIcon, Puzzle } from 'lucide-react';
import { Fragment } from 'react';
import { LINT_PLUGIN_META } from '@/components/settings/lint-plugin-meta';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { OkScaffoldPlan, OkSeedPackInfo } from '@/lib/desktop-bridge-types';
import { skillDisplayName } from '@/lib/skill-scope';

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * Stand-in for `CreatedItemsList` while its plan is in flight. Skeleton rows
 * match the real row shape (size-8 icon block, centered, + name/description
 * lines) so the plan swaps in without a layout jump. `rowCount` tracks the
 * pack's folders (the dominant row kind). `role="status"` so assistive tech
 * hears it loading.
 */
export function CreatedItemsSkeleton({ rowCount }: { rowCount: number }) {
  const { t } = useLingui();
  return (
    <section role="status" aria-busy="true" aria-label={t`Loading preview`}>
      <ul className="space-y-2">
        {Array.from({ length: rowCount }, (_, i) => i).map((i) => (
          <li key={`seed-skeleton-${i}`} aria-hidden="true" className="flex items-center gap-3">
            <div className="size-8 shrink-0 animate-pulse rounded-lg bg-muted" />
            <div className="min-w-0 flex-1 py-0.5">
              <span className="block h-3.5 w-28 animate-pulse rounded bg-muted" />
              <span className="mt-2 block h-3 w-4/5 animate-pulse rounded bg-muted" />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A top-level folder to preview as a row. `templateCount` is the number of
 * starter/extra templates the plan installs into `<folder>/.ok/templates/`.
 */
interface FolderCard {
  path: string;
  summary: string;
  templateCount: number;
  /** Basenames of the templates installed into this folder's `.ok/templates/`. */
  templates: string[];
}

/**
 * One entry per pack folder actually being scaffolded. `templateCount` is the
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
    const templates = plan.created
      .filter(
        (e) =>
          e.kind === 'file' &&
          (e.path.startsWith(templatesNeedle) || e.path.includes(`/${templatesNeedle}`)),
      )
      .map((e) => basename(e.path));
    const templateCount = templates.length;
    // A folder whose directory is being created OR whose templates are being
    // (re)installed is in-scope; one that's fully present (all in `skipped`)
    // isn't part of "what gets created", so it drops out.
    const folderCreated = plan.created.some(
      (e) => e.kind === 'folder' && (e.path === folder.path || e.path.endsWith(`/${folder.path}`)),
    );
    if (templateCount > 0 || folderCreated) {
      folders.push({ path: folder.path, summary: folder.summary, templateCount, templates });
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

/** One preview row — a folder, root file, or the pack skill. */
interface PreviewRow {
  key: string;
  icon: LucideIcon;
  name: string;
  title?: string;
  pill?: string;
  /** When set, the pill reveals these names (the folder's templates) on hover/focus. */
  pillTooltip?: string[];
  description?: string;
}

/**
 * Renders `plan.created` grouped into typed sections — Folders, Files, Skill —
 * each a scannable list of rows. A row leads with a full-height icon block
 * (icon + folder trailing-slash carry the type — never color alone), then the
 * name, an optional count pill (folders' template count), and the human-readable
 * summary inline. The top summary header breaks the plan into the counts a user
 * can actually observe in the app — folders, files, skill, templates. Only
 * user-visible paths surface; `.ok/` internals (templates, frontmatter) never
 * appear.
 */
export function CreatedItemsList({
  plan,
  selectedPack,
}: {
  plan: OkScaffoldPlan;
  selectedPack: OkSeedPackInfo | undefined;
}) {
  const { t } = useLingui();
  const folders = describeFolderCards(plan, selectedPack);
  const files = describeFileCards(plan);
  const pendingSkills = (plan.packSkills ?? []).filter((s) => s.pending);
  // Pending only, mirroring skills — and it happens to be exactly the set that
  // needs explaining. A plugin already on did not "turn back on", so it has
  // nothing to disclose; a pending one is either new or was deliberately
  // switched off, and that is the case the user is owed a reason for.
  const pendingPlugins = (plan.requiredPlugins ?? []).filter((p) => p.pending);
  // Derive the counts straight from the rows so the summary line always
  // matches what's rendered. Counting `plan.created` directly diverged in
  // subfolder mode, where the plan also creates the parent folder (e.g.
  // `brain/`) — a real folder entry with no row, which read as one extra.
  const folderCount = folders.length;
  const fileCount = files.length;
  const templateCount = folders.reduce((sum, f) => sum + f.templateCount, 0);
  const skillCount = pendingSkills.length;
  const pluginCount = pendingPlugins.length;

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
    pluginCount > 0
      ? {
          key: 'plugins',
          n: pluginCount,
          label: t`${plural(pluginCount, { one: 'plugin', other: 'plugins' })}`,
        }
      : null,
  ].filter((c): c is { key: string; n: number; label: string } => c !== null);

  // Rows are grouped into their own sections (Folders / Files / Skill) rather
  // than one flat list. Every row is a leaf the user will actually see in the
  // sidebar; `.ok/` internals are filtered out upstream. `pill` is the count
  // badge — folders carry their template count; files and the skill carry none
  // (the section header already names the type, so a "Skill" pill is redundant).
  const folderRows: PreviewRow[] = folders.map((folder) => ({
    key: `folder:${folder.path}`,
    icon: Folder,
    name: `${basename(folder.path)}/`,
    pill:
      folder.templateCount > 0
        ? t`${plural(folder.templateCount, { one: '# template', other: '# templates' })}`
        : undefined,
    pillTooltip: folder.templateCount > 0 ? folder.templates : undefined,
    description: folder.summary || undefined,
  }));
  const fileRows: PreviewRow[] = files.map((file) => ({
    key: `file:${file.path}`,
    icon: File,
    name: file.name,
    title: file.name,
    description: fileDescriptions[file.name],
  }));
  const skillRows: PreviewRow[] = pendingSkills.map((skill) => ({
    key: `skill:${skill.name}`,
    icon: Hexagon,
    // Drop the shared `open-knowledge-pack-` prefix (identical across
    // packs, non-distinguishing) so the name reads + fits; full name
    // stays on hover.
    name: skillDisplayName(skill.name),
    title: skill.name,
    description: t`Guides your AI agents on how to work here.`,
  }));
  // What each plugin does, so the row reads like its neighbors (which describe
  // the thing, not where it came from). Keyed per plugin rather than one shared
  // sentence: a pack requiring a different plugin must not inherit this text.
  // Resolved here rather than as a field on LINT_PLUGIN_META because that is a
  // plain module — a `t` macro there would bind at import, not at render.
  const pluginDescriptions: Partial<Record<LintPluginId, string>> = {
    okf: t`Checks your project against the Open Knowledge Format. Turn it off any time in Settings.`,
  };
  // The disclosure this section exists for: a user who turned a plugin off and
  // then seeds a pack that requires it needs to see, here, that it is coming
  // back on — and the description says it stays theirs to turn off again.
  const pluginRows: PreviewRow[] = pendingPlugins.map((plugin) => ({
    key: `plugin:${plugin.id}`,
    icon: Puzzle,
    name: LINT_PLUGIN_META.find((meta) => meta.id === plugin.id)?.label ?? plugin.id,
    title: plugin.id,
    description: pluginDescriptions[plugin.id] ?? t`Turn it off any time in Settings.`,
  }));

  // Ordered, non-empty sections. Labels pluralize with their own count so a
  // single item reads "Skill" / "File", not "Skills" / "Files".
  const sections = [
    {
      key: 'folders',
      label: t`${plural(folderRows.length, { one: 'Folder', other: 'Folders' })}`,
      rows: folderRows,
    },
    {
      key: 'files',
      label: t`${plural(fileRows.length, { one: 'File', other: 'Files' })}`,
      rows: fileRows,
    },
    {
      key: 'skill',
      label: t`${plural(skillRows.length, { one: 'Skill', other: 'Skills' })}`,
      rows: skillRows,
    },
    {
      key: 'plugin',
      label: t`${plural(pluginRows.length, { one: 'Plugin', other: 'Plugins' })}`,
      rows: pluginRows,
    },
  ].filter((s) => s.rows.length > 0);

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap justify-between items-baseline gap-x-2 gap-y-0.5">
        <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase font-mono tracking-wider text-muted-foreground">
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

      <div className="space-y-5">
        {sections.map((section) => (
          <div key={section.key} className="space-y-2.5">
            <h4 className="flex items-baseline gap-2 text-xs font-medium uppercase font-mono tracking-wider text-muted-foreground">
              <span>{section.label}</span>
              <span className="text-muted-foreground/50">{section.rows.length}</span>
            </h4>
            <ul className="space-y-4">
              {section.rows.map((row) => {
                const Icon = row.icon;
                return (
                  <li key={row.key} className="flex items-center gap-3">
                    {/* Type is
                        carried by the icon + folder trailing-slash, never color
                        alone. aria-hidden — the section header + name convey it. */}
                    <div
                      aria-hidden="true"
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60"
                    >
                      <Icon className="size-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1 py-0.5">
                      {/* Name + pill share the top line (pill aligned to the
                          name, at the row's right edge); the description drops
                          below, spanning the full width under both. */}
                      <div className="flex items-center gap-2">
                        <code
                          className="min-w-0 flex-1 truncate font-mono text-1sm text-foreground/90"
                          title={row.title}
                        >
                          {row.name}
                        </code>
                        {row.pill ? (
                          row.pillTooltip && row.pillTooltip.length > 0 ? (
                            <Tooltip>
                              {/* Default (button) trigger so the template names are
                                  keyboard-reachable, not hover-only. cursor-help
                                  signals there's more to see. */}
                              <TooltipTrigger className="shrink-0 cursor-help rounded bg-transparent p-0 font-mono text-2xs uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground/70 focus-visible:text-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                                {row.pill}
                              </TooltipTrigger>
                              <TooltipContent>
                                <ul className="space-y-0.5 text-left font-mono">
                                  {row.pillTooltip.map((name) => (
                                    <li key={name}>{name}</li>
                                  ))}
                                </ul>
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <span className="shrink-0 font-mono text-2xs uppercase tracking-wide text-muted-foreground">
                              {row.pill}
                            </span>
                          )
                        ) : null}
                      </div>
                      {row.description ? (
                        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                          {row.description}
                        </p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
