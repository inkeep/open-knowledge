import {
  displayCategoryForRule,
  findRuleConfigEntry,
  MARKDOWNLINT_RULE_CATALOG,
  type MarkdownlintRuleSetting,
  type MarkdownlintRuleSeverity,
  type MarkdownlintRuleWriteValue,
  RULE_DISPLAY_CATEGORIES,
  type RuleCatalogEntry,
  type RuleDisplayCategory,
} from '@inkeep/open-knowledge-core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, ChevronRight, Info, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  emitLintConfigChanged,
  useProjectLintConfig,
  writeMarkdownlintRule,
} from '@/editor/lint-config-client';
import { dispatchExternalLinkClick } from '@/lib/external-link';
import { RuleOptionField, type RuleOptionValue } from './rule-option-field';

type RuleValues = Record<string, MarkdownlintRuleSetting>;

interface MarkdownlintRuleBrowserProps {
  hideConfigSourceNote?: boolean;
  initialRuleQuery?: { query: string; nonce: number } | null;
}

export function MarkdownlintRuleBrowser({
  hideConfigSourceNote = false,
  initialRuleQuery,
}: MarkdownlintRuleBrowserProps = {}) {
  const { t } = useLingui();
  const { data } = useProjectLintConfig();
  const ready = data !== null;
  const rules: RuleValues = data?.effective.plugins.markdownlint.rules ?? {};
  const configFile = data?.configFile ?? null;
  const [search, setSearch] = useState(initialRuleQuery?.query ?? '');
  const [onlyModified, setOnlyModified] = useState(false);

  const seedNonce = initialRuleQuery?.nonce;
  const seedQuery = initialRuleQuery?.query;
  useEffect(() => {
    if (seedNonce === undefined || seedQuery === undefined) return;
    setSearch(seedQuery);
  }, [seedNonce, seedQuery]);
  const [collapsed, setCollapsed] = useState<readonly RuleDisplayCategory[]>([]);

  function setRule(ruleId: string, value: MarkdownlintRuleWriteValue | null) {
    void writeMarkdownlintRule(ruleId, value).then((res) => {
      if (!res.ok) {
        toast.error(res.errorDetail ?? t`Failed to update markdownlint rules`);
        return;
      }
      emitLintConfigChanged();
    });
  }

  const filtersActive = search.trim() !== '' || onlyModified;
  const visible = MARKDOWNLINT_RULE_CATALOG.filter(
    (rule) =>
      ruleMatchesSearch(rule, search) &&
      (!onlyModified || isRuleModified(rules, configFile, rule.id)),
  );
  const sections = RULE_DISPLAY_CATEGORIES.map((category) => ({
    category,
    entries: visible.filter((rule) => displayCategoryForRule(rule) === category),
  })).filter((section) => section.entries.length > 0);

  return (
    <div className="space-y-3" data-testid="settings-linting-markdownlint-rules">
      {!hideConfigSourceNote &&
        (!ready ? (
          <div
            className="space-y-2"
            aria-busy="true"
            data-testid="markdownlint-rule-browser-config-loading"
          >
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : configFile ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="markdownlint-config-source-note"
          >
            <Trans>
              These rules come from your project's{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{configFile}</code>{' '}
              file, which fully governs linting for this project. Turn rules on or off and edit
              their options here; changes write back to the file.
            </Trans>
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              <Trans>
                No{' '}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                  .markdownlint.*
                </code>{' '}
                file yet — every rule runs on the same defaults as the VS Code markdownlint
                extension: all on, except line length.
              </Trans>
            </p>
            <p
              className="flex items-start gap-1.5 rounded-md border border-dashed p-2.5 text-sm text-muted-foreground"
              data-testid="markdownlint-no-file-disclaimer"
            >
              <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>
                <Trans>
                  Heads up: editing any rule or option here creates a{' '}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                    .markdownlint.json
                  </code>{' '}
                  file in your project to save your changes.
                </Trans>
              </span>
            </p>
          </div>
        ))}

      <p className="text-sm text-muted-foreground" data-testid="markdownlint-rule-browser-legend">
        <Trans>
          A <span className="font-medium text-foreground">Modified</span> badge marks rules your
          config sets explicitly — directly, or inherited through{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">extends</code>. Unmarked
          rules keep their default state.
        </Trans>
      </p>

      <div className="flex items-center gap-4">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t`Search rules`}
          aria-label={t`Search rules by id, alias, or name`}
          className="h-8"
          data-testid="markdownlint-rule-search"
        />
        <div className="flex shrink-0 items-center gap-2">
          <Checkbox
            id="markdownlint-only-modified"
            checked={onlyModified}
            onCheckedChange={(next) => setOnlyModified(next === true)}
            data-testid="markdownlint-only-modified"
          />
          <Label htmlFor="markdownlint-only-modified" className="text-sm font-normal">
            <Trans>Only modified</Trans>
          </Label>
        </div>
      </div>

      {sections.length === 0 ? (
        <p
          className="rounded-md border border-dashed p-3 text-sm text-muted-foreground"
          data-testid="markdownlint-rule-browser-empty"
        >
          <Trans>No rules match your filters.</Trans>
        </p>
      ) : (
        <div className="space-y-2">
          {sections.map(({ category, entries }) => {
            const enabledCount = entries.filter((rule) =>
              ruleEnabled(governingRuleValue(rules, rule.id)),
            ).length;
            return (
              <Collapsible
                key={category}
                open={filtersActive || !collapsed.includes(category)}
                onOpenChange={(open) =>
                  setCollapsed(
                    open ? collapsed.filter((c) => c !== category) : [...collapsed, category],
                  )
                }
              >
                <CollapsibleTrigger
                  className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-sm font-medium hover:bg-muted/50"
                  data-testid={`markdownlint-rule-category-${categorySlug(category)}`}
                >
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
                  <CategoryLabel category={category} />
                  <span className="ms-auto text-xs font-normal text-muted-foreground tabular-nums">
                    <Trans>
                      {enabledCount}/{entries.length} on
                    </Trans>
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-1 divide-y rounded-md border">
                    {entries.map((rule) => (
                      <RuleRow
                        key={rule.id}
                        rule={rule}
                        value={governingRuleValue(rules, rule.id)}
                        modified={isRuleModified(rules, configFile, rule.id)}
                        ready={ready}
                        onWrite={(value) => setRule(rule.id, value)}
                      />
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RuleRow({
  rule,
  value,
  modified,
  ready,
  onWrite,
}: {
  rule: RuleCatalogEntry;
  value: MarkdownlintRuleSetting;
  modified: boolean;
  ready: boolean;
  onWrite: (value: MarkdownlintRuleWriteValue | null) => void;
}) {
  const { t } = useLingui();
  const enabled = ruleEnabled(value);
  const severity = ruleSeverity(value);
  const opts = optionKeys(value);

  return (
    <Collapsible data-testid={`markdownlint-rule-row-${rule.id}`}>
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        {}
        <CollapsibleTrigger
          className="group flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-0.5 text-left hover:bg-muted/50"
          data-testid={`markdownlint-rule-expand-${rule.id}`}
        >
          <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{rule.name}</span>
        </CollapsibleTrigger>
        <div className="flex shrink-0 items-center gap-2">
          {opts.length > 0 ? (
            <span
              id={`settings-linting-markdownlint-options-${rule.id}`}
              className="text-xs text-muted-foreground"
              title={opts.join(', ')}
              data-testid={`settings-linting-markdownlint-options-${rule.id}`}
            >
              <Plural value={opts.length} one="# option set" other="# options set" />
            </span>
          ) : null}
          {severity !== null ? (
            <Badge variant="gray" data-testid={`markdownlint-rule-severity-${rule.id}`}>
              {severity}
            </Badge>
          ) : null}
          {modified ? (
            <Badge variant="outline" data-testid={`markdownlint-rule-modified-${rule.id}`}>
              <Trans>Modified</Trans>
            </Badge>
          ) : null}
          {modified ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 shrink-0 text-muted-foreground opacity-60 hover:opacity-100"
                  disabled={!ready}
                  aria-label={t`Reset ${rule.id} to default`}
                  onClick={() => onWrite(null)}
                >
                  <RotateCcw className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <Trans>Reset to default</Trans>
              </TooltipContent>
            </Tooltip>
          ) : null}
          <Switch
            id={`markdownlint-rule-toggle-${rule.id}`}
            checked={enabled}
            disabled={!ready}
            aria-label={enabled ? t`Disable ${rule.name}` : t`Enable ${rule.name}`}
            aria-describedby={
              opts.length > 0 ? `settings-linting-markdownlint-options-${rule.id}` : undefined
            }
            onCheckedChange={(next) => onWrite(toggledRuleValue(value, next))}
            data-testid={`markdownlint-rule-toggle-${rule.id}`}
          />
        </div>
      </div>
      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-[collapsible-down_150ms_ease-out] data-[state=closed]:animate-[collapsible-up_150ms_ease-in]">
        <div className="space-y-3 px-3 pb-3 pt-1">
          <p className="text-1sm text-muted-foreground">
            <span className="font-mono">
              {rule.id} · {rule.alias}
            </span>
            {' · '}
            <a
              href={rule.docUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => dispatchExternalLinkClick(e, rule.docUrl)}
              onAuxClick={(e) => dispatchExternalLinkClick(e, rule.docUrl)}
              aria-label={t`Documentation for ${rule.id} (opens in browser)`}
              className="inline-flex items-center gap-0.5 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              <Trans>Documentation</Trans>
              <ArrowUpRight aria-hidden className="size-3" />
            </a>
          </p>
          {rule.options.map((spec) => (
            <RuleOptionField
              key={spec.key}
              ruleId={rule.id}
              spec={spec}
              value={ruleOptionValueOf(value, spec.key)}
              disabled={!ready}
              onChange={(next) => onWrite(ruleValueWithOption(value, spec.key, next))}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function CategoryLabel({ category }: { category: RuleDisplayCategory }) {
  switch (category) {
    case 'Headings':
      return <Trans>Headings</Trans>;
    case 'Lists':
      return <Trans>Lists</Trans>;
    case 'Whitespace':
      return <Trans>Whitespace</Trans>;
    case 'Code':
      return <Trans>Code</Trans>;
    case 'Links & images':
      return <Trans>Links & images</Trans>;
    case 'Style':
      return <Trans>Style</Trans>;
    default:
      return category satisfies never;
  }
}

function categorySlug(category: RuleDisplayCategory): string {
  return category
    .toLowerCase()
    .replace(/[^a-z]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function governingRuleValue(rules: RuleValues, ruleId: string): MarkdownlintRuleSetting {
  const entry = findRuleConfigEntry(rules, ruleId);
  if (entry !== undefined) return entry.value as MarkdownlintRuleSetting;
  return rules.default ?? true;
}

export function isRuleModified(
  rules: RuleValues,
  configFile: string | null,
  ruleId: string,
): boolean {
  return configFile !== null && findRuleConfigEntry(rules, ruleId) !== undefined;
}

export function ruleSeverity(value: MarkdownlintRuleSetting): MarkdownlintRuleSeverity | null {
  return typeof value === 'string' ? value : null;
}

export function ruleMatchesSearch(rule: RuleCatalogEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return (
    rule.id.toLowerCase().includes(q) ||
    rule.alias.toLowerCase().includes(q) ||
    rule.name.toLowerCase().includes(q)
  );
}

export function ruleEnabled(value: MarkdownlintRuleSetting): boolean {
  if (typeof value !== 'object' || value === null) return value !== false;
  return (value as { enabled?: unknown }).enabled !== false;
}

export function optionKeys(value: MarkdownlintRuleSetting): string[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.keys(value).filter((key) => key !== 'enabled');
}

export function toggledRuleValue(
  value: MarkdownlintRuleSetting,
  nextEnabled: boolean,
): MarkdownlintRuleWriteValue {
  if (typeof value !== 'object' || value === null) return nextEnabled;
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (key !== 'enabled') rest[key] = (value as Record<string, unknown>)[key];
  }
  if (Object.keys(rest).length === 0) return nextEnabled;
  return nextEnabled ? rest : { ...rest, enabled: false };
}

export function ruleValueWithOption(
  value: MarkdownlintRuleSetting,
  key: string,
  optionValue: RuleOptionValue,
): MarkdownlintRuleWriteValue {
  if (typeof value === 'object' && value !== null) return { ...value, [key]: optionValue };
  if (value === false) return { enabled: false, [key]: optionValue };
  return { [key]: optionValue };
}

function ruleOptionValueOf(value: MarkdownlintRuleSetting, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}
