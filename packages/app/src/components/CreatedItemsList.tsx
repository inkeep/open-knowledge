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

interface FolderCard {
  path: string;
  summary: string;
  templateCount: number;
  templates: string[];
}

function describeFolderCards(
  plan: OkScaffoldPlan,
  selectedPack: OkSeedPackInfo | undefined,
): FolderCard[] {
  const folders: FolderCard[] = [];
  for (const folder of selectedPack?.folders ?? []) {
    const templatesNeedle = `${folder.path}/.ok/templates/`;
    const templates = plan.created
      .filter(
        (e) =>
          e.kind === 'file' &&
          (e.path.startsWith(templatesNeedle) || e.path.includes(`/${templatesNeedle}`)),
      )
      .map((e) => basename(e.path));
    const templateCount = templates.length;
    const folderCreated = plan.created.some(
      (e) => e.kind === 'folder' && (e.path === folder.path || e.path.endsWith(`/${folder.path}`)),
    );
    if (templateCount > 0 || folderCreated) {
      folders.push({ path: folder.path, summary: folder.summary, templateCount, templates });
    }
  }
  return folders;
}

function describeFileCards(plan: OkScaffoldPlan): Array<{ path: string; name: string }> {
  return plan.created
    .filter((e) => e.kind === 'file' && !e.path.split('/').includes('.ok'))
    .map((e) => ({ path: e.path, name: basename(e.path) }));
}

interface PreviewRow {
  key: string;
  icon: LucideIcon;
  name: string;
  title?: string;
  pill?: string;
  pillTooltip?: string[];
  description?: string;
}

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
  const pendingPlugins = (plan.requiredPlugins ?? []).filter((p) => p.pending);
  const folderCount = folders.length;
  const fileCount = files.length;
  const templateCount = folders.reduce((sum, f) => sum + f.templateCount, 0);
  const skillCount = pendingSkills.length;
  const pluginCount = pendingPlugins.length;

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
    name: skillDisplayName(skill.name),
    title: skill.name,
    description: t`Guides your AI agents on how to work here.`,
  }));
  const pluginDescriptions: Partial<Record<LintPluginId, string>> = {
    okf: t`Checks your project against the Open Knowledge Format. Turn it off any time in Settings.`,
  };
  const pluginRows: PreviewRow[] = pendingPlugins.map((plugin) => ({
    key: `plugin:${plugin.id}`,
    icon: Puzzle,
    name: LINT_PLUGIN_META.find((meta) => meta.id === plugin.id)?.label ?? plugin.id,
    title: plugin.id,
    description: pluginDescriptions[plugin.id] ?? t`Turn it off any time in Settings.`,
  }));

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
                    {}
                    <div
                      aria-hidden="true"
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60"
                    >
                      <Icon className="size-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1 py-0.5">
                      {}
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
                              {}
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
