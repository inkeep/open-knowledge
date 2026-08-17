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
import {
  type AppliesToPatternSummary,
  assertNeverOkfRuleGroupId,
  assertNeverOkfRuleId,
  type ConfigBinding,
  type ConfigPatch,
  type FrontmatterSchemaMapping,
  findZeroMatchAppliesToPatterns,
  humanFormat,
  isFrontmatterSchemaAsset,
  isOkfRuleEnabled,
  type LintPluginId,
  OKF_RULE_GROUPS,
  OKF_RULE_IDS,
  type OkfRuleGroupId,
  type OkfRuleId,
  OPENKNOWLEDGE_SKILLS_REPO,
  summarizeAppliesTo,
} from '@inkeep/open-knowledge-core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  ArrowUpRight,
  CircleAlert,
  FileText,
  GitMerge,
  Plus,
  Power,
  SquarePen,
  Trash2,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { DeleteConfirmationDialog } from '@/components/DeleteConfirmationDialog';
import { DisclosureWarning, DisclosureWarningItem } from '@/components/DisclosureWarning';
import { useOptionalPageList } from '@/components/PageListContext';
import { SkillPluginBundleDialog } from '@/components/SkillPluginBundleDialog';
import { AlertDialog } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { TagPillInput } from '@/components/ui/tag-pill-input';
import {
  createEmptyFrontmatterSchema,
  deleteFrontmatterSchema,
  emitLintConfigChanged,
  useFrontmatterSchemaFiles,
  useProjectLintConfig,
} from '@/editor/lint-config-client';
import {
  type GeneratedIndexSettingsIssue,
  useGeneratedIndexSettings,
} from '@/hooks/use-generated-index-settings';
import { useOpenSkill } from '@/hooks/use-open-skill';
import { useSkills } from '@/hooks/use-skills';
import { useConfigContext } from '@/lib/config-provider';
import { hashFromAssetPath } from '@/lib/doc-hash';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { requestSchemaFieldsView } from '@/lib/schema-fields-view-intent';
import { installPackSkill } from '@/lib/skills-api';
import { countMatchingDocs } from './applies-to-folder-globs';
import { AppliesToFolderPicker } from './applies-to-folder-picker';
import { indexGlobProblemsByFile, parseAppliesToGlobProblem } from './applies-to-glob-problems';
import { LINT_PLUGIN_META } from './lint-plugin-meta';
import { MarkdownlintRuleBrowser } from './markdownlint-rule-browser';
import { PluginBetaBadge } from './PluginBetaBadge';
import { notifyPluginEnabled } from './plugin-enabled-notice';
import { SettingsSectionHeader } from './SettingsSectionHeader';

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
    case 'okf':
      return <Trans>Keeps your knowledge base aligned with the Open Knowledge Format.</Trans>;
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
      <SettingsSectionHeader
        titleId="settings-plugins-title"
        title={<Trans>Plugins</Trans>}
        scope="project"
      >
        <Trans>
          Project plugins are your project's authoring standard — turn them on or off here. Each
          enabled plugin gets its own page under Plugins in the settings sidebar.
        </Trans>
      </SettingsSectionHeader>

      <div className="divide-y rounded-md border" data-testid="settings-plugins-list">
        {LINT_PLUGIN_META.map((plugin) => {
          const on = contentRules?.[plugin.id]?.enabled === true;
          const descriptionId = `settings-plugin-toggle-${plugin.id}-description`;
          return (
            <div key={plugin.id} className="flex items-center justify-between gap-3 px-3 py-3">
              <div className="min-w-0">
                <Label
                  htmlFor={`settings-plugin-toggle-${plugin.id}`}
                  className="inline-flex items-center gap-1.5 text-sm font-medium"
                >
                  {plugin.label}
                  {plugin.beta ? <PluginBetaBadge /> : null}
                </Label>
                <p id={descriptionId} className="text-sm text-muted-foreground">
                  <PluginManageDescription id={plugin.id} />
                </p>
              </div>
              <Switch
                id={`settings-plugin-toggle-${plugin.id}`}
                aria-describedby={descriptionId}
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
      <SettingsSectionHeader
        titleId="settings-user-plugins-title"
        title={<Trans>Plugins</Trans>}
        scope="user"
      >
        <Trans>
          User plugins are personal to this device — turn them on or off here. Each enabled plugin
          gets its own page under Plugins in the settings sidebar.
        </Trans>
      </SettingsSectionHeader>

      <div className="divide-y rounded-md border" data-testid="settings-user-plugins-list">
        <div className="flex items-center justify-between gap-3 px-3 py-3">
          <div className="min-w-0">
            <Label htmlFor="settings-plugin-toggle-theme" className="text-sm font-medium">
              <Trans>Themes</Trans>
            </Label>
            <p
              id="settings-plugin-toggle-theme-description"
              className="text-1sm text-muted-foreground"
            >
              <Trans>
                A personal color-theme picker — not shared with your project. When on, it appears
                under Plugins in the sidebar.
              </Trans>
            </p>
          </div>
          <Switch
            id="settings-plugin-toggle-theme"
            aria-describedby="settings-plugin-toggle-theme-description"
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
        <div className="flex items-center justify-between gap-3 px-3 py-3">
          <div className="min-w-0">
            <Label
              htmlFor="settings-plugin-toggle-slides"
              className="inline-flex items-center gap-1.5 text-sm font-medium"
            >
              <Trans>Slidev</Trans>
              <PluginBetaBadge />
            </Label>
            <p
              id="settings-plugin-toggle-slides-description"
              className="text-1sm text-muted-foreground"
            >
              <Trans>
                Present a document as a slide deck in its own window. Works in the OpenKnowledge
                desktop app only, and needs the Slidev CLI, which you install separately. When on,
                it appears under Plugins in the sidebar.
              </Trans>
            </p>
          </div>
          <Switch
            id="settings-plugin-toggle-slides"
            aria-describedby="settings-plugin-toggle-slides-description"
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

/** Whether one plugin carries the Beta tag — read from the same registry the row does. */
function pluginIsBeta(id: LintPluginId): boolean {
  return LINT_PLUGIN_META.find((plugin) => plugin.id === id)?.beta === true;
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
      <SettingsSectionHeader
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
      </SettingsSectionHeader>
      <MarkdownlintRuleBrowser initialRuleQuery={initialRuleQuery} />
    </section>
  );
}

/**
 * What one OKF rule checks, in a sentence. Ids are untranslated identifiers (like
 * the plugin labels in `LINT_PLUGIN_META`); only the prose is translated — the
 * same split `PluginManageDescription` uses.
 */
function OkfRuleDescription({ id }: { id: OkfRuleId }) {
  switch (id) {
    case 'no-wiki-links':
      return (
        <Trans>
          Wiki-links like [[Page]] — a supported way to link here, but an external reader resolves
          nothing and shows the brackets.
        </Trans>
      );
    case 'log-shape':
      return (
        <Trans>
          In a log document: entry headings lead with an ISO YYYY-MM-DD date, newest first. How many
          titles you use, and whether entries are bullets, is up to you.
        </Trans>
      );
    case 'index-shape':
      return (
        <Trans>
          In an index document: entries sit under a section heading and each one carries a link.
          Prose around the lists is fine.
        </Trans>
      );
    case 'reserved-casing':
      return (
        <Trans>
          Reserved files are named index.md and log.md in lowercase. On a case-sensitive filesystem,
          Index.md is read as an ordinary document and loses its meaning.
        </Trans>
      );
    case 'frontmatter-required':
      return (
        <Trans>
          Every concept document carries a non-empty type. This is the whole of OKF's conformance
          floor — a document with only a type is fully conformant.
        </Trans>
      );
    case 'frontmatter-recommended':
      return (
        <Trans>
          The shapes of title, description, resource, and tags when you use them. None are required;
          declaring one only pins its type, so tags written as a comma-separated string is flagged.
        </Trans>
      );
    case 'frontmatter-provenance':
      return (
        <Trans>
          The provenance, trust, and lifecycle families: sources, generated, verified, status, and
          stale_after. Every field is optional, and absence is never an error.
        </Trans>
      );
    case 'frontmatter-computation':
      return (
        <Trans>
          The attested-computation contract. Only applies to documents typed Attested Computation,
          where OKF requires a runtime; ordinary concepts are unaffected.
        </Trans>
      );
    case 'frontmatter-reserved-index':
      return (
        <Trans>
          Index documents carry no frontmatter, except the one at your knowledge base's root. Log
          documents are not covered — OKF does not constrain their frontmatter.
        </Trans>
      );
    case 'frontmatter-root-index':
      return (
        <Trans>
          On the root index, okf_version is written as a quoted string like "0.2". Unquoted, YAML
          reads it as a number and 0.10 silently becomes 0.1.
        </Trans>
      );
    case 'project-no-mdx':
      return (
        <Trans>
          Any .mdx file. The format is .md-only, so a reader scanning for .md never opens it — and
          if a .md of the same name exists, reads that one instead.
        </Trans>
      );
    default:
      return assertNeverOkfRuleId(id);
  }
}

/** The heading for one group of OKF rules. */
function OkfGroupLabel({ id }: { id: OkfRuleGroupId }) {
  switch (id) {
    case 'structure':
      return <Trans>Document structure</Trans>;
    case 'frontmatter':
      return <Trans>Frontmatter</Trans>;
    case 'project':
      return <Trans>Project</Trans>;
    default:
      return assertNeverOkfRuleGroupId(id);
  }
}

/**
 * When a group's rules behave differently from the rest, say so under its heading.
 * Project rules compare files, so they cannot run against a single open document — a
 * reader watching the Problems panel while typing would otherwise read their silence
 * as a pass.
 */
function OkfGroupNote({ id }: { id: OkfRuleGroupId }) {
  if (id !== 'project') return null;
  return (
    <p className="text-sm text-muted-foreground">
      <Trans>
        This one needs to see your files, not just the open document, so it appears when you run a
        project audit rather than while you type.
      </Trans>
    </p>
  );
}

function OkfRecommendedSkillCard({ packId, name }: { packId: string; name: string }) {
  const { t } = useLingui();
  const skills = useSkills();
  const openSkill = useOpenSkill();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [optimisticStatus, setOptimisticStatus] = useState<'installed' | 'existing' | null>(null);
  const installSkillTriggerRef = useRef<HTMLButtonElement>(null);
  const description = t`Helps coding agents choose OKF document types, preserve provenance, and avoid inventing unsupported metadata.`;
  const entry =
    skills.status === 'ready'
      ? skills.data.find((skill) => skill.scope === 'project' && skill.name === name)
      : undefined;
  const status = entry
    ? entry.origin?.source === OPENKNOWLEDGE_SKILLS_REPO
      ? 'installed'
      : 'existing'
    : optimisticStatus;
  const checking = skills.status === 'idle' || skills.status === 'loading';

  async function installSelected(
    selected: readonly string[],
  ): Promise<ReadonlyMap<string, string> | null> {
    if (!selected.includes(name)) return new Map();
    const result = await installPackSkill(packId);
    if (!result.ok) {
      toast.error(result.error);
      return null;
    }
    const installed = result.skills.find((skill) => skill.name === name);
    const nextStatus = installed?.created === false ? 'existing' : 'installed';
    setOptimisticStatus(nextStatus);
    toast.success(
      nextStatus === 'installed' ? t`OKF agent skill installed` : t`Skill already in project`,
    );
    return new Map([[name, name]]);
  }

  return (
    <>
      <Card size="sm" data-testid="settings-okf-recommended-skill">
        <CardHeader>
          <CardTitle>
            <Trans>Open Knowledge Format guidance</Trans>
          </CardTitle>
          <CardDescription>{description}</CardDescription>
          {status === 'installed' ? (
            <CardAction>
              <Badge variant="secondary">
                <Trans>Installed</Trans>
              </Badge>
            </CardAction>
          ) : status === 'existing' ? (
            <CardAction>
              <Badge variant="outline">
                <Trans>Already in project</Trans>
              </Badge>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardFooter className="justify-end gap-2">
          {status !== null ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => openSkill('project', name)}
            >
              <Trans>Open skill</Trans>
            </Button>
          ) : (
            <Button
              ref={installSkillTriggerRef}
              type="button"
              variant="secondary"
              size="sm"
              disabled={checking}
              onClick={() => setDialogOpen(true)}
            >
              {checking ? <Trans>Checking skill</Trans> : <Trans>Install skill</Trans>}
            </Button>
          )}
        </CardFooter>
      </Card>
      <SkillPluginBundleDialog
        bundle={
          dialogOpen
            ? { plugin: 'OKF', names: [name], descriptions: { [name]: description } }
            : null
        }
        source={OPENKNOWLEDGE_SKILLS_REPO}
        defaultScope="project"
        installOverride={{ scope: 'project', installSelected }}
        onOpenChange={setDialogOpen}
        returnFocus={() => installSkillTriggerRef.current?.focus()}
      />
    </>
  );
}

/**
 * OKF plugin panel: the per-rule on/off list. The plugin's own toggle lives on the
 * Plugins manage page — the sidebar only offers this panel once the plugin is on,
 * so nothing here needs a parent-disabled state.
 *
 * A rule is on unless config says `false`, so the absent case reads as enabled and
 * only deviations are written.
 */
export function OkfPluginSection() {
  const { t } = useLingui();
  const { contentRules, bindingReady, write } = useLinterConfig();
  const rules = contentRules?.okf?.rules;
  const enabledCount = OKF_RULE_IDS.filter((id) => isOkfRuleEnabled(rules, id)).length;
  // Opt-in, unlike the rules: this one writes a file, so absent reads as off.
  const generateIndex = contentRules?.okf?.generate?.index === true;
  const generatedIndexSettings = useGeneratedIndexSettings();
  const generateIndexEnabled = generatedIndexSettings.status?.enabled ?? generateIndex;
  const [confirmingGenerateIndex, setConfirmingGenerateIndex] = useState(false);
  const generateIndexTriggerRef = useRef<HTMLButtonElement>(null);
  const recommendedSkills =
    LINT_PLUGIN_META.find((plugin) => plugin.id === 'okf')?.recommendedSkills ?? [];

  function toggleGenerateIndex(next: boolean): void {
    if (next) {
      // The config write starts generation, so the disclosure must complete before
      // this controlled switch can move to its on state.
      setConfirmingGenerateIndex(true);
      return;
    }
    // This key has a schema default, so `false` is the concrete off state. Unlike
    // rule overrides, disabling never needs the patch walker's delete signal.
    void generatedIndexSettings.setEnabled(false);
  }

  async function confirmGenerateIndex(): Promise<void> {
    await generatedIndexSettings.setEnabled(true);
    setConfirmingGenerateIndex(false);
  }

  function toggleRule(id: OkfRuleId, next: boolean): void {
    // Re-enabling must send an explicit `null`, which the patch walker turns into
    // a `deleteIn`. OMITTING the key does NOT remove it: the walker treats
    // `undefined` as "leave alone" (deep-partial semantics), so a rule switched
    // off would stay off forever with no way back on from this pane.
    const rules: Partial<Record<OkfRuleId, boolean | null>> = {};
    rules[id] = next ? null : false;
    if (write({ okf: { rules } })) {
      emitLintConfigChanged();
    }
  }

  return (
    <section
      aria-labelledby="settings-plugin-okf-title"
      className="space-y-4"
      data-testid="settings-plugin-okf"
    >
      <SettingsSectionHeader
        titleId="settings-plugin-okf-title"
        title="OKF"
        scope="project"
        beta={pluginIsBeta('okf')}
        docUrl={pluginDocUrl('okf')}
      >
        <Trans>Keeps your knowledge base aligned with the Open Knowledge Format.</Trans>
      </SettingsSectionHeader>

      {recommendedSkills.length > 0 ? (
        <div className="flex flex-col gap-2" data-testid="settings-okf-recommended-skills">
          <h4 className="text-sm font-medium">
            <Trans>Recommended agent skill</Trans>
          </h4>
          {recommendedSkills.map((skill) => (
            <OkfRecommendedSkillCard key={skill.name} packId={skill.packId} name={skill.name} />
          ))}
        </div>
      ) : null}

      <div className="space-y-2" data-testid="settings-okf-generated-files">
        <h4 className="text-sm font-medium">
          <Trans>Generated files</Trans>
        </h4>
        <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
          <div className="min-w-0">
            <Label htmlFor="settings-okf-generate-index" className="text-sm font-medium">
              <Trans>Maintain index.md</Trans>
            </Label>
            {/* States ownership plainly, because this is the one setting here
                that writes to the user's tree rather than reporting on it. */}
            <p className="text-sm text-muted-foreground">
              <Trans>
                Open Knowledge maintains a navigation file named index.md in every folder that
                contains Markdown, each listing that folder's documents by type and linking to its
                subfolders. It rewrites these files as your documents change, and anything you edit
                into them yourself is replaced.
              </Trans>
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              <Trans>
                In Git projects, Open Knowledge also adds a scoped .gitattributes rule so concurrent
                index changes combine before the next rebuild.
              </Trans>
            </p>
          </div>
          <Switch
            ref={generateIndexTriggerRef}
            id="settings-okf-generate-index"
            checked={generateIndexEnabled}
            disabled={
              !bindingReady ||
              generatedIndexSettings.status === null ||
              generatedIndexSettings.pending
            }
            onCheckedChange={toggleGenerateIndex}
            aria-label={
              generateIndexEnabled ? t`Stop maintaining index.md` : t`Start maintaining index.md`
            }
            data-testid="settings-okf-generate-index"
          />
        </div>
        <GeneratedIndexSettingsNotice
          enabled={generatedIndexSettings.status?.enabled ?? generateIndex}
          gitState={generatedIndexSettings.status?.git.state}
          issue={generatedIndexSettings.issue}
        />
        <Dialog open={confirmingGenerateIndex} onOpenChange={setConfirmingGenerateIndex}>
          <DialogContent
            className="sm:max-w-lg"
            data-testid="settings-okf-generate-index-confirm"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              generateIndexTriggerRef.current?.focus();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                <Trans>Maintain generated indexes in every folder?</Trans>
              </DialogTitle>
              <DialogDescription className="text-inherit">
                <Trans>
                  Open Knowledge creates and maintains a navigation file named index.md in every
                  folder that contains Markdown.
                </Trans>
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <DisclosureWarning>
                <DisclosureWarningItem
                  icon={
                    <FileText
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    />
                  }
                  title={<Trans>Generated files</Trans>}
                  body={
                    <Trans>
                      Open Knowledge rewrites these index.md files as documents change, so manual
                      edits to them are replaced.
                    </Trans>
                  }
                />
                <DisclosureWarningItem
                  icon={
                    <GitMerge
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    />
                  }
                  title={<Trans>Git merge rule</Trans>}
                  body={
                    <Trans>
                      In Git projects, Open Knowledge adds a scoped rule to the repository-root
                      .gitattributes file so concurrent index changes combine.
                    </Trans>
                  }
                />
                <DisclosureWarningItem
                  icon={
                    <Power
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    />
                  }
                  title={<Trans>Turning it off</Trans>}
                  body={
                    <Trans>
                      The index files stay in place. Open Knowledge removes only the Git rule it
                      added.
                    </Trans>
                  }
                />
              </DisclosureWarning>
            </DialogBody>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">
                  <Trans>Cancel</Trans>
                </Button>
              </DialogClose>
              <Button
                variant="secondary"
                className="font-mono uppercase"
                onClick={() => void confirmGenerateIndex()}
                disabled={generatedIndexSettings.pending}
                data-testid="settings-okf-generate-index-confirm-accept"
              >
                {generatedIndexSettings.pending ? (
                  <>
                    <Spinner aria-hidden="true" />
                    <Trans>Enabling index generation</Trans>
                  </>
                ) : (
                  <Trans>Enable indexes</Trans>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">
          <Trans>Rules</Trans>
        </h4>
        <span className="text-xs text-muted-foreground">
          <Trans>
            {enabledCount}/{OKF_RULE_IDS.length} on
          </Trans>
        </span>
      </div>

      <div className="space-y-4" data-testid="settings-okf-rules-list">
        {OKF_RULE_GROUPS.map((group) => (
          <div
            key={group.id}
            className="space-y-2"
            data-testid={`settings-okf-rule-group-${group.id}`}
          >
            <h5 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <OkfGroupLabel id={group.id} />
            </h5>
            <OkfGroupNote id={group.id} />
            <div className="divide-y rounded-md border">
              {group.ids.map((id) => {
                const on = isOkfRuleEnabled(rules, id);
                return (
                  <div key={id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <Label
                        htmlFor={`settings-okf-rule-toggle-${id}`}
                        className="text-sm font-medium"
                      >
                        {id}
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        <OkfRuleDescription id={id} />
                      </p>
                    </div>
                    <Switch
                      id={`settings-okf-rule-toggle-${id}`}
                      checked={on}
                      disabled={!bindingReady}
                      onCheckedChange={(next) => toggleRule(id, next)}
                      aria-label={on ? t`Disable ${id}` : t`Enable ${id}`}
                      data-testid={`settings-okf-rule-toggle-${id}`}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function GeneratedIndexSettingsNotice({
  enabled,
  gitState,
  issue,
}: {
  enabled: boolean;
  gitState?: 'not-applicable' | 'ready' | 'missing' | 'conflict' | 'unavailable';
  issue: GeneratedIndexSettingsIssue | null;
}) {
  const effectiveIssue =
    issue ??
    (enabled && gitState === 'conflict'
      ? 'git-conflict'
      : enabled && (gitState === 'missing' || gitState === 'unavailable')
        ? 'git-unavailable'
        : null);
  if (effectiveIssue === null) return null;

  return (
    <div
      role="status"
      className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
      data-testid="settings-okf-generate-index-status"
    >
      <CircleAlert
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300"
      />
      <p>
        {effectiveIssue === 'git-conflict' ? (
          <Trans>
            Index maintenance is paused because another Git attribute controls index.md. Update
            .gitattributes so the scoped index.md paths use merge=union, then try again.
          </Trans>
        ) : effectiveIssue === 'config-write' ? (
          <Trans>
            Index maintenance stayed off because the project setting could not be saved. Check the
            project file permissions, then try again.
          </Trans>
        ) : effectiveIssue === 'connection' ? (
          <Trans>
            Index maintenance stayed off because Open Knowledge could not reach the project server.
            Try again when the project reconnects.
          </Trans>
        ) : (
          <Trans>
            Index maintenance is paused because Open Knowledge could not confirm the required Git
            merge rule. Check Git and .gitattributes, then try again.
          </Trans>
        )}
      </p>
    </div>
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
  const pageList = useOptionalPageList();
  // Live count over the project's actual docs — the immediate counterpart to
  // the server's after-the-fact zero-match warning. An authored set matching
  // nothing (the `blog`-instead-of-`blog/**` trap) reads "0 of N" the moment
  // it's typed. A polite status line: zero is de-emphasized rather than
  // alarmed.
  const counted =
    pageList !== null && pageList.pages.size > 0
      ? countMatchingDocs(appliesTo, pageList.pages)
      : null;
  const zeroMatch =
    counted !== null && counted.matched === 0 && appliesToList(appliesTo).length > 0;
  // Diagnose each authored pattern independently: a live sibling must not
  // hide a bare folder name that still matches nothing on its own.
  const zeroMatchPatterns =
    pageList !== null ? findZeroMatchAppliesToPatterns(appliesTo, [...pageList.pages]) : [];
  const zeroMatchBareNameAuthored = zeroMatchPatterns.some((pattern) =>
    summarizeAppliesTo(pattern).includes.some((entry) => entry.kind === 'exact'),
  );
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
      {counted !== null ? (
        <span
          role="status"
          aria-live="polite"
          className={zeroMatch ? 'text-muted-foreground/70' : undefined}
          data-testid={`frontmatter-schema-match-count-${file}`}
        >
          {' '}
          <Plural
            value={counted.total}
            one={
              <Trans>
                Matches {counted.matched} of {counted.total} doc right now.
              </Trans>
            }
            other={
              <Trans>
                Matches {counted.matched} of {counted.total} docs right now.
              </Trans>
            }
          />
          {zeroMatchBareNameAuthored ? (
            <span className="ms-1 text-muted-foreground/60">
              <Trans>(a bare folder name needs /** after it to match what's inside)</Trans>
            </span>
          ) : null}
        </span>
      ) : null}
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
        <div className="mt-2 space-y-1 ps-1.5">
          <Label htmlFor={`frontmatter-schema-applies-${file}`} className="text-xs">
            <Trans>Applies to (globs — leading ! excludes; empty means every doc)</Trans>
          </Label>
          <AppliesToFolderPicker
            file={file}
            globs={appliesToList(mapping?.appliesTo)}
            disabled={disabled}
            onChange={onAppliesToChange}
          />
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
      <SettingsSectionHeader
        titleId="settings-plugin-frontmatter-title"
        title={t`Frontmatter schemas`}
        scope="project"
        beta={pluginIsBeta('frontmatter')}
        docUrl={pluginDocUrl('frontmatter')}
      >
        <Trans>
          Validate document frontmatter against standard JSON Schema files (draft-06, draft-07,
          2019-09, or 2020-12). Toggle a schema on to validate the docs its globs match; violations
          surface as warnings and never block a write. Use Edit to open the schema file.
        </Trans>
      </SettingsSectionHeader>

      {problems.length > 0 && (
        <div
          className="space-y-1 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
          data-testid="frontmatter-config-problems"
        >
          <p className="font-medium">
            <Trans>Configuration problems</Trans>
          </p>
          <ul className="list-disc ps-5 text-muted-foreground">
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
      <AlertDialog
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
      </AlertDialog>
    </section>
  );
}
