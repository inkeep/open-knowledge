import { stripFrontmatter, unwrapFrontmatterFences } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { X } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { TemplateBodyTextarea } from '@/components/TemplateBody';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { moveTemplate, saveTemplate } from '@/lib/folder-config-api';

/** Filename grammar: ASCII alnum + `_` + `-`. The id agents pass to write. */
const NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Derive a filesystem-safe template filename from the human-facing name:
 * lowercase, every non-alphanumeric run collapsed to a single `-`, edges
 * trimmed. The result satisfies NAME_RE, or is empty when the name has no
 * alphanumeric content — callers treat empty as invalid.
 *
 * Distinct from `toWikiLinkSlug` in `@inkeep/open-knowledge-core`, which
 * preserves Unicode letters and digits; this is ASCII-only on purpose so
 * the derived filename always satisfies NAME_RE.
 */
export function slugifyTemplateName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build the `{title?, description?}` frontmatter payload — trimmed, with
 * empties dropped. The server distinguishes absent from empty-string: an
 * absent key lets the folder cascade fall back to an inherited value.
 */
function buildTemplateFrontmatter(args: { title: string; description: string }): {
  title?: string;
  description?: string;
} {
  const out: { title?: string; description?: string } = {};
  const title = args.title.trim();
  if (title) out.title = title;
  const description = args.description.trim();
  if (description) out.description = description;
  return out;
}

/** A single default-property row: a frontmatter key and its raw YAML value text. */
export interface PropRow {
  /** Stable id for React list keys (not persisted). */
  id: string;
  key: string;
  /** Raw value text after `key: ` — e.g. `provisional`, `[]`, `{{date}}`. */
  value: string;
}

/**
 * The doc-frontmatter a template stamps onto new docs lives in the starter
 * content's leading frontmatter block, but is surfaced in the dialog as a
 * dedicated `type` field + editable property rows. These helpers split it out
 * for editing and recompose it on save. They work at the TEXT level (no YAML
 * parse) so `{{date}}`/`{{user}}` tokens and value shapes (`[]`, flow lists)
 * survive verbatim.
 */

let propRowSeq = 0;
function nextRowId(): string {
  propRowSeq += 1;
  return `prop-${propRowSeq}`;
}

/**
 * Split a template body into its `type`, the remaining doc-frontmatter rows,
 * and the markdown. Each frontmatter line `key: value` becomes one row;
 * indented continuation lines fold into the prior row's value so nothing is
 * lost on a multi-line value.
 */
export function parseDocBody(rawBody: string): {
  type: string;
  properties: PropRow[];
  markdown: string;
} {
  const { frontmatter, body } = stripFrontmatter(rawBody);
  if (frontmatter === '') return { type: '', properties: [], markdown: rawBody };

  const parsed: { key: string; value: string }[] = [];
  for (const line of unwrapFrontmatterFences(frontmatter).split('\n')) {
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    // Indented or colon-less lines are continuations of the previous value.
    if ((/^\s/.test(line) || colon === -1) && parsed.length > 0) {
      const prev = parsed[parsed.length - 1];
      if (prev) prev.value += `\n${line}`;
      continue;
    }
    if (colon === -1) continue;
    parsed.push({
      key: line.slice(0, colon).trim(),
      value: line.slice(colon + 1).replace(/^ /, ''),
    });
  }

  let type = '';
  const properties: PropRow[] = [];
  for (const row of parsed) {
    if (row.key === 'type' && type === '') {
      type = row.value.trim();
      continue;
    }
    properties.push({ id: nextRowId(), key: row.key, value: row.value });
  }
  return { type, properties, markdown: body };
}

/**
 * Recompose a template body from the `type` field, the property rows, and the
 * markdown. `type` is written first; empty-key rows are dropped; no rows at all
 * → markdown only (no empty frontmatter block).
 */
export function composeDocBody(args: {
  type: string;
  properties: PropRow[];
  markdown: string;
}): string {
  const lines: string[] = [];
  const type = args.type.trim();
  if (type) lines.push(`type: ${type}`);
  for (const row of args.properties) {
    const key = row.key.trim();
    // Skip empty keys, and `type` — it is owned by the dedicated Type field;
    // a property row also named `type` would emit a duplicate YAML key.
    if (key === '' || key === 'type') continue;
    lines.push(row.value === '' ? `${key}:` : `${key}: ${row.value}`);
  }
  if (lines.length === 0) return args.markdown.replace(/^\n+/, '');
  const md = args.markdown.startsWith('\n') ? args.markdown : `\n${args.markdown}`;
  return `---\n${lines.join('\n')}\n---\n${md}`;
}

interface TemplateFormInitial {
  /** Filename (slug). Empty in create mode; the immutable name in edit mode. */
  name: string;
  title: string;
  description: string;
  body: string;
}

interface UseTemplateFormArgs {
  mode: 'create' | 'edit';
  folderPath: string;
  /**
   * Resolution scope of the template being edited. Only a `local` template can
   * be renamed in place — a rename is a `git mv` of this folder's own file.
   * An `inherited` template is owned by an ancestor; renaming here would touch
   * every folder that inherits it, so the filename stays locked. Defaults to
   * `local` (create always authors a local template).
   */
  scope?: 'local' | 'inherited';
  initial: TemplateFormInitial;
  /**
   * Template names already resolving for this folder (create mode only). A
   * match surfaces a shadow warning — saving a local template of the same
   * name supersedes the inherited one per closest-wins.
   */
  existingNames?: ReadonlySet<string>;
  /** Called after a successful create/save/rename with the committed filename. */
  onCommitted: (committedName: string) => void;
}

export interface TemplateFormState {
  mode: 'create' | 'edit';
  /** The human-facing name (stored as frontmatter `title`). */
  title: string;
  /** The filename without `.md` (stored as the file `name`). */
  slug: string;
  description: string;
  /** OKF `type` for created docs; lifted out of the starter-content frontmatter. */
  type: string;
  /** The remaining default doc-frontmatter, as editable key/value rows. */
  properties: PropRow[];
  /** Starter content as pure markdown (frontmatter lifted into type + properties). */
  body: string;
  setTitle: (next: string) => void;
  setSlug: (next: string) => void;
  setDescription: (next: string) => void;
  setType: (next: string) => void;
  setProperty: (id: string, patch: Partial<Pick<PropRow, 'key' | 'value'>>) => void;
  addProperty: () => void;
  removeProperty: (id: string) => void;
  setBody: (next: string) => void;
  markTitleTouched: () => void;
  titleTouched: boolean;
  isSaving: boolean;
  canSubmit: boolean;
  titleInvalid: boolean;
  slugInvalid: boolean;
  slugShadows: boolean;
  trimmedSlug: string;
  /** The filename shown in edit mode (the rename source / read-only display). */
  fixedName: string;
  /**
   * Whether the filename is editable in edit mode (a local template). Drives
   * whether the edit dialog shows an editable Filename field or the locked
   * read-only display. Always `false` in create mode (the slug field is its
   * own affordance there).
   */
  canRename: boolean;
  submit: () => Promise<void>;
}

/**
 * State + submit logic for the template create/edit form. The user fills one
 * `Name` field; the filename `slug` is derived from it until the user takes
 * manual control via the `Edit` affordance, after which the two decouple.
 *
 * Rendering is `TemplateFormFields` — split out so the create and edit dialogs
 * can place the fields and footer buttons in different DOM parents.
 */
export function useTemplateForm({
  mode,
  folderPath,
  scope = 'local',
  initial,
  existingNames,
  onCommitted,
}: UseTemplateFormArgs): TemplateFormState {
  const [title, setTitleState] = useState(initial.title);
  const [slug, setSlugState] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  // The doc-frontmatter is lifted out of the starter content: `type` gets a
  // dedicated field, the rest become editable property rows, and the body
  // textarea shows only the markdown.
  const initialDoc = useState(() => parseDocBody(initial.body))[0];
  const [type, setType] = useState(initialDoc.type);
  const [properties, setProperties] = useState<PropRow[]>(initialDoc.properties);
  const [body, setBody] = useState(initialDoc.markdown);
  const [saving, setSaving] = useState(false);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [titleTouched, setTitleTouched] = useState(false);

  function setProperty(id: string, patch: Partial<Pick<PropRow, 'key' | 'value'>>) {
    setProperties((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }
  function addProperty() {
    setProperties((rows) => [...rows, { id: nextRowId(), key: '', value: '' }]);
  }
  function removeProperty(id: string) {
    setProperties((rows) => rows.filter((row) => row.id !== id));
  }

  function setTitle(next: string) {
    setTitleState(next);
    // Keep the filename in lockstep with the name until the user takes
    // manual control of it via the Edit affordance.
    if (mode === 'create' && !slugManuallyEdited) {
      setSlugState(slugifyTemplateName(next));
    }
  }

  function setSlug(next: string) {
    setSlugState(next);
    setSlugManuallyEdited(true);
  }

  // A local template can be renamed in place (edit mode); the filename field
  // is editable and validated just like create's slug. Inherited templates
  // keep the locked read-only filename.
  const canRename = mode === 'edit' && scope === 'local';
  const slugEditable = mode === 'create' || canRename;

  const trimmedTitle = title.trim();
  const trimmedSlug = slug.trim();
  const titleInvalid = trimmedTitle === '';
  const slugInvalid = slugEditable && (trimmedSlug === '' || !NAME_RE.test(trimmedSlug));
  const slugShadows =
    mode === 'create' && !slugInvalid && (existingNames?.has(trimmedSlug) ?? false);
  const canSubmit = !saving && !titleInvalid && !slugInvalid;

  async function submit() {
    if (!canSubmit) {
      // Reveal the name error if the user submits an untouched empty form.
      setTitleTouched(true);
      return;
    }
    setSaving(true);
    const frontmatter = buildTemplateFrontmatter({ title, description });
    // Recompose the starter content: type + property rows back into the
    // leading frontmatter, above the markdown body.
    const composedBody = composeDocBody({ type, properties, markdown: body });
    // Edit mode + changed filename on a local template → a move/rename
    // (git mv), carrying the edited content so it's one atomic server op.
    const renaming = canRename && trimmedSlug !== initial.name;
    const result = renaming
      ? await moveTemplate({
          fromFolder: folderPath,
          fromName: initial.name,
          toFolder: folderPath,
          toName: trimmedSlug,
          frontmatter,
          body: composedBody,
        })
      : await saveTemplate({
          folder: folderPath,
          name: mode === 'create' ? trimmedSlug : initial.name,
          frontmatter,
          body: composedBody,
        });
    setSaving(false);
    if (!result.ok) {
      const { error } = result;
      toast.error(
        mode === 'create'
          ? t`Couldn't create template: ${error}`
          : t`Couldn't save template: ${error}`,
      );
      return;
    }
    if (renaming) {
      toast.success(t`Template renamed`);
    } else if ('warnings' in result && result.warnings.length > 0) {
      toast.warning(result.warnings.join(' '));
    } else if (mode === 'create') {
      toast.success(t`Template "${trimmedTitle}" created`);
    } else {
      toast.success(t`Template saved`);
    }
    // The committed filename: the slug on create/rename, else the unchanged name.
    onCommitted(mode === 'create' || renaming ? trimmedSlug : initial.name);
  }

  return {
    mode,
    title,
    slug,
    description,
    type,
    properties,
    body,
    setTitle,
    setSlug,
    setDescription,
    setType,
    setProperty,
    addProperty,
    removeProperty,
    setBody,
    markTitleTouched: () => setTitleTouched(true),
    titleTouched,
    isSaving: saving,
    canSubmit,
    titleInvalid,
    slugInvalid,
    slugShadows,
    trimmedSlug,
    fixedName: initial.name,
    canRename,
    submit,
  };
}

/**
 * Renders the template form's fields: the `Name` field (with the derived,
 * overridable filename beneath it), `Description`, and the body.
 */
export function TemplateFormFields({
  form,
  bodyPlaceholder,
}: {
  form: TemplateFormState;
  bodyPlaceholder?: string;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const descriptionId = useId();
  const typeId = useId();
  const showNameError = form.titleTouched && form.titleInvalid;
  const { fixedName } = form;

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={nameId}>
          <Trans>Title</Trans>
          <span className="text-destructive">*</span>
        </FieldLabel>
        <Input
          id={nameId}
          data-testid="template-name-input"
          value={form.title}
          onChange={(e) => form.setTitle(e.target.value)}
          onBlur={form.markTitleTouched}
          placeholder={t`Blog post`}
          disabled={form.isSaving}
          aria-invalid={showNameError}
        />
        {showNameError ? (
          <FieldError>
            <Trans>Enter a title for this template.</Trans>
          </FieldError>
        ) : null}
      </Field>
      {form.mode === 'create' ? (
        <DerivedFilename form={form} />
      ) : form.canRename ? (
        <EditFilename form={form} />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            <Trans>
              File: <code className="font-mono">{fixedName}.md</code>
            </Trans>
          </p>
          <p className="text-xs text-muted-foreground">
            <Trans>
              Inherited templates can't be renamed here — rename it in the folder that owns it.
            </Trans>
          </p>
        </>
      )}
      <Field>
        <FieldLabel htmlFor={descriptionId}>
          <Trans>Description</Trans>
        </FieldLabel>
        <Textarea
          id={descriptionId}
          value={form.description}
          onChange={(e) => form.setDescription(e.target.value)}
          placeholder={t`A short line shown under the name in the template list.`}
          disabled={form.isSaving}
          rows={2}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={typeId}>
          <Trans>Type</Trans>
        </FieldLabel>
        <Input
          id={typeId}
          value={form.type}
          onChange={(e) => form.setType(e.target.value)}
          placeholder={t`research-note`}
          disabled={form.isSaving}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="font-mono"
        />
        <FieldDescription>
          <Trans>
            The <code className="font-mono">type</code> every document created from this template
            gets (e.g. <code className="font-mono">research-note</code>). Keeps new docs Open
            Knowledge Format–conformant.
          </Trans>
        </FieldDescription>
      </Field>
      <TemplateDefaultProperties form={form} />
      <TemplateBodyTextarea
        value={form.body}
        onChange={form.setBody}
        disabled={form.isSaving}
        placeholder={bodyPlaceholder}
      />
    </FieldGroup>
  );
}

/**
 * The default doc-frontmatter every new document inherits, as editable key/value
 * rows. Values are raw YAML text (e.g. `[]`, `[a, b]`, `{{date}}`) so any value
 * shape and the `{{date}}`/`{{user}}` tokens round-trip untouched.
 */
function TemplateDefaultProperties({ form }: { form: TemplateFormState }) {
  const { t } = useLingui();
  return (
    <Field>
      <FieldLabel>
        <Trans>Default properties</Trans>
      </FieldLabel>
      <FieldDescription>
        <Trans>
          Frontmatter every document created from this template starts with. Values are YAML — a
          list is <code className="font-mono">[a, b]</code>;{' '}
          <code className="font-mono">{'{{date}}'}</code> fills in on create.
        </Trans>
      </FieldDescription>
      {form.properties.length > 0 ? (
        <div className="flex flex-col gap-2">
          {form.properties.map((row) => (
            <div key={row.id} className="flex items-center gap-2">
              <Input
                aria-label={t`Property name`}
                value={row.key}
                onChange={(e) => form.setProperty(row.id, { key: e.target.value })}
                placeholder={t`status`}
                disabled={form.isSaving}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="font-mono w-1/3"
              />
              <Input
                aria-label={t`Property value`}
                value={row.value}
                onChange={(e) => form.setProperty(row.id, { value: e.target.value })}
                placeholder={t`provisional`}
                disabled={form.isSaving}
                spellCheck={false}
                className="font-mono flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t`Remove property`}
                onClick={() => form.removeProperty(row.id)}
                disabled={form.isSaving}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={form.addProperty}
        disabled={form.isSaving}
      >
        <Trans>Add property</Trans>
      </Button>
    </Field>
  );
}

/**
 * The filename line beneath the `Name` field (create mode). Collapsed, it
 * shows the derived `<slug>.md` with an `Edit` affordance; expanded — or when
 * the derived slug is unusable — it shows the editable filename input.
 */
function DerivedFilename({ form }: { form: TemplateFormState }) {
  const { t } = useLingui();
  const slugId = useId();
  const [editing, setEditing] = useState(false);
  // Force the editor open once the user has engaged the name and the derived
  // slug is either unusable or would shadow an inherited template, so the error
  // or the shadow warning shows without the user having to open Edit.
  const showEditor = editing || (form.titleTouched && (form.slugInvalid || form.slugShadows));
  const { slug, trimmedSlug } = form;

  if (!showEditor) {
    if (trimmedSlug === '') return null;
    return (
      <p className="text-xs text-muted-foreground">
        <Trans>
          Saved as <code className="font-mono">{slug}.md</code>
        </Trans>{' '}
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 align-baseline text-xs font-mono uppercase"
          onClick={() => setEditing(true)}
          disabled={form.isSaving}
        >
          <Trans>Edit</Trans>
        </Button>
      </p>
    );
  }

  return (
    <Field>
      <FieldLabel htmlFor={slugId}>
        <Trans>Filename</Trans>
      </FieldLabel>
      <Input
        id={slugId}
        value={slug}
        onChange={(e) => form.setSlug(e.target.value)}
        placeholder={t`blog-post`}
        disabled={form.isSaving}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-invalid={form.slugInvalid}
        className="font-mono"
      />
      {form.slugInvalid ? (
        <FieldError>
          <Trans>
            Use letters, digits, <code className="font-mono">-</code> or{' '}
            <code className="font-mono">_</code> only.
          </Trans>
        </FieldError>
      ) : form.slugShadows ? (
        <FieldDescription className="text-yellow-600 dark:text-yellow-500">
          <Trans>
            A template named <code className="font-mono">{trimmedSlug}</code> already exists here.
            Saving creates a local copy that overrides it for this folder.
          </Trans>
        </FieldDescription>
      ) : (
        <FieldDescription>
          <Trans>The file on disk, and the id agents use. It can't be changed later.</Trans>
        </FieldDescription>
      )}
    </Field>
  );
}

/**
 * The editable filename field shown in edit mode for a LOCAL template. Changing
 * it renames the template — a `git mv` of `<folder>/.ok/templates/<name>.md`,
 * carrying any body/description edits in the same save. Inherited templates
 * never render this (their filename is locked); create mode uses
 * `DerivedFilename` (which derives the slug from the name).
 */
function EditFilename({ form }: { form: TemplateFormState }) {
  const { t } = useLingui();
  const slugId = useId();
  return (
    <Field>
      <FieldLabel htmlFor={slugId}>
        <Trans>Filename</Trans>
      </FieldLabel>
      <Input
        id={slugId}
        value={form.slug}
        onChange={(e) => form.setSlug(e.target.value)}
        placeholder={t`blog-post`}
        disabled={form.isSaving}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-invalid={form.slugInvalid}
        className="font-mono"
      />
      {form.slugInvalid ? (
        <FieldError>
          <Trans>
            Use letters, digits, <code className="font-mono">-</code> or{' '}
            <code className="font-mono">_</code> only.
          </Trans>
        </FieldError>
      ) : (
        <FieldDescription>
          <Trans>
            Renaming changes the file on disk and the id agents use to pick this template.
          </Trans>
        </FieldDescription>
      )}
    </Field>
  );
}
