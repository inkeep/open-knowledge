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

const NAME_RE = /^[A-Za-z0-9_-]+$/;

export function slugifyTemplateName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

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

export interface PropRow {
  id: string;
  key: string;
  value: string;
}


let propRowSeq = 0;
function nextRowId(): string {
  propRowSeq += 1;
  return `prop-${propRowSeq}`;
}

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
    if (key === '' || key === 'type') continue;
    lines.push(row.value === '' ? `${key}:` : `${key}: ${row.value}`);
  }
  if (lines.length === 0) return args.markdown.replace(/^\n+/, '');
  const md = args.markdown.startsWith('\n') ? args.markdown : `\n${args.markdown}`;
  return `---\n${lines.join('\n')}\n---\n${md}`;
}

interface TemplateFormInitial {
  name: string;
  title: string;
  description: string;
  body: string;
}

interface UseTemplateFormArgs {
  mode: 'create' | 'edit';
  folderPath: string;
  scope?: 'local' | 'inherited';
  initial: TemplateFormInitial;
  existingNames?: ReadonlySet<string>;
  onCommitted: (committedName: string) => void;
}

export interface TemplateFormState {
  mode: 'create' | 'edit';
  title: string;
  slug: string;
  description: string;
  type: string;
  properties: PropRow[];
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
  fixedName: string;
  canRename: boolean;
  submit: () => Promise<void>;
}

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
    if (mode === 'create' && !slugManuallyEdited) {
      setSlugState(slugifyTemplateName(next));
    }
  }

  function setSlug(next: string) {
    setSlugState(next);
    setSlugManuallyEdited(true);
  }

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
      setTitleTouched(true);
      return;
    }
    setSaving(true);
    const frontmatter = buildTemplateFrontmatter({ title, description });
    const composedBody = composeDocBody({ type, properties, markdown: body });
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

function DerivedFilename({ form }: { form: TemplateFormState }) {
  const { t } = useLingui();
  const slugId = useId();
  const [editing, setEditing] = useState(false);
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
