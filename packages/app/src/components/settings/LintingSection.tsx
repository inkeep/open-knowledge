/**
 * Settings → Plugins — the no-code GUI for the markdown linter, organized as
 * lint plugins. Project scope: lint rules are an authoring standard shared with
 * the team via the committed `config.yml` + the project's native
 * `.markdownlint.*` file (the source of truth for rules).
 *
 * Exported sections: `ProjectPluginsManageSection` + `UserPluginsManageSection`
 * (per-plugin on/off, one manage page per scope) and `MarkdownlintPluginSection`
 * (the full-catalog rule browser — see `markdownlint-rule-browser.tsx`).
 */
// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import {
  type AppliesToPatternSummary,
  type ConfigBinding,
  type ConfigPatch,
  type FrontmatterSchemaMapping,
  humanFormat,
  isFrontmatterSchemaAsset,
  type LintPluginId,
  summarizeAppliesTo,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, Plus, SquarePen, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { DeleteConfirmationDialog } from '@/components/DeleteConfirmationDialog';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { TagPillInput } from '@/components/ui/tag-pill-input';
import {
  createEmptyFrontmatterSchema,
  deleteFrontmatterSchema,
  emitLintConfigChanged,
  useFrontmatterSchemaFiles,
  useProjectLintConfig,
} from '@/editor/lint-config-client';
import { useConfigContext } from '@/lib/config-provider';
import { hashFromAssetPath } from '@/lib/doc-hash';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { requestSchemaFieldsView } from '@/lib/schema-fields-view-intent';
import { indexGlobProblemsByFile, parseAppliesToGlobProblem } from './applies-to-glob-problems';
import { LINT_PLUGIN_META } from './lint-plugin-meta';
import { MarkdownlintRuleBrowser } from './markdownlint-rule-browser';
import { PluginBetaBadge } from './PluginBetaBadge';
import { PluginSectionHeader } from './PluginSectionHeader';
import { notifyPluginEnabled } from './plugin-enabled-notice';

/** Project-scope content-rules config + a `contentRules`-patch writer. Shared by the sections. */
function useLinterConfig() {
  const { t } = useLingui();
  const { projectConfig, projectSynced, projectBinding } = useConfigContext();
  const contentRules = projectConfig?.contentRules;
  const bindingReady = projectSynced && projectBinding !== null;

  function write(patch: ConfigPatch['contentRules']): boolean {
    if (projectBinding === null) {
      toast.error(t`Content rules not yet loaded — try again in a moment`);
      return false;
    }
    const result = projectBinding.patch({ contentRules: patch });
    if (!result.ok) {
      toast.error(t`Failed to save content rules — ${humanFormat(result.error)}`);
      return false;
    }
    return true;
  }

  return { contentRules, bindingReady, write };
}

/** A `contentRules` patch toggling one plugin's `enabled` (dynamic key needs the cast). */
function pluginEnabledPatch(id: LintPluginId, enabled: boolean): ConfigPatch['contentRules'] {
  return { [id]: { enabled } } as ConfigPatch['contentRules'];
}

function PluginManageDescription({ id }: { id: LintPluginId }) {
  switch (id) {
    case 'markdownlint':
      return (
        <Trans>
          Common markdown issues — hard tabs, heading increments, list markers, and more.
        </Trans>
      );
    case 'frontmatter':
      return (
        <Trans>
          Validate document frontmatter against JSON Schema files, scoped to doc sets by glob.
        </Trans>
      );
  }
}

/**
 * Project-scope plugins management page (This project → Plugins). Toggles the
 * project's content-rule plugins on/off; the choice is committed to config.yml
 * and shared via git. Enabled plugins also appear under the Plugins sidebar
 * section with their own panel.
 */
export function ProjectPluginsManageSection() {
  const { t } = useLingui();
  const { contentRules, bindingReady, write } = useLinterConfig();

  return (
    <section
      aria-labelledby="settings-plugins-title"
      className="space-y-4"
      data-testid="settings-plugins-manage"
    >
      <div className="space-y-1">
        <h3 id="settings-plugins-title" className="text-base font-semibold">
          <Trans>Plugins</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          <Trans>
            Project plugins are your project's authoring standard — turn them on or off here. The
            choice is committed to config.yml and shared with every collaborator via git. Each
            enabled plugin gets its own page under Plugins in the settings sidebar.
          </Trans>
        </p>
      </div>

      <div className="divide-y rounded-md border" data-testid="settings-plugins-list">
        {LINT_PLUGIN_META.map((plugin) => {
          const on = contentRules?.[plugin.id]?.enabled === true;
          return (
            <div key={plugin.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <Label
                  htmlFor={`settings-plugin-toggle-${plugin.id}`}
                  className="inline-flex items-center gap-1.5 text-sm font-medium"
                >
                  {plugin.label}
                  {plugin.id === 'frontmatter' ? <PluginBetaBadge /> : null}
                </Label>
                <p className="text-sm text-muted-foreground">
                  <PluginManageDescription id={plugin.id} />
                </p>
              </div>
              <Switch
                id={`settings-plugin-toggle-${plugin.id}`}
                checked={on}
                disabled={!bindingReady}
                onCheckedChange={(next) => {
                  if (!write(pluginEnabledPatch(plugin.id, next))) return;
                  if (next) notifyPluginEnabled({ pluginId: plugin.id, label: plugin.label });
                }}
                aria-label={on ? t`Disable ${plugin.label}` : t`Enable ${plugin.label}`}
                data-testid={`settings-plugin-toggle-${plugin.id}`}
              />
            </div>
          );
        })}
      </div>

      <p className="text-sm text-muted-foreground" data-testid="settings-plugins-audit-pointer">
        <Trans>Run a project audit from the Problems panel.</Trans>
      </p>
    </section>
  );
}

/**
 * User-scope plugins management page (User → Plugins). Toggles personal,
 * device-local plugins (Themes) on/off; the choice lives in your user config
 * and is never committed to the project.
 */
export function UserPluginsManageSection({ userBinding }: { userBinding: ConfigBinding | null }) {
  const { t } = useLingui();
  const { userConfig } = useConfigContext();
  // The theme plugin is user-scope (personal). Default on.
  const themeEnabled = userConfig?.appearance?.colorThemeEnabled !== false;
  // Slidev is user-scope too, but ships OFF — the gate is `=== true`, not
  // Themes' `!== false`.
  const slidesEnabled = userConfig?.slides?.enabled === true;

  return (
    <section
      aria-labelledby="settings-user-plugins-title"
      className="space-y-4"
      data-testid="settings-user-plugins-manage"
    >
      <div className="space-y-1">
        <h3 id="settings-user-plugins-title" className="text-base font-semibold">
          <Trans>Plugins</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          <Trans>
            User plugins are personal to this device — turn them on or off here. The choice lives in
            your user config and is never committed to the project. Each enabled plugin gets its own
            page under Plugins in the settings sidebar.
          </Trans>
        </p>
      </div>

      <div className="divide-y rounded-md border" data-testid="settings-user-plugins-list">
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <div className="min-w-0">
            <Label htmlFor="settings-plugin-toggle-theme" className="text-sm font-medium">
              <Trans>Themes</Trans>
            </Label>
            <p className="text-sm text-muted-foreground">
              <Trans>
                A personal color-theme picker — not shared with your project. When on, it appears
                under Plugins in the sidebar.
              </Trans>
            </p>
          </div>
          <Switch
            id="settings-plugin-toggle-theme"
            checked={themeEnabled}
            disabled={userBinding === null}
            onCheckedChange={(next) => {
              if (!userBinding) return;
              const result = userBinding.patch({ appearance: { colorThemeEnabled: next } });
              if (!result.ok) {
                toast.error(t`Failed to save theme setting`);
                return;
              }
              // 'theme' is the user-scope plugin's `plugin:theme` sidebar id —
              // it owns no `contentRules` slice, so it is not in LINT_PLUGIN_META.
              if (next) notifyPluginEnabled({ pluginId: 'theme', label: t`Themes` });
            }}
            aria-label={themeEnabled ? t`Disable Themes` : t`Enable Themes`}
            data-testid="settings-plugin-toggle-theme"
          />
        </div>
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <div className="min-w-0">
            <Label
              htmlFor="settings-plugin-toggle-slides"
              className="inline-flex items-center gap-1.5 text-sm font-medium"
            >
              <Trans>Slidev</Trans>
              <PluginBetaBadge />
            </Label>
            <p className="text-sm text-muted-foreground">
              <Trans>
                Present a document as a slide deck in its own window. Works in the OpenKnowledge
                desktop app only, and needs the Slidev CLI, which you install separately. When on,
                it appears under Plugins in the sidebar.
              </Trans>
            </p>
          </div>
          <Switch
            id="settings-plugin-toggle-slides"
            checked={slidesEnabled}
            disabled={userBinding === null}
            onCheckedChange={(next) => {
              if (!userBinding) return;
              const result = userBinding.patch({ slides: { enabled: next } });
              if (!result.ok) {
                toast.error(t`Failed to save Slidev setting`);
                return;
              }
              if (next) notifyPluginEnabled({ pluginId: 'slides', label: t`Slidev` });
            }}
            aria-label={slidesEnabled ? t`Disable Slidev` : t`Enable Slidev`}
            data-testid="settings-plugin-toggle-slides"
          />
        </div>
      </div>
    </section>
  );
}

/** Docs page for one plugin — panel headers link it beside their description. */
function pluginDocUrl(id: LintPluginId): string | undefined {
  return LINT_PLUGIN_META.find((plugin) => plugin.id === id)?.docUrl;
}

/** markdownlint plugin: the full-catalog rule browser. */
export function MarkdownlintPluginSection({
  initialRuleQuery,
}: {
  /** Seeds the rule browser's search when the settings search jumps to a rule. */
  initialRuleQuery?: { query: string; nonce: number } | null;
} = {}) {
  return (
    <section
      aria-labelledby="settings-plugin-markdownlint-title"
      className="space-y-4"
      data-testid="settings-plugin-markdownlint"
    >
      <PluginSectionHeader
        titleId="settings-plugin-markdownlint-title"
        title="markdownlint"
        scope="project"
        docUrl={pluginDocUrl('markdownlint')}
      >
        <Trans>
          Flag common markdown issues in the editor. Powered by{' '}
          <a
            href="https://github.com/DavidAnson/markdownlint"
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) =>
              dispatchExternalLinkClick(e, 'https://github.com/DavidAnson/markdownlint')
            }
            onAuxClick={(e) =>
              dispatchExternalLinkClick(e, 'https://github.com/DavidAnson/markdownlint')
            }
            className="inline-flex items-center gap-0.5 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            markdownlint
            <ArrowUpRight aria-hidden className="size-3" />
          </a>
          .
        </Trans>
      </PluginSectionHeader>
      <MarkdownlintRuleBrowser initialRuleQuery={initialRuleQuery} />
    </section>
  );
}

/** Normalize a mapping's authored appliesTo (string | string[] | absent) for the pill editor. */
function appliesToList(appliesTo: FrontmatterSchemaMapping['appliesTo']): string[] {
  if (appliesTo === undefined) return [];
  return Array.isArray(appliesTo) ? appliesTo : [appliesTo];
}

/**
 * One classified pattern as a human phrase. The fallback names the raw glob
 * so the summary never claims more than the matcher does.
 */
function AppliesToPhrase({ summary }: { summary: AppliesToPatternSummary }) {
  switch (summary.kind) {
    case 'everything':
      return <Trans>every doc</Trans>;
    case 'folder-recursive':
      return <Trans>everything under {summary.folder}/</Trans>;
    case 'folder-direct':
      return <Trans>docs directly in {summary.folder}/</Trans>;
    case 'exact':
      return <Trans>the doc {summary.target}</Trans>;
    case 'name-anywhere':
      return <Trans>any doc named {summary.name}</Trans>;
    case 'folder-anywhere':
      return <Trans>everything under any {summary.folder}/ folder</Trans>;
    case 'folder-recursive-nested':
      return (
        <Trans>
          everything under {summary.folder}/ folders inside {summary.root}/
        </Trans>
      );
    case 'matches-nothing':
      return <Trans>nothing ({summary.pattern} cannot match a doc)</Trans>;
    case 'invalid':
      return <Trans>nothing ({summary.pattern} is not a valid pattern)</Trans>;
    case 'pattern':
      return <Trans>docs matching {summary.pattern}</Trans>;
  }
}

/** The live plain-language reading of a mapping's globs, under the pills. */
function AppliesToSummaryLine({
  file,
  appliesTo,
}: {
  file: string;
  appliesTo: FrontmatterSchemaMapping['appliesTo'];
}) {
  const { includes, excludes } = summarizeAppliesTo(appliesTo);
  const list = (entries: AppliesToPatternSummary[]) =>
    entries.map((entry, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: display-only phrase list, order-stable.
      <span key={index}>
        {index > 0 ? ', ' : null}
        <AppliesToPhrase summary={entry} />
      </span>
    ));
  return (
    <p
      className="text-xs text-muted-foreground"
      data-testid={`frontmatter-schema-applies-summary-${file}`}
    >
      <Trans>Applies to</Trans>{' '}
      {includes.length === 0 ? (
        <AppliesToPhrase summary={{ kind: 'everything' }} />
      ) : (
        list(includes)
      )}
      {excludes.length > 0 ? (
        <>
          {' '}
          <Trans>— except</Trans> {list(excludes)}
        </>
      ) : null}
      .
    </p>
  );
}

/** Absent `enabled` = on — back-compat with configs written before the toggle. */
function mappingEnabled(mapping: FrontmatterSchemaMapping): boolean {
  return mapping.enabled !== false;
}

function SchemaFileRow({
  file,
  mapping,
  disabled,
  globProblems,
  onToggle,
  onAppliesToChange,
  onDelete,
}: {
  file: string;
  mapping: FrontmatterSchemaMapping | undefined;
  disabled: boolean;
  globProblems: ReadonlyMap<string, string> | undefined;
  onToggle: (on: boolean) => void;
  onAppliesToChange: (globs: string[]) => void;
  onDelete: (() => void) | null;
}) {
  const { t } = useLingui();
  const on = mapping !== undefined && mappingEnabled(mapping);

  // The Edit button is the row's ONLY way into the file. Hash nav is OK's
  // source of truth: it activates (or re-activates) the file's tab AND closes
  // the hash-driven Settings dialog. The one-shot intent lands the schema
  // editor on its Fields view — a Settings open is an editing gesture,
  // whatever the persisted Source/Fields preference.
  const openSchemaFile = () => {
    requestSchemaFieldsView(file);
    window.location.hash = hashFromAssetPath(file);
  };

  return (
    <div className="px-3 py-2" data-testid={`frontmatter-schema-row-${file}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 flex-1 truncate font-mono text-sm" title={file}>
          {file}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-6 shrink-0 gap-1 px-2 text-xs"
            onClick={openSchemaFile}
            aria-label={t`Edit schema ${file}`}
            data-testid={`frontmatter-schema-edit-${file}`}
          >
            <SquarePen aria-hidden className="size-3" />
            <Trans>Edit</Trans>
          </Button>
          {onDelete !== null ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 shrink-0 text-muted-foreground opacity-60 hover:opacity-100"
              disabled={disabled}
              aria-label={t`Delete schema file ${file}`}
              onClick={onDelete}
              data-testid={`frontmatter-schema-delete-${file}`}
            >
              <Trash2 className="size-3.5" />
            </Button>
          ) : null}
          <Switch
            checked={on}
            disabled={disabled}
            aria-label={on ? t`Disable ${file}` : t`Enable ${file}`}
            onCheckedChange={onToggle}
            data-testid={`frontmatter-schema-toggle-${file}`}
          />
        </div>
      </div>
      {on ? (
        <div className="mt-2 space-y-1 pl-1.5">
          <Label htmlFor={`frontmatter-schema-applies-${file}`} className="text-xs">
            <Trans>Applies to (globs — leading ! excludes; empty means every doc)</Trans>
          </Label>
          <TagPillInput
            id={`frontmatter-schema-applies-${file}`}
            value={appliesToList(mapping?.appliesTo)}
            grammar="free-text"
            disabled={disabled}
            entryProblems={globProblems}
            onChange={onAppliesToChange}
            placeholder={t`Add file or folder pattern, e.g. guides/**/*`}
            aria-label={t`Glob patterns this schema applies to`}
          />
          <AppliesToSummaryLine file={file} appliesTo={mapping?.appliesTo} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Frontmatter plugin panel: a browser over every schema file in the project
 * (discovered `*.schema.json` + `.ok/schemas/*.json` + anything config.yml
 * maps). The toggle is the only control: on writes an `enabled: true` mapping
 * to `contentRules.frontmatter.schemas`, off keeps the mapping (and its
 * appliesTo) with `enabled: false`, so re-enabling restores the globs. There
 * is deliberately no way to unmap a schema from here — config-file state is an
 * internal detail, and anyone who wants the mapping gone edits config.yml.
 * The Edit button opens the file itself in the editor — field editing lives on
 * the file surface, not here.
 */
export function FrontmatterPluginSection() {
  const { t } = useLingui();
  const { contentRules, bindingReady, write } = useLinterConfig();
  const { data } = useProjectLintConfig();
  const { schemas: discovered } = useFrontmatterSchemaFiles();
  const mappings = contentRules?.frontmatter?.schemas ?? [];
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newSchemaName, setNewSchemaName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // The config channel carries every plugin's problems; show the frontmatter
  // ones where the mappings are managed. Per-mapping problems are gated on the
  // file still being referenced by a LIVE mapping (the server composes from
  // the on-disk config.yml, which lags a just-committed CRDT edit by the
  // persistence debounce). The prefix strings are the compose contract in the
  // server's frontmatter-schemas.ts — keep in sync on either-side change.
  const mappedFiles = new Set(mappings.map((m) => m.file));
  const scopedProblems = (data?.configProblems ?? []).filter((p) => {
    if (p.startsWith('frontmatter schema ')) {
      return [...mappedFiles].some((file) => p.startsWith(`frontmatter schema ${file}:`));
    }
    if (
      p.startsWith('invalid appliesTo glob') ||
      p.startsWith('suspicious appliesTo glob') ||
      p.startsWith('unmatched appliesTo glob')
    ) {
      return [...mappedFiles].some((file) => p.endsWith(`(frontmatter mapping for ${file})`));
    }
    return false;
  });

  function writeMappings(next: FrontmatterSchemaMapping[]): void {
    if (write({ frontmatter: { schemas: next } } as ConfigPatch['contentRules'])) {
      emitLintConfigChanged();
    }
  }

  // One row per file; the FIRST mapping for a file is the row's binding
  // (hand-authored duplicates keep validating, untouched).
  const files = [...new Set([...discovered, ...mappings.map((m) => m.file)])].sort((a, b) =>
    a.localeCompare(b),
  );
  const query = search.trim().toLowerCase();
  const visible = files.filter((f) => query === '' || f.toLowerCase().includes(query));

  // Glob problems belong to the glob that caused them, so a pattern whose pill
  // can carry its finding is dropped from this list — including when the search
  // box happens to be hiding that row, since the pill is still where the
  // finding lives.
  //
  // Two cases keep the list, and they are decided against the authored config
  // rather than against what is currently rendered:
  //
  //   - A pattern absent from every mapping is stale. The config channel is
  //     composed from the on-disk config.yml and lags a just-committed CRDT
  //     edit by the persistence debounce, so a glob the author has already
  //     deleted still has a live problem for a moment. Suppressed, or removing
  //     a flagged glob would flash a warning about a pattern that no longer
  //     exists on its way out.
  //   - A pattern authored in a mapping that no pill can ever reach is listed.
  //     A row binds to the FIRST mapping for its file (duplicates are a
  //     supported hand-authored shape) and only mounts the glob input when that
  //     mapping is enabled — so a second mapping's globs, or any mapping behind
  //     a disabled first one, have nowhere to render. The server reports those
  //     per mapping entry; dropping them would silently unvalidate docs that
  //     are actively governed.
  const globProblemsByFile = indexGlobProblemsByFile(scopedProblems);
  const problems = scopedProblems.filter((p) => {
    const parsed = parseAppliesToGlobProblem(p);
    if (parsed === null) return true;
    const bound = mappings.find((m) => m.file === parsed.file);
    const carriedByPill =
      bound !== undefined &&
      mappingEnabled(bound) &&
      appliesToList(bound.appliesTo).includes(parsed.pattern);
    const authoredSomewhere = mappings.some(
      (m) => m.file === parsed.file && appliesToList(m.appliesTo).includes(parsed.pattern),
    );
    return !carriedByPill && authoredSomewhere;
  });

  function toggleFile(file: string, on: boolean): void {
    if (!mappings.some((m) => m.file === file)) {
      if (on) writeMappings([...mappings, { file, enabled: true }]);
      return;
    }
    writeMappings(mappings.map((m) => (m.file === file ? { ...m, enabled: on } : m)));
  }

  function setAppliesTo(file: string, globs: string[]): void {
    writeMappings(
      mappings.map((m) => {
        if (m.file !== file) return m;
        if (globs.length === 0) {
          const { appliesTo: _cleared, ...rest } = m;
          return rest;
        }
        return { ...m, appliesTo: globs };
      }),
    );
  }

  async function deleteSchemaFile(file: string): Promise<void> {
    setDeleting(true);
    const result = await deleteFrontmatterSchema(file);
    setDeleting(false);
    if (!result.ok) {
      toast.error(result.errorDetail ?? t`Failed to delete ${file}`);
      return;
    }
    // The file is gone — its mapping (if any) would only produce a broken
    // reference, so wipe it in the same gesture.
    if (mappings.some((m) => m.file === file)) {
      writeMappings(mappings.filter((m) => m.file !== file));
    }
    setDeleteTarget(null);
    toast.success(t`Deleted ${file}`);
  }

  async function createSchema(): Promise<void> {
    const name = newSchemaName.trim();
    if (name === '' || name.includes('/') || name.includes('\\')) return;
    const file = `.ok/schemas/${name.endsWith('.json') ? name : `${name}.schema.json`}`;
    const result = await createEmptyFrontmatterSchema(file);
    if (!result.ok) {
      toast.error(result.errorDetail ?? t`Failed to create the schema file`);
      return;
    }
    // A schema someone just created is a schema they mean to use — map it on.
    writeMappings([...mappings, { file, enabled: true }]);
    setCreateOpen(false);
    setNewSchemaName('');
  }

  return (
    <section
      aria-labelledby="settings-plugin-frontmatter-title"
      className="space-y-4"
      data-testid="settings-plugin-frontmatter"
    >
      <PluginSectionHeader
        titleId="settings-plugin-frontmatter-title"
        title={t`Frontmatter schemas`}
        beta
        docUrl={pluginDocUrl('frontmatter')}
      >
        <Trans>
          Validate document frontmatter against standard JSON Schema files (draft-06, draft-07,
          2019-09, or 2020-12). Toggle a schema on to validate the docs its globs match; violations
          surface as warnings and never block a write. Use Edit to open the schema file.
        </Trans>
      </PluginSectionHeader>

      {problems.length > 0 && (
        <div
          className="space-y-1 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
          data-testid="frontmatter-config-problems"
        >
          <p className="font-medium">
            <Trans>Configuration problems</Trans>
          </p>
          <ul className="list-disc pl-5 text-muted-foreground">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center gap-4">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t`Search schemas`}
          aria-label={t`Search schema files by path`}
          className="h-8"
          data-testid="frontmatter-schema-search"
        />
        <Popover open={createOpen} onOpenChange={setCreateOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              data-testid="frontmatter-create-schema"
            >
              <Plus aria-hidden className="size-4" />
              <Trans>New schema</Trans>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 space-y-2">
            <Label htmlFor="frontmatter-create-schema-name" className="text-xs">
              <Trans>File name (created in .ok/schemas/)</Trans>
            </Label>
            <Input
              id="frontmatter-create-schema-name"
              value={newSchemaName}
              onChange={(e) => setNewSchemaName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createSchema();
              }}
              placeholder="doc"
              data-testid="frontmatter-create-schema-name"
            />
            <Button
              size="sm"
              disabled={!bindingReady || newSchemaName.trim() === ''}
              onClick={() => void createSchema()}
              data-testid="frontmatter-create-schema-save"
            >
              <Trans>Create</Trans>
            </Button>
          </PopoverContent>
        </Popover>
      </div>

      {visible.length === 0 ? (
        <p
          className="rounded-md border border-dashed p-3 text-sm text-muted-foreground"
          data-testid="frontmatter-schemas-empty"
        >
          {files.length === 0 ? (
            <Trans>No schema files in this project yet — create one to start validating.</Trans>
          ) : (
            <Trans>No schemas match your search.</Trans>
          )}
        </p>
      ) : (
        <div className="divide-y rounded-md border" data-testid="frontmatter-schemas-list">
          {visible.map((file) => (
            <SchemaFileRow
              key={file}
              file={file}
              mapping={mappings.find((m) => m.file === file)}
              disabled={!bindingReady}
              globProblems={globProblemsByFile.get(file)}
              onToggle={(on) => toggleFile(file, on)}
              onAppliesToChange={(globs) => setAppliesTo(file, globs)}
              onDelete={isFrontmatterSchemaAsset(file) ? () => setDeleteTarget(file) : null}
            />
          ))}
        </div>
      )}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        {deleteTarget !== null ? (
          <DeleteConfirmationDialog
            itemName={t`schema ${deleteTarget}`}
            isSubmitting={deleting}
            onDelete={() => void deleteSchemaFile(deleteTarget)}
            customDescription={t`This permanently deletes ${deleteTarget} from the project and removes its mapping from config.yml.`}
          />
        ) : null}
      </Dialog>
    </section>
  );
}
