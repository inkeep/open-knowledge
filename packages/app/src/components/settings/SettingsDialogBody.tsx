// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
/**
 * Lazy body for the Settings modal — pulled in as a separate chunk by
 * `SettingsDialogShell.tsx` via `React.lazy`. Receives the active
 * sidebar section id + the user/okignore bindings (already gated by
 * their synced state at the shell level) and dispatches to the section
 * components.
 *
 * The shell ships Dialog/Sidebar/skeleton synchronously so the dialog
 * frame paints immediately on Cmd-,; this file's ~330kB of schema-form
 * harness (ConfigSchema, react-hook-form, schema-walker) + heavy
 * section bodies (Sync/Templates/Okignore/Integrations) loads in
 * parallel and swaps in.
 *
 * The user-scope ConfigBinding is owned by ConfigProvider for the app
 * session — see `lib/config-provider.tsx`. The body is a pure consumer
 * of the props the shell passes (no provider creation, no per-open
 * teardown).
 *
 * Auto-save: per-control commits via `binding.patch`. Client-side L1
 * validation gates writes. Per-field reset writes the schema default
 * (or null per RFC 7396 for fields without a default).
 *
 * L3 rejection from non-pane writers (CLI, MCP, hand-edit) surfaces
 * as a sonner toast + brief field flash on the matching scope's
 * section (when mounted).
 *
 * The Integrations section's "Install in Claude Desktop" row opens
 * `<InstallInClaudeDesktopDialog>` (its own internal Dialog).
 */

import {
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_USER,
  type Config,
  type ConfigBinding,
  ConfigSchema,
  type ConfigValidationError,
  DEFAULT_ATTACHMENT_FOLDER_PATH,
  getFieldMeta,
  humanFormat,
  isKnownConfigError,
  normalizeAttachmentFolderPath,
  type OkignoreBinding,
  SHOW_INSTALL_SKILL,
} from '@inkeep/open-knowledge-core';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, Check, ChevronRight, RotateCcw } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useRef, useState } from 'react';
import { type ControllerRenderProps, type FieldPath, useFormContext } from 'react-hook-form';
import { toast } from 'sonner';
import { AuthModal } from '@/components/AuthModal';
import { EnableSyncConfirmDialog } from '@/components/EnableSyncConfirmDialog';
import { InstallInClaudeDesktopDialog } from '@/components/InstallInClaudeDesktopDialog';
import { PublishToGitHubDialog } from '@/components/PublishToGitHubDialog';
import {
  formatPausedReason,
  shouldDisableSyncSwitch,
  shouldOfferSignInAgain,
} from '@/components/SyncStatusBadge';
import { SharingSection } from '@/components/settings/SharingSection';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  useEnableSyncWithConfirm,
  useSyncDefaultWriter,
  useSyncEnabledWriter,
} from '@/hooks/use-enable-sync-with-confirm';
import { useGitSyncStatus } from '@/hooks/use-git-sync-status';
import { useConfigContext } from '@/lib/config-provider';
import { subscribeToConfigValidationRejected } from '@/lib/config-validation-events';
import { useClaudeDesktopIntegration } from '@/lib/handoff/use-claude-desktop-integration';
import {
  formatShortcutBinding,
  formatShortcutTextLabel,
  KEYBOARD_SHORTCUTS,
  SHORTCUT_CATEGORY_LABELS,
  SHORTCUT_CATEGORY_ORDER,
  type ShortcutBinding,
} from '@/lib/keyboard-shortcuts';
import { cn } from '@/lib/utils';
import { AccountSection } from './AccountSection';
import { EmbeddingsKeySection } from './EmbeddingsKeySection';
import { OkignoreSection } from './OkignoreSection';
import { ProjectTemplatesSection } from './ProjectTemplatesSection';
import { SearchSection } from './SearchSection';
import { SkillsManagerSection } from './SkillsManagerSection';
import {
  getEnumOptions,
  getFieldDefault,
  getLeafTypeTag,
  resolveLeafSchema,
} from './schema-walker';
import type { SlotForwardedProps } from './slot-forwarded-props';
import { TerminalSection } from './TerminalSection';
import { pickFirstIssueForPath, useConfigForm } from './use-config-form';

/**
 * Internal scope tag for routing each section to its config binding.
 * Not exposed to the user — there's no top-level scope toggle in the
 * new design. Sections under USER use the user binding; sections under
 * THIS PROJECT use the project binding.
 */
type Scope = 'user' | 'project';

interface FieldDef {
  path: string[];
  label: MessageDescriptor;
  description?: MessageDescriptor;
  /** Optional override: 'enum-toggle' renders enum as a ToggleGroup; default is select-style toggle. */
  control?: 'enum-toggle';
}

const FIELDS_USER_PREFERENCES: FieldDef[] = [
  {
    path: ['appearance', 'theme'],
    label: msg`Theme`,
    description: msg`Light, dark, or follow the OS.`,
    control: 'enum-toggle',
  },
  {
    path: ['editor', 'wordWrap'],
    label: msg`Word wrap`,
    description: msg`Wrap long lines in the markdown source editor.`,
  },
  {
    path: ['appearance', 'preview', 'autoOpen'],
    label: msg`Open preview when agent edits`,
    description: msg`When enabled, the agent opens or refreshes the preview after each edit. Disable if you manage your own preview window (OK Desktop, a browser tab on another display, etc.).`,
  },
];

// The selected committed-default option uses the app's primary blue (the same
// token as the Button default variant), not the muted ToggleGroup default, so
// the active stance reads as clearly chosen and matches the accent used
// elsewhere in the app.
const COMMITTED_DEFAULT_SELECTED_CLASS =
  'data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90';

interface SettingsDialogBodyProps {
  activeId: string;
  userBinding: ConfigBinding | null;
  okignoreBinding: OkignoreBinding | null;
  okignoreSynced: boolean;
}

export function SettingsDialogBody({
  activeId,
  userBinding,
  okignoreBinding,
  okignoreSynced,
}: SettingsDialogBodyProps) {
  const { t } = useLingui();
  if (activeId === 'preferences') {
    return (
      <div className="space-y-8">
        {userBinding ? (
          <BoundSchemaSection
            title={t`Preferences`}
            description={t`Customize how the editor looks and behaves.`}
            scope="user"
            binding={userBinding}
            fields={FIELDS_USER_PREFERENCES}
          />
        ) : (
          <SectionSkeleton />
        )}
        <AttachmentsSection />
      </div>
    );
  }
  if (activeId === 'hotkeys') {
    return <HotkeysSection />;
  }
  if (activeId === 'account') {
    // Two machine-global credentials live here: the GitHub account and the
    // embeddings provider key (the latter shared across all projects; semantic
    // search is enabled per-project in This project → Search).
    return (
      <div className="space-y-8">
        <AccountSection />
        <EmbeddingsKeySection />
      </div>
    );
  }
  if (activeId === 'sync') {
    // When there's no git remote, SyncSection renders a setup CTA (the
    // Publish-to-GitHub wizard) rather than the auto-sync toggle. (Preview
    // was a sibling here until `preview.baseUrl` was removed from the
    // schema; if a project-scope setting reappears, stack it alongside
    // `<SyncSection />` again and rename the sidebar item back to something
    // more general.)
    return <SyncSection />;
  }
  if (activeId === 'search') {
    // Project-local semantic-search opt-in. Reads its own project-local
    // binding from ConfigContext (like SyncSection) — no prop threading.
    return <SearchSection />;
  }
  if (activeId === 'terminal') {
    // Desktop-only per-project shell consent (the nav item is gated to the
    // Electron host). Reads + writes its own project-local binding.
    return <TerminalSection />;
  }
  if (activeId === 'project-templates') {
    return <ProjectTemplatesSection />;
  }
  if (activeId === 'skills') {
    return <SkillsManagerSection />;
  }
  if (activeId === 'sharing') {
    return <SharingSection />;
  }
  if (activeId === 'okignore') {
    // Project-scope `.okignore` editor. Binding is shared with the
    // FileTree right-click "Hide this file/folder" affordance via
    // `<ConfigProvider>` — both write to the same Y.Text body.
    return <OkignoreSection binding={okignoreBinding} synced={okignoreSynced} />;
  }
  if (activeId === 'claude-desktop') {
    return <IntegrationsSection />;
  }
  return null;
}

function firstIssuePath(error: ConfigValidationError): string | null {
  if (!isKnownConfigError(error) || error.code !== 'SCHEMA_INVALID') return null;
  const first = error.issues[0];
  if (!first || first.path.length === 0) return null;
  return first.path.map(String).join('.');
}

function SectionSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-4 w-64" />
      <div className="space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    </div>
  );
}

function ShortcutBindingChips({ binding }: { binding: ShortcutBinding }) {
  return formatShortcutBinding(binding)
    .split(' / ')
    .map((part, index) =>
      index === 0 ? (
        <Kbd key={`kbd-${part}`} aria-label={formatShortcutTextLabel(part)}>
          {part}
        </Kbd>
      ) : (
        <span key={`or-${part}`} className="inline-flex items-center gap-1.5">
          <span className="sr-only">
            <Trans> or </Trans>
          </span>
          <span aria-hidden="true"> / </span>
          <Kbd aria-label={formatShortcutTextLabel(part)}>{part}</Kbd>
        </span>
      ),
    );
}

function HotkeysSection() {
  const { t } = useLingui();
  const titleId = 'settings-hotkeys-title';
  return (
    <section aria-labelledby={titleId} className="space-y-5" data-testid="settings-hotkeys">
      <div className="space-y-1">
        <h3 id={titleId} className="text-base font-semibold">
          <Trans>Hotkeys</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          <Trans>Keyboard shortcuts available in the editor and workspace.</Trans>
        </p>
      </div>

      <div className="space-y-6" data-testid="settings-hotkeys-list">
        {SHORTCUT_CATEGORY_ORDER.map((category) => {
          const shortcuts = KEYBOARD_SHORTCUTS.filter((shortcut) => shortcut.category === category);
          if (shortcuts.length === 0) return null;

          return (
            <section key={category} aria-labelledby={`settings-hotkeys-${category}`}>
              <h4
                id={`settings-hotkeys-${category}`}
                className="mb-2 font-mono text-muted-foreground text-xs uppercase tracking-wide"
              >
                {t(SHORTCUT_CATEGORY_LABELS[category])}
              </h4>
              <ul
                aria-labelledby={`settings-hotkeys-${category}`}
                className="m-0 list-none overflow-hidden rounded-md border p-0"
              >
                {shortcuts.map((shortcut) => {
                  const shortcutTitleId = `settings-hotkey-${shortcut.id}-title`;
                  const shortcutDescriptionId = `settings-hotkey-${shortcut.id}-description`;
                  const bindingChipCount = shortcut.bindings.reduce(
                    (count, binding) => count + formatShortcutBinding(binding).split(' / ').length,
                    0,
                  );
                  const hasDenseBindings = bindingChipCount > 4;

                  return (
                    <li
                      key={shortcut.id}
                      aria-describedby={shortcutDescriptionId}
                      aria-labelledby={shortcutTitleId}
                      className={cn(
                        'grid gap-2 border-border border-b px-3 py-3 last:border-b-0',
                        hasDenseBindings
                          ? 'sm:grid-cols-1'
                          : 'sm:grid-cols-[minmax(0,1fr)_minmax(0,auto)]',
                      )}
                      data-testid={`settings-hotkey-${shortcut.id}`}
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-sm" id={shortcutTitleId}>
                            {t(shortcut.title)}
                          </p>
                          <Badge variant="gray">
                            <span className="sr-only">
                              <Trans>Scope: </Trans>
                            </span>
                            {t(shortcut.scope)}
                          </Badge>
                        </div>
                        <p className="text-muted-foreground text-sm" id={shortcutDescriptionId}>
                          {t(shortcut.description)}
                        </p>
                      </div>
                      <div
                        className={cn(
                          'flex min-w-0 max-w-full self-start content-start flex-wrap items-start gap-1.5',
                          hasDenseBindings ? 'sm:justify-start' : 'sm:max-w-[38rem] sm:justify-end',
                        )}
                      >
                        {shortcut.bindings.map((binding) => (
                          <ShortcutBindingChips
                            key={`${shortcut.id}-${binding.mac}-${binding.windowsLinux}`}
                            binding={binding}
                          />
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </section>
  );
}

interface BoundSchemaSectionProps {
  title: string;
  description: string;
  scope: Scope;
  binding: ConfigBinding;
  fields: FieldDef[];
}

/**
 * Mounts the harness (`useConfigForm`) once per binding identity and
 * wraps the body in shadcn's `<Form>` (RHF's `FormProvider`). One per
 * scope; both scopes' sections live under the same dialog so each has
 * its own form instance.
 *
 * Owns the CC1 `'config-validation-rejected'` subscription scoped to
 * the matching docName, plus the per-field flash state — both need
 * access to the form. The toast fires for any rejection on this scope;
 * `setError` + `setFocus` + `flash` only fire when the field's section
 * is the active one (the form is unmounted otherwise, so nothing to
 * flash).
 */
function BoundSchemaSection({
  title,
  description,
  scope,
  binding,
  fields,
}: BoundSchemaSectionProps) {
  const { form, commitField } = useConfigForm(binding);
  const [flashedPath, setFlashedPath] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const docName = scope === 'project' ? CONFIG_DOC_NAME_PROJECT : CONFIG_DOC_NAME_USER;
    const unsubscribe = subscribeToConfigValidationRejected((event) => {
      if (event.docName !== docName) return;

      // Toast carries the full multi-line summary (humanFormat); the
      // inline FormMessage shows only the path-matched issue so the
      // field doesn't render a multi-line block with file paths and
      // caret markers.
      toast.error(humanFormat(event.error), { duration: 8000 });

      const path = firstIssuePath(event.error);
      if (path) {
        form.setError(path as FieldPath<Config>, {
          type: 'config-validation-rejected',
          message: pickFirstIssueForPath(event.error, path),
        });
        form.setFocus(path as FieldPath<Config>);
        setFlashedPath(path);
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => {
          setFlashedPath(null);
          // Clear the inline error alongside the flash. The toast
          // (8s) remains the persistent feedback channel; if the
          // external writer corrected the value via Y.Text,
          // `applyExternalUpdate` already updated the field — we
          // don't want a stale red FormMessage lingering on a
          // now-valid value.
          form.clearErrors(path as FieldPath<Config>);
        }, 600);
      }
    });
    return () => {
      unsubscribe();
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, [scope, form]);

  return (
    <Form {...form}>
      <SchemaSection
        title={title}
        description={description}
        scope={scope}
        fields={fields}
        commitField={commitField}
        flashedPath={flashedPath}
      />
    </Form>
  );
}

interface SchemaSectionProps {
  title: string;
  description: string;
  scope: Scope;
  fields: FieldDef[];
  commitField: (name: FieldPath<Config>) => boolean;
  flashedPath: string | null;
}

function SchemaSection({
  title,
  description,
  scope,
  fields,
  commitField,
  flashedPath,
}: SchemaSectionProps) {
  const titleId = `settings-section-${scope}-title`;
  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <div className="space-y-1">
        <h3 id={titleId} className="text-base font-semibold">
          {title}
        </h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="space-y-10">
        {fields.map((field) => (
          <SettingsField
            key={field.path.join('.')}
            field={field}
            scope={scope}
            commitField={commitField}
            isFlashed={flashedPath === field.path.join('.')}
          />
        ))}
      </div>
    </section>
  );
}

type AttachmentPlacementMode =
  | 'same-folder'
  | 'content-root'
  | 'current-folder-subfolder'
  | 'content-root-folder';

const ATTACHMENT_FIELD_NAME = 'content.attachmentFolderPath';
const ATTACHMENT_FALLBACK_FOLDER = 'attachments';

function attachmentModeFromPath(path: string): AttachmentPlacementMode {
  const normalized = normalizeAttachmentFolderPath(path);
  if (normalized === DEFAULT_ATTACHMENT_FOLDER_PATH) return 'same-folder';
  if (normalized === '/') return 'content-root';
  if (normalized.startsWith('./')) return 'current-folder-subfolder';
  return 'content-root-folder';
}

function attachmentFolderTextFromPath(path: string): string {
  const normalized = normalizeAttachmentFolderPath(path);
  if (normalized === DEFAULT_ATTACHMENT_FOLDER_PATH || normalized === '/') {
    return ATTACHMENT_FALLBACK_FOLDER;
  }
  if (normalized.startsWith('./')) {
    return normalized.slice(2) || ATTACHMENT_FALLBACK_FOLDER;
  }
  return normalized;
}

function normalizeAttachmentFolderInput(value: string): string {
  return value
    .trim()
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/g, '');
}

function attachmentPathFromMode(mode: AttachmentPlacementMode, folderText: string): string {
  const folder = normalizeAttachmentFolderInput(folderText) || ATTACHMENT_FALLBACK_FOLDER;
  if (mode === 'same-folder') return DEFAULT_ATTACHMENT_FOLDER_PATH;
  if (mode === 'content-root') return '/';
  if (mode === 'current-folder-subfolder') return `./${folder}`;
  return folder;
}

// The mode select and folder input are one config leaf, so this needs a
// small custom state machine instead of the single-field BoundSchemaSection.
function AttachmentsSection() {
  const { projectBinding, projectConfig, projectSynced } = useConfigContext();
  if (!projectBinding || !projectSynced || !projectConfig) {
    return <SectionSkeleton />;
  }
  const attachmentFolderPath =
    projectConfig.content.attachmentFolderPath ?? DEFAULT_ATTACHMENT_FOLDER_PATH;
  return (
    <AttachmentsSectionBody
      key={attachmentFolderPath}
      binding={projectBinding}
      value={attachmentFolderPath}
    />
  );
}

function AttachmentsSectionBody({ binding, value }: { binding: ConfigBinding; value: string }) {
  const { t } = useLingui();
  const [mode, setMode] = useState<AttachmentPlacementMode>(() => attachmentModeFromPath(value));
  const [folderText, setFolderText] = useState(() => attachmentFolderTextFromPath(value));
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);
  const [flashed, setFlashed] = useState(false);
  const savedTickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (savedTickTimerRef.current) clearTimeout(savedTickTimerRef.current);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const unsubscribe = subscribeToConfigValidationRejected((event) => {
      if (event.docName !== CONFIG_DOC_NAME_PROJECT) return;
      if (firstIssuePath(event.error) !== ATTACHMENT_FIELD_NAME) return;
      const issue = pickFirstIssueForPath(event.error, ATTACHMENT_FIELD_NAME);
      toast.error(humanFormat(event.error), { duration: 8000 });
      setError(issue);
      setFlashed(true);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => {
        setFlashed(false);
        setError(null);
      }, 600);
    });
    return unsubscribe;
  }, []);

  const flashSavedTick = () => {
    setSavedTick(true);
    if (savedTickTimerRef.current) clearTimeout(savedTickTimerRef.current);
    savedTickTimerRef.current = setTimeout(() => setSavedTick(false), 1200);
  };

  const commitPath = (nextPath: string) => {
    const result = binding.patch({ content: { attachmentFolderPath: nextPath } });
    if (result.ok) {
      setError(null);
      flashSavedTick();
      return;
    }
    const detail = pickFirstIssueForPath(result.error, ATTACHMENT_FIELD_NAME);
    setError(detail);
    toast.error(t`Failed to update attachment location — ${detail}`);
  };

  const onModeChange = (next: string) => {
    if (
      next !== 'same-folder' &&
      next !== 'content-root' &&
      next !== 'current-folder-subfolder' &&
      next !== 'content-root-folder'
    ) {
      return;
    }
    const nextMode = next as AttachmentPlacementMode;
    const nextFolderText =
      nextMode === 'current-folder-subfolder' || nextMode === 'content-root-folder'
        ? folderText || ATTACHMENT_FALLBACK_FOLDER
        : folderText;
    setMode(nextMode);
    setFolderText(nextFolderText);
    commitPath(attachmentPathFromMode(nextMode, nextFolderText));
  };

  const commitFolderText = () => {
    const nextPath = attachmentPathFromMode(mode, folderText);
    setFolderText(attachmentFolderTextFromPath(nextPath));
    commitPath(nextPath);
  };

  const showsFolderInput = mode === 'current-folder-subfolder' || mode === 'content-root-folder';
  const labelId = 'settings-attachments-location-label';
  const inputId = 'settings-attachments-folder-input';

  return (
    <section
      aria-labelledby="settings-attachments-title"
      className="space-y-3"
      data-testid="settings-attachments"
    >
      <div className="space-y-1">
        <h3 id="settings-attachments-title" className="text-base font-semibold">
          <Trans>Attachments</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          <Trans>Set where pasted and dropped files are stored for this project.</Trans>
        </p>
      </div>

      <div
        className={cn('rounded-md border p-3', flashed && 'animate-settings-flash')}
        data-field={ATTACHMENT_FIELD_NAME}
        data-scope="project"
      >
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(16rem,18rem)] sm:items-start">
          <div className="space-y-0.5">
            <div className="text-sm font-medium" id={labelId}>
              <Trans>Default location for new attachments</Trans>
            </div>
            <p className="text-muted-foreground text-1sm">
              <Trans>Where newly added attachments are placed.</Trans>
            </p>
          </div>
          <Select value={mode} onValueChange={onModeChange}>
            <SelectTrigger
              aria-labelledby={labelId}
              data-testid="settings-attachments-mode"
              size="sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="same-folder">
                <Trans>Same folder as current file</Trans>
              </SelectItem>
              <SelectItem value="content-root">
                <Trans>Content root</Trans>
              </SelectItem>
              <SelectItem value="current-folder-subfolder">
                <Trans>Subfolder under current folder</Trans>
              </SelectItem>
              <SelectItem value="content-root-folder">
                <Trans>Fixed folder in content root</Trans>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {showsFolderInput ? (
          <div className="mt-3 max-w-sm space-y-1">
            <label className="text-sm font-medium" htmlFor={inputId}>
              <Trans>Folder</Trans>
            </label>
            <Input
              id={inputId}
              value={folderText}
              placeholder={t`e.g. assets/uploads`}
              onChange={(event) => setFolderText(event.target.value)}
              onBlur={commitFolderText}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitFolderText();
                }
              }}
              className="h-8 text-sm"
              data-testid="settings-attachments-folder"
            />
          </div>
        ) : null}

        <div className="mt-2 flex min-h-5 items-center gap-2">
          {error ? (
            <p
              className="text-1sm text-destructive"
              data-field-error={ATTACHMENT_FIELD_NAME}
              role="alert"
            >
              {error}
            </p>
          ) : null}
          <SavedIndicator visible={savedTick} />
        </div>
      </div>
    </section>
  );
}

/**
 * Sync section — surface the git auto-sync toggle in Settings so users
 * have a deliberate path to re-enable when the header badge is hidden
 * (state === 'disabled' hides the badge).
 *
 * The toggle writes through the project-local ConfigBinding so the choice
 * lands in `<projectDir>/.ok/local/config.yml`; the file watcher then drives
 * the SyncEngine to match.
 */
function SyncSection() {
  const { t } = useLingui();
  const status = useGitSyncStatus();
  const { projectConfig, projectLocalConfig, projectLocalSynced, projectSynced } =
    useConfigContext();
  const writer = useSyncEnabledWriter();
  const defaultWriter = useSyncDefaultWriter();
  const { confirmOpen, setConfirmOpen, onToggleRequest, onConfirm } =
    useEnableSyncWithConfirm(writer);
  const [publishOpen, setPublishOpen] = useState(false);
  // Local AuthModal control for the Sign-in-again affordance surfaced when
  // the probe returns 401. The editor header has its own AuthModal — settings
  // doesn't share it, so the section owns one locally (same pattern as
  // AccountSection).
  const [authModalOpen, setAuthModalOpen] = useState(false);

  // No git remote configured — instead of dead-ending on a CLI instruction,
  // lead with the outcome (back up + share) and offer the existing
  // Publish-to-GitHub wizard, which creates a repo and connects it with no
  // terminal. The raw `git remote add` path stays as an Advanced disclosure
  // for users who already have a repository.
  if (status && !status.hasRemote && status.state === 'dormant') {
    return (
      <section
        aria-labelledby="settings-sync-title"
        className="space-y-4"
        data-testid="settings-sync-empty"
      >
        <div className="space-y-1">
          <h3 id="settings-sync-title" className="text-base font-semibold">
            <Trans>Sync</Trans>
          </h3>
          <p className="text-sm text-muted-foreground">
            <Trans>
              This project lives only on this computer. Connect it to GitHub to back it up and share
              it with other people.
            </Trans>
          </p>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-md border p-3">
          <div className="space-y-0.5">
            <div className="text-sm font-medium">
              <Trans>Connect to GitHub</Trans>
            </div>
            <p className="text-muted-foreground text-1sm">
              <Trans>We'll create a repository and start syncing — no terminal needed.</Trans>
            </p>
          </div>
          <Button onClick={() => setPublishOpen(true)} data-testid="settings-sync-setup">
            <Trans>Set up syncing</Trans>
          </Button>
        </div>

        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="group gap-1 px-1.5 text-muted-foreground">
              <ChevronRight
                className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
                aria-hidden
              />
              <Trans>Connect an existing repository</Trans>
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="px-1.5 pt-2 text-sm text-muted-foreground">
            <Trans>
              Already have a git repository? Add it with{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                git remote add origin &lt;url&gt;
              </code>{' '}
              in this project's folder. This page updates automatically once a remote is detected.
            </Trans>
          </CollapsibleContent>
        </Collapsible>

        <PublishToGitHubDialog open={publishOpen} onOpenChange={setPublishOpen} />
      </section>
    );
  }

  // Read user intent from the synchronous local CRDT preference (the same
  // binding `useSyncEnabledWriter` writes to). Don't read from the server's
  // engine-state projection — that round-trips through ~2 s persistence
  // debounce + chokidar settle + 100 ms CC1 debounce, making the Switch
  // appear to lag every click.
  const enabled = projectLocalConfig?.autoSync?.enabled ?? false;
  // Mirrors the SyncStatusBadge popover so both surfaces gate identically.
  // Disable on cold start OR on a denied probe; never disable on
  // undefined / unknown / pending (preserves read+write parity).
  const disabledControl = shouldDisableSyncSwitch(
    projectLocalSynced,
    status?.pushPermission?.checkStatus,
  );
  // Whether the body line should carry the no-permission copy inline (instead
  // of the standard "your edits stay local" string + a redundant paragraph
  // underneath). Fires for both the probe-`denied` path AND the in-memory
  // pause path (autoSync was already enabled when probe came back denied —
  // engine sets `pausedReason='no-push-permission'`).
  const isPushDenied =
    status?.pushPermission?.checkStatus === 'denied' ||
    status?.pausedReason === 'no-push-permission';
  const sectionMessage =
    isPushDenied || !status?.pausedReason ? null : formatPausedReason(status.pausedReason);

  // Committed project default (`autoSync.default`) — the maintainer-facing,
  // git-shared seed for everyone's first open. true/false/null map to the three
  // ToggleGroup options; `null` (ask) is the absence of a committed seed.
  const committedDefault = projectConfig?.autoSync?.default ?? null;
  const committedDefaultValue =
    committedDefault === true ? 'on' : committedDefault === false ? 'off' : 'ask';
  function onCommittedDefaultChange(next: string) {
    // Radix single ToggleGroup emits '' when the active item is re-pressed
    // (deselect) — ignore it so there is always exactly one committed stance.
    if (next !== 'ask' && next !== 'on' && next !== 'off') return;
    if (defaultWriter === null) {
      toast.error(t`Sync settings not yet loaded — try again in a moment`);
      return;
    }
    // 'ask' writes null, which clears the committed key (RFC 7396 merge-patch) →
    // unanswered machines see the onboarding prompt again.
    const value = next === 'on' ? true : next === 'off' ? false : null;
    const result = defaultWriter(value);
    if (!result.ok) {
      const detail = result.error;
      toast.error(t`Failed to update the project sync default — ${detail}`);
    }
  }

  return (
    <section aria-labelledby="settings-sync-title" className="space-y-3">
      <div className="space-y-1">
        <h3 id="settings-sync-title" className="text-base font-semibold">
          <Trans>Sync</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          <Trans>
            Auto-sync pushes/pulls commits to your git remote on intervals and on save. Toggling on
            requires confirmation.
          </Trans>
        </p>
      </div>
      <div className="rounded-md border p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <label htmlFor="settings-sync-toggle" className="text-sm font-medium">
              <Trans>Git auto-sync</Trans>
            </label>
            <p className="text-muted-foreground text-1sm" data-testid="settings-sync-body">
              {isPushDenied ? (
                // Probe denied (or engine paused in-memory because autoSync was
                // already on when probe denied). Replace the standard body copy
                // with the permission-specific message — the redundant
                // sectionMessage paragraph below is suppressed in this case.
                <Trans>Auto-sync is off — you don't have permission to push to this repo</Trans>
              ) : enabled ? (
                <Trans>
                  Auto-sync is on — your commits push and remote changes pull on intervals.
                </Trans>
              ) : (
                <Trans>
                  Auto-sync is off — your edits stay local until you commit and push manually.
                </Trans>
              )}
            </p>
            {status?.remote ? (
              <p
                className="text-muted-foreground text-1sm truncate"
                data-testid="settings-sync-remote"
              >
                <Trans>Connected to</Trans>{' '}
                {status.remote.webUrl ? (
                  <a
                    href={status.remote.webUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-foreground hover:text-primary hover:underline inline-flex items-center gap-0.5"
                    aria-label={t`Open ${status.remote.label} on GitHub (opens in a new tab)`}
                    data-testid="settings-sync-remote-link"
                  >
                    <span>{status.remote.label}</span>
                    <ArrowUpRight className="inline size-3.5" aria-hidden />
                  </a>
                ) : (
                  <span
                    className="font-medium text-foreground"
                    data-testid="settings-sync-remote-label"
                  >
                    {status.remote.label}
                  </span>
                )}
              </p>
            ) : null}
          </div>
          <Switch
            id="settings-sync-toggle"
            checked={enabled}
            disabled={disabledControl}
            onCheckedChange={onToggleRequest}
            aria-label={
              status?.pushPermission?.checkStatus === 'denied'
                ? t`Sync disabled — you don't have permission to push`
                : enabled
                  ? t`Disable git auto-sync`
                  : t`Enable git auto-sync`
            }
            data-testid="settings-sync-toggle"
          />
        </div>
        {sectionMessage !== null && (
          <p className="text-1sm text-muted-foreground mt-2" data-testid="settings-sync-reason">
            {sectionMessage}
          </p>
        )}
        {shouldOfferSignInAgain(status?.pushPermission) && (
          // Probe-401 ('unknown/token-invalid') surfaces a Sign in again
          // affordance without disabling sync. Mirrors the popover so both
          // surfaces gate identically.
          <div className="mt-2 flex items-start gap-2" data-testid="settings-sync-signin-again">
            <p className="text-1sm text-muted-foreground flex-1 min-w-0">
              <Trans>Your GitHub session expired — sign in again to verify push access.</Trans>
            </p>
            <Button
              variant="outline"
              size="xs"
              className="self-start"
              onClick={() => setAuthModalOpen(true)}
            >
              <Trans>Sign in</Trans>
            </Button>
          </div>
        )}
      </div>
      <div className="rounded-md border p-3 space-y-2" data-testid="settings-sync-default">
        <div className="space-y-0.5">
          <div className="text-sm font-medium">
            <Trans>Shared default</Trans>
          </div>
          <p className="text-muted-foreground text-1sm">
            <Trans>
              Set the auto-sync default for users opening this project for the first time. This
              setting is committed to your repository.
            </Trans>
          </p>
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={2}
          value={committedDefaultValue}
          onValueChange={onCommittedDefaultChange}
          disabled={!projectSynced}
          aria-label={t`Shared auto-sync default`}
          data-testid="settings-sync-default-toggle"
        >
          <ToggleGroupItem
            value="ask"
            className={COMMITTED_DEFAULT_SELECTED_CLASS}
            data-testid="settings-sync-default-ask"
          >
            <Trans>None</Trans>
          </ToggleGroupItem>
          <ToggleGroupItem
            value="on"
            className={COMMITTED_DEFAULT_SELECTED_CLASS}
            data-testid="settings-sync-default-on"
          >
            <Trans>On</Trans>
          </ToggleGroupItem>
          <ToggleGroupItem
            value="off"
            className={COMMITTED_DEFAULT_SELECTED_CLASS}
            data-testid="settings-sync-default-off"
          >
            <Trans>Off</Trans>
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <EnableSyncConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={onConfirm}
      />
      <AuthModal
        open={authModalOpen}
        onOpenChange={setAuthModalOpen}
        onSuccess={() => setAuthModalOpen(false)}
      />
    </section>
  );
}

interface SettingsFieldProps {
  field: FieldDef;
  scope: Scope;
  commitField: (name: FieldPath<Config>) => boolean;
  isFlashed: boolean;
}

function SettingsField({ field, scope, commitField, isFlashed }: SettingsFieldProps) {
  // 'use no memo' — the FormField inline render-prop below destructures
  // `ctl` (a ControllerRenderProps with a `ref` field), which the React
  // Compiler heuristic flags as ref-access during render. Same rationale
  // as FieldControlBody / control bodies.
  'use no memo';
  const { t } = useLingui();
  const form = useFormContext<Config>();
  const leafSchema = resolveLeafSchema(ConfigSchema, field.path);
  const typeTag = leafSchema ? getLeafTypeTag(leafSchema) : undefined;
  const defaultValue = leafSchema ? getFieldDefault(leafSchema) : undefined;
  const enumOptions = leafSchema ? getEnumOptions(leafSchema) : undefined;

  // Defensive cross-scope check — every FieldDef in the new design is
  // routed to a section that matches its schema scope, so this should
  // never fire. Keeping the meta lookup as a guard rail; we don't
  // render a readonly note (the sidebar IA prevents the cross-scope
  // case from being reachable).
  const meta = leafSchema ? getFieldMeta(leafSchema) : undefined;
  const scopeMismatch =
    (meta?.scope === 'project' && scope !== 'project') ||
    (meta?.scope === 'user' && scope !== 'user');

  const dottedName = field.path.join('.') as FieldPath<Config>;
  const labelText = t(field.label);

  const [savedTick, setSavedTick] = useState(false);
  // Tracks the SavedIndicator timeout so an unmount mid-flash doesn't fire
  // `setSavedTick(false)` on a torn-down component (React warning).
  const savedTickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (savedTickTimerRef.current) clearTimeout(savedTickTimerRef.current);
    },
    [],
  );

  const flashSavedTick = () => {
    setSavedTick(true);
    if (savedTickTimerRef.current) clearTimeout(savedTickTimerRef.current);
    savedTickTimerRef.current = setTimeout(() => setSavedTick(false), 1200);
  };

  /**
   * Run `commitField` (the harness-owned binding.patch + form.setError /
   * form.clearErrors path) and flash the SavedIndicator on success. The
   * value committed is whatever currently lives in the form at `name` —
   * call sites are responsible for writing the desired value via
   * `ctl.onChange` (per-control commits) or `form.setValue` (reset path)
   * BEFORE invoking `runCommit`.
   */
  const runCommit = (): boolean => {
    const ok = commitField(dottedName);
    if (ok) flashSavedTick();
    return ok;
  };

  /**
   * Per-interaction commit (blur/change/Enter). Skips no-op commits where
   * the field is not dirty against its current `defaultValue` baseline —
   * after a successful commit, `useConfigForm` re-baselines via
   * `form.resetField(name, { defaultValue: value })`, so subsequent
   * blurs on an unchanged field correctly report `isDirty: false` and
   * the unconditional `binding.patch → Y.Text delete+insert` cycle is
   * avoided. Returns true on no-op (no error to surface).
   *
   * The reset path bypasses this guard by calling `runCommit` directly:
   * `form.setValue(name, target, { shouldDirty: false })` leaves the
   * field non-dirty, but the commit is still intentional (the user
   * clicked Reset).
   */
  const runCommitIfDirty = (): boolean => {
    if (!form.getFieldState(dottedName).isDirty) return true;
    return runCommit();
  };

  /**
   * Reset writes the schema default (or `null` for fields with no
   * default — null-as-clear preserves RFC 7396 semantics) into form
   * state, then commits via the harness. `shouldDirty: false` so the
   * field doesn't end up flagged as dirty after reset.
   */
  const reset = () => {
    const target = defaultValue === undefined ? null : defaultValue;
    form.setValue(dottedName, target as never, { shouldDirty: false });
    runCommit();
  };

  const wrapperClass = cn('relative', isFlashed && 'animate-settings-flash');

  return (
    <FormField
      control={form.control}
      name={dottedName}
      render={({ field: ctl }) => {
        // Reset-button visibility derives from the form's reactive value
        // (`ctl.value`) so it updates in lockstep with user edits, external
        // Y.Text updates, and resets.
        const showResetButton =
          !scopeMismatch && (defaultValue !== undefined || ctl.value !== undefined);

        return (
          <FormItem className={wrapperClass} data-field={field.path.join('.')} data-scope={scope}>
            <div className="flex items-center justify-between gap-2">
              <FormLabel className="text-sm font-medium">{labelText}</FormLabel>
              {showResetButton ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 text-muted-foreground opacity-60 hover:opacity-100"
                      onClick={reset}
                      aria-label={t`Reset ${labelText} to default`}
                    >
                      <RotateCcw className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <Trans>Reset to default</Trans>
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            {field.description ? (
              <FormDescription className="text-muted-foreground text-1sm">
                {t(field.description)}
              </FormDescription>
            ) : null}
            <div className="flex items-center gap-2">
              <FormControl>
                <FieldControlBody
                  field={field}
                  ctl={ctl}
                  typeTag={typeTag}
                  enumOptions={enumOptions}
                  onCommit={runCommitIfDirty}
                />
              </FormControl>
              <SavedIndicator visible={savedTick} />
            </div>
            <FormMessage data-field-error={field.path.join('.')} />
          </FormItem>
        );
      }}
    />
  );
}

interface FieldControlBodyProps {
  field: FieldDef;
  ctl: ControllerRenderProps<Config, FieldPath<Config>>;
  typeTag: string | undefined;
  enumOptions: readonly string[] | undefined;
  /**
   * Commits the field's CURRENT form value via the harness's
   * `commitField`. Call sites must write the desired value through
   * `ctl.onChange` BEFORE invoking — the commit reads from form state.
   */
  onCommit: () => boolean;
}

/**
 * Type-tag-driven dispatch for the inner control element. Returns a
 * single React element so the wrapping `<FormControl>` (Radix Slot)
 * can forward `id`, `aria-describedby`, and `aria-invalid` to the
 * underlying DOM input. The Slot clones this component with those props;
 * destructure + forward as `...slotForwarded` into each leaf — without
 * this hop the a11y attributes hit FieldControlBody and stop, breaking
 * screen-reader notification of L1 rejection (ARIA §4.10).
 *
 * `'use no memo'` opts out of React Compiler memoization because RHF's
 * `ControllerRenderProps` exposes a `ref` field; the compiler heuristic
 * flags every property access on objects with `ref` as ref-access during
 * render. The control bodies below use the same opt-out for the same
 * reason.
 */
function FieldControlBody({
  field,
  ctl,
  typeTag,
  enumOptions,
  onCommit,
  ...slotForwarded
}: FieldControlBodyProps & SlotForwardedProps) {
  'use no memo';
  const { t } = useLingui();
  // Optimistic theme apply. next-themes' `useTheme` is safe to
  // call unconditionally — it returns a no-op `setTheme` when no
  // <ThemeProvider> is mounted (e.g. in unit harnesses), and the app always
  // mounts one in `main.tsx`. The actual flip is gated to the theme field in
  // the enum-toggle branch below, so non-theme controls are unaffected.
  const { setTheme } = useTheme();
  if (typeTag === 'boolean') {
    return (
      <Switch
        {...slotForwarded}
        checked={Boolean(ctl.value)}
        ref={ctl.ref}
        onCheckedChange={(next) => {
          ctl.onChange(next);
          onCommit();
        }}
        onBlur={ctl.onBlur}
      />
    );
  }
  if (typeTag === 'enum' && enumOptions && enumOptions.length > 0) {
    if (field.control === 'enum-toggle' || enumOptions.length <= 4) {
      // Slot.Root forwards `id` onto its child; ToggleGroup root renders a
      // <div>, which is not a labelable element — `<label htmlFor>` on a
      // div doesn't focus its descendants on click. Pluck the id and put
      // it on the first ToggleGroupItem (a <button>) so label-click moves
      // focus into the group. aria-describedby/aria-invalid stay on the
      // wrapper since they describe the group as a whole.
      const { id: forwardedId, ...wrapperSlotProps } = slotForwarded;
      // Theme is the one enum-toggle that flips app-wide appearance. Detect it
      // by path so the optimistic next-themes write stays scoped to this field.
      const isThemeField = field.path[0] === 'appearance' && field.path[1] === 'theme';
      return (
        <ToggleGroup
          {...wrapperSlotProps}
          type="single"
          value={typeof ctl.value === 'string' ? ctl.value : ''}
          ref={ctl.ref}
          onValueChange={(next) => {
            if (!next) return;
            // Optimistic flip on the originating client: apply via next-themes
            // synchronously so the UI changes on click instead of waiting for
            // the patch -> user-config Y.Text -> ConfigProvider merged-effect
            // round-trip (the perceived lag). `next` is forwarded verbatim —
            // 'system' is the OS-tracking lever and must not be resolved here.
            // The ConfigProvider merged-effect still drives cross-project /
            // remote clients (via config.yml + file-watcher) and Electron
            // native chrome, and no-ops here (same value -> next-themes
            // state bailout), so there is no double-flip.
            if (isThemeField) setTheme(next);
            ctl.onChange(next);
            onCommit();
          }}
          onBlur={ctl.onBlur}
          variant="segmented"
          size="sm"
          spacing={1}
          className="bg-muted dark:bg-background p-0.5 rounded-lg"
          aria-label={t(field.label)}
        >
          {enumOptions.map((opt, idx) => (
            <ToggleGroupItem
              key={opt}
              value={opt}
              id={idx === 0 ? forwardedId : undefined}
              className="text-1sm capitalize"
            >
              {opt}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      );
    }
  }
  if (typeTag === 'number' || typeTag === 'int') {
    return <NumberControlBody ctl={ctl} onCommit={onCommit} {...slotForwarded} />;
  }
  if (typeTag === 'array') {
    return <StringArrayControlBody ctl={ctl} onCommit={onCommit} {...slotForwarded} />;
  }
  return <StringControlBody ctl={ctl} onCommit={onCommit} {...slotForwarded} />;
}

/**
 * String-typed text input. Form value IS the displayed text — no local
 * presentation buffer needed. Commits on blur or Enter.
 */
function StringControlBody({
  ctl,
  onCommit,
  ...slotForwarded
}: {
  ctl: ControllerRenderProps<Config, FieldPath<Config>>;
  onCommit: () => boolean;
} & SlotForwardedProps) {
  'use no memo';
  return (
    <Input
      {...slotForwarded}
      value={typeof ctl.value === 'string' ? ctl.value : ''}
      ref={ctl.ref}
      onChange={(e) => ctl.onChange(e.target.value)}
      onBlur={() => {
        ctl.onBlur();
        onCommit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit();
        }
      }}
      className="h-8 text-sm"
    />
  );
}

/**
 * Number-typed input. Form value is a `number`; the textbox needs a
 * string presentation buffer so the user can type intermediate text
 * (`'1.'`, `'-'`) without it parsing prematurely. The local `pendingText`
 * resyncs with `ctl.value` whenever the user isn't actively editing.
 */
function NumberControlBody({
  ctl,
  onCommit,
  ...slotForwarded
}: {
  ctl: ControllerRenderProps<Config, FieldPath<Config>>;
  onCommit: () => boolean;
} & SlotForwardedProps) {
  'use no memo';
  const [pendingText, setPendingText] = useState(ctl.value === undefined ? '' : String(ctl.value));
  const lastSyncedValueRef = useRef(ctl.value);

  useEffect(() => {
    // Skip if ctl.value hasn't changed since the last sync (dedup —
    // avoids resetting pendingText on unrelated re-renders). When
    // ctl.value DOES change, refresh pendingText to track it.
    if (lastSyncedValueRef.current === ctl.value) return;
    setPendingText(ctl.value === undefined ? '' : String(ctl.value));
    lastSyncedValueRef.current = ctl.value;
  }, [ctl.value]);

  const commitText = () => {
    const parsed = Number(pendingText);
    if (!Number.isFinite(parsed)) {
      // Let L1 reject + show a typed FormMessage error rather than silently swallow.
      ctl.onChange(pendingText as unknown as number);
      onCommit();
      return;
    }
    ctl.onChange(parsed);
    onCommit();
    lastSyncedValueRef.current = parsed as unknown as Config[keyof Config];
  };

  return (
    <Input
      {...slotForwarded}
      type="number"
      value={pendingText}
      ref={ctl.ref}
      onChange={(e) => setPendingText(e.target.value)}
      onBlur={() => {
        ctl.onBlur();
        commitText();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitText();
        }
      }}
      className="h-8 w-28 text-sm tabular-nums"
    />
  );
}

/**
 * String-array textarea. Form value is `string[]`; the textarea displays
 * a newline-joined string. Local `pendingText` resyncs with `ctl.value`
 * whenever the user isn't actively editing. Commit splits on newlines,
 * trims each entry, and filters empty lines.
 */
function StringArrayControlBody({
  ctl,
  onCommit,
  ...slotForwarded
}: {
  ctl: ControllerRenderProps<Config, FieldPath<Config>>;
  onCommit: () => boolean;
} & SlotForwardedProps) {
  'use no memo';
  const initial = Array.isArray(ctl.value) ? (ctl.value as string[]).join('\n') : '';
  const [pendingText, setPendingText] = useState(initial);
  const lastSyncedRef = useRef(initial);

  useEffect(() => {
    const incoming = Array.isArray(ctl.value) ? (ctl.value as string[]).join('\n') : '';
    if (incoming === lastSyncedRef.current) return;
    setPendingText(incoming);
    lastSyncedRef.current = incoming;
  }, [ctl.value]);

  const commitText = () => {
    const parsed = pendingText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    ctl.onChange(parsed);
    onCommit();
    lastSyncedRef.current = parsed.join('\n');
  };

  return (
    <textarea
      {...slotForwarded}
      value={pendingText}
      ref={ctl.ref}
      onChange={(e) => setPendingText(e.target.value)}
      onBlur={() => {
        ctl.onBlur();
        commitText();
      }}
      rows={Math.max(2, Math.min(6, pendingText.split('\n').length))}
      className="min-h-16 w-full rounded-md border border-input bg-background px-3 py-1.5 font-mono text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"
    />
  );
}

function SavedIndicator({ visible }: { visible: boolean }) {
  // Live region — auto-save replaces an explicit Save button, so this
  // checkmark IS the save confirmation. Polite announcement so screen
  // readers say "Saved" without interrupting other speech (WCAG 4.1.3).
  // Always render the wrapper so the SR-only text node is present at
  // mount time; the visible checkmark is the only thing that toggles.
  return (
    <span role="status" aria-live="polite" className="text-emerald-600">
      {visible ? (
        <>
          <Check aria-hidden="true" className="size-3.5" />
          <span className="sr-only">
            <Trans>Saved</Trans>
          </span>
        </>
      ) : null}
    </span>
  );
}

function IntegrationsSection() {
  const [installOpen, setInstallOpen] = useState(false);
  const { skillInstalled, refresh } = useClaudeDesktopIntegration();
  if (!SHOW_INSTALL_SKILL) return null;

  return (
    <section aria-labelledby="settings-integrations-title" className="space-y-3">
      <div className="space-y-1">
        <h3 id="settings-integrations-title" className="text-base font-semibold">
          <Trans>Integrations</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          <Trans>Connect OpenKnowledge to other tools you use.</Trans>
        </p>
      </div>
      <div className="rounded-md border p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium">
              <Trans>Install in Claude Desktop</Trans>
            </div>
            <p className="text-muted-foreground text-1sm">
              <Trans>Make this knowledge base available as a Claude Skill.</Trans>
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setInstallOpen(true)}
            data-testid="settings-install-claude-desktop"
            className="uppercase font-mono"
          >
            {skillInstalled ? <Trans>Reinstall</Trans> : <Trans>Install</Trans>}
          </Button>
        </div>
      </div>
      <InstallInClaudeDesktopDialog
        open={installOpen}
        onOpenChange={(next) => {
          setInstallOpen(next);
          if (!next) refresh();
        }}
        reinstall={skillInstalled}
      />
    </section>
  );
}
